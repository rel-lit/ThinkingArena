// Version: 1.0.0
/**
 * cli/run：组合根 + 一局运行入口。
 *
 * 装配序（依赖方向 schema ← services ← meta ← components ← orchestrator ← cli）：
 *   eventLog → blackboard → llm-gateway（mock executor 经 LlmExecutor 缝注入）→ memory → agentService
 *   → envelopeSource（裁决 3-D-1 的可变信封源，exec/run 上下文通道的 MVP 机制）
 *   → directorPump → meta registry → component registry → FlowRunner。
 * envelopeSource 同时注入 meta registry 与 FlowRunnerDeps（鸭子类型额外字段，冻结 types.ts 无此通道），
 * FlowRunner 逐节点边界更新其 current()。
 *
 * Bundle 目录加载：场景文件以 JSON 语法书写（YAML 1.2 ⊇ JSON），JSON.parse 直读，零新依赖；
 * 名册引用的身份牌文件做存在性交叉校验（D20 加载期消灭配置错误）。
 *
 * 用法：node cli/run.ts --bundle <dir> --run-dir <dir> [--mock-llm <script.json>] [--resume] [--poll-interval-ms <n>]
 * run 目录产物：script.jsonl（Script）/ manifest.json（D24）/ director_inbox.jsonl（导演通道，F1）/ memory/。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { BUNDLE_LAYOUT, ScenarioBundleSchema, type ScenarioBundle } from '../schema/bundle.ts';
import type { MetaRegistry } from '../schema/meta-component.ts';
import { createEventLog, type EventLogFileContext } from '../services/event-log.ts';
import { createBlackboard, type BlackboardRunContext } from '../services/blackboard.ts';
import { createLLMGateway, type LLMGatewayPricing } from '../services/llm-gateway.ts';
import { createMemoryService, type MemoryServiceEx } from '../services/memory.ts';
import { createAgentService, type AgentServiceEx } from '../services/agent-service.ts';
import type { LlmExecutor } from '../services/types.ts';
import { createMetaRegistry, type MetaEnvelope } from '../meta/registry.ts';
import { createBuiltinComponentRegistry } from '../components/index.ts';
import { createDirectorPump, type DirectorPumpControl } from '../orchestrator/director-pump.ts';
import { createFlowRunner, type MutableEnvelopeSource } from '../orchestrator/flow-runner.ts';
import type { ComponentRegistry, DirectorPump, FlowRunner } from '../orchestrator/types.ts';
import { createMockExecutor, loadMockScript } from './mock-llm.ts';
import { createAiSdkExecutor } from '../services/ai-sdk-executor.ts';
import { loadDotEnv } from './env.ts';

// ===== Bundle 目录加载 =====

/**
 * 加载 Bundle 目录（flow/game/worldbook/seeds.yaml + identity_cards/*）→ ScenarioBundle。
 * 契约校验失败或名册引用缺失身份牌即抛错（局不开始，D20）。
 */
