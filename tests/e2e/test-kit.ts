// Version: 1.0.0
/**
 * e2e 共享工具：线性测试 Bundle（叙事 → 骰子 → 判定 → 导演门 → 条件分支/回边 → 销毁）、
 * mock LLM 脚本、Script 读取、导演门自动投喂（经泵 isWaiting 判定，无竞态）。
 */
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUNDLE_LAYOUT, ScenarioBundleSchema, type ScenarioBundle } from '../../schema/bundle.ts';
import type { DirectorDirective, Event, GateTimeoutPolicy } from '../../schema/event.ts';
import type { DirectorPumpControl } from '../../orchestrator/director-pump.ts';
import type { MockLLMResponse } from '../../cli/mock-llm.ts';

/** 临时 run/bundle 目录。 */
export function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ===== 线性测试 Bundle =====

const PROTAGONIST_CARD = {
  version: '1.0',
  name: '求生者',
  description: '被丢进废土的普通人，冷静、先观察再行动。',
  personality: '谨慎、复盘癖',
  scenario: '核冬天后的灰烬荒原，必须活下去。',
} as const;

const REFEREE_CARD = {
  version: '1.0',
  name: '裁判',
  description: '公正的叙事裁判，只按规则与骰点裁决。',
} as const;

export interface LinearBundleOptions {
  /** 门超时策略（缺省 wait_forever——测试经 inbox 投喂驱动）。 */
  gateTimeout?: GateTimeoutPolicy;
  /** 快照策略（resume 测试调密以覆盖快照窗口恢复路径，D30）。 */
  snapshot?: { every_node_boundaries: number; min_events: number };
}

/**
 * 线性首局 Bundle：create_roles → narrate → dice_check → judge_action → gate
 *   →（state.rounds >= 2）→ destroy_protagonist → destroy_referee → 落定
 *   →（否则回边）→ narrate（第 2 轮）。
 * 覆盖：叙事（含工具循环）/ 骰子 / 判定 / 条件分支 / 回边循环（2 轮）/ 导演门 / 生命周期收尾。
 */
export function makeLinearBundle(opts: LinearBundleOptions = {}): ScenarioBundle {
  const gateTimeout: GateTimeoutPolicy = opts.gateTimeout ?? { policy: 'wait_forever' };
  const raw = {
    flow: {
      name: 'e2e-linear',
      version: '1.0.0',
      entry: 'create_roles',
      nodes: [
        {
          id: 'create_roles',
          type: 'role_create',
          version: '1.0.0',
          params: {
            agents: [
              { id: 'protagonist', identity_card: PROTAGONIST_CARD, model: { model: 'mock-flagship', tier: 'flagship', params: { temperature: 0.7 } } },
              { id: 'referee', identity_card: REFEREE_CARD, model: { model: 'mock-standard', tier: 'standard' } },
            ],
          },
          on_error: 'stop',
        },
        {
          id: 'narrate',
          type: 'narrative',
          version: '1.0.0',
          params: { agent_id: 'protagonist', intent: '描述你的处境并声明本回合行动', tools: ['bb_get'], max_tool_rounds: 2 },
          on_error: 'stop',
        },
        { id: 'dice_check', type: 'dice', version: '1.0.0', params: { expression: '1d20', purpose: '行动检定' }, on_error: 'stop' },
        {
          id: 'judge_action',
          type: 'judge',
          version: '1.0.0',
          params: { subject: '主角的本回合行动', referee_agent_id: 'referee', grades: ['成功', '失败'], max_retries: 1 },
          on_error: 'stop',
        },
        {
          id: 'gate',
          type: 'director_gate',
          version: '1.0.0',
          params: { targets: ['protagonist'], accepts: ['whisper'], timeout: gateTimeout },
          on_error: 'stop',
        },
        { id: 'destroy_protagonist', type: 'role_destroy', version: '1.0.0', params: { agent_id: 'protagonist', reason: '局末收尾' }, on_error: 'stop' },
        { id: 'destroy_referee', type: 'role_destroy', version: '1.0.0', params: { agent_id: 'referee', reason: '局末收尾' }, on_error: 'stop' },
      ],
      edges: [
        { from: 'create_roles', from_port: 'out', to: 'narrate', to_port: 'in' },
        { from: 'narrate', from_port: 'out', to: 'dice_check', to_port: 'in' },
        { from: 'dice_check', from_port: 'out', to: 'judge_action', to_port: 'in' },
        { from: 'judge_action', from_port: 'out', to: 'gate', to_port: 'in' },
        {
          id: 'e_finish',
          from: 'gate',
          from_port: 'out',
          to: 'destroy_protagonist',
          to_port: 'in',
          condition: { op: 'gte', left: { ref: 'state.rounds' }, right: 2 },
          order: 0,
        },
        { id: 'e_loop', from: 'gate', from_port: 'out', to: 'narrate', to_port: 'in', order: 1 },
        { from: 'destroy_protagonist', from_port: 'out', to: 'destroy_referee', to_port: 'in' },
      ],
    },
    game: {
      version: '1.0',
      rules: {},
      agents: [
        { id: 'protagonist', identity_card: 'protagonist.yaml', model: { model: 'mock-flagship', tier: 'flagship', params: { temperature: 0.7 } }, memory_ref: null },
        { id: 'referee', identity_card: 'referee.yaml', model: { model: 'mock-standard', tier: 'standard' }, memory_ref: null },
      ],
      cost_budget: { max_total: 50, currency: 'CNY' }, // D28 机制在场、阈值极大不触发
      iteration_limit: 8,
      ...(opts.snapshot !== undefined ? { snapshot: opts.snapshot } : {}),
    },
    identity_cards: { 'protagonist.yaml': PROTAGONIST_CARD, 'referee.yaml': REFEREE_CARD },
    worldbook: {
      version: '1.0',
      entries: [{ key: 'wasteland', title: '灰烬荒原', content: '核冬天后的废土，极寒与辐射尘。' }],
    },
    seeds: { version: '1.0', rng_seed: 20260801, llm_seed: null },
  };
  return ScenarioBundleSchema.parse(raw); // 测试 Bundle 本身先过契约（D20）
}

