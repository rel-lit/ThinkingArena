// Version: 1.0.0
/**
 * 接入验收冒烟工具（roadmap Phase 1 出口检查；deep-dive-llm-gateway 问题 2/5 的冒烟清单落地）。
 *
 * 对每个持有 API key 的服务商跑四项验收（全真网络调用，不经 mock）：
 *   ① cost 非零          —— 真实调用 → 归一化 usage → priceOf 计算值 > 0（D16 双轨的计算轨）
 *   ② cached_tokens 返回  —— 同一长 prompt 连发两次，第二次 cached_read > 0（服务商原生前缀缓存）
 *   ③ 结构化往返          —— jsonSchema 路径（json_schema 原生 / DeepSeek 降级 json_object）返回合 schema 对象
 *   ④ json_object 正常    —— 最小 schema 的 JSON 模式可用（deep-dive 未决问题 1：DeepSeek json_object 怪癖实测）
 *
 * 用法：
 *   node cli/dev-smoke.ts                      # 跑全部有 key 的服务商
 *   node cli/dev-smoke.ts --provider deepseek  # 单跑 DeepSeek
 *   node cli/dev-smoke.ts --provider kimi      # kimi 是 moonshotai 的别名
 *   node cli/dev-smoke.ts --provider deepseek --model deepseek-v4-flash
 *
 * 环境变量（凭证只读环境变量，缺 key 的服务商跳过并标注 SKIP）：
 *   DEEPSEEK_API_KEY / DEEPSEEK_MODEL（可选覆盖默认模型）
 *   MOONSHOT_API_KEY / MOONSHOT_MODEL（可选覆盖默认模型）
 *
 * 退出码：有任一 FAIL → 1；全部 PASS 或 SKIP → 0。
 * 纪律：不打印密钥、不打印原始响应体（F7）；usage 摘要只含 token 计数（D16 双轨允许的算账轨数据）。
 */
import { createLLMGateway, type LLMGatewayPricing, type PriceRates } from '../services/llm-gateway.ts';
import { createAiSdkExecutor } from '../services/ai-sdk-executor.ts';
import { loadDotEnv } from './env.ts';
import type { NormalizedUsage } from '../schema/event.ts';
import type { LLMGatewayErrorKind, Result } from '../schema/errors.ts';
import type { LLMResponse, RouteDecision } from '../services/types.ts';

// ===== 服务商名册（冒烟用占位价格：只需正费率验证 cost 非零，非正式价格表）=====

interface SmokeProvider {
  /** RouteDecision.provider / 价格表 provider 字段（ai-sdk-executor 的分流键）。 */
  provider: string;
  /** API key 环境变量名。 */
  envKey: string;
  /** 默认模型（可被 --model 或 *_MODEL 环境变量覆盖）。 */
  defaultModel: string;
  /** 模型覆盖环境变量名。 */
  modelEnvKey: string;
  /** 冒烟占位费率（每 1M tokens；仅验证 cost>0，金额不代表真实账单）。 */
  price: PriceRates;
}

const PROVIDERS: Record<string, SmokeProvider> = {
  deepseek: {
    provider: 'deepseek',
    envKey: 'DEEPSEEK_API_KEY',
    defaultModel: 'deepseek-chat',
    modelEnvKey: 'DEEPSEEK_MODEL',
    price: { currency: 'CNY', input: 1, output: 2, cached_read: 0.02 },
  },
  moonshotai: {
    provider: 'moonshotai',
    envKey: 'MOONSHOT_API_KEY',
    defaultModel: 'kimi-k2-0711-preview',
    modelEnvKey: 'MOONSHOT_MODEL',
    price: { currency: 'CNY', input: 4, output: 16, cached_read: 0.7 },
  },
};
const PROVIDER_ALIASES: Record<string, string> = { kimi: 'moonshotai', moonshot: 'moonshotai' };

const CALL_TIMEOUT_MS = 120_000; // 单次调用超时（思考模型首轮可能较慢）

// ===== 检查框架 =====

interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

