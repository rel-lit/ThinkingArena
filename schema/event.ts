// Version: 1.0.0
/**
 * 事件契约：Script JSONL 的唯一事实形态（core-loop 原则 3「事件即事实」，D1/D32）。
 *
 * 结构总览：
 * - 信封：{ id, parent_id, ts, run_id, branch, exec, type, payload }，控制条目与叙事事件同一信封（D32）。
 * - 内核封闭集：本文件命名的 38 个事件类型（D32），按 D35 唯一写者表分族：
 *   编排事实 run_*、node_*（FlowRunner）；服务事实 agent_*、turn_*、cost、prompt_hash、cache_invalidation（服务自动落）；
 *   游戏语义 speech、monologue、dice、judgement、milestone、agent_to_agent、gate_*、director_intervention、bb_set、judge_retry（组件显式发射）；
 *   控制条目 snapshot、fork；runner 级 director_note、system。
 * - 开放注册集：组件自定义事件必须含命名空间前缀（形如 `isekai.omen_triggered`，内核类型不含 '.'），
 *   EventLog 按注册表校验（D32），见 createEventSchema。
 * - EventDraft（无 id/parent_id）是 append 入参：id 由 EventLog 在 append / TCAS 批串行提交时取号
 *   （deep-dive-event-log §1.5-3/4），保证「id 序 = 文件序」。
 * - id/parent_id/ts 为结构元数据，不参与 reduce；reduce 输入语义仅为 type + payload（deep-dive §1.5-2，重放确定性）。
 */
import { z } from 'zod';
import {
  ErrorCodeSchema,
  FlowRunnerErrorKindSchema,
} from './errors.ts';

// ===== 信封基元 =====

/** 事件 id：文件内全局零填充单调序号（deep-dive-event-log §1.4 裁决：前缀 e + ≥7 位零填充数字）。 */
export const EventIdSchema = z
  .string()
  .regex(/^e\d{7,}$/)
  .describe(
    '事件 id：文件内全局零填充单调序号（deep-dive §1.4），由 EventLog 在 append/TCAS 批提交时分配（写者不自带 id）；' +
      'id 序 = 文件物理序；结构元数据，不参与 reduce（deep-dive §1.5-2）',
  );
export type EventId = z.infer<typeof EventIdSchema>;

/** run id：UUID v7（deep-dive §1.3-⑥：跨局引用无歧义、run 目录字典序即时间序，D24）。 */
export const RunIdSchema = z
  .uuidv7()
  .describe('局 id = UUID v7（deep-dive §1.4；D24 run 目录命名与 manifest 族谱指针的跨局唯一标识）');
export type RunId = z.infer<typeof RunIdSchema>;

/** 分支标识：同一 Script 文件内多分支共存（D21/§2.4 fork 模型），初始分支约定为 "main"。 */
export const BranchIdSchema = z
  .string()
  .min(1)
  .describe('分支标识（§2.4 版本域 fork 模型：同版本内分叉共享前缀事实，旧分支封存不再增长）');
export type BranchId = z.infer<typeof BranchIdSchema>;

/** SHA256 十六进制（小写）：干预指令 hash（D18）、静态前缀 hash（D16）、Bundle 版本 hash（D33）共用格式。 */
export const Sha256HexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .describe('SHA256 小写十六进制（D16 静态前缀校验 / D18 干预指令校验 / D33 Bundle 版本身份）');
export type Sha256Hex = z.infer<typeof Sha256HexSchema>;

/** 节点执行标识（D36）：{ 节点 id, 迭代计数 }，孤儿事件判定与调度进度键（§3.3 元组）。与事件 id 语义域独立，禁止合并（deep-dive §1.3-⑤）。 */
export const NodeExecSchema = z
  .strictObject({
    node_id: z.string().min(1).describe('产生本事件的流程图节点 id（D36；对应 flow.ts FlowNode.id）'),
    iteration: z
      .number()
      .int()
      .nonnegative()
      .describe('该节点的迭代计数（回边重入递增，§3.3 调度进度以（节点,迭代计数）元组表达）'),
  })
  .describe('节点执行标识（D36）：崩溃恢复时跳过最后未完成节点执行的孤儿事件（cost 类除外）的依据');
export type NodeExec = z.infer<typeof NodeExecSchema>;

// ===== 跨事件共享的载荷构件 =====

/** 干预类型封闭集合（D18）：whisper / inject / edit_world / note / agent_broadcast。 */
export const INTERVENTION_KINDS = ['whisper', 'inject', 'edit_world', 'note', 'agent_broadcast'] as const;
export const InterventionKindSchema = z
  .enum(INTERVENTION_KINDS)
  .describe('导演干预类型封闭集（D18）：whisper 私有催眠 / inject 公开环境事件 / edit_world 改世界设定 / note 批注 / agent_broadcast 多目标 steering');
export type InterventionKind = z.infer<typeof InterventionKindSchema>;

/** 导演指令（指令全文落盘，D18/D31「可归因」的机械保证）。inbox 行、gate_input_received、director_intervention、门默认输入共用本形态。 */
export const DirectorDirectiveSchema = z
  .strictObject({
    kind: InterventionKindSchema,
    text: z.string().min(1).describe('指令全文（D18/D31：干预必须全文落盘，hash 仅作校验——「导演如何操纵故事」本身是视频素材）'),
    targets: z
      .array(z.string().min(1))
      .describe('目标 Agent id 列表：whisper 单目标 / agent_broadcast 多目标（D18）；inject/edit_world/note 无目标为空数组'),
    mode: z
      .enum(['steering', 'follow_up'])
      .nullable()
      .describe('干预档位（D4）：steering=tool 边界打断转向 / follow_up=自然停止点续作；仅 whisper 类有意义，其余为 null'),
  })
  .describe('导演指令全文（D18；F1 inbox 行格式与门指令落盘载荷的共用形态）');
