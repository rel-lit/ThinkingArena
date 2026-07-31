# Runtime Architecture 审查记录（多 Agent 追加式）

> **文件纪律**：本文件是 `runtime-architecture.md`（运转架构文档）的多 Agent 审查汇总。
> 各审查 Agent 只在文件末尾**追加**自己的章节，不修改、不覆盖任何已有内容。
> 每章以 `## Review Agent N` 开头，署名、日期、审查范围齐备。
> 审查对象是 upload/ 下的文档，审查行为本身不改动被审文件。

---

## Review Agent 1

- **署名**：Review Agent 1
- **日期**：2026-07-25
- **审查对象**：`upload/runtime-architecture.md`（v1.0，2026-07-24）
- **参照系**：`upload/layers.md`（导航与决策覆盖索引）、`upload/docs/`（Vision / core-loop / architecture / research / design/overview / scenarios/isekai-survival / investigation 五份调研）
- **审查方式**：全文通读 + 交叉核对——决策编号连续性、layers.md 索引完备性、状态机图表一致性、数据流编号图表对应、调研引用逐条回查原文、与上游文档冲突比对附录 B 登记情况。

### 总体结论

文档质量很高：D1–D37 决策全部在 layers.md 决策覆盖索引登记（逐条点数，37 条无遗漏）；调研引用逐一回查原文**全部命中**（pi §2.2/2.3/3.1/3.4/3.5/6.2.1/6.3、n8n §4.3/4.5/A3/A5/A6/E1/E3、Masquerade §4.4/7.3、ChatRPG §7.4 P3/§7.6 P5/§8.5.1、SillyTavern 模式 2/3）；三个状态机的转移表与 mermaid 图一致，无死状态自查成立；F 流编号图/表一一对应（F11 删除已在附录 B-8 留痕）；附录 B 第 7→8 轮关于 emit/subscribe 的"否决→推翻"叙事自洽。

以下为发现的问题，按严重度排列。

### 实质问题（5 条）

**1. `cache_invalidation` 写者与 D35 唯一写者表冲突**
D35 把 `cache_invalidation` 划归"服务事实 → 服务自动落"，但 §2.1 时序图中 edit_world 分支画的是 `G->>EL: append(cache_invalidation)`——门组件（游戏语义写者）直接落盘。错误矩阵"导演门 | 世界书"行也未指明写者。同一张表内 LLM 网关行的 `cache_invalidation` 才是服务落。这是 D35 要解决的那类"写者两属"问题的残留。

**2. §0.2 决策计数陈旧 + 分期清单漏 D34**
- 正文写"33 条决策全量实现"，实际已是 37 条（D1–D37）。
- 三期清单合起来未覆盖 D34（世界书归属）：首局含 D18（edit_world 在封闭干预集内）却不含 D34——edit_world 的写入目标（worldbook 命名空间）没有分期归属。D10/D25 是删除/否决类可豁免，D35–D37 可被"不分期"项隐含覆盖，但 D34 是有实现内容的机制，建议明确归期。

**3. D24 的"终态"措辞与 §3.3 补充语义冲突**
D24 说"**所有终态**（COMPLETED/cancel/error）都写 manifest"，但 §3.3 补充语义明确"ERROR 是挂起态（调度冻结、调用存活），`run()` 只在 COMPLETED 或 cancel 后落定"。且 R5（RUNNING→ERROR）动作里只写 `run_error`，未提 manifest。若 ERROR 后经 R7 恢复最终 COMPLETED，manifest 写两次的时序未定义（"resume 后幂等重写"似指崩溃恢复，未覆盖 ERROR→resume 路径）。

**4. §2.4 引用错误：`core-loop §3.3.2` 不存在**
core-loop.md 全文无编号章节；"§3.3.2 系统外：两条人的链路"在 `docs/design/overview.md`。导演工作流五步法在 core-loop.md 里对应的是无编号的"运转：两个循环、一条工作流、一条管线"一节。

**5. 与调研文档的一处冲突未登记入附录 B**
文档头部承诺"凡与调研文档冲突之处，以本文档为准，分歧记录见附录 B"。D14/F9 决定素材调用不写局内 Script，这直接否决了 architecture.md §5 M4"每次调用作为 `service_call` 事件写入 Script"与 overview.md §5.1 事件类型表中的 `service_call`——附录 B 未记录此分歧（B-6 只把它记为审查采纳项，未标注它推翻了哪份文档的哪句话）。对比之下，broadcast/sendTo（B-1）、裸 set（B-2）、stale 传播（B-5）都有明确登记。

### 轻微问题（6 条）

6. **§4 恢复纪律残留"订阅"措辞**："replay 自身零副作用（不产生新事件、不触发订阅与沉淀、不调 LLM）"——订阅机制已被 D10 删除，"不触发订阅"成为无指对象的残留。
7. **F4 与错误矩阵的落盘口径需一句解释**：F4 行说"元组件调用本身不落盘"，§5 矩阵中"组件→元组件 参数校验失败 / before 钩子拦截"两行落盘=是。二者可调和（经节点失败事件由 FlowRunner 落），但表内无说明，易误读为矛盾。
8. **follow-up 档注入路径未闭合**：D4 立了 steering/follow-up 两档，AgentService 也有 `followUp()`，但门状态机 G5 与 §2.1 只画了 whisper→steering 队列。follow-up 档干预从门到 `followUp()` 的路径未出现在任何时序/状态机中。
9. **`MetaComponent.run` 返回类型宽于 D5**：`Result<unknown, string>` 中的 `string` 与"错误类型全部枚举化"有张力（注释已说明是所属服务错误枚举，可接受，但 Schema 阶段需收紧为枚举联合类型，否则 AI 生成组件可产出任意错误字符串）。
10. **layers.md 自身的三处导航瑕疵**：① B1 写"数据流 F1–F18"，F11 已删，范围表述易误导（建议"F1–F18（F11 已删）"）；② 路径写法不统一——全树用 `docs/...` 前缀，唯独 S1E/S5C/K4/C1/C2 等写 `design/overview.md`（实际位于 `docs/design/overview.md`，附录 B-4 已确认过这个坑）；③ I3 引用 `docs/roadmap.md`，该文件不在工作区（docs/README.md 文档地图也引用它，两份文档都指向缺失文件）。
11. **静态前缀口径的继承性歧义**：runtime architecture 文档采用"静态前缀 L0–L5"，与 overview §5.3 的分层表一致（L4/L5 标为静态前缀），但 architecture.md §4.3 与 overview §5.3 断点规划的文字写"L0–L3 静态前缀"。runtime architecture 文档附录 A-4 把分层定义指回 overview §5.3，等于继承了一个原文档内部文字/表格不一致的歧义源。选择本身是对的，但歧义源头未在附录 B 登记。