function usageSummary(u: NormalizedUsage, raw: unknown): string {
  return `usage={input:${u.input} output:${u.output} cached_read:${u.cached_read} cached_write:${u.cached_write} reasoning:${u.reasoning}} raw=${JSON.stringify(raw ?? null)}`;
}

/** 单次调用（统一超时与失败摘要；错误只取枚举，不带响应体）。 */
async function callOnce(
  gateway: LLMGatewayPricing,
  decision: RouteDecision,
  req: Parameters<LLMGatewayPricing['call']>[1],
): Promise<Result<LLMResponse, LLMGatewayErrorKind>> {
  return gateway.call(decision, req, AbortSignal.timeout(CALL_TIMEOUT_MS));
}

/** ① cost 非零：真实调用 → priceOf 计算值必须 > 0（D16 计算轨）。 */
async function checkCost(gateway: LLMGatewayPricing, decision: RouteDecision): Promise<CheckResult> {
  const r = await callOnce(gateway, decision, { prompt: '用一句话介绍你自己。', maxTokens: 128 });
  if (!r.ok) return { name: 'cost 非零', pass: false, detail: `调用失败：${r.error}` };
  const cost = gateway.priceOf(r.value.model, r.value.usage);
  const pass = cost !== null && cost.amount > 0;
  return {
    name: 'cost 非零',
    pass,
    detail: `model=${r.value.model} cost=${cost === null ? 'null（模型不在价格表）' : `${cost.amount} ${cost.currency}`} ${usageSummary(r.value.usage, r.value.rawUsage)}`,
  };
}

/** ② cached_tokens：同一长 prompt 连发两次，第二次 cached_read > 0（原生前缀缓存命中）。 */
async function checkCache(gateway: LLMGatewayPricing, decision: RouteDecision): Promise<CheckResult> {
  // 长前缀（Kimi >256 tokens 才参与缓存；DeepSeek 按前缀单元匹配）：重复段落构造 >500 tokens
  const para = '推演世界设定：近未来东亚沿海城邦群，气候剧变后垂直农业塔林立，各城邦以数据配给制维系运转。';
  const longPrompt = `${para.repeat(30)}\n\n基于以上设定，给出一个人物名。`;
  const req = { prompt: longPrompt, maxTokens: 32 };
  const first = await callOnce(gateway, decision, req);
  if (!first.ok) return { name: 'cached_tokens', pass: false, detail: `第一次调用失败：${first.error}` };
  const second = await callOnce(gateway, decision, req);
  if (!second.ok) return { name: 'cached_tokens', pass: false, detail: `第二次调用失败：${second.error}` };
  const hit = second.value.usage.cached_read;
  return {
    name: 'cached_tokens',
    pass: hit > 0,
    detail: `第二次 cached_read=${hit} ${usageSummary(second.value.usage, second.value.rawUsage)}（命中具概率性，FAIL 可隔分钟重跑复核）`,
  };
}

/** 结构化输出判定：object 是非空对象且各断言成立。 */
function checkObject(obj: unknown, asserts: Record<string, (v: unknown) => boolean>): string | null {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return 'object 不是 JSON 对象';
  const rec = obj as Record<string, unknown>;
  for (const [k, pred] of Object.entries(asserts)) {
    if (!pred(rec[k])) return `字段 ${k} 不符合 schema 期望（值=${JSON.stringify(rec[k])?.slice(0, 80)}）`;
  }
  return null;
}

/** ③ 结构化往返：完整 schema（最严交集风格）→ 返回合 schema 对象。 */
async function checkStructured(gateway: LLMGatewayPricing, decision: RouteDecision): Promise<CheckResult> {
  const r = await callOnce(gateway, decision, {
    prompt: '判定如下情境的紧张程度并给出一句评语：探险队在垂直农业塔顶层发现异常的信号源。',
    jsonSchema: {
      type: 'object',
      properties: {
        verdict: { type: 'string', description: '一句评语' },
        score: { type: 'integer', description: '紧张程度 0-10' },
      },
      required: ['verdict', 'score'],
      additionalProperties: false,
    },
    maxTokens: 512,
  });
  if (!r.ok) return { name: '结构化往返', pass: false, detail: `调用失败：${r.error}` };
  const bad = checkObject(r.value.object, {
    verdict: (v) => typeof v === 'string' && v.length > 0,
    score: (v) => Number.isInteger(v),
  });
  return {
    name: '结构化往返',
    pass: bad === null,
    detail: bad === null ? `object 合规 ${usageSummary(r.value.usage, r.value.rawUsage)}` : `${bad}（DeepSeek 走 json_object 降级，需业务层 Zod 兜底）`,
  };
}