export type DirectorDirective = z.infer<typeof DirectorDirectiveSchema>;

/** 导演门超时策略（D15 封闭三档；默认 wait_forever 保持 MVP 交互式导演语义，锦标赛无人值守须显式选后两档）。 */
export const GateTimeoutPolicySchema = z
  .discriminatedUnion('policy', [
    z
      .strictObject({
        policy: z.literal('wait_forever').describe('无限等待导演输入（D15 默认档；MVP 交互式导演语义）'),
      })
      .describe('无限等待（D15）'),
    z
      .strictObject({
        policy: z.literal('use_default').describe('超时后采用门参数中的默认输入继续（D15；§3.2 G3）'),
        after_ms: z.number().int().positive().describe('超时阈值（毫秒）；到期触发 gate_timeout 并采用默认输入（G3）'),
        default_input: DirectorDirectiveSchema.describe('超时采用的默认导演指令（G3：视为导演输入进入 RECEIVED）'),
      })
      .describe('超时采用默认输入（D15）'),
    z
      .strictObject({
        policy: z.literal('cancel_branch').describe('超时后取消门所在分支，其余分支不受影响（D15；§3.2 G4）'),
        after_ms: z.number().int().positive().describe('超时阈值（毫秒）；到期触发 gate_timeout + gate_cancelled（G4）'),
      })
      .describe('超时取消分支（D15）'),
  ])
  .describe('导演门超时策略（D15；门等待独立于 join 超时计时，§3.3 补充语义）');
export type GateTimeoutPolicy = z.infer<typeof GateTimeoutPolicySchema>;

/** 归一化 usage 五字段（deep-dive-llm-gateway 问题 1 裁决：cached_read/cached_write 单列，未命中输入单列，reasoning 单列；归一化语义在网关层写死）。 */
export const NormalizedUsageSchema = z
  .strictObject({
    input: z.number().int().nonnegative().describe('未命中缓存的输入 tokens（计费口径；Anthropic 口径不含缓存读写，其余家为 prompt_tokens 减命中）'),
    output: z.number().int().nonnegative().describe('输出 tokens（各家 completion/output tokens 归一）'),
    cached_read: z.number().int().nonnegative().describe('缓存命中读 tokens（各家 cached_tokens/cache_read_input_tokens 归一；无则 0）'),
    cached_write: z.number().int().nonnegative().describe('缓存写入 tokens（Anthropic cache_creation / OpenAI cache_write 归一；无则 0；写费倒贴监控单列，D28）'),
    reasoning: z.number().int().nonnegative().describe('reasoning/thinking tokens（各家 reasoning_tokens 归一；无则 0）'),
  })
  .describe('五字段归一 usage（D16 双轨台账的算账轨；deep-dive-llm-gateway 问题 1「对契约的影响」）');
export type NormalizedUsage = z.infer<typeof NormalizedUsageSchema>;

/** 单次成本金额（价格表计算值，D16 双轨之一）。 */
export const CostAmountSchema = z
  .strictObject({
    amount: z.number().nonnegative().describe('按价格表计算的本次调用成本（D16；价格表接口 price(model)→(usage)→money，含豆包分段/DeepSeek 峰谷扩展点）'),
    currency: z.string().min(1).describe('币种（如 CNY/USD；由价格表决定，跨局成本聚合的前提，D24）'),
  })
  .describe('单次调用成本（价格表计算值，D16 双轨台账的计算轨）');
export type CostAmount = z.infer<typeof CostAmountSchema>;

/** 成本汇总（D24 manifest / D28 账本切片 / run_completed 共用）：cost 事件经 reduce 累计的派生切片。 */
export const CostSummarySchema = z
  .strictObject({
    total: z.number().nonnegative().describe('累计成本（D28 成本闸的比较量；账本是 FlowRunner 调度状态的 reduce 派生切片，无独立台账）'),
    currency: z.string().min(1).describe('币种（同一局内所有 cost 事件必须同币种才可汇总）'),
    by_model: z
      .record(z.string(), z.number().nonnegative())
      .optional()
      .describe('按实际出账模型分列的累计成本（可选明细；fallback 归因，deep-dive-llm-gateway 问题 4）'),
  })
  .describe('成本汇总切片（D24 成本汇总 / D28 成本闸账本；reduce 派生）');
export type CostSummary = z.infer<typeof CostSummarySchema>;

/** Agent 生命周期状态（§3.1 状态机六态）；快照载荷中生命周期表的取值域。 */
export const AGENT_LIFECYCLE_STATES = ['CREATED', 'IDLE', 'RUNNING', 'PAUSED', 'ERROR', 'DESTROYED'] as const;
export const AgentLifecycleStateSchema = z
  .enum(AGENT_LIFECYCLE_STATES)
  .describe('Agent 实例生命周期状态（§3.1：CREATED/IDLE/RUNNING/PAUSED/ERROR/DESTROYED，DESTROYED 为唯一终止态）');
export type AgentLifecycleState = z.infer<typeof AgentLifecycleStateSchema>;

/** 黑板键路径（D7 分支条件引用的点路径；worldbook 保留命名空间等皆以此寻址，D34）。 */
export const BlackboardKeySchema = z
  .string()
  .min(1)
  .describe('黑板键（点路径，如 protagonist.hp / worldbook.ashen_wastes；保留命名空间写者唯一性由 D26 校验）');
export type BlackboardKey = z.infer<typeof BlackboardKeySchema>;

/** Agent id。 */
export const AgentIdSchema = z
  .string()
  .min(1)
  .describe('Agent 实例 id（Bundle game.yaml agents[].id 声明；跨局记忆挂载的键，D22）');
export type AgentId = z.infer<typeof AgentIdSchema>;

// ===== 信封拼装 =====