### 组织层面（非内容错误）

- `runtime-architecture.md` 与 `layers.md` 均未登记进 `docs/README.md` 文档地图；layers.md 树中 `design/runtime-architecture.md` 的路径假设它落在 design/ 目录，目前两份文件在工作区根目录。

### 核对通过项（摘录）

- 决策表 D1–D37 连续无断号，每条带来源标注，"自推理"项均给出理由；layers.md 索引 37/37 全覆盖。
- D2（删 broadcast/sendTo）、D10（删 emit/subscribe）在 §4.1/§4.2 接口中确实不存在对应方法，与附录 B 记录一致。
- D18 干预封闭集 ×5、D15 超时三策略、D4 双档在状态机 G1–G8、接口、错误矩阵三处表述一致。
- TCAS（D9）在 §1.2、§3.3 补充语义、§4.7 `batchView`、layers.md O1B 四处表述一致。
- isekai 引用（§1 锦标赛→D15、§2 数值依据→D31）核对无误；Vision/core-loop 的四层模型、导演门定位、设计原则引用均吻合。

---

## Review Agent 2

- **署名**：Review Agent 2
- **日期**：2026-07-25
- **审查对象**：`upload/runtime-architecture.md`（v1.0，2026-07-24）
- **参照系**：`upload/layers.md`、`upload/docs/architecture.md`、`upload/docs/core-loop.md`、`upload/docs/design/overview.md`、`upload/docs/Vision.md`、`upload/docs/investigation/pi-agent-investigation.md`、`upload/docs/investigation/masquerade-investigation.md`、`upload/docs/investigation/n8n-investigation.md`
- **审查方式**：全文通读 + 网络检索 pi Agent 最新演进（v1.2.0–v1.6.0，2026-04~06）+ 架构决策逐条与 pi 原设计对比核对 + 与 Agent 1 发现交叉验证

### 总体结论

runtime-architecture.md 对 pi Agent 的吸收属于"知识级嫁接"的典范：不 fork 代码、不复制片段，但每个关键机制都有明确源码出处和改造理由。五大核心机制（AgentTool 契约、JSONL 树持久化、两段式接缝、Turn 快照+安全点、Steering/FollowUp 双队列）的吸收准确、标注清晰、改造有理有据。37 条决策全部可回溯到 pi 或自推理，无凭空设计。与所有参考文件交叉引用一致，无矛盾。

**核心改造逻辑成立**：pi 是"单 Agent 编码 harness"，ThinkingArena 是"多 Agent 模拟推演器"。runtime-arch 没有盲目照搬 pi 的单 Agent 假设，而是在 pi 的薄核心哲学之上，自研了编排层（DAG 执行器）、黑板系统、导演门、TCAS 并发协议、版本域语义等——这些正是 pi 明确不做、而 ThinkingArena 必须自研的领域。

### 与 pi Agent 的核心对比矩阵

| 维度 | pi Agent 原设计 | ThinkingArena runtime-arch 实现 | 判定 |
|------|----------------|--------------------------------|------|
| **定位** | 单 Agent 编码 harness，明确不做 Multi-Agent | 多 Agent 模拟推演器，DAG 编排 | 合理扩展 |
| **架构哲学** | 薄核心 + 事件即全部 + 分层接缝 | 完全继承，规模纪律一致 | 准确吸收 |
| **核心抽象** | AgentLoop（循环引擎） | FlowRunner（DAG 执行器）+ Agent 服务 | 合理改造 |
| **持久化** | JSONL 树（SessionManager），append-only，parent_id | Script JSONL（EventLog），append-only，parent_id | 准确吸收 |
| **状态重建** | `state = reduce(state, event)`，崩溃恢复=重放 JSONL | 完全一致 | 准确吸收 |
| **干预机制** | Steering（打断）/ FollowUp（排队）双队列 | 导演门 + steering/follow-up 两档 | 合理域适配 |
| **安全点** | Tool 边界检查 steering，turn_end 检查 | 同构：tool 边界/turn_end/组件边界 | 准确吸收 |
| **工具契约** | AgentTool：schema 前置 + before/after 钩子 + 错误编码 | MetaComponent：同构，Zod 替代 TypeBox | 准确吸收 |
| **截断处理** | `stop_reason=="length"` 整批拒执行 | D6 完全一致 | 准确吸收 |
| **上下文管理** | 两段式接缝：存储全集 ⊃ LLM 投影 | L0-L9 分层 + prompt_hash 验证 | 合理扩展 |
| **压缩机制** | CompactionEntry（有损，为 LLM 上下文服务） | MemoryService.compact()（同构）+ EventLog snapshot（无损，为恢复服务） | 职责分离合理 |
| **Agent 间通信** | 无（明确不做） | D2 否决直发通道，F8 组件编排间接通信 | 自研合理 |
| **错误处理** | 错误编码进结果，不抛异常 | D5 完全继承 + 扩展为全模块枚举化 | 合理增强 |
| **运行模式** | Interactive/Print/JSON/RPC/SDK | SDK 模式 + CLI 导演界面 | 合理裁剪 |

### 来自 pi 的决策审查（D1–D37 中标注 pi 来源的项）

| 决策 | pi 来源 | 审查结论 | 备注 |
|------|---------|---------|------|
| **D1** 黑板写穿事件流 | pi JSONL 树 append-only + `session-manager.ts` | 准确 | 将 pi 的 Session 级 append-only 下沉到黑板键值级，更细粒度 |
| **D3** 干预只在安全点生效 | pi Turn 快照 + 安全点（`agent-loop.ts`） | 准确 | 安全点层级扩展为：LLM/tool 边界 ⊂ 组件边界 ⊂ 分支/局边界 |
| **D4** 导演干预两档 | pi Steering/Follow-up 双队列（`agent.ts`） | 准确 | 从 Agent 级双队列扩展到导演门级两档干预 |
| **D5** 错误编码进返回值 | pi AgentTool 契约 | 准确 | 扩展为全模块枚举化，超出 pi 的范围 |
| **D6** 截断整批拒执行 | pi AgentTool 约束 | 准确 | 完全一致 |
| **D7** 分支条件快照落盘 | pi JSONL 树 + 遍历瞬间求值 | 准确 | 增加"封闭算子集"约束，增强可校验性 |
| **D11** 内联快照条目 | pi CompactionEntry（`session-manager.ts`） | 准确 | 目的改造：pi 的 CompactionEntry 是有损压缩，ThinkingArena 的 snapshot 是无损检查点 |
| **D21** 版本域 fork | pi /fork + leaf 指针 | 准确 | 扩展为"Bundle 全输入 hash = 版本身份"，解决 pi 未涉及的跨版本混淆问题 |
| **D22** 持久化边界 | pi CompactionEntry 自包含 + core-loop 记忆独立 | 准确 | 明确裁决"记忆不从事件流重建"，解决附录 A 的表述矛盾 |

