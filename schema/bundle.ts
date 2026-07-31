// Version: 1.0.0
/**
 * Scenario Bundle 契约：一局的全部输入（目录，进 git）+ run manifest（D24）。
 *
 * Bundle 目录形态（used-reference/design/overview.md §4.3）：
 *   flow.yaml          流程图配置（schema/flow.ts）
 *   game.yaml          规则参数 + LLM 绑定 + Agent 名册 + 成本闸/快照策略
 *   identity_cards/    身份牌目录（schema/identity-card.ts，一卡一文件）
 *   worldbook.yaml     世界书（加载期导入黑板 worldbook 保留命名空间，D34）
 *   seeds.yaml         种子（D33：参与版本身份，同版本 rerun 复现骰点序列）
 *
 * 版本域身份（D33）：Bundle 全输入 hash——图、组件版本、身份牌、LLM 绑定、世界书、种子全部参与；
 * run_started 记录该 hash，恢复校验比对它。hash 计算（规范化与算法）属实现层，本契约定义输入集与格式。
 */
import { z } from 'zod';
import { FlowConfigSchema } from './flow.ts';
import { IdentityCardV1Schema } from './identity-card.ts';
import { AgentIdSchema, CostSummarySchema, EventIdSchema, RunIdSchema, Sha256HexSchema } from './event.ts';
import { FlowRunnerErrorKindSchema } from './errors.ts';

// ===== Bundle 目录布局约定 =====

/** Bundle 目录内文件名约定（overview §4.3 Bundle 目录形态的落地）。 */
export const BUNDLE_LAYOUT = {
  flow: 'flow.yaml',
  game: 'game.yaml',
  identityCardsDir: 'identity_cards',
  worldbook: 'worldbook.yaml',
  seeds: 'seeds.yaml',
} as const;

// ===== game.yaml：LLM 绑定与规则参数 =====

/** LLM 绑定（game.yaml）：身份与模型解耦的另一半——「用什么模型扮演这个角色」（overview §7.5）。 */
export const ModelBindingSchema = z
  .strictObject({
    model: z.string().min(1).describe('主模型名（LLM 网关按名路由，§4.4 route；价格表查找键）'),
    tier: z
      .string()
      .min(1)
      .optional()
      .describe('能力级（D13 同能力级 fallback 的组织维度；deep-dive-llm-gateway 问题 4：RouteDecision 需显式 tier）'),
    fallback: z
      .array(z.string().min(1))
      .optional()
      .describe('显式 fallback 链（同能力级候选模型名，按序；D13 薄路由，链耗尽=NO_FALLBACK_AVAILABLE）'),
    params: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('采样参数（如 temperature；透传服务商 API——L0 区，附录 A「L0 不是 prompt 内容」）'),
  })
  .describe('LLM 绑定（overview §7.5：同一身份牌可绑定不同模型，A/B 测试与成本优化；fallback 只换模型不换角色身份）');
export type ModelBinding = z.infer<typeof ModelBindingSchema>;

/** Agent 名册条目（game.yaml）：实例 id → 身份牌 + LLM 绑定 + 记忆挂载。 */
export const AgentBindingSchema = z
  .strictObject({
    id: AgentIdSchema,
    identity_card: z.string().min(1).describe('身份牌文件名（identity_cards/ 目录内；身份与 LLM 解耦——卡内禁模型字段，绑定在此处）'),
    model: ModelBindingSchema.describe('该实例的 LLM 绑定'),
    memory_ref: z
      .string()
      .min(1)
      .nullable()
      .describe('跨局记忆文件挂载引用（D22：Bundle 声明 agentId → 记忆文件；崩溃恢复经 agent_created 事件重建挂载点）；无挂载为 null'),
  })
  .describe('Agent 名册条目（D22/D33；创建时经 agent_created 事件落盘归因）');
export type AgentBinding = z.infer<typeof AgentBindingSchema>;

/** 成本闸配置（D28：局级预算阈值；机制必须在场，阈值可设极大值——§0.2 最小实现）。 */
export const CostBudgetSchema = z
  .strictObject({
    max_total: z.number().nonnegative().describe('局级成本预算阈值（累计超阈 → 局暂停并通知导演，D28）'),
    currency: z.string().min(1).describe('预算币种（与价格表一致；DeepSeek 峰谷 2x 期间预算消耗加速，配置时须提示导演）'),
  })
  .describe('成本闸（D28；账本为 cost 事件 reduce 派生切片，无独立台账）');
export type CostBudget = z.infer<typeof CostBudgetSchema>;