const idField = EventIdSchema;
const parentIdField = EventIdSchema.nullable().describe(
  '父事件 id（append-only 树结构，pi JSONL 树参照；首条事件为 null）；由 EventLog 分配（写者不自带，deep-dive §1.5-3）',
);
const tsField = z
  .iso.datetime()
  .describe('墙钟时间戳（D31 事件信封必带；ISO 8601 UTC）；TCAS 批内事件为缓冲入队时刻（D9）；结构元数据，不参与 reduce');
const runIdField = RunIdSchema;
const branchField = BranchIdSchema;
const execRequiredField = NodeExecSchema;
const execNullField = z
  .null()
  .describe('节点执行标识（D36）：本事件类型不由节点执行产生（run_*、snapshot、fork、director_note、system 等 runner/服务级条目），恒为 null');

interface DefineEventOptions<P extends z.ZodTypeAny> {
  type: string;
  /** 事件族语义说明，落在 type 字段的 describe 上。 */
  family: string;
  exec: typeof execRequiredField | typeof execNullField;
  payload: P;
}

/** 统一定义内核事件：full（含 id/parent_id）与 draft（append 入参，deep-dive §1.5-3）两个形态。 */
function defineEvent<P extends z.ZodTypeAny>(opts: DefineEventOptions<P>) {
  const full = z.strictObject({
    id: idField,
    parent_id: parentIdField,
    ts: tsField,
    run_id: runIdField,
    branch: branchField,
    exec: opts.exec,
    type: z.literal(opts.type).describe(`事件类型（D32 内核封闭集；${opts.family}；写者归属见 D35 唯一写者表）`),
    payload: opts.payload,
  });
  const draft = full.omit({ id: true, parent_id: true });
  return { full, draft };
}

// ===== 编排事实：run_*（FlowRunner，§3.3 状态机 R1–R10）=====

const runStarted = defineEvent({
  type: 'run_started',
  family: '编排事实（R1）：局开始，记录 Bundle 版本身份',
  exec: execNullField,
  payload: z
    .strictObject({
      bundle_hash: Sha256HexSchema.describe('Bundle 全输入 hash（D33：图/组件版本/身份牌/LLM 绑定/世界书/种子全部参与；恢复校验比对它，版本不匹配拒绝恢复）'),
      bundle_path: z.string().min(1).describe('Bundle 目录指针（D24 作品库归因：哪份配置产生了本局）'),
      mode: z.enum(['fresh', 'resume', 'fork']).describe('开局方式：fresh 新局 / resume 崩溃恢复（§2.3）/ fork 同版本内分叉重跑（§2.4-3）'),
      fork_from_event_id: EventIdSchema.nullable().describe('mode=fork 时的分叉锚点事件 id（§2.4-3）；其余为 null'),
    })
    .describe('run_started 载荷（R1/D33）'),
});

const runPaused = defineEvent({
  type: 'run_paused',
  family: '编排事实（R2）：执行器暂停，所有在飞组件已到达安全点',
  exec: execNullField,
  payload: z
    .strictObject({
      reason: z.string().optional().describe('暂停请求来源说明（F15 CLI 控制；人读归因）'),
    })
    .describe('run_paused 载荷（R2）'),
});

const runResumed = defineEvent({
  type: 'run_resumed',
  family: '编排事实（R3/R7）：恢复调度循环；resume 永远沿原图版本继续（D21）',
  exec: execNullField,
  payload: z
    .strictObject({
      from_state: z.enum(['paused', 'error']).describe('恢复来源状态（R3 常规暂停恢复 / R7 导演决策重试或跳过失败节点后恢复）'),
    })
    .describe('run_resumed 载荷（R3/R7）'),
});

const runCompleted = defineEvent({
  type: 'run_completed',
  family: '编排事实（R4）：图执行完毕，终止态；写 run manifest（D24）',
  exec: execNullField,
  payload: z
    .strictObject({
      ending: z.string().describe('结局标识（D24 manifest 结局字段的数据源；取值语义由场景规则定义，如通关/死亡/疯狂）'),
      cost: CostSummarySchema.describe('局末成本汇总（D24/D16 双轨台账的 reduce 终态；manifest 成本汇总的数据源）'),
    })
    .describe('run_completed 载荷（R4）'),
});

const runError = defineEvent({
  type: 'run_error',
  family: '编排事实（R5/R6）：不可恢复失败，ERROR 为挂起态等待导演决策',
  exec: execNullField,
  payload: z
    .strictObject({
      error: FlowRunnerErrorKindSchema.describe('执行器错误枚举（§4.5；错误事件只记枚举与元数据，F7 凭证消毒）'),
      node_id: z.string().min(1).nullable().describe('致错节点 id（onError=stop 的节点失败时为该节点；事件流故障等非节点级为 null）'),
      detail: z.string().optional().describe('元数据级补充说明（禁止原始响应体与凭证落盘，F7/附录 A）'),
    })
    .describe('run_error 载荷（R5/R6）'),
});

const runCancelled = defineEvent({
  type: 'run_cancelled',
  family: '编排事实（R8/R9/R10）：安全点优雅终止；事件流完整保留供分叉重开',
  exec: execNullField,
  payload: z
    .strictObject({
      reason: z.string().optional().describe('取消来源说明（R8 运行中 / R9 暂停中 / R10 导演放弃整局；人读归因）'),
    })
    .describe('run_cancelled 载荷（R8–R10）'),
});

// ===== 编排事实：node_*（FlowRunner 唯一写者，D19/D35）=====

const nodeStart = defineEvent({
  type: 'node_start',
  family: '编排事实（D19）：节点执行开始',
  exec: execRequiredField,
  payload: z
    .strictObject({
      component_type: z.string().min(1).describe('组件类型名（对应 flow.ts FlowNode.type；版本归因的组成，§2.4-1）'),
      component_version: z.string().min(1).describe('组件版本（D19/§2.4-1：节点边界事件记录组件 version，Bundle 锁定）'),
      params: z.unknown().optional().describe('节点入参快照（可选，归因用；权威来源仍是流程图配置，§3.3 重入即参数重读）'),
    })
    .describe('node_start 载荷（D19）'),
});

