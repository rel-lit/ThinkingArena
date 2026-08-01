// Version: 1.0.0
/**
 * 服务层运行时接口类型（跨模块冻结，runtime-architecture.md §4 的落地）。
 *
 * 本文件是 3-A/3-B/3-C/3-D 四个实现 Agent 的共享契约：
 * - 只允许类型与工厂签名声明，不含实现；
 * - 任何 Agent 不得修改本文件——需要变更必须回报架构师裁决；
 * - 依赖方向：schema ← services ← meta ← components ← orchestrator ← cli，禁止反向 import。
 */
import type { Result } from '../schema/errors.js';
import type {
  AgentServiceErrorKind,
  BlackboardErrorKind,
  EventLogErrorKind,
  LLMGatewayErrorKind,
  MemoryErrorKind,
} from '../schema/errors.js';
import type {
  AgentId,
  BlackboardKey,
  BranchId,
  DirectorDirective,
  Event,
  EventDraft,
  EventId,
  NormalizedUsage,
  RunId,
} from '../schema/event.js';
import type { ModelBinding } from '../schema/bundle.js';
import type { IdentityCardV1 } from '../schema/identity-card.js';
import type { ToolCallRequest, TurnOutcome } from '../schema/meta-component.js';

// ===== EventLog（§4.3）=====

export interface EventLogReplayOptions {
  fromSnapshot?: EventId; // 定位最新快照；指定则从该快照起
  branch?: BranchId;      // 重放目标分支（缺省为当前活跃分支）
  until?: EventId;        // 重放到该事件为止（分叉点状态重建用）
}

export interface EventLog {
  /**
   * 追加一条事件草稿（无 id/parent_id）；契约校验前置（F12），非法拒写。
   * id/序号/parent_id 由 EventLog 分配（deep-dive 裁决：单调零填充序号，TCAS 批内提交时才取号）。
   * 返回盖章后的事件（调用方需要 id 做 parent 链接）。同步。
   */
  append(draft: EventDraft): Result<Event, EventLogErrorKind>;

  /** 只吐有序事件序列（首条可为快照检查点），reduce 归调用方。异步。 */
  replay(options?: EventLogReplayOptions): Promise<Result<AsyncIterable<Event>, EventLogErrorKind>>;

  /** 同版本内从任意事件分叉（后续 append 携带新 branch）。同步。 */
  branch(atEventId: EventId, newBranch: BranchId): Result<void, EventLogErrorKind>;

  /** 写内联快照条目（reduce 状态检查点，D11）。返回快照条目 id。同步。 */
  snapshot(state: unknown): Result<EventId, EventLogErrorKind>;
}

// ===== Blackboard（§4.2）=====

export interface Blackboard {
  /** 读。同步。键不存在返回 undefined，不是错误。 */
  get(key: BlackboardKey): unknown;

  /** 写穿：先作为事件落盘，后生效；落盘失败则写入不生效（D1）。同步。 */
  set(key: BlackboardKey, value: unknown): Result<void, BlackboardErrorKind>;

  /** 恢复路径：replay 重建专用——不写穿、不通知、不落盘（§4 恢复纪律）。同步。 */
  applyEvent(event: Event): void;

  /** 纯函数快照：分支条件求值（D7 被引用键子集由调用方裁剪）。同步。 */
  snapshot(): Record<string, unknown>;
}

// ===== LLMGateway（§4.4）=====

export interface RouteDecision {
  /** 实际出账模型（成本归因，deep-dive-llm-gateway 要求）。 */
  model: string;
  /** 服务商标识（价格表键）。 */
  provider: string;
  /** 同能力级 fallback 候选链（不含当前模型，D13）。 */
  fallbackChain: readonly string[];
  /** 能力档位（deep-dive 三档：flagship/mid/light，可选）。 */
  tier?: string;
}

export interface LLMRequest {
  /** 渲染后的完整 prompt（L0–L9 产物；Phase 1 可为单段文本）。 */
  prompt: string;
  /** 系统预设（L1，可选）。 */
  system?: string;
  /** 结构化输出 schema（判定路径；jsonSchema 优先，缺省纯文本）。 */
  jsonSchema?: Record<string, unknown>;
  maxTokens?: number;
  temperature?: number;
}

export interface LLMResponse {
  /** 纯文本输出（非结构化调用）。 */
  text: string;
  /** 结构化输出（jsonSchema 调用解析后的对象）。 */
  object?: unknown;
  /** 归一化 usage（五字段，deep-dive-llm-gateway 裁决）。 */
  usage: NormalizedUsage;
  /** 原始 usage（双轨对账轨，D16）。 */
  rawUsage?: unknown;
  /** 实际出账模型（fallback 归因）。 */
  model: string;
}