/** 快照策略（D30 周期 + deep-dive §2.3 建议值；配置项而非常量——锦标赛与交互式单局膨胀容忍度不同）。 */
export const SnapshotPolicySchema = z
  .strictObject({
    every_node_boundaries: z
      .number()
      .int()
      .positive()
      .describe('每隔多少个节点边界允许落快照（deep-dive §2.3 建议 10；快照落在节点边界与 D12 恢复点天然对齐）'),
    min_events: z
      .number()
      .int()
      .positive()
      .describe('距上次快照至少多少事件才落（deep-dive §2.3 建议 500；双条件先到为准，最坏恢复量 < 5ms）'),
  })
  .describe('快照频率策略（D30 周期条件；局末与 pause 必落不在此配置——无条件执行）');
export type SnapshotPolicy = z.infer<typeof SnapshotPolicySchema>;

/** game.yaml 顶层：规则参数 + LLM 绑定 + 执行约束。 */
export const GameConfigSchema = z
  .strictObject({
    version: z.literal('1.0').describe('game.yaml 格式版本（契约独立版本化，overview §7.6）'),
    rules: z
      .record(z.string(), z.unknown())
      .describe('场景规则参数开放命名空间（如 isekai 的状态表初始值/世界序列/档级阈值；不属于通用契约，由场景组件加载期自行校验）'),
    agents: z.array(AgentBindingSchema).min(1).describe('Agent 名册（至少 1 个实例；创建组件按此创建，§3.1 A1）'),
    cost_budget: CostBudgetSchema.optional().describe('成本闸（D28；缺省=不设闸，仅交互式调试点允许）'),
    iteration_limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('统一迭代上限（D28：工具循环、截断重发、judge_retry 共享；缺省值由实现层给）'),
    snapshot: SnapshotPolicySchema.optional().describe('快照频率策略（D30/deep-dive §2.4-2；缺省取建议值 10 节点边界 + 500 事件）'),
  })
  .describe('game.yaml 顶层（规则参数 + LLM 绑定；D20 加载期完成绑定冒烟，失败则局不开始）');
export type GameConfig = z.infer<typeof GameConfigSchema>;

// ===== worldbook.yaml =====

/** 世界书（D34：加载期导入黑板 worldbook 保留命名空间；写者仅导演门组件，D26）。 */
export const WorldBookSchema = z
  .strictObject({
    version: z.literal('1.0').describe('worldbook.yaml 格式版本（契约独立版本化）'),
    entries: z
      .array(
        z
          .strictObject({
            key: z
              .string()
              .regex(/^[a-z][a-z0-9_]*$/)
              .describe('条目键（导入后为黑板键 worldbook.<key>，D34；edit_world 写穿同一命名空间）'),
            title: z.string().min(1).optional().describe('人读标题（L3 静态段渲染时的分节名，附录 A）'),
            content: z.string().min(1).describe('条目正文（L3 静态段内容源；静态前缀逐字稳定置前的组成部分，附录 A 不变量）'),
          })
          .describe('世界书条目（D34）'),
      )
      .describe('世界书条目列表（运行时以可写副本放黑板 worldbook 命名空间，写者仅导演门组件，D26/D34）'),
  })
  .describe('worldbook.yaml 顶层（D34；edit_world 触发 cache_invalidation 后 L3 段于下次组装重建）');
export type WorldBook = z.infer<typeof WorldBookSchema>;

// ===== seeds.yaml =====

/** 种子（D33：参与 Bundle 版本身份——同版本 rerun 复现骰点序列，改种子即改版、开新分支）。 */
export const SeedsSchema = z
  .strictObject({
    version: z.literal('1.0').describe('seeds.yaml 格式版本'),
    rng_seed: z.number().int().describe('随机源种子（骰子等局内随机性的根；同版本 rerun 复现骰点序列，D33）'),
    llm_seed: z
      .number()
      .int()
      .nullable()
      .describe('LLM 采样种子（服务商支持时透传，不支持则忽略；null=不指定；参与版本身份，D33）'),
  })
  .describe('seeds.yaml 顶层（D33；core-loop：种子属 Bundle）');
export type Seeds = z.infer<typeof SeedsSchema>;

// ===== 装配态 Bundle（加载后的内存形态）=====

/** Scenario Bundle（装配态）：目录全部输入经各文件契约解析后的合体；D33 hash 的输入即本形态的规范化序列化。 */
export const ScenarioBundleSchema = z
  .strictObject({
    flow: FlowConfigSchema.describe('流程图配置（flow.yaml）'),
    game: GameConfigSchema.describe('规则参数 + LLM 绑定（game.yaml）'),
    identity_cards: z
      .record(z.string(), IdentityCardV1Schema)
      .describe('身份牌表：键 = identity_cards/ 内文件名，值 = identity_card_v1（加载期先过模型字段守卫再解析）'),
    worldbook: WorldBookSchema.describe('世界书（worldbook.yaml，D34）'),
    seeds: SeedsSchema.describe('种子（seeds.yaml，D33）'),
  })
  .describe('Scenario Bundle 装配态（一局的全部输入，overview §4.3；D20 加载期校验 + LLM 绑定冒烟，失败则局不开始）');
