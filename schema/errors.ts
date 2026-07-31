// Version: 1.0.0
/**
 * 全局错误码枚举契约（runtime-architecture.md §4 六组枚举 + §4.7 组件枚举的落地）。
 *
 * 纪律（D5）：跨模块错误以 Result<T, 错误枚举> 编码进返回值，禁止裸 Error 跨模块传播；
 * 错误类型全部枚举化，事件流中的错误事件只记枚举与元数据（F7 凭证消毒纪律）。
 *
 * 本文件只定义枚举常量、Zod Schema 与类型，不实现任何错误处理逻辑。
 */
import { z } from 'zod';

// ===== AgentService（§4.1 状态机 §3.1）=====

/** Agent 服务错误枚举值集合（§4 AgentServiceErrorKind）。 */
export const AGENT_SERVICE_ERROR_KINDS = [
  'AGENT_NOT_FOUND',      // 目标实例不存在
  'AGENT_ALREADY_EXISTS', // create 冲突
  'AGENT_BUSY',           // RUNNING 中再次 runTurn（pi 状态保护，§3.1 A4）
  'AGENT_DESTROYED',      // 操作已销毁实例
  'TURN_FAILED',          // 回合内不可恢复失败（LLM 最终失败等，§3.1 A8）
  'TURN_ABORTED',         // 回合被 abort/cancel 中断
] as const;

export const AgentServiceErrorKindSchema = z
  .enum(AGENT_SERVICE_ERROR_KINDS)
  .describe('Agent 服务错误枚举（§4.1；D5 错误编码进结果，AGENT_BUSY 只代表编排配置错误）');
export type AgentServiceErrorKind = z.infer<typeof AgentServiceErrorKindSchema>;

// ===== Blackboard（§4.2，D1 写穿 / D26 命名空间写者声明）=====

export const BLACKBOARD_ERROR_KINDS = [
  'PERSIST_FAILED',       // 写穿落盘失败（set 不生效，致命，D1）
  'NAMESPACE_FORBIDDEN',  // 越权写保留命名空间（D26）
] as const;

export const BlackboardErrorKindSchema = z
  .enum(BLACKBOARD_ERROR_KINDS)
  .describe('黑板错误枚举（§4.2；PERSIST_FAILED 致命终止局，NAMESPACE_FORBIDDEN 为 D26 越权写）');
export type BlackboardErrorKind = z.infer<typeof BlackboardErrorKindSchema>;

// ===== EventLog（§4.3，D11/D12/D32）=====

export const EVENT_LOG_ERROR_KINDS = [
  'EVENT_SCHEMA_INVALID', // 事件未过契约校验，拒写（F12 校验前置）
  'APPEND_FAILED',        // IO 追加失败（致命，F5）
  'REPLAY_CORRUPT',       // 重放中遇到无法修复的损坏（§2.3）
  'BRANCH_NOT_FOUND',     // 分叉锚点不存在（§2.4-3）
  'SNAPSHOT_CORRUPT',     // 快照条目校验失败（D11）
] as const;

export const EventLogErrorKindSchema = z
  .enum(EVENT_LOG_ERROR_KINDS)
  .describe('事件流错误枚举（§4.3；APPEND_FAILED 为致命错误——不能继续产生不落盘的事实）');
export type EventLogErrorKind = z.infer<typeof EventLogErrorKindSchema>;

// ===== LLMGateway（§4.4，D6/D13）=====

export const LLM_GATEWAY_ERROR_KINDS = [
  'TIMEOUT',              // 请求超时（可重试，D13）
  'RATE_LIMITED',         // 限流（可重试，指数退避）
  'PROVIDER_ERROR',       // 服务商 5xx/格式异常（可重试）
  'TRUNCATED',            // stop_reason=="length"，整批拒执行并重发（D6）
  'SCHEMA_MISMATCH',      // 结构化输出不符合判定 schema（D17 重试路径）
  'AUTH_FAILED',          // 凭证失效（不重试，直接 fallback）
  'QUOTA_EXCEEDED',       // 额度耗尽（不重试，直接 fallback）
  'CIRCUIT_OPEN',         // 熔断中，拒绝本次调用（D13）
  'NO_FALLBACK_AVAILABLE',// 同能力级 fallback 链耗尽（D13）
] as const;

export const LLMGatewayErrorKindSchema = z
  .enum(LLM_GATEWAY_ERROR_KINDS)
  .describe('LLM 网关错误枚举（§4.4；D13 可重试类型判定见 LLM_GATEWAY_RETRYABLE）');