const nodeEnd = defineEvent({
  type: 'node_end',
  family: '编排事实（D19）：节点执行完成；恢复点 = 最近一个完整落盘的节点边界（D12）',
  exec: execRequiredField,
  payload: z
    .strictObject({
      component_type: z.string().min(1).describe('组件类型名（与 node_start 成对，§2.4-1 版本归因）'),
      component_version: z.string().min(1).describe('组件版本（D19/§2.4-1）'),
    })
    .describe('node_end 载荷（D19）'),
});

const nodeFailed = defineEvent({
  type: 'node_failed',
  family: '编排事实（D19）：节点执行失败，按 onError 策略处理',
  exec: execRequiredField,
  payload: z
    .strictObject({
      component_type: z.string().min(1).describe('组件类型名（§2.4-1 版本归因）'),
      component_version: z.string().min(1).describe('组件版本（D19/§2.4-1）'),
      error: ErrorCodeSchema.describe('失败错误枚举（D5：组件/服务错误编码进结果；onError=stop 时执行器转 ERROR，R5）'),
      detail: z.string().optional().describe('元数据级补充说明（禁止原始响应体与凭证，F7）'),
    })
    .describe('node_failed 载荷（D19/错误矩阵）'),
});

// ===== 游戏语义：gate_*（门组件发射，§3.2 状态机 G1–G8）=====

const gateWaiting = defineEvent({
  type: 'gate_waiting',
  family: '游戏语义（G1）：分支到达门节点，分支级阻塞开始（非执行级挂起）',
  exec: execRequiredField,
  payload: z
    .strictObject({
      targets: z.array(AgentIdSchema).describe('门声明的目标 Agent（门参数；inject/edit_world 类干预无目标为空数组）'),
      accepts: z.array(InterventionKindSchema).min(1).describe('门接受的干预类型子集（D18 封闭集内；note 不经门，D18/D27）'),
      timeout: GateTimeoutPolicySchema.describe('门声明的超时策略（D15）'),
    })
    .describe('gate_waiting 载荷（G1；单门等待约束 D27/D37：第二门进入 WAITING 即节点失败）'),
});

const gateInputReceived = defineEvent({
  type: 'gate_input_received',
  family: '游戏语义（G2/G3）：读到有效干预；导演门重入时据此直接进入 RECEIVED（D36）',
  exec: execRequiredField,
  payload: z
    .strictObject({
      directive: DirectorDirectiveSchema.describe('干预指令全文（D18/D31 全文落盘）'),
      directive_hash: Sha256HexSchema.describe('指令全文 SHA256（D18：hash 作校验，全文作事实）'),
      source: z.enum(['director_inbox', 'timeout_default']).describe('输入来源（G2 导演 inbox / G3 超时采用门默认输入）'),
    })
    .describe('gate_input_received 载荷（G2/G3；D36 门重入判定的查询目标）'),
});

const gateTimeout = defineEvent({
  type: 'gate_timeout',
  family: '游戏语义（G3/G4）：门等待超时，按声明策略走向默认输入或取消分支',
  exec: execRequiredField,
  payload: z
    .strictObject({
      policy: z.enum(['use_default', 'cancel_branch']).describe('到期的超时策略（D15；wait_forever 不产生本事件）'),
      waited_ms: z.number().int().nonnegative().describe('实际等待时长（毫秒；锦标赛无人值守的运行证据）'),
    })
    .describe('gate_timeout 载荷（G3/G4）'),
});

const gateCancelled = defineEvent({
  type: 'gate_cancelled',
  family: '游戏语义（G4/G6）：门激活周期终止，其余分支不受影响',
  exec: execRequiredField,
  payload: z
    .strictObject({
      reason: z.enum(['run_cancelled', 'timeout_cancel_branch']).describe('取消原因（G4 整局取消 / 超时策略取消分支；G6 安全点前整局取消同记 run_cancelled）'),
    })
    .describe('gate_cancelled 载荷（G4/G6）'),
});

// ===== 游戏语义：director_*（干预由门组件发射；note 由 runner 消费泵直落，D18/D27/D35）=====

const directorIntervention = defineEvent({
  type: 'director_intervention',
  family: '游戏语义（G5）：干预在安全点注入完成；「导演如何操纵故事」的核心素材（D31）',
  exec: execRequiredField,
  payload: z
    .strictObject({
      directive: DirectorDirectiveSchema.describe('干预指令全文（D18/D31 全文落盘，可归因）'),
      directive_hash: Sha256HexSchema.describe('指令全文 SHA256（D18 校验）'),
      outcome: z.enum(['applied', 'degraded_to_note']).describe('注入结果（G5 生效 / F2b 注入目标已销毁时降级为 note 仅批注，保可归因）'),
    })
    .describe('director_intervention 载荷（G5/F2b）'),
});

const directorNote = defineEvent({
  type: 'director_note',
  family: 'runner 级（D18/D27）：note 随时可发、仅批注 Script，不需门在等待；消费泵直接落盘',
  exec: execNullField,
  payload: z
    .strictObject({
      text: z.string().min(1).describe('批注全文（D18/D31：指令全文落盘）'),
      directive_hash: Sha256HexSchema.describe('批注全文 SHA256（D18 校验）'),
    })
    .describe('director_note 载荷（D18/D27）'),
});

// ===== 服务事实：agent_*（Agent 服务自动落，§3.1 状态机 A1–A12）=====