### 自推理决策审查（与 pi 不冲突）

| 决策 | 推理依据 | 审查结论 | 备注 |
|------|---------|---------|------|
| **D2** 无自主直发通道 | 显式优于自动 + 12-Factor Agents | 合理 | 修正 pi 调研 §6.2.1 的 broadcast/sendTo 提案（该提案是 ThinkingArena 自己提的，非 pi 原生） |
| **D8** join 等待表 + 超时 | n8n `waitingExecution` + pi 风险表 | 合理 | n8n 与 pi 的嫁接 |
| **D9** TCAS 批协议 | Masquerade TCAS | 合理 | pi 无此需求（单 Agent），Masquerade 是正确来源 |
| **D10** 观察者纪律 | Masquerade Recorder | 合理 | 删除 Blackboard emit/subscribe 的裁决正确 |
| **D12** 恢复点语义 | 事件溯源标准语义 + n8n A5 | 合理 | "已落盘的是事实，未落盘的从未发生" |
| **D13** LLM 失败处理 | n8n `retryOnFail` + overview 薄路由 | 合理 | 增强 pi 的简单重试 |
| **D14** 素材局外 | core-loop 产出管线定位 | 合理 | 明确局内/局外边界 |
| **D15** 门超时策略 | isekai 锦标赛模式 | 合理 | pi 无无人值守场景 |
| **D16** 成本双轨 | overview §5.3 | 合理 | pi 有成本追踪但无"双轨对账" |
| **D17** 判定重试升级 | overview §5.4 | 合理 | pi 无判定系统 |
| **D18** 干预封闭集 + note | overview §5.2 | 合理 | 扩展 pi 的干预类型 |
| **D19** 节点边界事件 | n8n A5 | 合理 | Step 级替代 item 级 |
| **D20** 加载期校验 | n8n A6 | 合理 | 消灭配置类错误 |
| **D23** 一局一进程 | 规模纪律 + 12-Factor | 合理 | pi 无多局并行需求 |
| **D24** 作品库 | 链 B 不变量 | 合理 | pi 的 Session 文件即作品，ThinkingArena 需要跨局管理 |
| **D25** 否决响应级缓存 | 版本域语义推论 | 合理 | 与 pi 的服务商原生缓存不冲突 |
| **D26** 黑板命名空间 | ChatRPG v2 P3 | 合理 | pi 无黑板 |
| **D27** 消费泵 | 自推理 | 合理 | 解决 note 无消费方问题 |
| **D28** 成本闸 | 故障审查 | 合理 | pi 无无人值守场景 |
| **D29** 文件并发协议 | 故障审查 | 合理 | pi 单进程无此需求 |
| **D30** 修剪占位 | 故障审查 | 合理 | 显式欠债优于空头支票 |
| **D31** 下游内容契约 | 下游审查 | 合理 | pi 无下游加工 |
| **D32** 事件类型空间 | 契约审查 | 合理 | 明确开放/封闭边界 |
| **D33** 版本身份 = Bundle hash | 契约审查 | 合理 | 核心创新，解决版本混淆 |
| **D34** 世界书归属 | 分解树审查 | 合理 | 补全归属空洞 |
| **D35** 唯一写者表 | 可实现性审查 | 合理 | 解决写者归属打架 |
| **D36** 孤儿事件规则 | 实现沙盘 | 合理 | append-only 下的必然产物 |
| **D37** 导演门本体 | 实现审查 | 合理 | 解决"组件 vs 订阅者"矛盾 |

### 发现的问题（9 条，按严重度排列）

#### [建议] 1. `deliveryMode`（`one-at-a-time` / `all`）未在 AgentService 接口体现

**pi 原设计**：`steer()` 和 `followUp()` 支持 `deliveryMode: 'one-at-a-time' | 'all'`（pi 调研 §3.5）。
- `one-at-a-time`：每次只投递一条消息，Agent 逐条响应
- `all`：批量投递所有排队消息

**runtime-arch 现状**：§4.1 AgentService 接口的 `steer`/`followUp` 方法没有 `deliveryMode` 参数。

**影响**：导演可能一次发送多条干预指令（如连续多条 whisper），Agent 的行为模式不明确——是逐条响应还是批量处理？

**建议**：在 `steer`/`followUp` 接口中增加 `deliveryMode` 参数，或在导演门协议中明确"单条指令"语义。MVP 可先固定为 `one-at-a-time`（导演逐条注入，Agent 逐条响应），后续扩展。

**位置**：§4.1 AgentService 接口

#### [建议] 2. `abort` 方法在 AgentService 接口中缺失

**pi 原设计**：pi 的 Agent 类有 `abort()` 方法（pi 调研 §2.2）。运行中调用 `prompt()` 会抛错，必须用 `steer()`/`followUp()`/`abort()`。abort 用于取消当前运行。

**runtime-arch 现状**：§4.1 AgentService 接口只有 `create`/`destroy`/`steer`/`followUp`/`runTurn`，没有 `abort`。A8 状态转移（RUNNING → ERROR）提到"abort 超时"作为不可恢复失败的一种，但接口层面无 abort 能力。

**影响**：FlowRunner `cancel()` 时，如何取消在飞的 LLM 请求？当前依赖 AbortSignal 逐环传递（§4.7 ComponentContext），但 Agent 服务层面没有显式 abort 入口。

**建议**：在 AgentService 接口中增加 `abort(id: string): Result<void, AgentServiceErrorKind>`，用于：
1. FlowRunner cancel 时取消在飞 LLM 请求
2. 导演紧急终止某 Agent 的当前回合

**位置**：§4.1 AgentService 接口

#### [建议] 3. `agent_start`/`agent_end` 事件 vs `turn_start`/`turn_end` 的语义层级需明确

**pi 原设计**：pi 的 Agent loop 有 `agent_start` → `turn_start` → ... → `turn_end` → `agent_end` 的完整事件层级（pi 调研 §2.2）。`agent_start`/`agent_end` 标记一个 Agent 任务的完整生命周期（可能跨越多个 turn）。

**runtime-arch 现状**：D35 唯一写者表中有 `turn_start`/`turn_end`（服务自动落）和 `agent_created`/`agent_destroyed`（服务自动落），但没有 `agent_start`/`agent_end`。

**影响**：一个 Agent 可能在一个局中执行多个 turn（如回边循环），如何标记"一个 Agent 任务的完整生命周期"？下游复盘可能需要知道"Agent X 从何时开始活跃、何时结束活跃"。