export type LLMGatewayErrorKind = z.infer<typeof LLMGatewayErrorKindSchema>;

/**
 * D13 可重试类型判定表（契约元数据，非逻辑）：
 * true = 指数退避重试（有界）；false = 不重试（直接 fallback / 错误编码进结果）。
 * TRUNCATED 为 false：整批拒执行由网关自动重发（D6），不走调用方重试。
 */
export const LLM_GATEWAY_RETRYABLE: Readonly<Record<LLMGatewayErrorKind, boolean>> = {
  TIMEOUT: true,
  RATE_LIMITED: true,
  PROVIDER_ERROR: true,
  TRUNCATED: false,
  SCHEMA_MISMATCH: false,
  AUTH_FAILED: false,
  QUOTA_EXCEEDED: false,
  CIRCUIT_OPEN: false,
  NO_FALLBACK_AVAILABLE: false,
};

// ===== FlowRunner（§4.5，状态机 §3.3）=====

export const FLOW_RUNNER_ERROR_KINDS = [
  'BUNDLE_INVALID',    // Bundle/图/绑定校验失败（局不开始，D20）
  'NODE_FAILED',       // onError=stop 的节点失败（R5）
  'JOIN_TIMEOUT',      // join 等待超时（死锁防护，D8）
  'EVENTLOG_FATAL',    // 事件流 append 失败（R5/R6）
  'RUN_CANCELLED',     // 已被取消后再操作（R8/R9/R10）
  'RUN_STATE_CORRUPT', // 恢复时状态重建失败（§2.3）
] as const;

export const FlowRunnerErrorKindSchema = z
  .enum(FLOW_RUNNER_ERROR_KINDS)
  .describe('DAG 执行器错误枚举（§4.5；BUNDLE_INVALID 在加载期拦截，局不开始）');
export type FlowRunnerErrorKind = z.infer<typeof FlowRunnerErrorKindSchema>;

// ===== MemoryService（§4.6，D22 独立持久化）=====

export const MEMORY_ERROR_KINDS = [
  'MEMORY_NOT_FOUND',   // 挂载目标不存在
  'PERSIST_FAILED',     // 落盘失败（局末重试有界 → 告警，错误矩阵）
  'CHECKPOINT_CORRUPT', // 压缩检查点损坏（回退上一代，D29）
] as const;

export const MemoryErrorKindSchema = z
  .enum(MEMORY_ERROR_KINDS)
  .describe('记忆服务错误枚举（§4.6；记忆在事件流之外独立持久化，D22）');
export type MemoryErrorKind = z.infer<typeof MemoryErrorKindSchema>;

// ===== Component（§4.7）=====

export const COMPONENT_ERROR_KINDS = [
  'PARAM_SCHEMA_INVALID', // 节点参数校验失败（加载期拦截，D20）
  'COMPONENT_FAILED',     // 组件内部失败（错误编码进结果，走节点 onError）
  'ABORTED',              // 收到取消（AbortSignal 取消链，§4.7）
] as const;

export const ComponentErrorKindSchema = z
  .enum(COMPONENT_ERROR_KINDS)
  .describe('组件错误枚举（§4.7；组件失败按节点 onError 策略 stop/retry/continue，F3）');
export type ComponentErrorKind = z.infer<typeof ComponentErrorKindSchema>;

// ===== 汇总 =====

/** 全部错误枚举的并集：事件流错误事件（run_error/node_failed/agent_error 等）的 error 字段取值域。 */
// 注：PERSIST_FAILED 在 §4.2（黑板）与 §4.6（记忆）两组同名出现（架构文档原文如此），
// 并集自然去重为 33 个唯一值；事件经 type/exec 即可归因到模块，无需改名。
export const ErrorCodeSchema = z
  .enum([
    ...AGENT_SERVICE_ERROR_KINDS,
    ...BLACKBOARD_ERROR_KINDS,
    ...EVENT_LOG_ERROR_KINDS,
    ...LLM_GATEWAY_ERROR_KINDS,
    ...FLOW_RUNNER_ERROR_KINDS,
    ...MEMORY_ERROR_KINDS,
    ...COMPONENT_ERROR_KINDS,
  ])
  .describe('全局错误码（§4 七组枚举的并集；事件只记枚举与元数据，原始响应体不进 Script，F7）');
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/** 通用返回形态（§4 统一纪律 D5）：跨模块错误编码进返回值。 */
export type Result<T, E extends string = ErrorCode> =
  | { ok: true; value: T }
  | { ok: false; error: E };