const agentCreated = defineEvent({
  type: 'agent_created',
  family: '服务事实（A1/A2）：实例创建并初始化完成',
  exec: execRequiredField,
  payload: z
    .strictObject({
      agent_id: AgentIdSchema,
      card_name: z.string().min(1).describe('身份牌名（归因到 Bundle identity_cards/ 内哪张卡产生了本实例；卡内容经 Bundle hash 锁定，D33）'),
      card_version: z.string().min(1).describe('身份牌版本（identity_card_v1 的 version 字段；版本归因）'),
      model: z.string().min(1).describe('创建时的 LLM 绑定模型名（归因；运行期 fallback 后的实际出账模型以 cost 事件为准）'),
      memory_ref: z.string().min(1).nullable().describe('记忆文件挂载引用（D22：Bundle 声明 agentId → 记忆文件；崩溃恢复重建挂载点的依据）；无挂载为 null'),
    })
    .describe('agent_created 载荷（A1/A2；D22 恢复重建生命周期与挂载点）'),
});

const agentDestroyed = defineEvent({
  type: 'agent_destroyed',
  family: '服务事实（A3/A10/A11/A12）：显式销毁，持久化记忆后释放实例',
  exec: execRequiredField,
  payload: z
    .strictObject({
      agent_id: AgentIdSchema,
      reason: z.string().optional().describe('销毁路径说明（A3 未启用即销毁 / A10 显式销毁 / A11 暂停期销毁 / A12 销毁止损；人读归因）'),
    })
    .describe('agent_destroyed 载荷（A3/A10–A12；不销毁则跨局存续，D22）'),
});

const agentPaused = defineEvent({
  type: 'agent_paused',
  family: '服务事实（A6）：执行器暂停且该 Agent 到达安全点',
  exec: execRequiredField,
  payload: z.strictObject({ agent_id: AgentIdSchema }).describe('agent_paused 载荷（A6）'),
});

const agentResumed = defineEvent({
  type: 'agent_resumed',
  family: '服务事实（A7）：执行器恢复，从冻结点继续',
  exec: execRequiredField,
  payload: z.strictObject({ agent_id: AgentIdSchema }).describe('agent_resumed 载荷（A7）'),
});

const agentError = defineEvent({
  type: 'agent_error',
  family: '服务事实（A8）：不可恢复失败，错误编码进 TurnOutcome，保留现场',
  exec: execRequiredField,
  payload: z
    .strictObject({
      agent_id: AgentIdSchema,
      error: ErrorCodeSchema.describe('致错枚举（LLM 最终失败/abort 超时等，A8；只记枚举与元数据，F7）'),
      detail: z.string().optional().describe('元数据级补充说明（禁止原始响应体与凭证，F7）'),
    })
    .describe('agent_error 载荷（A8）'),
});

const agentRecovered = defineEvent({
  type: 'agent_recovered',
  family: '服务事实（A9）：导演/系统决策重试或跳过，回最近一致安全点（不是回滚事件，§3.3）',
  exec: execRequiredField,
  payload: z
    .strictObject({
      agent_id: AgentIdSchema,
      strategy: z.enum(['retry', 'skip']).describe('恢复策略（A9：重试该回合 / 跳过该回合）'),
    })
    .describe('agent_recovered 载荷（A9）'),
});

// ===== 服务事实：turn_*（Agent 服务自动落，D35；turn 为多次 LLM 往返的完整回合）=====

const turnStart = defineEvent({
  type: 'turn_start',
  family: '服务事实（A4）：回合开始，Agent 进入 RUNNING',
  exec: execRequiredField,
  payload: z
    .strictObject({
      agent_id: AgentIdSchema,
      first_turn: z.boolean().describe('是否该 Agent 的首回合（附录 A：以首回合标志表达 Agent 完整活跃期的起点，pi agent_start 参照）'),
    })
    .describe('turn_start 载荷（A4/附录 A）'),
});

const turnEnd = defineEvent({
  type: 'turn_end',
  family: '服务事实（A5）：回合完成的安全点；steering 队列为空方落本事件',
  exec: execRequiredField,
  payload: z
    .strictObject({
      agent_id: AgentIdSchema,
      outcome: z.enum(['final', 'aborted', 'failed']).describe('回合结局（A5 正常完成 / abort 中断 / 失败——伴随 agent_error 事件）'),
    })
    .describe('turn_end 载荷（A5；干预在目标 Agent 的本安全点生效，D3）'),
});

// ===== 游戏语义：叙事与判定（组件经 F12 显式发射，D31 下游内容契约）=====

const speech = defineEvent({
  type: 'speech',
  family: '游戏语义（D31）：角色发言；由 TurnOutcome 带回组件后发射，不由 Agent 实例中途落（D35）',
  exec: execRequiredField,
  payload: z
    .strictObject({
      agent_id: AgentIdSchema.describe('发言角色（角色归属，D31）'),
      text: z.string().describe('发言全文（D31 下游内容契约：全文 + 角色归属）'),
    })
    .describe('speech 载荷（D31）'),
});

const monologue = defineEvent({
  type: 'monologue',
  family: '游戏语义（D31）：内心独白 = LLM reasoning/thinking 全文，视频解说双线的素材',
  exec: execRequiredField,
  payload: z
    .strictObject({
      agent_id: AgentIdSchema.describe('独白角色（角色归属，D31）'),
      text: z.string().describe('独白全文（D31：monologue 语义含 LLM reasoning/thinking 全文）'),
    })
    .describe('monologue 载荷（D31）'),
});

const dice = defineEvent({
  type: 'dice',
  family: '游戏语义（D31）：骰点入 Script，骰运即素材；同版本 rerun 经种子复现骰点序列（D33）',
  exec: execRequiredField,
  payload: z
    .strictObject({
      expression: z.string().min(1).describe('骰式（如 "1d20+2"；人读归因）'),
      rolls: z.array(z.number().int()).min(1).describe('逐骰结果（骰运即素材，高光帧数据源）'),
      modifier: z.number().describe('总修正值（技能/物资等修正之和；明细见 judgement 事件）'),
      total: z.number().describe('最终结果（rolls 之和 + modifier）'),
      purpose: z.string().optional().describe('检定目的（归因：这次骰点判什么）'),
    })
    .describe('dice 载荷（D31；isekai §2 判定环节）'),
});

