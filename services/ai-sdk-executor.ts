// Version: 1.0.0
/**
 * 真 LLM 适配器（LlmExecutor 缝的 Vercel AI SDK 实现；cli/run 的 --mock-llm 之外的另一轨）。
 *
 * 实现要点：
 * - 模型解析按 RouteDecision.provider 分流（D13 薄路由：provider 由价格表给出，此处只做实例化）：
 *   deepseek → @ai-sdk/deepseek（读 DEEPSEEK_API_KEY）；moonshotai → @ai-sdk/moonshotai（读 MOONSHOT_API_KEY）。
 *   provider 实例懒加载并缓存——模块 import 不要求 key 在场，缺 key 在首次调用时才报 AUTH_FAILED。
 * - 纯文本走 generateText；req.jsonSchema 存在时走 generateText + Output.object({ schema })（AI SDK v6+
 *   官方路径，deep-dive-llm-gateway 问题 5）。DeepSeek 无 json_schema，SDK 自动降级 json_object +
 *   prompt 引导（见 @ai-sdk/deepseek responseFormat 分支），业务层 Zod 二次校验语义不变（D6/D17）。
 * - maxRetries: 0——重试是网关职责（D13 指数退避 + 熔断），适配层不重复重试。
 * - usage 归一化五字段（deep-dive 问题 1 裁决口径：cached_read 单列、未命中输入单列）：
 *   标准字段优先（v7 供应商包已把各家原始 usage 转进 inputTokenDetails），
 *   DeepSeek 缓存命中兜底取 providerMetadata.deepseek.promptCacheHitTokens（deep-dive 问题 5）。
 * - 原始 usage（usage.raw）落 LLMResponse.rawUsage（D16 双轨之二）；F7 消毒纪律：原始响应体不进
 *   任何返回值，错误只映射枚举，不携带 responseBody/请求内容。
 * - finishReason === 'length' → TRUNCATED（D6：网关整批重发一次，仍截断则编码返回）。
 * - 异常映射（mapSdkError）：超时/中止 → TIMEOUT；APICallError 按 statusCode 分流
 *   （401/403 → AUTH_FAILED，402 → QUOTA_EXCEEDED，429 → RATE_LIMITED，其余 → PROVIDER_ERROR）；
 *   NoObjectGeneratedError → SCHEMA_MISMATCH（D17 重试路径）；其余 → PROVIDER_ERROR。
 */
import { generateText, jsonSchema, Output, APICallError, NoObjectGeneratedError } from 'ai';
import type { LanguageModel } from 'ai';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createMoonshotAI } from '@ai-sdk/moonshotai';
import type { NormalizedUsage } from '../schema/event.ts';
import type { LLMGatewayErrorKind, Result } from '../schema/errors.ts';
import type {
  LLMRequest,
  LLMResponse,
  LlmExecutor,
  RouteDecision,
} from './types.ts';

// ===== 纯函数：usage 归一化与错误映射（单测面，不碰网络）=====

/** 非负整数兜底读取（非法/缺失一律 0，归一化语义写死在网关适配层）。 */
function intOr0(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0;
}

/** 对象字段安全读取。 */
function field(obj: unknown, key: string): unknown {
  return obj !== null && typeof obj === 'object' ? (obj as Record<string, unknown>)[key] : undefined;
}

/**
 * AI SDK 标准 usage + providerMetadata → 五字段归一 usage（deep-dive-llm-gateway 问题 1/5）。
 * - input 取 noCacheTokens（未命中输入）；缺失时以 inputTokens − cached_read 兜底，再缺失为 0。
 * - cached_read 取 cacheReadTokens；缺失时兜底 providerMetadata.deepseek.promptCacheHitTokens。
 * - cached_write 取 cacheWriteTokens（DeepSeek/Kimi 无写费字段 → 0）；reasoning 取 reasoningTokens。
 */
export function normalizeUsage(usage: unknown, providerMetadata?: unknown): NormalizedUsage {
  const details = field(usage, 'inputTokenDetails');
  const outDetails = field(usage, 'outputTokenDetails');
  const dsMeta = field(providerMetadata, 'deepseek');
  const cachedRead = intOr0(field(details, 'cacheReadTokens')) || intOr0(field(dsMeta, 'promptCacheHitTokens'));
  const total = intOr0(field(usage, 'inputTokens'));
  const noCache = intOr0(field(details, 'noCacheTokens'));
  return {
    input: noCache > 0 || total === 0 ? noCache : total - cachedRead,
    output: intOr0(field(usage, 'outputTokens')),
    cached_read: cachedRead,
    cached_write: intOr0(field(details, 'cacheWriteTokens')),
    reasoning: intOr0(field(outDetails, 'reasoningTokens')),
  };
}

/**
 * 异常 → LLMGatewayErrorKind（D13 可重试判定表配合网关退避；F7：不携带原始响应体）。
 * 依据错误 name/statusCode 的结构化特征判定，不解析服务商错误文案。
 */