/**
 * 线性首局 mock LLM 脚本（FIFO，5 次调用）：
 * 第 1 轮 narrate 走一次工具循环（bb_get）再 final；judge 输出合法裁决 JSON（写 state.rounds=1）；
 * 第 2 轮 narrate 直接 final；judge 写 state.rounds=2（触发条件分支退出循环）。
 */
export const LINEAR_MOCK_SCRIPT: readonly MockLLMResponse[] = [
  { object: { tool_calls: [{ call_id: 'tc-1', name: 'bb_get', arguments: { key: 'state.rounds' } }], reasoning: '先查看当前回合数再决策' } },
  { text: '我环顾四周，决定向北探索废墟。' },
  { text: '裁决：{"grade":"成功","rationale":"骰点支持，行动合理","updates":[{"key":"state.rounds","value":1,"reason":"第 1 轮结算"}]}' },
  { text: '继续向北，建立临时营地。' },
  { text: '裁决：{"grade":"成功","rationale":"营地建立，站稳脚跟","updates":[{"key":"state.rounds","value":2,"reason":"第 2 轮结算"}]}' },
];

/** 把 Bundle 写成目录形态（JSON 语法，YAML 1.2 ⊇ JSON）；identity_cards 键即文件名。 */
export function writeBundleDir(dir: string, bundle: ScenarioBundle): void {
  mkdirSync(join(dir, BUNDLE_LAYOUT.identityCardsDir), { recursive: true });
  const w = (name: string, v: unknown) => writeFileSync(join(dir, name), JSON.stringify(v, null, 2), 'utf8');
  w(BUNDLE_LAYOUT.flow, bundle.flow);
  w(BUNDLE_LAYOUT.game, bundle.game);
  w(BUNDLE_LAYOUT.worldbook, bundle.worldbook);
  w(BUNDLE_LAYOUT.seeds, bundle.seeds);
  for (const [file, card] of Object.entries(bundle.identity_cards)) {
    writeFileSync(join(dir, BUNDLE_LAYOUT.identityCardsDir, file), JSON.stringify(card, null, 2), 'utf8');
  }
}

// ===== Script / inbox 助手 =====

/** 读取 run 目录的 Script（逐行 JSON.parse；含尾部半行容忍）。 */
export function readScript(runDir: string): Event[] {
  let text: string;
  try {
    text = readFileSync(join(runDir, 'script.jsonl'), 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Event);
}

/** 轮询等待条件成立（e2e 时序同步原语）。 */
export async function waitFor(cond: () => boolean, what: string, timeoutMs = 15_000, intervalMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (cond()) return;
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** 构造 whisper 导演指令（steering 档）。 */
export function makeWhisper(text: string): DirectorDirective {
  return { kind: 'whisper', text, targets: ['protagonist'], mode: 'steering' };
}

/** 向 director_inbox.jsonl 追加一条导演指令（F1 通道）。 */
export function writeDirective(runDir: string, d: DirectorDirective): void {
  appendFileSync(join(runDir, 'director_inbox.jsonl'), JSON.stringify(d) + '\n', 'utf8');
}

/**
 * 导演门自动投喂：泵登记等待（isWaiting）后才写 inbox——等待注册在 awaitDirective 内同步完成，
 * isWaiting()===true 即已可解析，无「指令先于等待到达被拒」竞态。
 * 解析确认走 gate_input_received 计数（不能等 isWaiting 翻 false：mock LLM 下两门间隙 < 轮询间隔，
 * 「false 窗口」会被跳过而误判超时）。依次投喂 texts 各一条。
 */
export async function autoDirect(pump: DirectorPumpControl, runDir: string, texts: readonly string[]): Promise<void> {
  for (const [i, text] of texts.entries()) {
    await waitFor(() => pump.isWaiting(), `门进入等待（第 ${i + 1} 条）`);
    writeDirective(runDir, makeWhisper(text));
    await waitFor(
      () => readScript(runDir).filter((e) => e.type === 'gate_input_received').length > i,
      `门指令被解析（第 ${i + 1} 条）`,
    );
  }
}