export function loadBundle(dir: string): ScenarioBundle {
  const readJson = (name: string): unknown => JSON.parse(readFileSync(join(dir, name), 'utf8'));
  const cardsDir = join(dir, BUNDLE_LAYOUT.identityCardsDir);
  const identityCards: Record<string, unknown> = {};
  for (const f of readdirSync(cardsDir).sort()) {
    if (/\.(ya?ml|json)$/.test(f)) identityCards[f] = JSON.parse(readFileSync(join(cardsDir, f), 'utf8'));
  }
  const parsed = ScenarioBundleSchema.safeParse({
    flow: readJson(BUNDLE_LAYOUT.flow),
    game: readJson(BUNDLE_LAYOUT.game),
    identity_cards: identityCards,
    worldbook: readJson(BUNDLE_LAYOUT.worldbook),
    seeds: readJson(BUNDLE_LAYOUT.seeds),
  });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Bundle 契约校验失败（${dir}）: ${issues}`);
  }
  // D20 加载期交叉校验：名册引用的身份牌文件必须存在（契约之外的装配层守卫）
  for (const a of parsed.data.game.agents) {
    if (!(a.identity_card in parsed.data.identity_cards)) {
      throw new Error(`Agent ${a.id} 引用的身份牌文件不存在: ${a.identity_card}`);
    }
  }
  return parsed.data;
}

// ===== 组合根 =====

/** 一局的全套装配产物（测试与 CLI 共用本根）。 */
export interface Composition {
  runDir: string;
  scriptPath: string;
  inboxPath: string;
  eventLog: EventLogFileContext;
  blackboard: BlackboardRunContext;
  gateway: LLMGatewayPricing;
  memory: MemoryServiceEx;
  agentService: AgentServiceEx;
  envelopeSource: MutableEnvelopeSource;
  pump: DirectorPump & DirectorPumpControl;
  meta: MetaRegistry;
  components: ComponentRegistry;
  runner: FlowRunner;
}

export interface CompositionOptions {
  runDir: string;
  /** 骰流种子（Bundle seeds.rng_seed；D33 同版本 rerun 复现骰点序列）。 */
  rngSeed: number;
  /** 价格表（D16 计算轨来源；mock 局用 buildMockPriceTable 从名册生成）。 */
  priceTable: Record<string, unknown>;
  /** LLM 执行器缝（本期注入 mock；真实 AI SDK 适配器走同一缝）。 */
  executor: LlmExecutor;
  /** 导演泵轮询间隔（测试可调小；缺省 200ms）。 */
  pollIntervalMs?: number;
}

/** 组合根：装配全部服务 + 元组件层 + 组件层 + 编排层。调用方负责 pump.start()/stop()。 */
export function assembleComposition(opts: CompositionOptions): Composition {
  mkdirSync(opts.runDir, { recursive: true });
  const scriptPath = join(opts.runDir, 'script.jsonl');
  const inboxPath = join(opts.runDir, 'director_inbox.jsonl');

  const eventLog = createEventLog({ filePath: scriptPath });
  const blackboard = createBlackboard({ eventLog });
  const gateway = createLLMGateway({ priceTable: opts.priceTable, executor: opts.executor });
  const memory = createMemoryService({ dir: join(opts.runDir, 'memory'), gateway });
  const agentService = createAgentService({ gateway, memory, blackboard, eventLog });

  // 裁决 3-D-1：exec/run 上下文通道——可变信封源，组合根持有，FlowRunner 逐节点边界 set()
  let current: MetaEnvelope | null = null;
  const envelopeSource: MutableEnvelopeSource = {
    current: () => current,
    set: (env) => {
      current = env;
    },
  };

  const pump = createDirectorPump({ inboxPath, eventLog, pollIntervalMs: opts.pollIntervalMs });
  const meta = createMetaRegistry({ agentService, memory, blackboard, eventLog, directorPump: pump, envelopeSource });
  const components = createBuiltinComponentRegistry({ rngSeed: opts.rngSeed });
  // envelopeSource 经鸭子类型额外字段传给 FlowRunner（冻结 FlowRunnerDeps 无此通道；变量传参绕开字面量检查）
  const deps = {
    services: { eventLog, blackboard, agentService, memory },
    meta,
    components,
    directorPump: pump,
    runDir: opts.runDir,
    envelopeSource,
  };
  const runner = createFlowRunner(deps);

  return {
    runDir: opts.runDir, scriptPath, inboxPath,
    eventLog, blackboard, gateway, memory, agentService, envelopeSource, pump, meta, components, runner,
  };
}

/** 按模型 id 推断服务商标识（价格表 provider 键，executor 据此选 provider 工厂）。 */
function inferProvider(model: string): string {
  if (model.startsWith('deepseek')) return 'deepseek';
  if (model.startsWith('k3') || model.startsWith('kimi') || model.startsWith('moonshot')) return 'moonshotai';
  return 'mock'; // 未知前缀：mock 局不受影响；真实局会在 route 期暴露为 NO_FALLBACK_AVAILABLE
}

/** 价格表：名册主模型 + fallback 候选全部入表（fallback 归因的前提，D13/D16）。 */
export function buildMockPriceTable(bundle: ScenarioBundle): Record<string, unknown> {
  const currency = bundle.game.cost_budget?.currency ?? 'CNY';
  const table: Record<string, unknown> = {};
  for (const a of bundle.game.agents) {
    const chain = [a.model.model, ...(a.model.fallback ?? [])];
    for (const [i, m] of chain.entries()) {
      table[m] ??= {
        provider: inferProvider(m),
        tier: a.model.tier,
        fallback: chain.slice(i + 1),
        price: { currency, input: 2, output: 8 }, // 每 1M tokens 单价（占位费率，非真实报价；真实价格表待建）
      };
    }
  }
  return table;
}

// ===== CLI 入口 =====

async function main(argv: string[]): Promise<number> {
  loadDotEnv(); // 先加载 .env（已有环境变量优先），再解析参数
  const { values } = parseArgs({
    args: argv,
    options: {
      bundle: { type: 'string' },
      'run-dir': { type: 'string' },
      'mock-llm': { type: 'string' },
      resume: { type: 'boolean', default: false },
      'poll-interval-ms': { type: 'string' },
    },
  });
  if (values.bundle === undefined || values['run-dir'] === undefined) {
    console.error('用法: node cli/run.ts --bundle <dir> --run-dir <dir> [--mock-llm <script.json>] [--resume] [--poll-interval-ms <n>]');
    return 2;
  }
  const bundle = loadBundle(values.bundle);
  // 一文件一局（event-log 不变量）：非 resume 时 run 目录已有 Script 则拒开，避免 EVENT_SCHEMA_INVALID 谜面
  if (!values.resume && existsSync(join(values['run-dir'], 'script.jsonl'))) {
    console.error(`run 目录已存在 Script（一文件一局）。换一个 --run-dir，或加 --resume 恢复上一局。`);
    return 2;
  }
  // 执行器选择：--mock-llm 走脚本 mock（测试/彩排）；缺省走真 AI SDK 适配器（真实局，key 经环境变量，凭证纪律附录 A）。
  const executor = values['mock-llm'] !== undefined
    ? createMockExecutor(loadMockScript(values['mock-llm']))
    : createAiSdkExecutor();
  const c = assembleComposition({
    runDir: values['run-dir'],
    rngSeed: bundle.seeds.rng_seed,
    priceTable: buildMockPriceTable(bundle),
    executor,
    pollIntervalMs: values['poll-interval-ms'] !== undefined ? Number(values['poll-interval-ms']) : undefined,
  });
  await c.pump.start();
  // 保活句柄：wait_forever 门 = 纯 promise 挂起，泵轮询 timer 又是 unref 的——CLI 自持保活，
  // 否则等导演投喂期间事件循环空转、进程静默退出（库侧保持 unref 纪律，事件循环生命周期归应用层）
  const keepAlive = setInterval(() => {}, 60_000);
  try {
    const r = await c.runner.run(bundle, values.resume ? { resume: true } : undefined);
    if (!r.ok) {
      console.error(`局失败: ${r.error}`);
      return 1;
    }
    console.log(JSON.stringify({ status: r.value.status, run_id: r.value.runId, manifest: join(c.runDir, 'manifest.json'), cost: r.value.manifest.cost }, null, 2));
    return 0;
  } finally {
    clearInterval(keepAlive);
    c.pump.stop();
  }
}

const invokedAsMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsMain) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    },
  );
}