export function mapSdkError(error: unknown): LLMGatewayErrorKind {
  const name = field(error, 'name');
  if (name === 'TimeoutError' || name === 'AbortError' || name === 'ResponseAborted') return 'TIMEOUT';
  if (name === 'AI_LoadAPIKeyError') return 'AUTH_FAILED'; // 环境变量缺 key（调用期才加载凭证）
  if (APICallError.isInstance(error)) {
    const status = error.statusCode;
    if (status === 401 || status === 403) return 'AUTH_FAILED';
    if (status === 402) return 'QUOTA_EXCEEDED';
    if (status === 429) return 'RATE_LIMITED';
    return 'PROVIDER_ERROR'; // 5xx、无状态码的网络层失败、4xx 其余（格式异常归一类）
  }
  if (NoObjectGeneratedError.isInstance(error)) return 'SCHEMA_MISMATCH'; // D17 重试路径
  return 'PROVIDER_ERROR';
}

// ===== 执行器工厂 =====

/** provider 标识 → 模型实例构造器（懒加载缓存；价格表 RouteDecision.provider 的取值口径）。 */
type ProviderFactory = (modelId: string) => LanguageModel;

export interface AiSdkExecutorOptions {
  /**
   * 覆盖 provider 分流表（扩展服务商/测试注入用）。
   * 缺省：{ deepseek: @ai-sdk/deepseek, moonshotai: @ai-sdk/moonshotai }，key 走各自环境变量。
   */
  providers?: Record<string, ProviderFactory>;
}

/** 创建真 LLM 执行器（LlmExecutor 缝的 AI SDK 实现）。 */
export function createAiSdkExecutor(options: AiSdkExecutorOptions = {}): LlmExecutor {
  // provider 工厂懒加载：首次用到才 create（此时才要求环境变量在场），实例按 provider 缓存。
  const factories = new Map<string, ProviderFactory>();
  const builtin: Record<string, () => ProviderFactory> = {
    deepseek: () => {
      // 读 DEEPSEEK_API_KEY；可选 DEEPSEEK_BASE_URL 覆盖端点（代理/专线场景）
      const baseURL = process.env.DEEPSEEK_BASE_URL;
      const p = baseURL !== undefined && baseURL !== '' ? createDeepSeek({ baseURL }) : createDeepSeek();
      return (id) => p(id);
    },
    moonshotai: () => {
      // 读 MOONSHOT_API_KEY；可选 MOONSHOT_BASE_URL 覆盖端点。
      // 注意：platform.moonshot.cn（国内）与 api.moonshot.ai（国际）是两套账号体系，key 不通用——
      // 国内控制台申请的 key 必须设 MOONSHOT_BASE_URL=https://api.moonshot.cn/v1，否则 401。
      const baseURL = process.env.MOONSHOT_BASE_URL;
      const p = baseURL !== undefined && baseURL !== '' ? createMoonshotAI({ baseURL }) : createMoonshotAI();
      return (id) => p(id);
    },
  };
  for (const [k, v] of Object.entries(options.providers ?? {})) factories.set(k, v);

  function resolveModel(decision: RouteDecision): LanguageModel | null {
    const custom = factories.get(decision.provider);
    if (custom !== undefined) return custom(decision.model);
    const lazy = builtin[decision.provider];
    if (lazy === undefined) return null; // 未知服务商（价格表配置与适配层不同步）
    const factory = lazy();
    factories.set(decision.provider, factory);
    return factory(decision.model);
  }

  return async (decision, req, signal) => {
    let model: LanguageModel | null;
    try {
      model = resolveModel(decision);
    } catch {
      return { ok: false, error: 'AUTH_FAILED' }; // 实例化期失败即凭证缺失（LoadAPIKeyError）
    }
    if (model === null) return { ok: false, error: 'PROVIDER_ERROR' };

    try {
      const result = await generateText({
        model,
        ...(req.system !== undefined ? { system: req.system } : {}),
        prompt: req.prompt,
        ...(req.maxTokens !== undefined ? { maxOutputTokens: req.maxTokens } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        abortSignal: signal,
        maxRetries: 0, // 重试归网关（D13），适配层不重复
        ...(req.jsonSchema !== undefined
          ? { output: Output.object({ schema: jsonSchema(req.jsonSchema as never) }) }
          : {}),
      });

      if (result.finishReason === 'length') return { ok: false, error: 'TRUNCATED' }; // D6 整批重发

      const resp: LLMResponse = {
        text: result.text,
        ...(req.jsonSchema !== undefined ? { object: result.output } : {}),
        usage: normalizeUsage(result.usage, result.providerMetadata),
        ...(result.usage.raw !== undefined ? { rawUsage: result.usage.raw } : {}), // D16 双轨之二
        model: result.response.modelId, // 实际出账模型回填
      };
      return { ok: true, value: resp };
    } catch (e) {
      return { ok: false, error: mapSdkError(e) };
    }
  };
}
