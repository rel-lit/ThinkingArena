// Version: 1.0.0
/**
 * 元组件接口契约（runtime-architecture.md §4.7）：服务层的唯一调用面，pi AgentTool 式契约。
 *
 * 两层交付：
 * 1. Zod Schema（可导出 JSON Schema）：内置元组件名册与各自 parameters 契约、TurnOutcome、
 *    组件/元组件的「描述性」形态（不含函数——函数无法无损序列化，硬约束 2/3）。
 * 2. TS interface（纯类型，擦除后零运行时）：beforeCall/afterCall/run 的签名（§4.7 原文），
 *    含取消链 AbortSignal 逐环传递与 TCAS batchView（D9）。
 *
 * 纪律：schema 校验前置（F4/F12）；错误编码进结果（D5）；组件不持有服务句柄，F4 是唯一能力面。
 */
import { z } from 'zod';
import { ErrorCodeSchema, type ComponentErrorKind, type ErrorCode, type Result } from './errors.ts';
import { AgentIdSchema, BlackboardKeySchema, GateTimeoutPolicySchema, InterventionKindSchema } from './event.ts';

// ===== 内置元组件 parameters 契约 =====

/** call_agent：发起单次 LLM 往返（§4.1 runTurn 粒度裁决；组件驱动工具循环，§2.2 层纪律）。 */
export const CallAgentParamsSchema = z
  .strictObject({
    agent_id: AgentIdSchema.describe('目标 Agent（须 IDLE；RUNNING 中重复调用返回 AGENT_BUSY，§3.1 A4）'),
    intent: z.string().min(1).describe('本回合意图/指令文本（组件对 Agent 的任务描述；渲染进回合上下文区，附录 A 四区）'),
    tool_results: z
      .array(
        z
          .strictObject({
            call_id: z.string().min(1).describe('对应 TurnOutcome.tool_calls 的 call_id（配对依据）'),
            content: z.unknown().describe('工具执行结果（经元组件执行，错误编码进结果，D5）'),
            is_error: z.boolean().optional().describe('该结果是否为错误编码（true 时 content 为错误枚举与元数据）'),
          })
          .describe('单条工具结果（§2.2 工具循环：组件携带工具结果再次调用）'),
      )
      .optional()
      .describe('上一轮 tool_calls 的执行结果（§2.2 决策循环由组件驱动；首次调用缺省）'),
  })
  .describe('call_agent 参数（§4.1/§2.2；0..n 工具循环受 D28 统一迭代上限约束）');
export type CallAgentParams = z.infer<typeof CallAgentParamsSchema>;

/** inject_context：注入目标 Agent 私有上下文（D2/F8：Agent 对 Agent 通信的唯一通道；绝不进静态前缀）。 */
export const InjectContextParamsSchema = z
  .strictObject({
    target_agent_id: AgentIdSchema.describe('目标 Agent（私有上下文接受注入的一方，F8）'),
    text: z.string().min(1).describe('注入内容（将落 agent_to_agent 事件全文，归因）'),
    source: z.string().min(1).optional().describe('来源标识（agent_to_agent 编排时的源 Agent 或组件；D2 三级信息分离的审计面）'),
  })
  .describe('inject_context 参数（D2/F8；私有上下文转录走 D22 独立持久化，不进黑板不写穿事件流）');
export type InjectContextParams = z.infer<typeof InjectContextParamsSchema>;

/** bb_get：读黑板（键不存在返回 undefined，不是错误，§4.2）。 */
export const BbGetParamsSchema = z
  .strictObject({
    key: BlackboardKeySchema.describe('读取的黑板键'),
  })
  .describe('bb_get 参数（§4.2）');
export type BbGetParams = z.infer<typeof BbGetParamsSchema>;

/** bb_set：写穿黑板（D1：先落盘为事件、后生效；落盘失败写入不生效并上抛致命）。 */
export const BbSetParamsSchema = z
  .strictObject({
    key: BlackboardKeySchema.describe('写入的黑板键（保留命名空间受 D26 写者声明约束；越权写 NAMESPACE_FORBIDDEN）'),
    value: z.unknown().describe('写入值（JSON 可序列化，F10）'),
    reason: z.string().optional().describe('数值依据/变更说明（透传 bb_set 事件载荷，D31）'),
  })
  .describe('bb_set 参数（D1/F10；私有上下文禁止经此通道，D22）');