const judgement = defineEvent({
  type: 'judgement',
  family: '游戏语义（D31）：裁判判定——档级 + 修正明细',
  exec: execRequiredField,
  payload: z
    .strictObject({
      subject: z.string().min(1).describe('被判定的行动声明（归因：判的是什么行动）'),
      grade: z.string().min(1).describe('档级（D31；档级集合由场景规则参数定义，如 isekai 的大成功/成功/部分成功/失败/大失败）'),
      modifiers: z
        .array(
          z
            .strictObject({
              label: z.string().min(1).describe('修正来源标签（如技能名/物资名；D31 修正明细）'),
              value: z.number().describe('修正值（可正可负）'),
            })
            .describe('单条修正明细（D31）'),
        )
        .describe('修正明细全表（D31：判定事件必须能回答「这个档级怎么算出来的」）'),
      dice_event_id: EventIdSchema.nullable().describe('关联的骰点事件 id（判定的随机性来源归因；无骰判定为 null）'),
      rationale: z.string().optional().describe('裁判说明/数值依据（isekai §2：状态变动须给出数值依据）'),
    })
    .describe('judgement 载荷（D31 判定族：档级 + 修正明细）'),
});

const milestone = defineEvent({
  type: 'milestone',
  family: '游戏语义（D31）：幕/世界/回合边界等语义坐标，与图结构解耦',
  exec: execRequiredField,
  payload: z
    .strictObject({
      kind: z.string().min(1).describe('坐标类型（如 act/world/turn 边界；取值语义由场景定义，D31）'),
      label: z.string().min(1).describe('人读标签（视频分镜的幕间转场锚点，isekai §5）'),
      data: z.record(z.string(), z.unknown()).optional().describe('坐标参数（如 { world: 2, day: 3 }；语义坐标与图结构解耦，D31）'),
    })
    .describe('milestone 载荷（D31）'),
});

const agentToAgent = defineEvent({
  type: 'agent_to_agent',
  family: '游戏语义（D2/F8）：Agent 对 Agent 通信的唯一合法形态——组件编排 + 私有上下文注入 + 事件落盘',
  exec: execRequiredField,
  payload: z
    .strictObject({
      source_agent_id: AgentIdSchema.describe('源 Agent（输出文本的一方）'),
      target_agent_id: AgentIdSchema.describe('目标 Agent（私有上下文被注入的一方，F8）'),
      text: z.string().describe('注入内容全文（可归因：谁对谁说了什么，D2 三级信息分离的审计面）'),
    })
    .describe('agent_to_agent 载荷（D2/F8）'),
});

const bbSet = defineEvent({
  type: 'bb_set',
  family: '游戏语义（D1 写穿）：黑板 set 先落盘为事件、后生效；黑板状态可由事件流完整重建',
  exec: execRequiredField,
  payload: z
    .strictObject({
      key: BlackboardKeySchema,
      value: z.unknown().describe('写入值（JSON 可序列化；F10 键值 JSON）'),
      reason: z.string().optional().describe('数值依据/变更说明（D31 状态变更语义载荷；isekai §2 要求状态表变动给出依据）'),
    })
    .describe('bb_set 载荷（D1/F10；私有上下文不经黑板，D22）'),
});

const judgeRetry = defineEvent({
  type: 'judge_retry',
  family: '游戏语义（D17）：判定输出 schema 校验失败的重试记录；达上限升级导演裁决',
  exec: execRequiredField,
  payload: z
    .strictObject({
      attempt: z.number().int().positive().describe('当前重试序号（从 1 起）'),
      max_attempts: z.number().int().positive().describe('重试上限（D17/D28 统一迭代上限约束；达上限升级导演裁决）'),
      error: ErrorCodeSchema.describe('触发重试的错误枚举（通常为 SCHEMA_MISMATCH；json_object 降级路径，D17/错误矩阵）'),
      detail: z.string().optional().describe('元数据级补充说明（禁止原始响应体，F7）'),
    })
    .describe('judge_retry 载荷（D17）'),
});

const branchDecision = defineEvent({
  type: 'branch_decision',
  family: '编排事实（D7）：分支条件在遍历瞬间求值并落盘；重放时分支走向来自记录而非重新求值',
  exec: execRequiredField,
  payload: z
    .strictObject({
      condition: z.unknown().describe('分支条件 DSL 的 JSON 快照（封闭算子集结构定义见 flow.ts ConditionExpr；本层不 import 以避免契约环依赖）'),
      snapshot: z.record(z.string(), z.unknown()).describe('求值瞬间读取的黑板快照——被引用键子集而非全量（D7；重放确定性的刚需）'),
      result: z.boolean().describe('条件求值结果（F14）'),
      from_port: z.string().min(1).describe('求值边所在输出端口名（对应 flow.ts FlowEdge.from_port）'),
      target_node: z.string().min(1).describe('该边目标节点 id；result=true 时即重放采用的分支走向（D7）'),
    })
    .describe('branch_decision 载荷（D7/F14）'),
});

// ===== 服务事实：cost / prompt_hash / cache_invalidation（D16/D34/D35）=====