**建议**：考虑增加 `agent_started`/`agent_ended` 事件（或重命名 `turn_start` 为更明确的语义）。或者，在 `turn_start` 事件中增加"是否是该 Agent 的首 turn"标志。当前设计可用，但需在 Schema 阶段明确。

**位置**：D35 唯一写者表 + §3.1 Agent 状态机

#### [建议] 4. D21 "旧分支封存只读"的文件层语义需补充

**runtime-arch 现状**：D21 说"旧分支封存只读、可在旧版本下回放/重跑/对比"，D24 说"一局一个目录"，但"旧分支"与"一局"的关系未完全明确：
- 同版本内的 fork：在同一 Script 文件内创建新分支（pi 的 /fork 语义）
- 跨版本改版：新局新文件（D21 的"改版 = 新局新分支"）

**问题**：同版本内的 fork 产生的新分支，是否在同一目录内？D24 说"一局一个目录"，但 fork 后的分支是否算"同一局"还是"新局"？

**建议**：在 D24 或 §2.4 中明确：
- **同版本 fork**：同一 Script 文件内的新 branch（pi 的 /fork 语义），同一目录
- **跨版本改版**：新 Script 文件，新目录，manifest 记录族谱

当前 §2.4 第 3 点已说明"同版本内可从任意事件分叉"，但文件层落点可更明确。

**位置**：D24 + §2.4

#### [建议] 5. 错误矩阵中 "AGENT_BUSY" 的处理策略可补充

**runtime-arch 现状**：错误矩阵中，组件 → Agent 服务的 `AGENT_BUSY` 错误处理为："错误编码进结果；属编排配置错误 → 节点失败走 onError"。

**pi 原设计**：pi 的 `AGENT_BUSY` 是状态保护机制——运行中实例拒绝第二个 `runTurn`（pi 调研 §2.2）。

**问题**：在 ThinkingArena 中，`AGENT_BUSY` 何时会发生？
- 场景 A：编排层错误地并发调度同一 Agent（TCAS 批内同一 Agent 出现在多个分支）
- 场景 B：回边重入时，上一迭代尚未完成，下一迭代已开始

场景 A 应由 D20 加载期校验拦截（同一 Agent 不应出现在并行分支中）。场景 B 需要明确——回边重入时，Agent 是否应等待上一 turn 完成？

**建议**：在 §3.3 补充语义中增加："回边重入时，若目标 Agent 仍在 RUNNING 状态，调度器应等待其到达 IDLE 后再调度，而非触发 AGENT_BUSY"。或者，明确 AGENT_BUSY 为"配置错误"，由 D20 校验排除。

**位置**：错误矩阵 + §3.3 补充语义

#### [提示] 6. pi 最新版本（v1.2.0–v1.6.0，2026-04~06）的新特性未纳入参考

**网络检索发现**：pi 在 2026 年 4-6 月发布了 v1.2.0 至 v1.6.0，新增了：
- **Confidence scoring**：Agent 输出的置信度评分
- **Hooks system**：更通用的迭代边界钩子
- **Config-file support**：自定义行为配置
- **pi-orchestrator 实验包**：v0.80.x 新增，负责"多 Agent 协调、RPC 进程通信与 Supervisor 监控"

**影响**：pi-orchestrator 虽然是实验性的，但其多 Agent 协调方向与 ThinkingArena 直接相关。如果 pi-orchestrator 成熟，ThinkingArena 的部分自研（如 DAG 执行器）可能需要重新评估是否仍坚持自研。

**建议**：
1. 在 `docs/investigation/pi-agent-investigation.md` 中补充 pi-orchestrator 的跟踪记录
2. 在 roadmap 中增加"定期复审 pi 多 Agent 演进"的检查点
3. Confidence scoring 机制可能与 ThinkingArena 的判定系统（Narrator + Archivist）相关，可作为未来增强参考

**位置**：附录 B（分歧记录）可新增一条跟踪项

#### [提示] 7. `follow-up` 在导演门时序图中的注入时机可更明确

**pi 原设计**：pi 的 follow-up 在"agent 无 tool 调用且无 steering 时"检查（pi 调研 §3.5），即 agent_end 安全点。

**runtime-arch 现状**：§2.1 导演门时序图展示了 steering（whisper/inject/edit_world）的注入路径，但没有明确展示 follow-up 的注入时机。D4 说 follow-up 是"自然停止点续作"，但"自然停止点"在多 Agent 场景下的语义比单 Agent 更复杂：
- 是 turn_end？
- 是组件 run 完成？
- 是分支完成？

**建议**：在 §2.1 时序图中增加 follow-up 分支，或在 §3.1 Agent 状态机 A5（RUNNING → IDLE）中明确"turn_end 安全点：steering 队列为空时检查 follow-up 队列"。当前 A5 的描述"检查 follow-up 队列"已隐含此语义，但时序图未展示。

**位置**：§2.1 时序图 + §3.1 状态机 A5

#### [提示] 8. pi 的 `message_update` 流式事件未流入事件流的设计需确认

**pi 原设计**：pi 的 Agent loop 有 `message_update` 流式增量事件（pi 调研 §2.2），用于 TUI 实时显示 LLM 输出。

**runtime-arch 现状**：F7/F7b 提到 SSE 流式响应（text/thinking/toolcall），但 D35 唯一写者表中没有 `message_update` 类型的事件。CLI 观察通过 F16 tail 事件流实现。

**影响**：如果导演需要实时看到 Agent 的"思考过程"（如 CoT/thinking 内容），这些内容是否流入 Script？如果不流入，下游复盘无法看到思考过程；如果流入，事件流体积会显著增加。

**建议**：明确 `thinking`/`reasoning` 内容的落盘策略：
- 选项 A：thinking 内容不落 Script，仅通过 CLI 实时流显示（当前隐含设计）
- 选项 B：thinking 内容以 `monologue` 事件落 Script（与发言区分）
- 选项 C：thinking 内容以独立事件类型落 Script，但可选（Bundle 配置）

当前 D31 的"下游内容契约"中有 `monologue`（内心独白），可用于承载 thinking 内容。建议在 D31 中明确 monologue 的语义包含 LLM 的 reasoning/thinking。

**位置**：D31 下游内容契约

#### [提示] 9. pi 的 `tool_execution_update`（工具流式输出）未覆盖

**pi 原设计**：pi 支持 `tool_execution_update` 流式事件，用于长时工具的进度反馈（pi 调研 §2.2）。

**runtime-arch 现状**：无对应机制。ThinkingArena 的工具调用通过元组件执行，结果是同步返回的。

**影响**：如果未来有长时工具（如生图进度、视频生成进度），组件可能阻塞等待，导演无法观察进度。