export type BbSetParams = z.infer<typeof BbSetParamsSchema>;

/** emit_event：组件发射游戏语义事件的唯一通道（F12：schema 校验前置，非法事件拒写）。 */
export const EmitEventParamsSchema = z
  .strictObject({
    type: z.string().min(1).describe('事件类型（内核游戏语义族，或经 createEventSchema 注册的自定义类型，D32；信封其余字段由运行上下文补齐）'),
    payload: z.unknown().describe('事件载荷（按 event.ts 对应类型的 payload 契约校验前置，F12）'),
  })
  .describe('emit_event 参数（F12/D35：组件显式发射；校验失败拒写并视为节点失败走 onError）');
export type EmitEventParams = z.infer<typeof EmitEventParamsSchema>;

/** await_director_input：导演门的等待原语（D37：门 = 普通无状态组件，等待只是栈上 pending promise，持久状态全在事件流）。 */
export const AwaitDirectorInputParamsSchema = z
  .strictObject({
    targets: z.array(AgentIdSchema).describe('门声明的目标 Agent（透传 gate_waiting 事件载荷；无目标干预为空数组）'),
    accepts: z.array(InterventionKindSchema).min(1).describe('接受的干预类型子集（D18 封闭集内；note 不经门，D27）'),
    timeout: GateTimeoutPolicySchema.describe('超时策略（D15；门等待独立于 join 超时计时，§3.3）'),
  })
  .describe('await_director_input 参数（D37；取消经 AbortSignal 到达，G4/G6）');
export type AwaitDirectorInputParams = z.infer<typeof AwaitDirectorInputParamsSchema>;

// ===== TurnOutcome：call_agent 的返回载荷（§4.1/§2.2）=====

/** 工具调用请求（Agent 服务产出、组件消费，§2.2 层纪律：服务不持有元组件句柄）。 */
export const ToolCallRequestSchema = z
  .strictObject({
    call_id: z.string().min(1).describe('调用 id（与 tool_results 配对的依据）'),
    name: z.string().min(1).describe('工具名（组件决定映射到哪个元组件——工具授予 = 组件选择调用哪些元组件，§2.2）'),
    arguments: z.record(z.string(), z.unknown()).describe('工具参数（JSON；执行前过目标元组件的 parameters 校验，F4）'),
  })
  .describe('单条工具调用请求（§2.2）');
export type ToolCallRequest = z.infer<typeof ToolCallRequestSchema>;

/** TurnOutcome（§4.1 runTurn 返回载荷）：final（发言文本）或 tool_calls（待执行工具）或 error（编码错误）。 */
export const TurnOutcomeSchema = z
  .discriminatedUnion('kind', [
    z
      .strictObject({
        kind: z.literal('final').describe('回合产出最终文本（A5 RUNNING→IDLE 的候选；steering 队列非空则回合继续，§2.2）'),
        text: z.string().describe('发言文本（组件据此发射 speech 事件，D35——不由 Agent 实例中途落）'),
        reasoning: z.string().optional().describe('LLM reasoning/thinking 全文（组件据此发射 monologue 事件，D31）'),
      })
      .describe('final：发言产出'),
    z
      .strictObject({
        kind: z.literal('tool_calls').describe('请求执行工具（§2.2：组件驱动工具循环，携带结果再次 call_agent）'),
        calls: z.array(ToolCallRequestSchema).min(1).describe('待执行工具调用列表'),
        reasoning: z.string().optional().describe('本轮 reasoning/thinking 全文（D31 monologue 素材）'),
      })
      .describe('tool_calls：工具调用请求'),
    z
      .strictObject({
        kind: z.literal('error').describe('回合内不可恢复失败（错误编码进结果，D5/A8）'),
        error: ErrorCodeSchema.describe('错误枚举（§4 七组枚举之一；§4.7 备注「错误位 Schema 阶段收紧为枚举联合」的落地，D5）'),
        detail: z.string().optional().describe('元数据级补充说明（禁止原始响应体与凭证，F7）'),
      })
      .describe('error：失败编码'),
  ])
  .describe('TurnOutcome（§4.1：单次 LLM 往返的返回载荷；speech 由组件经它带回后发射，D35）');
