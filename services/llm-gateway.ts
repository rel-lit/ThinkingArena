// Version: 1.0.0
/**
 * LLM 网关（§4.4）：薄路由（D13）+ 指数退避 + 熔断计数 + TRUNCATED 整批重发（D6）。
 *
 * 实现要点：
 * - route() 只查价格表（不发起网络调用）；fallback() 只产决策（同能力级链，跳过熔断中候选），
 *   链式降级由 Agent 服务主动触发（D13 薄路由纪律：网关不自动链式）。
 * - call() 内部：熔断检查 → 执行器调用（异常归一 PROVIDER_ERROR，D5 边界捕获）→ usage 五字段校验
 *   （归一化在适配层完成，网关把关，deep-dive 问题 1/5）→ 可重试类型按 LLM_GATEWAY_RETRYABLE
 *   指数退避（有界）→ TRUNCATED 自动整批重发一次（D6，仍截断则编码返回）。
 * - 熔断计数：可重试三型最终失败累计达阈值开路（CIRCUIT_THRESHOLD），冷却期（CIRCUIT_COOLDOWN_MS）
 *   内拒绝调用返回 CIRCUIT_OPEN；成功清零。进程内作用域（D23）。
 * - 价格表（deps.priceTable 的约定结构）：模型名 → { provider, tier?, fallback?, price }；
 *   price 为五字段费率（每 1M tokens 单价 + currency）或定价函数（豆包分段/DeepSeek 峰谷扩展点，
 *   deep-dive 问题 1 的 price(model)→(usage)→money）。增量面 priceOf() 是 cost 事件金额的计算轨来源（D16）。
 *
 * 实现级裁决：
 * - route() 找不到模型返回 NO_FALLBACK_AVAILABLE——枚举缺 UNKNOWN_MODEL（契约缺口，见汇报）。
 * - 退避等待可被 AbortSignal 提前唤醒；中止时立即停止重试返回当前失败（网关枚举无 ABORTED，
 *   abort 语义由 Agent 服务映射为 TURN_ABORTED）。
 */
import { LLM_GATEWAY_RETRYABLE, type LLMGatewayErrorKind, type Result } from '../schema/errors.ts';
import { NormalizedUsageSchema, type CostAmount, type NormalizedUsage } from '../schema/event.ts';
import type {
  LLMGateway,
  LLMRequest,
  LLMResponse,
  LlmExecutor,
  RouteDecision,
} from './types.ts';

/** 静态费率：五字段口径每 1M tokens 单价（缺省 0）+ 币种。 */
export interface PriceRates {
  currency: string;
  input?: number;
  output?: number;
  cached_read?: number;
  cached_write?: number;
  reasoning?: number;
}
/** 定价函数扩展点（分段/峰谷，deep-dive-llm-gateway 问题 1）。 */
export type PriceFn = (usage: NormalizedUsage) => { amount: number; currency: string };
/** 价格表条目（priceTable 的约定结构）。 */
export interface PriceTableEntry {
  provider: string;
  tier?: string;
  fallback?: readonly string[];
  price: PriceRates | PriceFn;
}

/** LLM 网关具体实现的增量面（成本计算轨）。 */
export interface LLMGatewayPricing extends LLMGateway {
  /** 按价格表计算单次调用成本（D16 计算轨）；模型不在表中返回 null。 */
  priceOf(model: string, usage: NormalizedUsage): CostAmount | null;
}