const cost = defineEvent({
  type: 'cost',
  family: '服务事实（D16）：每次 LLM 调用落 cost，价格表计算值 + 原始 usage 双轨',
  exec: NodeExecSchema.nullable().describe(
    '节点执行标识（D36）：节点执行内的调用必带（孤儿事件判定中 cost 类除外——真实花费不作废）；加载期 LLM 绑定冒烟（D20）等局外调用为 null',
  ),
  payload: z
    .strictObject({
      agent_id: AgentIdSchema.nullable().describe('归因到 Agent（锦标赛各 Build 成本对比的数据源）；系统级调用为 null'),
      model: z.string().min(1).describe('实际出账模型（fallback 后可能不同于请求模型，deep-dive-llm-gateway 问题 4；价格表查找键）'),
      requested_model: z.string().min(1).optional().describe('请求模型（归因：fallback 发生与否可由此与 model 对比得知）'),
      usage: NormalizedUsageSchema.describe('五字段归一 usage（价格表算账口径）'),
      cost: CostAmountSchema.describe('价格表计算值（D16 双轨之一）'),
      raw_usage: z.unknown().describe('服务商原始 usage JSON 原样落盘（D16 双轨之二；五家字段名不同正是双轨的原因）'),
    })
    .describe('cost 载荷（D16/D28；压缩调用同落，F18）'),
});

const promptHash = defineEvent({
  type: 'prompt_hash',
  family: '服务事实（D16）：每回合静态前缀 SHA256 落 Script，渲染器纯函数的逐字稳定验证',
  exec: execRequiredField,
  payload: z
    .strictObject({
      agent_id: AgentIdSchema.describe('该静态前缀所属 Agent（静态前缀逐 Agent 组装，附录 A 四区结构）'),
      prefix_sha256: Sha256HexSchema.describe('静态前缀 SHA256（D16：防缓存漂移 + 缓存命中率归因——hash 变化即预期命中率归零）'),
    })
    .describe('prompt_hash 载荷（D16）'),
});

const cacheInvalidation = defineEvent({
  type: 'cache_invalidation',
  family: '服务事实（D34/D35）：静态前缀缓存失效，服务在重建前缀时自动落',
  exec: execRequiredField,
  payload: z
    .strictObject({
      agent_id: AgentIdSchema.nullable().describe('受影响的 Agent（静态每 Agent 区失效）；静态共享区失效为 null（附录 A 四区）'),
      reason: z.enum(['edit_world', 'prefix_rebuild']).describe('失效原因（D34 edit_world 改写世界书触发 / 服务重建静态前缀时的自动记录，D35）'),
      detail: z.string().optional().describe('元数据级补充说明（如被改写的 worldbook 键）'),
    })
    .describe('cache_invalidation 载荷（D34/D35；下次上下文组装重建静态段）'),
});

// ===== 控制条目（D11/D32/§2.4；与叙事事件同一信封、不同 type）=====

const snapshot = defineEvent({
  type: 'snapshot',
  family: '控制条目（D11）：内联 reduce 状态检查点，非破坏性；崩溃恢复的定位锚点（§2.3）',
  exec: execNullField,
  payload: z
    .strictObject({
      last_event_id: EventIdSchema.describe('截至本快照已分配的最大事件序号（崩溃恢复续号锚点，deep-dive §1.5-6）'),
      blackboard: z.record(z.string(), z.unknown()).describe('黑板全量键值检查点（§2.3 快照四段之一；D1 可由事件流完整重建的同一状态）'),
      agents: z
        .record(
          z.string(),
          z
            .strictObject({
              state: AgentLifecycleStateSchema.describe('生命周期状态（§3.1 六态）'),
              memory_ref: z.string().min(1).nullable().describe('记忆挂载点引用（D22：恢复重建的是挂载点引用，记忆本身不从事件流重建）'),
            })
            .describe('单个 Agent 的生命周期检查点'),
        )
        .describe('Agent 生命周期表（§2.3 快照四段之二）'),
      progress: z
        .record(
          z.string(),
          z
            .strictObject({
              status: z.enum(['running', 'waiting', 'completed', 'failed']).describe('该次节点执行的状态（waiting = join 等待中，D8）'),
              detail: z.unknown().optional().describe('附加调度状态（如 join 等待表条目，D8 按迭代计数隔离配对）'),
            })
            .describe('单键调度进度'),
        )
        .describe('调度进度表（§2.3 快照四段之三；键为 "节点id#迭代计数" 的序列化元组，§3.3）'),
      ledger: CostSummarySchema.describe('成本账本切片（§2.3 快照四段之四，D28；恢复时随快照还原，成本闸在恢复后不清零——deep-dive §2.4-1）'),
    })
    .describe('snapshot 载荷（D11 内联条目；四段组织见 deep-dive §2.4-1；落点时机：周期节点边界 + 局末 + pause，D30）'),
});

const fork = defineEvent({
  type: 'fork',
  family: '控制条目（§2.4-3）：同版本内从任意事件分叉新分支，共享前缀事实',
  exec: execNullField,
  payload: z
    .strictObject({
      at_event_id: EventIdSchema.describe('分叉锚点事件 id（分叉点之后的一切局外输入在 rerun 时全部重新发生，§2.4-6）'),
      new_branch: BranchIdSchema.describe('新分支标识（后续 append 携带该 branch；旧分支封存不再增长）'),
      reason: z.string().optional().describe('分叉动机（归因：如换一个干预重来一轮）'),
    })
    .describe('fork 载荷（§2.4-3；append-only，D32 同信封）'),
});

const system = defineEvent({
  type: 'system',
  family: 'runner 级：无效导演输入、JSONL 尾部半行、观察者故障等系统注记（F1/§2.3/D10）',
  exec: execNullField,
  payload: z
    .strictObject({
      code: z.string().min(1).describe('机器可读分类（如 invalid_director_line / jsonl_tail_truncated / observer_render_failed）'),
      message: z.string().describe('人读说明（CLI 告警的同步文本）'),
      severity: z.enum(['info', 'warning', 'error']).describe('严重级（观察者纪律 D10：局外故障不影响局内，仅注记）'),
    })
    .describe('system 载荷（F1 无效行 / §2.3 尾部半行丢弃 / 错误矩阵观察者纪律）'),
});