export type TurnOutcome = z.infer<typeof TurnOutcomeSchema>;

// ===== 描述性 Schema（可导出 JSON Schema；函数签名见下方 TS interface）=====

/** 元组件描述形态（§4.7 四元组的可序列化部分；parameters 以 JSON Schema 导出形态表示）。 */
export const MetaComponentDescriptorSchema = z
  .strictObject({
    name: z.string().min(1).describe('元组件名（MetaRegistry.call 的寻址键，§4.7）'),
    version: z.string().regex(/^\d+\.\d+\.\d+$/).describe('元组件版本（semver；version 从第一天存在，Bundle 锁定版本，D33）'),
    description: z.string().min(1).describe('能力说明（AI 生成组件时的 API 面文档，§4.7）'),
    parameters: z.record(z.string(), z.unknown()).describe('参数契约的 JSON Schema 导出形态（运行时为 Zod Schema，z.toJSONSchema 导出）'),
  })
  .describe('元组件描述形态（§4.7；按可对外暴露形态设计，加 Adapter 即成 MCP——used-reference overview §4.3）');
export type MetaComponentDescriptor = z.infer<typeof MetaComponentDescriptorSchema>;

/** 组件描述形态（§4.7 ComponentDescription：名称/version/参数 schema/端口/可写键前缀 D26）。 */
export const ComponentDescriptorSchema = z
  .strictObject({
    name: z.string().min(1).describe('组件类型名（flow.ts FlowNode.type 的取值域）'),
    version: z.string().regex(/^\d+\.\d+\.\d+$/).describe('组件版本（semver；Bundle 锁定，D33/§2.4-1）'),
    description: z.string().min(1).describe('组件能力说明'),
    parameters: z.record(z.string(), z.unknown()).describe('节点参数契约的 JSON Schema 导出形态（节点 params 按此校验，D20/F3）'),
    inputs: z.array(z.string().min(1)).describe('输入端口名列表（边 to_port 的合法取值；join 显式等待的口，D8）'),
    outputs: z.array(z.string().min(1)).describe('输出端口名列表（边 from_port 的合法取值；端口用名字不用魔法下标）'),
    writable_prefixes: z
      .array(z.string().min(1))
      .describe('可写黑板键前缀声明（D26：加载期校验 + 运行期越权写=NAMESPACE_FORBIDDEN；如状态表键仅裁判组件可写）'),
  })
  .describe('组件描述形态（§4.7/D26；组件 = 无状态两元单元 description+run）');
export type ComponentDescriptor = z.infer<typeof ComponentDescriptorSchema>;

// ===== 内置元组件名册（§4.7 签名级列举的落地）=====

/** 内置元组件名册：名 → { version, description, parameters }（parameters 为运行时 Zod Schema）。 */
export const BUILTIN_META_COMPONENTS = {
  call_agent: {
    name: 'call_agent',
    version: '1.0.0',
    description: '发起单次 LLM 往返（§4.1）；返回 final/tool_calls/error 三态 TurnOutcome；组件驱动工具循环（§2.2）',
    parameters: CallAgentParamsSchema,
  },
  inject_context: {
    name: 'inject_context',
    version: '1.0.0',
    description: '注入目标 Agent 私有上下文（D2/F8）；agent_to_agent 编排的注入通道；绝不进静态前缀（附录 A 不变量）',
    parameters: InjectContextParamsSchema,
  },
  bb_get: {
    name: 'bb_get',
    version: '1.0.0',
    description: '读黑板（§4.2；键不存在返回 undefined 非错误）',
    parameters: BbGetParamsSchema,
  },
  bb_set: {
    name: 'bb_set',
    version: '1.0.0',
    description: '写穿黑板（D1：先落盘后生效；D26 写者声明约束；私有上下文禁入，D22）',
    parameters: BbSetParamsSchema,
  },
  emit_event: {
    name: 'emit_event',
    version: '1.0.0',
    description: '发射事件（F12：schema 校验前置、非法拒写；游戏语义事件的组件发射面，D35）',
    parameters: EmitEventParamsSchema,
  },
  await_director_input: {
    name: 'await_director_input',
    version: '1.0.0',
    description: '等待导演输入（D37：泵解析等待中的 promise；D15 超时策略；D27 单门等待）',
    parameters: AwaitDirectorInputParamsSchema,
  },
} as const;