/** ④ json_object：最小 schema 验证 JSON 模式基本可用（DeepSeek 怪癖实测，deep-dive 未决问题 1）。 */
async function checkJsonObject(gateway: LLMGatewayPricing, decision: RouteDecision): Promise<CheckResult> {
  const r = await callOnce(gateway, decision, {
    prompt: '输出一个 JSON 对象，包含字段 note（任意一句短话）。只输出 JSON。',
    jsonSchema: {
      type: 'object',
      properties: { note: { type: 'string' } },
      required: ['note'],
      additionalProperties: false,
    },
    maxTokens: 256,
  });
  if (!r.ok) return { name: 'json_object', pass: false, detail: `调用失败：${r.error}` };
  const bad = checkObject(r.value.object, { note: (v) => typeof v === 'string' && v.length > 0 });
  return {
    name: 'json_object',
    pass: bad === null,
    detail: bad === null ? `JSON 模式可用 ${usageSummary(r.value.usage, r.value.rawUsage)}` : bad,
  };
}

// ===== 主流程 =====

interface CliArgs {
  provider?: string;
  model?: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--provider') args.provider = argv[++i];
    else if (argv[i] === '--model') args.model = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('用法：node cli/dev-smoke.ts [--provider deepseek|moonshotai|kimi] [--model <id>]');
      process.exit(0);
    }
  }
  return args;
}

async function smokeProvider(sp: SmokeProvider, model: string): Promise<boolean> {
  console.log(`\n== ${sp.provider} / ${model} ==`);
  const gateway = createLLMGateway({
    priceTable: { [model]: { provider: sp.provider, price: sp.price } },
    executor: createAiSdkExecutor(),
  });
  const routed = gateway.route(model);
  if (!routed.ok) {
    console.log(`FAIL [${sp.provider}] 路由失败：${routed.error}`);
    return false;
  }
  const decision = routed.value;
  const results: CheckResult[] = [];
  for (const check of [checkCost, checkCache, checkStructured, checkJsonObject]) {
    results.push(await check(gateway, decision));
  }
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'} [${sp.provider}] ${r.name} — ${r.detail}`);
  return results.every((r) => r.pass);
}

async function main(): Promise<void> {
  loadDotEnv(); // 先加载 .env（已有环境变量优先），再解析参数
  const args = parseArgs(process.argv.slice(2));
  let names = Object.keys(PROVIDERS);
  if (args.provider !== undefined) {
    const resolved = PROVIDER_ALIASES[args.provider] ?? args.provider;
    if (PROVIDERS[resolved] === undefined) {
      console.error(`未知服务商：${args.provider}（可选：${[...names, ...Object.keys(PROVIDER_ALIASES)].join(' / ')}）`);
      process.exit(1);
    }
    names = [resolved];
  }

  let allPass = true;
  let ran = 0;
  for (const name of names) {
    const sp = PROVIDERS[name];
    if (process.env[sp.envKey] === undefined || process.env[sp.envKey] === '') {
      console.log(`SKIP [${sp.provider}] 缺 ${sp.envKey}（设置后重跑即可纳入验收）`);
      continue;
    }
    const model = args.model ?? process.env[sp.modelEnvKey] ?? sp.defaultModel;
    ran += 1;
    if (!(await smokeProvider(sp, model))) allPass = false;
  }

  console.log('\n== 汇总 ==');
  if (ran === 0) console.log('没有任何服务商持 key，全部 SKIP（未执行真实调用）');
  else console.log(`${ran} 个服务商已验收：${allPass ? '全部 PASS' : '存在 FAIL'}`);
  process.exitCode = allPass ? 0 : 1;
}

await main();
