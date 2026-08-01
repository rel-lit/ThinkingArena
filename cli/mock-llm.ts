// Version: 1.0.0
/**
 * mock LLM 执行器（LlmExecutor 缝的测试/mock 实现；真实 AI SDK 适配器走同一缝）。
 * 脚本形态：JSON 数组（或 {responses:[...]}），按 LLM 调用序 FIFO 消费；条目
 * { text?, object?, usage? }——object 存在即走结构化通道（tool_calls/final 由 Agent 服务判定），
 * 缺省 usage 给固定值（保证 cost 事件非零，D16/接入验收「cost 非零」的 mock 侧保证）。
 */
import { readFileSync } from 'node:fs';
import type { NormalizedUsage } from '../schema/event.ts';
import type { LLMResponse, LlmExecutor } from '../services/types.ts';

/** mock 脚本单条响应。 */
export interface MockLLMResponse {
  /** 纯文本回应（final 文本）。 */
  text?: string;
  /** 结构化回应（Agent 服务 JSON 约定：tool_calls 数组 → 工具循环；其余 → final 文本化）。 */
  object?: unknown;
  /** 归一化 usage（缺省取 DEFAULT_MOCK_USAGE）。 */
  usage?: NormalizedUsage;
}

/** 缺省 usage：非零，保证每次调用产生正成本（D16 双轨的计算轨输入）。 */
export const DEFAULT_MOCK_USAGE: NormalizedUsage = { input: 120, output: 60, cached_read: 0, cached_write: 0, reasoning: 0 };

/** 脚本耗尽后的兜底回应（保持局可推进；内容显眼便于排查脚本长度错误）。 */
const FALLBACK_TEXT = '【mock】脚本已耗尽的默认回应：继续。';

/**
 * 创建脚本化 mock 执行器：每次调用消费一条脚本；signal 语义 mock 不模拟中断
 * （abort 路径由 Agent 服务在调用前后检查，真实适配器才需要响应 signal）。
 */
export function createMockExecutor(script: readonly MockLLMResponse[]): LlmExecutor {
  const queue = [...script];
  return async (decision) => {
    const next = queue.shift();
    const resp: LLMResponse = {
      text: next?.text ?? (next?.object === undefined ? FALLBACK_TEXT : ''),
      ...(next?.object !== undefined ? { object: next.object } : {}),
      usage: next?.usage ?? DEFAULT_MOCK_USAGE,
      model: decision.model, // 实际出账模型归因（fallback 链可溯，D16）
    };
    return { ok: true, value: resp };
  };
}

/** 加载 mock 脚本文件（JSON 数组或 {responses:[...]}）。 */
export function loadMockScript(filePath: string): MockLLMResponse[] {
  const raw: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
  const list = Array.isArray(raw) ? raw : (raw as { responses?: unknown }).responses;
  if (!Array.isArray(list)) throw new Error(`mock LLM 脚本形态非法（须为数组或 {responses:[...]}）: ${filePath}`);
  return list as MockLLMResponse[];
}