/** 内置元组件名清单（名册校验用）。 */
export const BUILTIN_META_COMPONENT_NAMES = Object.keys(BUILTIN_META_COMPONENTS) as readonly string[];

// ===== 函数签名契约（§4.7 原文落地为 TS interface；纯类型，零运行时）=====

/** beforeCall 拦截返回（§4.7 BlockReason 占位落地；错误矩阵：before 钩子拦截 → 组件自行决定走向）。 */
export interface BlockReason {
  /** 拦截原因（人读 + CLI 可见性）。 */
  reason: string;
  /** 机器可读分类（可选；如 cost_gate、policy）。 */
  code?: string;
}

/** TCAS 批内视图（D9：快照 ⊕ 本分支缓冲；非批节点为 undefined，§4.7）。 */
export interface BatchView {
  /** 批前统一黑板快照（D9）。 */
  readonly snapshot: unknown;
  /** 本分支的发射缓冲（批作用域两阶段发射；批结束按声明分支序串行提交）。 */
  readonly branchBuffer: unknown;
}

/** 组件上下文（§4.7：取消链 FlowRunner → 组件 → 元组件 → 服务逐环传递）。 */
export interface ComponentContext {
  /** 唯一能力面（core-loop 层纪律：组件不持有服务句柄，F4）。 */
  readonly meta: MetaRegistry;
  /** 取消信号（§4.7 AbortSignal 逐环传递；G4 门取消经此到达）。 */
  readonly signal: AbortSignal;
  /** TCAS 批内视图（D9；非批节点为 undefined）。 */
  readonly batchView?: BatchView;
}

/** 元组件（§4.7 pi AgentTool 式契约：校验前置 → beforeCall → run → afterCall；错误编码进结果，D5）。 */
export interface MetaComponent<P = unknown, R = unknown> {
  /** 名（MetaRegistry.call 寻址键）。 */
  readonly name: string;
  /** 版本（从第一天存在，Bundle 锁定，D33）。 */
  readonly version: string;
  /** 能力说明。 */
  readonly description: string;
  /** 参数契约（运行时为 Zod Schema；可 z.toJSONSchema 导出）。 */
  readonly parameters: z.ZodType<P>;
  /** 前置钩子（可选；返回 BlockReason 即拦截，不执行 run）。 */
  beforeCall?(args: P, ctx: ComponentContext): Promise<void | BlockReason>;
  /** 后置钩子（可选；可改写/包装 run 的结果）。 */
  afterCall?(args: P, result: R, ctx: ComponentContext): Promise<Result<R, ErrorCode>>;
  /** 执行体（错误编码进结果，不抛异常，D5；错误位为所属服务的错误枚举——§4.7 备注「暂为 string，Schema 阶段收紧为枚举联合」的落地）。 */
  run(args: P, ctx: ComponentContext): Promise<Result<R, ErrorCode>>;
}

/** 元组件注册表（§4.7 MetaRegistry：按名调用，schema 校验前置）。 */
export interface MetaRegistry {
  call(name: string, args: unknown, ctx: ComponentContext): Promise<Result<unknown, ErrorCode>>;
}

/** 组件（§4.7：无状态两元单元；节点边界事件由 FlowRunner 落，D35——组件不负责）。 */
export interface Component {
  readonly description: ComponentDescriptor;
  run(params: unknown, ctx: ComponentContext): Promise<Result<void, ComponentErrorKind>>;
}
