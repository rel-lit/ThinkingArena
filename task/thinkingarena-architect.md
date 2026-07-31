# ThinkingArena 多阶段任务书（v2，架构师修订）

> v2 修订说明（2026-07-31，架构师）：阶段 0 完成后，架构经多轮审查演进（决策 D1–D37），原阶段 1 的问题清单部分已被决策回答。v2 按现状裁剪：阶段 1 由 3 组减为 2 组，阶段 2/3 同步修正工具链与路径。

---

## 阶段 0：运转架构设计 ✅ 已完成

- 产出：`docs/design/runtime-architecture.md`（v1.0，决策 D1–D37）
- 验收：四条标准全部通过（来源标注 / 无魔法箭头 / 无死状态 / 错误枚举）；另经 4 份外部独立审查（8.6–8.8/10）与机械终检
- 辅助产出：`docs/design/layers.md`（分解树 + 决策覆盖索引）

---

## 阶段 1：细化调研（2 个 Agent 并行，裁剪版）

### 任务名称
`thinkingarena-research-{topic}`

### 输入
- `docs/design/runtime-architecture.md`（阶段 0 产出，唯一架构权威）
- `docs/used-reference/investigation/` 下对应原始调研报告

### 任务分组

#### Agent 1-A：事件流与持久化（瘦身版）
> 原问题中"崩溃时在飞 LLM 请求处理"（D12/D36 已答）、"快照检查点必要性"（D11/D30 已答）已移除。

**具体问题**：
1. **事件 id / parent_id 生成方案选型**：候选（UUID v4 / UUID v7 / ULID / 分支内单调序号 / 内容 hash）对照评估。约束：一局一进程单写者（D23）、append-only 树 + fork 控制条目（D32）、重放确定性、与节点执行标识（D36）的关系。参考 pi 的 `packages/coding-agent/src/core/session-manager.ts` 实际用法（GitHub 可查）。
2. **快照频率数值**：估算 Node 下逐行 JSON.parse + reduce 重放 1 万 / 10 万事件的耗时量级，给出快照间隔建议（每 N 事件 / 每 M 节点边界），与 D30 策略（周期 + 局末 + pause）对齐。

**产出**：`docs/used-reference/investigation/deep-dive-event-log.md`
- 含：候选对照表、测算依据、明确推荐值、每项结论的"对架构/契约的影响"一节

#### Agent 1-B：LLM 网关与成本（原 1-C，全部有效）
**具体问题**（针对 DeepSeek / Kimi(Moonshot) / Anthropic / OpenAI / 豆包(火山方舟) 五家）：
1. **usage 字段格式**：prompt/completion/cached tokens 的字段名与计费口径（2026-07 最新官方文档）
2. **结构化输出支持矩阵**：`response_format` json_schema / json_object / 工具调用的各家支持度与已知怪癖现状（如 DeepSeek 对象形式报 500、Kimi 不支持 required——验证是否仍成立）
3. **缓存机制现状**：自动缓存 vs 显式断点、缓存读写价格
4. **fallback 能力分级建议**：同能力级模型映射表（主 → 备），供 D13 薄路由使用
5. **Vercel AI SDK `generateObject`** 在上述五家的实际行为差异

**产出**：`docs/used-reference/investigation/deep-dive-llm-gateway.md`
- 含：服务商差异对照表、缓存策略矩阵、fallback 链建议、每项结论的"对架构/契约的影响"一节

### 验收标准
1. 每份报告只回答上述具体问题，不泛泛调研
2. 包含可验证的官方文档/源码引用（URL）
3. 每个结论都有"对架构/契约的影响"一节

### 已移除（原 1-B 并发与调度，整组）
TCAS 语义（D9 批协议）、join 语义（D8 全到达+超时转 ERROR）、导演门阻塞期事件排序（D35/D9）、AbortController 传递（§4.7）——均已在架构文档中定案，无需再研。

---

## 阶段 2：Schema 定义（1 个 Agent，修正版）

### 任务名称
`thinkingarena-schema`

### 输入
- `docs/design/runtime-architecture.md`（阶段 0）
- `docs/used-reference/investigation/deep-dive-*.md`（阶段 1）
- `docs/scenarios/isekai-survival.md`（验证用例）

### 任务
产出 `schema/` 目录，包含以下 6 个文件：

| 文件 | 内容 |
|---|---|
| `schema/event.ts` | 事件契约 Zod Schema（discriminated union；信封含节点执行标识 D36、墙钟 D31；内核封闭集 + 开放注册 D32） |
| `schema/flow.ts` | 流程图配置 Zod Schema（节点、边、封闭算子条件 DSL D7） |
| `schema/meta-component.ts` | 元组件接口 Zod Schema（AgentTool 契约，§4.7） |
| `schema/identity-card.ts` | 身份牌 Zod Schema（MVP 简化版，见下） |
| `schema/bundle.ts` | Bundle 目录结构 + run manifest（D24）+ 版本 hash 输入集（D33） |
| `schema/errors.ts` | 全局错误码枚举（§4 六组枚举的落地） |

### 关键约束
1. **每个字段必须有 `.describe()` 说明其存在理由**，追溯到运转架构中的某个数据流或决策
2. **所有 Schema 必须可导出 JSON Schema**（`z.toJSONSchema()` 测试通过）
3. **对外暴露的 Schema 禁用 `.transform()` 和 `.refine()`**（保证序列化无损），自定义校验放运行时守卫
4. **版本号从 `v1.0.0` 开始**，文件头标注 `// Version: 1.0.0`
5. 测试框架为 **`node:test`**（Node LTS 直接跑 TS），~~不是 bun~~（v2 修正）

