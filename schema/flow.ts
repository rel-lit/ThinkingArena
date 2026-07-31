// Version: 1.0.0
/**
 * 流程图配置契约（flow.yaml）：组件节点 + 控制边 + 封闭算子条件 DSL（D7）。
 *
 * 依据：runtime-architecture.md §3.3（DAG 执行器/回边/重入）、§4.5（FlowRunner）、D7（分支条件求值与落盘）、
 * D8（join 等待表）、D9（TCAS 声明分支序）、D15（门超时策略）、D20（加载期校验）、D26（可写键前缀声明）。
 *
 * 结构校验纪律：本文件只定义单文件内可表达的形态约束（strictObject 拒绝笔误）；
 * 跨引用校验（entry 是否存在、边端点是否存在、join 输入口与入边配对、单门约束 D27、
 * 可写键前缀冲突 D26）属加载期图校验（D20），由 orchestrator/graph 实现，不在本契约内（不用 refine，JSON Schema 导出无损）。
 */
import { z } from 'zod';
import {
  DirectorDirectiveSchema,
  GateTimeoutPolicySchema,
  INTERVENTION_KINDS,
  InterventionKindSchema,
} from './event.ts';

// ===== 基元 =====

/** 节点 id：snake_case，边与调度进度（节点,迭代）元组以它寻址（§3.3）。 */
export const NodeIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/)
  .describe('节点 id（snake_case；边端点、事件 exec.node_id、调度进度键的寻址基础，§3.3/D36）');
export type NodeId = z.infer<typeof NodeIdSchema>;

/** 端口名：用名字不用魔法下标（used-reference/design/overview.md §4.3 流程图配置行）。 */
export const PortNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/)
  .describe('端口名（snake_case；端口用名字不用魔法下标——输出端口对应组件 description 声明，输入端口供 join 显式等待，D8）');
export type PortName = z.infer<typeof PortNameSchema>;

/** 黑板键路径：点路径（如 protagonist.hp、worldbook.ashen_wastes）；D7 分支条件只许引用黑板键。 */
export const KeyPathSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/)
  .describe('黑板键点路径（D7 分支条件的唯一数据来源；worldbook 保留命名空间同以此寻址，D34）');
export type KeyPath = z.infer<typeof KeyPathSchema>;

// ===== 条件 DSL（D7 封闭算子集；声明式，非可执行表达式）=====

/** 条件操作数：JSON 字面量或黑板键路径引用（{ ref: "protagonist.hp" }）。 */
export const ConditionOperandSchema = z
  .union([
    z.strictObject({ ref: KeyPathSchema.describe('黑板键路径引用（D7：求值瞬间从黑板快照读取该键）') }).describe('黑板键引用操作数'),
    z.string().describe('字符串字面量'),
    z.number().describe('数字字面量'),
    z.boolean().describe('布尔字面量'),
    z.null().describe('null 字面量（判断键不存在/已清空）'),
  ])
  .describe('条件操作数（D7：字面量或 { ref: 黑板键路径 }；引用不存在的键在求值期按配置错误处理，F14）');
export type ConditionOperand = z.infer<typeof ConditionOperandSchema>;

const COMPARISON_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'] as const;

/** 分支条件表达式的静态类型（与 ConditionExprSchema 同构；显式书写以满足 TS 递归类型标注）。 */
export type ConditionExpr =
  | { op: (typeof COMPARISON_OPS)[number]; left: ConditionOperand; right: ConditionOperand }
  | { op: 'and' | 'or'; args: ConditionExpr[] }
  | { op: 'not'; arg: ConditionExpr };

/**
 * 分支条件表达式（D7 封闭最小算子集：eq/neq/gt/gte/lt/lte/and/or/not）。
 * 声明式 JSON DSL——可静态校验（D20 可校验性前提）、可序列化落盘（branch_decision 事件载荷）、
 * 重放时分支走向来自记录而非重新求值（D7）。
 */
export const ConditionExprSchema: z.ZodType<ConditionExpr> = z
  .lazy(() =>
    z.union([
      z
        .strictObject({
          op: z.enum(COMPARISON_OPS).describe('比较算子（D7 封闭集：eq/neq/gt/gte/lt/lte）'),
          left: ConditionOperandSchema.describe('左操作数'),
          right: ConditionOperandSchema.describe('右操作数'),
        })
        .describe('比较条件（D7）'),
      z
        .strictObject({
          op: z.enum(['and', 'or']).describe('布尔合取/析取（D7 封闭集）'),
          args: z.array(ConditionExprSchema).min(1).describe('子条件列表（至少 1 个，递归）'),
        })
        .describe('布尔组合条件（D7）'),
      z
        .strictObject({
          op: z.literal('not').describe('布尔取反（D7 封闭集）'),
          arg: ConditionExprSchema.describe('子条件（递归）'),
        })
        .describe('取反条件（D7）'),
    ]),
  )
  .describe('分支条件 DSL（D7 封闭算子集；遍历瞬间求值、快照落盘、重放读记录）');

// ===== 节点与边 =====