/**
 * 可注入的底层调用执行器（真实 AI SDK 适配器 / 测试 mock 共用此缝）。
 * 真实适配器（Vercel AI SDK）在接入验收冒烟时接入；本期以 mock 验证。
 */
export type LlmExecutor = (
  decision: RouteDecision,
  req: LLMRequest,
  signal: AbortSignal,
) => Promise<Result<LLMResponse, LLMGatewayErrorKind>>;

export interface LLMGateway {
  /** 按模型名解析服务商与 fallback 链（不发起网络调用）。同步。 */
  route(model: string): Result<RouteDecision, LLMGatewayErrorKind>;

  /** 发起调用；内部执行指数退避与可重试类型判定（D13，重试表见 schema/errors）。异步。 */
  call(decision: RouteDecision, req: LLMRequest, signal: AbortSignal): Promise<Result<LLMResponse, LLMGatewayErrorKind>>;

  /** 失败后的降级决策（由 Agent 服务主动调用；网关不自动链式）。同步。 */
  fallback(failed: RouteDecision, kind: LLMGatewayErrorKind): Result<RouteDecision, LLMGatewayErrorKind>;
}

// ===== MemoryService（§4.6）=====

export interface MemoryService {
  /** 挂载指定 Agent 的记忆（进程启动/跨局恢复时）。异步。 */
  mount(agentId: AgentId): Promise<Result<void, MemoryErrorKind>>;

  /** 取 L5 投影（滚动摘要段，供上下文组装；MVP 简化为截断）。同步。 */
  projection(agentId: AgentId): Result<unknown, MemoryErrorKind>;

  /** 滚动压缩：生成自包含检查点（MVP 可简化为截断 + persist）。异步。 */
  compact(agentId: AgentId): Promise<Result<void, MemoryErrorKind>>;

  /** 显式落盘（局末/销毁前，状态机 A10）。异步。 */
  persist(agentId: AgentId): Promise<Result<void, MemoryErrorKind>>;
}

// ===== AgentService（§4.1）=====

export interface AgentSpec {
  id: AgentId;
  identityCard: IdentityCardV1;
  modelBinding: ModelBinding;
}

export interface TurnContext {
  /** 本回合意图（组件传入，如"生成情境呈现"）。 */
  intent: string;
  /** 工具循环回灌：上一轮工具调用结果（决策循环由组件驱动，§2.2 层纪律）。 */
  toolResults?: readonly { call: ToolCallRequest; result: unknown }[];
}

export interface AgentService {
  /** 显式创建实例；身份牌与 LLM 绑定在此校验。同步。 */
  create(spec: AgentSpec): Result<void, AgentServiceErrorKind>;

  /** 显式销毁；不销毁则跨局存续（D22 记忆文件保留）。同步。 */
  destroy(id: AgentId): Result<void, AgentServiceErrorKind>;

  /** steering 档干预：入队，下一安全点生效。同步。 */
  steer(id: AgentId, msg: DirectorDirective): Result<void, AgentServiceErrorKind>;

  /** follow-up 档干预：入队，turn_end 时 steering 为空则消费。同步。 */
  followUp(id: AgentId, msg: DirectorDirective): Result<void, AgentServiceErrorKind>;

  /** 中止当前在飞回合（cancel/紧急终止；安全点生效）。同步。 */
  abort(id: AgentId): Result<void, AgentServiceErrorKind>;

  /** 单次 LLM 往返：返回 final（发言文本）或 tool_calls（决策循环由组件驱动）。异步。 */
  runTurn(id: AgentId, ctx: TurnContext, signal: AbortSignal): Promise<Result<TurnOutcome, AgentServiceErrorKind>>;
}

// ===== 工厂签名（组合根在 cli/ 装配；跨 Agent 冻结）=====

export declare function createEventLog(opts: { filePath: string }): EventLog;
export declare function createBlackboard(deps: { eventLog: EventLog }): Blackboard;
export declare function createLLMGateway(deps: {
  priceTable: Record<string, unknown>;
  executor: LlmExecutor; // 本期注入 mock；真实 AI SDK 适配器走同一缝
}): LLMGateway;
export declare function createMemoryService(deps: {
  dir: string;
  gateway?: LLMGateway; // 压缩调用（F18）；MVP 截断模式可缺省
}): MemoryService;
export declare function createAgentService(deps: {
  gateway: LLMGateway;
  memory: MemoryService;
  blackboard: Blackboard;
  eventLog: EventLog;
}): AgentService;