### 身份牌 MVP 简化（v2 修正）
原任务书的字段集（含 `systemPrompt`、砍 scenario/mesExample）与 `used-reference/design/overview.md` §7.5 不一致。Schema Agent 需先裁决字段集，候选以 overview §7.5 为基础从精简：

```typescript
const IdentityCardV1 = z.object({
  version: z.literal("1.0"),
  name: z.string(),
  description: z.string(),
  personality: z.string().optional(),
  scenario: z.string().optional(),   // v2：保留，isekai Build 卡需要场景设定
  // 明确禁止出现模型字段（校验器机械保证）
});
```

**不要**实现：Tavern v2 导入、World Info、L0–L9 渲染器、缓存策略。这些留到后续版本；prompt 分层按"四区 + 不变量"口径（runtime-architecture.md 附录 A），不照抄 L0–L9 表格。

### 验收标准
1. `node --test schema/` 全部通过（正向/反向测试用例）
2. 能解析 isekai-survival 的示例 Bundle（Bundle 目录形态，非场景文档本身）
3. 每个 Schema 的 JSON Schema 导出与 Zod 定义等价（round-trip 测试）

---

## 阶段 3：模块实现（4 个 Agent 并行，修正版）

### 任务名称
`thinkingarena-impl-{module}`

### 输入
- `schema/` 目录（阶段 2，唯一权威）
- `docs/design/runtime-architecture.md`（理解上下文）
- `docs/used-reference/investigation/deep-dive-*.md`（实现参考）

### 任务分组

#### Agent 3-A：服务层
**产出**：
- `services/agent.ts`（Agent 实例管理，含 abort）
- `services/memory.ts`（滚动摘要，MVP 简化为截断；F17 沉淀通道）
- `services/blackboard.ts`（写穿 + applyEvent 恢复双路径）
- `services/event-log.ts`（JSONL 追加 + 重放吐序列 + 内联快照）
- `services/llm-gateway.ts`（AI SDK 薄路由 + 双轨台账）

**约束**：
- 每个服务有独立单元测试（`node:test`）
- 服务间不直接调用，只通过元组件层间接调用（记忆压缩调用 LLM 网关除外，F18）
- 错误处理符合架构文档的错误矩阵

#### Agent 3-B：元组件层 + 组件层
**产出**：
- `meta/` 目录（call_agent / inject_context / bb_get / bb_set / emit_event / await_director_input）
- `components/` 目录（内置组件：角色创建/销毁、叙事、判定、骰子、导演门）

**约束**：
- 元组件严格遵循 `MetaComponent` 接口（Schema 定义）
- 组件无状态两元结构，`version` 字段从第一天存在
- 导演门组件必须实现分支级阻塞（非执行级挂起），MVP 单门等待（D27）

#### Agent 3-C：编排层
**产出**：
- `orchestrator/flow-runner.ts`（外观）+ 内部模块 graph / scheduler / reducer / director-pump / ledger
- `orchestrator/graph-parser.ts`（流程图解析与加载期校验 D20）

**约束**：
- 首局范围：线性 + 回边 + 条件分支（§0.2）；join/TCAS 批协议（D8/D9）不在本期实现但接口预留
- 回边即循环，无循环原语；调度进度以（节点， 迭代计数）表达
- 分支条件使用声明式比较算子 DSL（非可执行表达式）

#### Agent 3-D：CLI + 集成测试
**产出**：
- `cli/run.ts`（运行一局）/ `cli/replay.ts`（重放 Script）/ 观察视图（F16）
- `tests/smoke.test.ts` / `tests/e2e/linear-first-game.test.ts`

**约束**：
- CLI 使用 `node:util parseArgs`
- 端到端测试跑线性首局（isekai 单世界切片），不依赖外部 LLM（使用 mock）
- run manifest 写出验证（D24）

### 验收标准
1. `node --test` 全部通过
2. 线性首局能完整跑完并产出 Script + manifest
3. replay 能重放并输出一致状态
4. 核心规模 ≤ 2500 行（规模纪律）

---

## 执行顺序与检查点

```
阶段 0：架构师 ───────────────────────────────→ ✅ runtime-architecture.md
           │
           ↓（架构师裁剪问题清单）
阶段 1：调研 Agent-A / Agent-B ────────────────→ deep-dive-event-log.md / deep-dive-llm-gateway.md
           │
           ↓（全部完成，人工审核"问题都回答了"）
阶段 2：Schema Agent ──────────────────────────→ schema/ 目录（冻结 v1.0.0）
           │
           ↓（round-trip 测试通过）
阶段 3：实现 Agent-A / B / C / D ──────────────→ 可运行的线性首局
```

**检查点**：
- 阶段 1 → 2：所有 deep-dive 报告通过人工审核
- 阶段 2 → 3：Schema 通过 round-trip 测试（Zod ↔ JSON Schema 等价）
- 阶段 3 → Phase 2：线性首局 Script + 成本报告验收；核心行数审计

---

## 一句话总结

> 先让架构师画"怎么转"（✅），再让调研 Agent 补"还缺的事实"（事件 id / 快照频率 / 服务商现状），再让 Schema Agent 定"接口长什么样"，最后让实现 Agent 按"首局线性"的范围写代码。