/** join 声明（D8）：显式等待哪些输入口 + join 超时（死锁缓解）。 */
export const JoinDeclSchema = z
  .strictObject({
    inputs: z
      .array(PortNameSchema)
      .min(1)
      .describe('显式等待的输入口名列表（D8/used-reference overview §4.3：join 显式声明等待哪些输入口；按迭代计数隔离配对，§3.3）'),
    timeout_ms: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('join 超时（D8 死锁缓解；超时执行器转 ERROR，错误枚举 JOIN_TIMEOUT；缺省=永不超时）'),
  })
  .describe('join 声明（D8；多入边节点必配，门等待不参与 join 计时——§3.3 补充语义）');
export type JoinDecl = z.infer<typeof JoinDeclSchema>;

/** 组件节点。 */
export const FlowNodeSchema = z
  .strictObject({
    id: NodeIdSchema,
    type: z
      .string()
      .min(1)
      .describe('组件类型名（内置组件——角色创建/销毁/叙事/判定/骰子/导演门——或注册组件；与 version 一起被 Bundle hash 锁定，D33）'),
    version: z
      .string()
      .min(1)
      .describe('组件版本（两元结构纪律：version 从第一天存在，Bundle 锁定版本，D33/§2.4-1；node_start 事件落此值）'),
    params: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('节点参数（加载期按组件 description.parameters 校验，D20/F3；导演门节点参数见 DirectorGateParamsSchema）'),
    on_error: z
      .enum(['stop', 'retry', 'continue'])
      .describe('节点失败策略（F3：stop=执行器转 ERROR（R5）/ retry=有界重试 / continue=跳过；显式声明，不设默认——显式优于自动）'),
    max_retries: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('on_error=retry 时的有界重试次数（错误矩阵「retry（有界）→ stop」；受 D28 统一迭代上限约束）'),
    join: JoinDeclSchema.optional().describe('join 声明（D8；仅多入边节点需要，显式等待输入口 + 可选超时）'),
  })
  .describe('组件节点（组件 = 无状态两元单元 description+run，§3.3；重入 = 无状态新执行、参数重读）');
export type FlowNode = z.infer<typeof FlowNodeSchema>;

/** 控制边。 */
export const FlowEdgeSchema = z
  .strictObject({
    id: z.string().min(1).optional().describe('边 id（可选；branch_decision 事件与加载期报错信息的引用便利）'),
    from: NodeIdSchema.describe('源节点 id'),
    from_port: PortNameSchema.describe('源节点输出端口名（端口用名字不用魔法下标；branch_decision 事件记录此端口，D7）'),
    to: NodeIdSchema.describe('目标节点 id'),
    to_port: PortNameSchema.describe('目标节点输入端口名（join 节点按此配对等待，D8）'),
    condition: ConditionExprSchema.optional().describe(
      '分支条件（D7：条件是边的属性；遍历瞬间求值、被引用键快照落 branch_decision 事件；缺省=无条件边）',
    ),
    order: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('并行分支的声明提交序（D9 TCAS：批结束按声明分支序串行提交；缺省按边在配置中的声明顺序）'),
  })
  .describe('控制边（回边即循环，无循环原语，§3.3；条件求值失败=配置错误走 onError，F14）');
export type FlowEdge = z.infer<typeof FlowEdgeSchema>;

// ===== 导演门节点参数（内置组件 director_gate 的 params 形态）=====

/** 内置导演门组件的节点参数（D37：门 = 普通无状态组件，run 内经 await_director_input 等待）。 */
export const DirectorGateParamsSchema = z
  .strictObject({
    targets: z
      .array(z.string().min(1))
      .describe('目标 Agent id 列表（门参数，§3.2；inject/edit_world 类干预无目标为空数组；whisper 单目标、agent_broadcast 多目标，D18）'),
    accepts: z
      .array(InterventionKindSchema)
      .min(1)
      .describe('本门接受的干预类型子集（D18 封闭集内；note 不经门——随时可发、由消费泵直落盘，D27）'),
    timeout: GateTimeoutPolicySchema.describe('超时策略（D15；默认 wait_forever 保持 MVP 交互语义，锦标赛须显式选 use_default/cancel_branch）'),
  })
  .describe(
    '导演门节点参数（D15/D37；单门等待约束 D27 与「不得有两个可能同时到达的门」为加载期图校验 D20，不在本 Schema 内）',
  );
export type DirectorGateParams = z.infer<typeof DirectorGateParamsSchema>;

// ===== 流程图配置（flow.yaml 顶层）=====

export const FlowConfigSchema = z
  .strictObject({
    name: z.string().min(1).describe('图名（人读标识；作品库检索与 manifest scenario 字段的来源候选）'),
    version: z.string().min(1).describe('图版本（人读语义版本；机器版本身份以 Bundle 全输入 hash 为准，D33）'),
    entry: NodeIdSchema.describe('入口节点 id（调度起点，§3.3 R1 后进入调度循环）'),
    nodes: z.array(FlowNodeSchema).min(1).describe('组件节点列表（至少 1 个；id 唯一性属加载期校验 D20）'),
    edges: z.array(FlowEdgeSchema).describe('控制边列表（可为空=单节点图；端点存在性与成环检测属加载期校验 D20）'),
  })
  .describe('流程图配置（flow.yaml 顶层；首局范围：线性 + 回边 + 条件分支，§0.2；join/TCAS 接口预留）');
export type FlowConfig = z.infer<typeof FlowConfigSchema>;

// 供外部复核的常量导出（名册校验用）
export { INTERVENTION_KINDS, DirectorDirectiveSchema };