// ===== 内核封闭集汇总（D32）=====

const KERNEL_EVENT_DEFS = [
  runStarted, runPaused, runResumed, runCompleted, runError, runCancelled,
  nodeStart, nodeEnd, nodeFailed,
  gateWaiting, gateInputReceived, gateTimeout, gateCancelled,
  directorIntervention, directorNote,
  agentCreated, agentDestroyed, agentPaused, agentResumed, agentError, agentRecovered,
  turnStart, turnEnd,
  speech, monologue, dice, judgement, milestone, agentToAgent, bbSet, judgeRetry, branchDecision,
  cost, promptHash, cacheInvalidation,
  snapshot, fork, system,
] as const;

/** 内核事件类型名清单（D32 内核封闭集；注册表校验时自定义类型不得与之冲突——命名空间前缀约定使其天然不冲突）。 */
export const KERNEL_EVENT_TYPES = KERNEL_EVENT_DEFS.map((d) => d.full.shape.type.value) as readonly string[];

/** 内核事件 discriminated union（封闭集，D32/D35）。 */
export const KernelEventSchema = z
  .discriminatedUnion('type', KERNEL_EVENT_DEFS.map((d) => d.full) as unknown as [z.ZodDiscriminatedUnionOption<'type'>, ...z.ZodDiscriminatedUnionOption<'type'>[]])
  .describe('内核事件封闭集（D32）：38 个类型，写者归属见 D35 唯一写者表');
export type KernelEvent = z.infer<typeof KernelEventSchema>;

/** 内核事件草稿 union：append 入参（无 id/parent_id，由 EventLog 取号，deep-dive §1.5-3/4）。 */
export const KernelEventDraftSchema = z
  .discriminatedUnion('type', KERNEL_EVENT_DEFS.map((d) => d.draft) as unknown as [z.ZodDiscriminatedUnionOption<'type'>, ...z.ZodDiscriminatedUnionOption<'type'>[]])
  .describe('内核事件草稿（append 入参）：无 id/parent_id，EventLog 在 append/TCAS 批串行提交时取号（deep-dive §1.5-3/4）');
export type KernelEventDraft = z.infer<typeof KernelEventDraftSchema>;

// ===== 开放注册集（D32）：组件自定义事件 =====

/**
 * 自定义事件类型命名约定：必须含命名空间前缀（至少两段，全小写，如 `isekai.omen_triggered`）。
 * 内核类型不含 '.'，二者天然不冲突（D32 命名空间前缀约定）。
 */
export const CUSTOM_EVENT_TYPE_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;

export const CustomEventTypeSchema = z
  .string()
  .regex(CUSTOM_EVENT_TYPE_RE)
  .describe('组件自定义事件类型（D32 开放注册集）：必须含命名空间前缀（如 isekai.omen_triggered）；内核类型无 "."，天然不冲突');

const customFull = z.strictObject({
  id: idField,
  parent_id: parentIdField,
  ts: tsField,
  run_id: runIdField,
  branch: branchField,
  exec: execRequiredField.describe('节点执行标识（D36）：自定义事件由组件在节点执行内发射，必带'),
  type: CustomEventTypeSchema,
  payload: z.unknown().describe('自定义载荷（组件自定义事件族，D32 开放集；载荷结构由组件自定义并自行版本化）'),
});

/** 组件自定义事件（开放集，未按注册表收紧的形态）。 */
export const CustomEventSchema = customFull.describe('组件自定义事件（D32 开放注册集）；EventLog 按注册表校验（createEventSchema）');
export type CustomEvent = z.infer<typeof CustomEventSchema>;

/** 组件自定义事件草稿（append 入参形态）。 */
export const CustomEventDraftSchema = customFull
  .omit({ id: true, parent_id: true })
  .describe('组件自定义事件草稿（append 入参，deep-dive §1.5-3）');
export type CustomEventDraft = z.infer<typeof CustomEventDraftSchema>;

// ===== 全量事件 Schema 与注册表工厂 =====

/** Script JSONL 单行的全量契约：内核封闭集 ∪ 自定义开放集（D32）。 */
export const EventSchema = z
  .union([KernelEventSchema, CustomEventSchema])
  .describe('事件全量契约（D32）：内核封闭集 + 组件自定义开放集；同一信封，append-only 树');
export type Event = z.infer<typeof EventSchema>;

/** append 入参的全量契约（草稿形态，deep-dive §1.5-3）。 */
export const EventDraftSchema = z
  .union([KernelEventDraftSchema, CustomEventDraftSchema])
  .describe('事件草稿全量契约：EventLog.append 的入参（无 id/parent_id，写者不自带 id）');
export type EventDraft = z.infer<typeof EventDraftSchema>;

/**
 * 按注册表构建事件校验器（D32「校验器按注册表校验」的落地）：
 * 内核封闭集之外，仅接受 customTypes 中显式注册的自定义类型。
 * 非法类型名（不符合命名空间前缀约定）直接抛错——这是契约构建期错误，非运行期。
 */
export function createEventSchema(customTypes: readonly string[]) {
  for (const t of customTypes) {
    if (!CUSTOM_EVENT_TYPE_RE.test(t)) {
      throw new Error(`非法自定义事件类型名（须含命名空间前缀，如 isekai.omen_triggered）: ${t}`);
    }
  }
  const customs = customTypes.map((t) =>
    z.strictObject({
      id: idField,
      parent_id: parentIdField,
      ts: tsField,
      run_id: runIdField,
      branch: branchField,
      exec: execRequiredField,
      type: z.literal(t).describe('已注册的组件自定义事件类型（D32 注册表）'),
      payload: z.unknown().describe('自定义载荷（结构由注册组件定义）'),
    }),
  );
  return z.union([KernelEventSchema, ...customs]);
}