const MAX_ATTEMPTS = 3; // 可重试错误的总尝试上限（含首次；D13 有界）
const BACKOFF_BASE_MS = 100; // 退避基数 100ms × 2^n
const CIRCUIT_THRESHOLD = 3; // 连续最终失败开路阈值（D13 熔断计数）
const CIRCUIT_COOLDOWN_MS = 60_000; // 熔断冷却（进程内，D23）

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}export function createLLMGateway(deps: {
  priceTable: Record<string, unknown>;
  executor: LlmExecutor;
}): LLMGatewayPricing {
  /** 熔断表：模型 → 连续最终失败计数与开路截止时刻。 */
  const circuits = new Map<string, { failures: number; openUntil: number }>();

  function readEntry(model: string): PriceTableEntry | null {
    const raw = deps.priceTable[model];
    if (raw === null || typeof raw !== 'object') return null;
    const e = raw as PriceTableEntry;
    if (typeof e.provider !== 'string' || e.provider.length === 0) return null;
    if (typeof e.price === 'function') return e;
    const p = e.price as PriceRates;
    if (p === null || typeof p !== 'object' || typeof p.currency !== 'string' || p.currency.length === 0) return null;
    return e;
  }

  function circuitOpen(model: string): boolean {
    const c = circuits.get(model);
    return c !== undefined && c.openUntil > Date.now();
  }

  /** 单次执行器调用 + 响应把关（usage 五字段校验；异常归一 PROVIDER_ERROR）。 */
  async function once(
    decision: RouteDecision,
    req: LLMRequest,
    signal: AbortSignal,
  ): Promise<Result<LLMResponse, LLMGatewayErrorKind>> {
    let r: Result<LLMResponse, LLMGatewayErrorKind>;
    try {
      r = await deps.executor(decision, req, signal);
    } catch {
      return { ok: false, error: 'PROVIDER_ERROR' };
    }
    if (!r.ok) return r;
    if (!NormalizedUsageSchema.safeParse(r.value.usage).success) return { ok: false, error: 'PROVIDER_ERROR' }; // 格式异常
    return r;
  }

  /** TRUNCATED 整批重发一次（D6）+ 可重试三型指数退避（LLM_GATEWAY_RETRYABLE 判定表）。 */
  async function attempt(
    decision: RouteDecision,
    req: LLMRequest,
    signal: AbortSignal,
  ): Promise<Result<LLMResponse, LLMGatewayErrorKind>> {
    let r = await once(decision, req, signal);
    if (!r.ok && r.error === 'TRUNCATED' && !signal.aborted) r = await once(decision, req, signal); // D6 整批重发仅一次
    for (let i = 1; !r.ok && LLM_GATEWAY_RETRYABLE[r.error] && i < MAX_ATTEMPTS && !signal.aborted; i += 1) {
      await sleep(BACKOFF_BASE_MS * 2 ** (i - 1), signal);
      if (signal.aborted) break;
      r = await once(decision, req, signal);
      if (!r.ok && r.error === 'TRUNCATED' && !signal.aborted) r = await once(decision, req, signal);
    }
    return r;
  }

  function route(model: string): Result<RouteDecision, LLMGatewayErrorKind> {
    const e = readEntry(model);
    if (e === null) return { ok: false, error: 'NO_FALLBACK_AVAILABLE' }; // 路由不可能（缺 UNKNOWN_MODEL 枚举）
    return { ok: true, value: { model, provider: e.provider, fallbackChain: e.fallback ?? [], tier: e.tier } };
  }

  async function call(
    decision: RouteDecision,
    req: LLMRequest,
    signal: AbortSignal,
  ): Promise<Result<LLMResponse, LLMGatewayErrorKind>> {
    if (circuitOpen(decision.model)) return { ok: false, error: 'CIRCUIT_OPEN' };
    const r = await attempt(decision, req, signal);
    if (r.ok) {
      circuits.delete(decision.model); // 成功清零
    } else if (r.error === 'TIMEOUT' || r.error === 'RATE_LIMITED' || r.error === 'PROVIDER_ERROR') {
      // 仅可重试三型计熔断（AUTH/QUOTA/TRUNCATED 等不计）
      const c = circuits.get(decision.model) ?? { failures: 0, openUntil: 0 };
      c.failures += 1;
      if (c.failures >= CIRCUIT_THRESHOLD) c.openUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
      circuits.set(decision.model, c);
    }
    return r;
  }

  function fallback(failed: RouteDecision, kind: LLMGatewayErrorKind): Result<RouteDecision, LLMGatewayErrorKind> {
    void kind; // 链选择只由声明链 + 熔断状态决定（D13；kind 留作归因/未来策略钩子）
    for (let i = 0; i < failed.fallbackChain.length; i += 1) {
      const name = failed.fallbackChain[i];
      const e = readEntry(name);
      if (e === null) continue;
      if (failed.tier !== undefined && e.tier !== undefined && failed.tier !== e.tier) continue; // 只同能力级降级
      if (circuitOpen(name)) continue; // 熔断中的候选跳过
      return {
        ok: true,
        value: { model: name, provider: e.provider, tier: e.tier ?? failed.tier, fallbackChain: failed.fallbackChain.slice(i + 1) },
      };
    }
    return { ok: false, error: 'NO_FALLBACK_AVAILABLE' };
  }

  function priceOf(model: string, usage: NormalizedUsage): CostAmount | null {
    const e = readEntry(model);
    if (e === null) return null;
    if (typeof e.price === 'function') return e.price(usage);
    const p = e.price;
    const amount =
      (usage.input * (p.input ?? 0) +
        usage.output * (p.output ?? 0) +
        usage.cached_read * (p.cached_read ?? 0) +
        usage.cached_write * (p.cached_write ?? 0) +
        usage.reasoning * (p.reasoning ?? 0)) /
      1e6;
    return { amount, currency: p.currency };
  }

  return { route, call, fallback, priceOf };
}