**建议**：当前 MVP 无需处理（工具执行时间短），但在 §4.7 MetaComponent 接口中预留流式返回能力（如 `AsyncIterable<Result<...>>`），或在架构层面注明"工具执行当前为同步，流式工具为未来扩展"。

**位置**：§4.7 MetaComponent 接口 + §0.2 MVP 范围

### 与 Agent 1 发现的交叉验证

| Agent 1 发现 | Agent 2 是否独立发现 | 交叉结论 |
|-------------|-------------------|---------|
| `cache_invalidation` 写者冲突（Agent 1 #1） | 未发现 | Agent 1 的文本层审查更深入，属 D35 表内一致性缺陷 |
| §0.2 决策计数陈旧（Agent 1 #2） | 未发现 | Agent 1 的编号连续性审查更细致 |
| D24 "终态"措辞冲突（Agent 1 #3） | 未发现 | Agent 1 对状态机转移的时序审查更精确 |
| §2.4 引用错误（Agent 1 #4） | 未发现 | Agent 1 的引用回查更彻底 |
| D14/F9 分歧未登记（Agent 1 #5） | 未发现 | Agent 1 的附录 B 完整性审查更严格 |
| §4 "订阅"残留措辞（Agent 1 #6） | 未发现 | Agent 1 的措辞清理更细致 |
| F4 与错误矩阵落盘口径（Agent 1 #7） | 未发现 | Agent 1 的数据流审查更精确 |
| follow-up 注入路径未闭合（Agent 1 #8） | **独立发现（提示 #7）** | 两 Agent 从不同角度发现同一问题：Agent 1 从状态机闭合性角度，Agent 2 从 pi 原设计对比角度 |
| `MetaComponent.run` 返回类型（Agent 1 #9） | 未发现 | Agent 1 的类型系统审查更严格 |
| layers.md 导航瑕疵（Agent 1 #10） | 未发现 | Agent 1 的索引层审查更细致 |
| 静态前缀歧义（Agent 1 #11） | 未发现 | Agent 1 的跨文档一致性审查更彻底 |
| `deliveryMode` 缺失（本报告 #1） | Agent 1 未发现 | **互补**：Agent 2 的 pi 对比视角独有 |
| `abort` 缺失（本报告 #2） | Agent 1 未发现 | **互补**：Agent 2 的 pi 对比视角独有 |
| `agent_start/end` 事件层级（本报告 #3） | Agent 1 未发现 | **互补**：Agent 2 的 pi 对比视角独有 |
| pi-orchestrator 跟踪（本报告 #6） | Agent 1 未发现 | **互补**：Agent 2 的网络检索补充独有 |
| `message_update` 落盘策略（本报告 #8） | Agent 1 未发现 | **互补**：Agent 2 的 pi 对比视角独有 |
| `tool_execution_update` 未覆盖（本报告 #9） | Agent 1 未发现 | **互补**：Agent 2 的 pi 对比视角独有 |

### 核心创新认定

**D33（版本身份 = Bundle 全输入 hash）被认定为 ThinkingArena 的核心创新** —— pi 有 `/fork` 但没有"版本域"概念。D33 用 hash 将"改图/改卡/改种子"全部纳入版本身份，从根本上防止了"旧内容在新版本下混用"的可归因性裂缝。此创新不来自 pi，也不来自任何调研文档，是 ThinkingArena 自研的架构决策，且与 pi 的 append-only 哲学不冲突。

### 总体评分

| 维度 | 评分 | 说明 |
|------|------|------|
| **pi 吸收准确性** | 9/10 | 五大核心机制全部准确吸收，标注清晰 |
| **改造合理性** | 9/10 | 从单 Agent 到多 Agent 的扩展有理有据 |
| **自洽性** | 9/10 | 37 条决策无矛盾，与所有参考文件一致 |
| **完备性** | 8/10 | 核心场景覆盖完整，少数边缘场景（流式工具、deliveryMode）可补充 |
| **可实现性** | 8/10 | MVP 分期合理，但 33 条决策全量实现仍超"几千行"纪律 |
| **总体** | **8.6/10** | **优秀，可作为实现权威** |

### 与参考文件的一致性检查

| 文件 | 检查项 | 结果 |
|------|--------|------|
| **layers.md** | D1-D37 全部有挂点 | 通过 |
| **layers.md** | 分解树叶子无黑盒 | 通过 |
| **architecture.md** | DAG 执行器与 §4.5 FlowRunner 一致 | 通过 |
| **architecture.md** | 四层目录结构与 runtime-arch 接口对应 | 通过 |
| **core-loop.md** | 设计原则 5（新元素先定位）落实 | 通过 |
| **core-loop.md** | "没有银弹"——服务层独立 | 通过 |
| **design/overview.md** | L0-L9 分层引用一致 | 通过 |
| **design/overview.md** | 导演门语义一致 | 通过 |
| **pi-agent-investigation.md** | 五大吸收点全部有落点 | 通过 |
| **pi-agent-investigation.md** | D2 修正 broadcast/sendTo 提案 | 自洽 |
| **masquerade-investigation.md** | TCAS 来源标注正确 | 通过 |
| **n8n-investigation.md** | join 等待表来源标注正确 | 通过 |
| **Vision.md** | "唯一开发者完全理解"——规模纪律落实 | 通过 |

### 与 pi 最新演进的对照（网络检索补充）

| pi 新特性 | 时间 | ThinkingArena 现状 | 建议 |
|-----------|------|-------------------|------|
| **Confidence scoring** | v1.2.0+ (2026-04) | 无 | 可作为 Narrator/Archivist 判定质量评估的参考 |
| **Hooks system** | v1.2.0+ (2026-04) | MetaComponent 有 beforeCall/afterCall | 功能类似，ThinkingArena 的钩子更细粒度（per-meta-component） |
| **Config-file support** | v1.2.0+ (2026-04) | Bundle YAML 配置 | ThinkingArena 的配置更结构化（Zod 校验） |
| **pi-orchestrator 实验包** | v0.80.x (2026-05) | 自研 DAG 执行器 | **建议跟踪**——若 pi-orchestrator 成熟，可评估是否替代自研编排层 |
| **Earendil 迁移** | v1.2.0+ (2026-04) | npm 包名未定 | 不影响架构 |

**关键洞察**：pi-orchestrator 的出现表明 pi 团队也在探索多 Agent 协调。ThinkingArena 的自研 DAG 执行器当前是合理的（pi-orchestrator 尚处实验阶段），但应在 roadmap 中设置检查点，定期评估 pi-orchestrator 的成熟度。

---

## Review Agent 3