export type ScenarioBundle = z.infer<typeof ScenarioBundleSchema>;

// ===== D33 版本 hash 输入集 =====

/** Bundle 版本 hash 的输入集（D33 原文枚举）：图、组件版本、身份牌、LLM 绑定、世界书、种子全部参与。 */
export const BUNDLE_HASH_INPUTS = [
  'graph',
  'component_versions',
  'identity_cards',
  'llm_bindings',
  'worldbook',
  'seeds',
] as const;
export type BundleHashInput = (typeof BUNDLE_HASH_INPUTS)[number];

/** Bundle 版本 hash（D33；格式同 Sha256Hex——run_started 记录、恢复校验比对、manifest 归因）。 */
export const BundleHashSchema = Sha256HexSchema.describe(
  'Bundle 全输入 hash（D33：graph/component_versions/identity_cards/llm_bindings/worldbook/seeds 全部参与；改任一输入=改版开新分支，D21）',
);
export type BundleHash = z.infer<typeof BundleHashSchema>;

// ===== run manifest（D24 作品库）=====

/** manifest 状态（D24 写入时机：run 落定 COMPLETED/cancel 时写；进入 ERROR 挂起时也写一份标记 error，恢复后幂等重写）。 */
export const RUN_MANIFEST_STATUSES = ['completed', 'cancelled', 'error'] as const;
export const RunManifestStatusSchema = z
  .enum(RUN_MANIFEST_STATUSES)
  .describe('局状态（D24：completed/cancelled 落定 / error 挂起——等待导演决策 resume/cancel，§3.3 补充语义）');
export type RunManifestStatus = z.infer<typeof RunManifestStatusSchema>;

/** 族谱指针（D24：跨版本 = 新局新文件，manifest 记录源局与源事件 id；deep-dive §1.5-7 二元组）。 */
export const GenealogyPointerSchema = z
  .strictObject({
    source_run_id: RunIdSchema.describe('源局 run id（改版再开的上一版；跨局引用须 run id + 事件 id 二元组，deep-dive §1.5-7）'),
    source_event_id: EventIdSchema.describe('源事件 id（改版分叉的叙事锚点：从源局哪条事件之后改版）'),
  })
  .describe('族谱指针（D24 版本谱系；无源局=初代版本，为 null——见 RunManifest.genealogy）');
export type GenealogyPointer = z.infer<typeof GenealogyPointerSchema>;

/** run manifest（D24）：一局面向上层与下游的文件层落点；Script 的派生物，缺失可由 CLI 重扫补写。 */
export const RunManifestSchema = z
  .strictObject({
    run_id: RunIdSchema.describe('局 id（UUID v7；run 目录命名的组成部分——目录名含场景/日期/Build 标识，D24）'),
    scenario: z.string().min(1).describe('场景名（作品库检索维度，D24「库可检索」）'),
    bundle_hash: BundleHashSchema.describe('Bundle 版本 hash（D33；可归因：哪版配置产生了本局）'),
    bundle_path: z.string().min(1).describe('Bundle 目录指针（D24 Bundle 指针）'),
    started_at: z.iso.datetime().describe('开局墙钟（D31 时间纪律）'),
    ended_at: z.iso.datetime().nullable().describe('落定墙钟（COMPLETED/cancel）；error 挂起中为 null'),
    status: RunManifestStatusSchema,
    ending: z.string().nullable().describe('结局（D24；run_completed 事件的 ending；未完成为 null）'),
    cost: CostSummarySchema.describe('成本汇总（D24「账可汇总」：跨局成本聚合 = 扫描 manifest，CLI/下游职责）'),
    genealogy: GenealogyPointerSchema.nullable().describe('族谱指针（D24；初代版本为 null）'),
    schema_version: z.string().min(1).describe('本 manifest 与 Script 遵循的事件契约版本（下游 M2/M3 兼容判据，F13）'),
    error: z
      .strictObject({
        code: FlowRunnerErrorKindSchema.describe('挂起原因枚举（status=error 时记录；只记枚举与元数据，F7）'),
        detail: z.string().optional().describe('元数据级补充说明'),
      })
      .optional()
      .describe('error 挂起的元信息（D24「标记 error」；status≠error 时缺省）'),
  })
  .describe('run manifest（D24；临时文件 + rename 原子写，D29；manifest 是 Script 派生物，缺失可重扫补写）');
export type RunManifest = z.infer<typeof RunManifestSchema>;