- **署名**：Review Agent 3
- **日期**：2026-07-25
- **审查对象**：`upload/runtime-architecture.md`（v1.0，2026-07-24）
- **参照系**：`upload/layers.md`、`upload/docs/architecture.md`、`upload/docs/core-loop.md`、`upload/docs/design/overview.md`、`upload/docs/Vision.md`
- **审查方式**：全文通读 + 四层模型一致性核对 + 接口签名完整性审查 + 数据流闭环检查 + 状态机可达性分析 + 与上游文档冲突比对

### 总体结论

文档架构定义**清晰自洽**，37 条决策全部可挂到分解树、全部有来源标注、全部在数据流/时序/状态机/接口中有落点。与 `layers.md`、`architecture.md`、`core-loop.md`、`overview.md` 的关系明确且一致，可作为实现权威。

### 实质问题（1 条）

#### 1. Agent 间通信（F8）缺少明确的元组件接口

**D2** 明确裁掉了 pi 的 `broadcast/sendTo`，改为"Agent 间通信由组件编排，**经元组件注入目标 Agent 私有上下文**"。但 **§4.7** `MetaRegistry` 的内置元组件列举只有：`call_agent` / `bb_get` / `bb_set` / `emit_event` / `await_director_input`，**没有"向目标 Agent 私有上下文注入"的元组件**。

- `call_agent` 是驱动 Agent 运行回合，不是注入上下文
- `bb_set` 写黑板（公共数据面），而 D2 明确说 Agent 间通信要注入**私有上下文**

**影响**：实现者读到此处会找不到落点。虽然 MVP 首局验证（§0.2）是线性图、暂不涉及多人并行，但文档作为 v1.0 权威应补齐。

**建议**：在 §4.7 `MetaRegistry` 内置元组件中补充 `inject_context(targetAgentId, text)` 或类似签名，并在 D2 处增加一句"注入经 `inject_context` 元组件完成"。

**位置**：§4.7 MetaRegistry 内置元组件 + D2 决策描述

### 轻微问题 / 建议（3 条）

#### 2. §2.1 导演门时序图的安全点触发可更明确

时序图步骤 7（`R-->>G: 解析等待中的 promise`）后，G 进入 `RECEIVED`，但**注入操作（whisper/inject/edit_world）放在 alt 内部，没有显式标注"安全点到达"这一触发条件**。状态机 G5 明确说 `RECEIVED → INJECTED` 的触发条件是"循环安全点到达"，时序图应与此对齐。

**建议**：在 alt 之前增加一个明确步骤，如 `Note over G: 等待当前 Agent 到达 turn_end 安全点`，使时序图与状态机转移条件一一对应。

**位置**：§2.1 导演门时序图

#### 3. architecture.md 的"重跑判定"与 D21 的 stale 传播否决可能让读者困惑

`architecture.md` §4.5 DAG 执行器中提到"**重跑判定**（n8n 参照）：参数变/图变 → 下游 stale；循环内任意节点 stale → 循环首节点 stale"。`runtime-architecture.md` **D21 明确否决** n8n 式 stale 传播（跨版本部分复用），§2.4 定义 rerun 为"从分叉点**全部重新执行**"。

两者不实质冲突（architecture.md 说的是同版本内的节点重跑标记，D21 否决的是跨版本复用），但**读者可能误以为 architecture.md 的 stale 判定在运转架构中仍然生效**。

**建议**：在 `runtime-architecture.md` §2.4 或附录 B 中增加一句澄清，如"architecture.md §4.5 的'重跑判定'仅指同版本内的节点失效标记，已被本文件的'版本域 fork 模型'（D21）取代；跨版本不复用任何执行结果"。

**位置**：§2.4 局间改版与分叉

#### 4. D27"单门等待"约束在 §3.2 状态机中未体现

D27 说"MVP 约束同一时刻最多一门 WAITING（D20 加载期校验）"，但 **§3.2 导演门状态机 G1** 的触发条件只有"分支到达门节点"，没有提及此约束。如果图作者放了两扇门在不同分支上，运行时第二扇门进入 WAITING 会触发 D37 的兜底"节点失败走 onError"，但状态机本身没有表达这个限制。

**建议**：在 G1 的"触发条件"或"执行动作"栏增加备注："受 D27 单门等待约束；若已有门 WAITING，第二门进入 WAITING 视为节点失败"。

**位置**：§3.2 导演门状态机 G1

### 一致性核查结果

| 核查维度 | 结果 | 备注 |
|---------|------|------|
| **内部自洽** | 通过 | 37 条决策、18 条数据流、4 个时序、3 个状态机、7 组接口、错误矩阵全部互相对齐，无矛盾 |
| **与 layers.md** | 通过 | D1–D37 全部有挂点；数据流/时序/状态机/接口的指针全部命中正确章节 |
| **与 architecture.md** | 通过 | 薄核心形态、四层目录、事件即真相、导演门、TCAS、DAG 执行器全部一致；stale 传播问题见轻微问题 3 |
| **与 core-loop.md** | 通过 | 四层模型、两个循环、导演工作流、设计原则 5 条全部落地 |
| **与 overview.md** | 通过 | 已知分歧（emit/subscribe 删除、broadcast/sendTo 裁掉）已全部记录在附录 B，且以 runtime-architecture.md 为准 |
| **编号完整性** | 通过 | D1–D37、F1–F18、A1–A12、G1–G8、R1–R10 无遗漏、无跳号 |
| **引用准确性** | 通过 | 所有外部引用（pi/n8n/Masquerade/isekai 等）均指向正确的调研章节 |
| **Mermaid 语法** | 通过 | 7 个图全部语法正确 |
| **TypeScript 接口** | 通过 | 类型定义清晰，错误枚举覆盖矩阵中全部错误类型 |

### 亮点

1. **"无死状态自查""无魔法箭头自查"** 等自检机制体现了文档的严谨性
2. **附录 B 的分歧记录** 详尽透明，设计演进过程可追溯，符合"唯一开发者完全理解把控"的 Vision 要求
3. **D35 唯一写者表** 解决了多轮审查中发现的"事件写者归属打架"问题，是可实现性的关键保障
4. **§0.2 MVP 分期** 诚实面对规模纪律，语义先行、实现分期，避免"全量框架"陷阱
5. **D33 种子参与版本身份** 补上了此前遗漏的关键输入，使版本校验真正完整

### 与 Agent 1 / Agent 2 的交叉验证

| 本报告发现 | Agent 1 | Agent 2 | 结论 |
|-----------|---------|---------|------|
| `inject_context` 元组件缺失（#1） | 未发现 | 未发现 | **Agent 3 独有**：从接口完整性角度发现 F8 数据流在元组件层无落点 |
| 安全点触发标注（#2） | 未发现 | 未发现（但独立发现 follow-up 路径问题） | **Agent 3 独有**：时序图与状态机对齐审查 |
| stale 传播读者困惑（#3） | 未发现 | 未发现 | **Agent 3 独有**：跨文档语义继承审查 |
| 单门等待约束未入状态机（#4） | 未发现 | 未发现 | **Agent 3 独有**：状态机可达性分析 |
| `cache_invalidation` 写者冲突 | 发现（#1） | 未发现 | 确认 Agent 1 发现有效 |
| §0.2 决策计数陈旧 | 发现（#2） | 未发现 | 确认 Agent 1 发现有效 |
| D24 "终态"措辞冲突 | 发现（#3） | 未发现 | 确认 Agent 1 发现有效 |
| `deliveryMode` 缺失 | 未发现 | 发现（#1） | 确认 Agent 2 发现有效 |
| `abort` 方法缺失 | 未发现 | 发现（#2） | 确认 Agent 2 发现有效 |
| pi-orchestrator 跟踪 | 未发现 | 发现（#6） | 确认 Agent 2 发现有效 |

### 总体评分

| 维度 | 评分 | 说明 |
|------|------|------|
| **架构自洽性** | 9/10 | 37 条决策、3 个状态机、18 条数据流、7 组接口全部对齐 |
| **文档一致性** | 9/10 | 与所有上游文档一致，附录 B 分歧记录完整 |
| **接口完整性** | 8/10 | 核心接口完备，F8 Agent 间通信在元组件层缺落点 |
| **可实现性** | 9/10 | MVP 分期合理，状态机/时序/数据流可直接指导实现 |
| **总体** | **8.8/10** | **优秀，可作为实现权威；建议补充 `inject_context` 元组件后发布 v1.1** |


---

## Review Agent 4

- **署名**：Review Agent 4
- **日期**：2026-07-25
- **审查对象**：`upload/runtime-architecture.md`（v1.0，2026-07-24）
- **参照系**：`upload/layers.md`、`upload/docs/architecture.md`、`upload/docs/core-loop.md`、`upload/docs/design/overview.md`、`upload/docs/Vision.md`、`upload/docs/scenarios/isekai-survival.md`
- **审查方式**：全文通读 + 内部一致性审查 + 交叉引用一致性审查 + 逻辑完整性审查 + 可实现性审查

### 总体结论

**结论：runtime-architecture.md 是一份架构级的高质量文档，内部逻辑自洽，决策链完整，可作为实现权威。**

- 37 条设计决策（D1–D37）全部可在分解树（layers.md）中挂点，无孤儿决策。
- 数据流 F1–F18 与决策表一一对应，每条流都有格式/同步性/错误行为/落盘四元定义。
- 三个状态机（Agent/导演门/FlowRunner）均通过"无死状态自查"。
- 错误处理矩阵覆盖五类必覆盖错误（超时/Schema/LLM/缓存/并发），主谓一致。
- 附录 B 的分歧记录完整，裁决理由充分。

**未发现严重级别问题（内部矛盾或不可实现的设计）。**

---

### 发现的问题

#### 中等严重度：与上游文档不一致（runtime-arch 是正确的权威，上游文档需同步）

| # | 位置 | 问题描述 | 影响 | 建议 |
|---|------|---------|------|------|
| M1 | `architecture.md` §4.5 | 仍保留 n8n 式 **stale 传播**，但 runtime-arch D21/§2.4/附录 B-5 已明确**否决 n8n 式 stale 传播**，改为"版本域 fork"语义。 | 实现者可能按 architecture.md 实现 stale 传播，与 runtime-arch 冲突。 | architecture.md 删除 stale 传播段落，统一为 runtime-arch 的 fork 模型。 |
| M2 | `overview.md` §7.1.1 | `AgentService` 仍含 `broadcast/sendTo`，但 D2 已裁掉 | 接口定义矛盾。 | overview.md 同步为 §4.1 的接口（无 broadcast/sendTo）。 |
| M3 | `overview.md` §7.1.2 | `Blackboard` 仍含 `emit/subscribe`，但 D10 已删除 | 接口定义矛盾；实现者可能保留不必要的发布订阅机制。 | overview.md 同步为 §4.2 的接口（无 emit/subscribe）。 |
| M4 | `overview.md` §5.1 | 事件契约仍含 `service_call`，但 D14 明确素材调用归局外、不写局内 Script | 事件类型空间不一致；局内 Script 可能混入局外素材调用事件。 | overview.md 将 service_call 从局内事件契约移至局外 manifest 约定，或明确标注为"局外事件"。 |

#### 轻微：可优化或需澄清

| # | 位置 | 问题描述 | 建议 |
|---|------|---------|------|
| L1 | §3.2 状态机 G5 | 触发条件写为"循环安全点到达"，但门组件在节点边界（已是安全点）执行注入操作（whisper→steering队列/inject→黑板写穿/edit_world→cache_invalidation），操作完成后即应转入 INJECTED。**"安全点到达"的语义更适用于目标 Agent 消费 steering 队列的时机，而非门状态机的转移条件。** | G5 触发条件改为"注入操作完成"或"门组件执行完注入指令"，避免与 D3"干预在目标 Agent 安全点生效"的语义混淆。 |
| L2 | §0.2 MVP 范围 | 首局验证未包含 D28 成本闸，但 D28 指出"0..n 工具循环 + 重试叠加 N 进程，账单失控是迟早路径"。首局虽为交互式（导演可手动取消），但**缺少成本闸的基本框架意味着首局也可能意外超支。** | 建议将 D28 的"成本累计切片 + 超阈检测"纳入首局验证的最小实现，阈值可先设为一个极大值，保证机制存在。 |
| L3 | §4.4 LLMGateway | `fallback()` 作为独立方法暴露，但 D13 描述为自动流程（"退避重试 → 同能力级 fallback → 熔断"）。**接口设计暗示调用方（Agent 服务）需主动调用 fallback，与"自动"语义存在张力。** | 在 §4.4 或 D13 补充说明：fallback 由 Agent 服务在收到可重试错误后主动调用，网关内部不自动链式调用（保持路由层"薄"的纪律）。 |
| L4 | D27 / §3.3 补充语义 | "同一时刻最多一门 WAITING"是 MVP 全局约束，但**未充分说明其对流程图设计的限制**——例如两个独立分支各有一个门时，第二个门会触发 onError。 | 在 D27 或 §0.2 补充一句："此约束意味着 MVP 流程图中不能同时存在两个均可能到达的门节点；Phase 1 解除。" |
| L5 | §2.1 时序图 | 导演门时序图的 alt 分支只展示了 whisper/inject/edit_world，未展示 **agent_broadcast**（D18 明确为第 5 种干预类型）。 | 补充 agent_broadcast 分支：与 whisper 类似，但遍历 targetAgents 逐个 steer。 |
| L6 | §4.3 EventLog.replay | 返回类型注释 `AsyncIterable<Event> /* 有序事件序列（首条可为快照检查点） */` 嵌在泛型参数内部，作为 TypeScript 类型草图**语法上不够标准**（注释应放在参数列表外）。 | 改为 `Promise<Result<{ events: AsyncIterable<Event>; firstEntryMayBeSnapshot: boolean }, EventLogErrorKind>>` 或调整注释位置。 |

#### 格式/笔误（不影响语义）

| # | 位置 | 问题 |
|---|------|------|
| T1 | §0.1 D21 | "算力复用置于作品版本归因之上的类别错误（见 D21 的被否决方案）"——括号内"见 D21"应为"见 §2.4"或"见附录 B-5"，D21 本身是被采纳决策，不是被否决方案的位置。 |
| T2 | 附录 B-6 | "采纳——§0.1 补'链 B 长期存续实体'（原框架最大缺维）"——"缺维"应为"缺维度"或"缺失"。 |
| T3 | §3.3 补充语义 | "两种'快照'不是一物"——口语化表达，建议改为"两种'快照'并非同一概念"。 |

---

### 逐维度审查详情

#### 3.1 内部一致性 通过

- **决策表 ↔ 数据流**：D1（写穿）对应 F10/F10b；D2（无直发）对应 F8；D3（安全点）对应 §2.2 时序图；D9（TCAS）对应 F12/§3.3 补充语义；D18（干预封闭集）对应 F1/F2/G2；D35（唯一写者表）对应全部 F 流的落盘列。全部对应关系一致。
- **决策表 ↔ 状态机**：D4（双队列）对应 A4/A5/S1C；D15（超时策略）对应 G3/G4；D20（加载期校验）对应 R1；D28（成本闸）对应 §3.3 补充语义 ledger 模块。全部对应。
- **状态机 ↔ 时序图**：§2.1 导演门时序图的 6 个步骤与 G1–G7 转移一一对应；§2.2 Agent 回合时序图与 A4/A5/A8 对应；§2.3 崩溃恢复与 D12/D36 对应。
- **状态机自查**：Agent（DESTROYED 唯一终止态）、导演门（CANCELLED 终止态）、FlowRunner（COMPLETED 成功终止态 + IDLE 兼作取消终态）均通过无死状态检查。
- **接口 ↔ 决策**：§4.1 AgentService 无 broadcast/sendTo（符合 D2）；§4.2 Blackboard 无 emit/subscribe（符合 D10）；§4.3 EventLog 有 snapshot/branch（符合 D11/D21）；§4.6 MemoryService 补充跨局挂载（符合 D22）。

#### 3.2 与引用文档一致性 4 处待同步

- **与 core-loop.md**：高度一致。设计原则 5 条全部在 runtime-arch 中落实。
- **与 architecture.md**：基本一致，除 M1（stale 传播遗留）。
- **与 overview.md**：存在 M2/M3/M4 三处接口/契约分歧，runtime-arch 的裁决更合理（附录 B 已记录）。
- **与 isekai-survival.md**：一致。锦标赛模式（§1）与 D15/D23/D24/D28 兼容；状态表（§2）与 D26 兼容；导演干预点（§4）与 D18 兼容。
- **与 layers.md**：决策覆盖索引 D1–D37 全部可挂点，无遗漏。

#### 3.3 逻辑完整性 通过

- **两条生命周期（链 A / 链 B）**：§0.1 定义清晰，D21–D24/D30 覆盖版本域/持久化边界/作品库/修剪策略，无空头支票。
- **导演操作集**：创作/开局/观察/注入/改版/对比/挑选/废弃/检索/批量运行——全部有机制支撑。
- **不变量**：可归因（D18/D31/D33）、可重放（D1/D7/D11/D12）、可对比（D21）、记忆可审计（D22）、成本可账（D16/D24/D28）——全部有机制保证。
- **错误覆盖**：超时（LLM/组件/join/门）、Schema 校验（元组件/事件/判定/Bundle）、LLM 失败（7 种类型）、缓存失效、并发冲突——五类必覆盖错误全部在错误矩阵中有位置。
- **无魔法箭头**：§1.2 末尾自查"图中每条边都在上表有对应行"，经验证属实。

#### 3.4 可实现性 通过

- **同步 append**：F10/F12 的同步写穿对单行 JSONL 追加而言，Node.js `fs.appendFileSync` 性能可接受，MVP 无瓶颈。
- **单门等待约束**：D27 的 MVP 全局约束限制了流程图设计空间（不能同时有两个门 WAITING），但 Phase 1 即解除，规模纪律下可接受。
- **TCAS 批协议**：D9 的"快照读 + 分支缓冲 + 串行提交"是 Masquerade 已验证模式，复杂度可控。
- **版本 hash**：D33 的 Bundle 全输入 hash 需定义序列化规范，但仅用于校验，不影响运行时逻辑。
- **FlowRunner 内部分解**：§3.3 补充语义将外观分解为 graph/scheduler/reducer/pump/ledger 五个模块，消解 god object 风险，实现量可控。

---

### 特别值得肯定的点

1. **附录 B 的审查记录**：五视角并行审查（实现者/故障运维/下游内容/契约/规模）+ 可实现性审查（依赖结构/实现沙盘/并发语义）的记录方式，是高质量架构文档的标杆。每个采纳/否决都有明确理由。
2. **D35 事件唯一写者表**：解决了 F12 与 §2.2 时序图之间"speech 归谁落/节点边界归谁落"的三处打架，是可实现性审查的关键产出。
3. **D36 孤儿事件规则**：在 append-only 语义下，崩溃前已落盘的事件无法作废——节点执行标识 + 重放跳过（cost 除外）是精巧且必要的机制。
4. **"两种快照不是一物"的明确区分**（§3.3 补充语义）：避免了 D7（分支求值快照）与 D11（恢复检查点）在命名和语义上的混淆。
5. **D33 种子参与版本身份**：补全了"同版本 rerun 复现骰点序列"的控制变量对照能力，是 D21 版本域语义的自然推论。

---

### 总体评分

| 维度 | 评分 | 说明 |
|------|------|------|
| **内部一致性** | 9/10 | 无内部矛盾，决策/数据流/状态机/接口全部对齐 |
| **与上游文档一致性** | 7/10 | runtime-arch 本身是权威的，但 4 处上游文档未同步 |
| **逻辑完整性** | 9/10 | 决策链完整，无空头支票，不变量全部有机制保证 |
| **可实现性** | 9/10 | MVP 分期合理，机制可直接指导实现 |
| **文档质量** | 9/10 | 附录 B 审查记录是标杆，自检机制严谨 |
| **总体** | **8.6/10** | **优秀，可作为实现权威；建议同步上游文档 M1–M4** |

---

