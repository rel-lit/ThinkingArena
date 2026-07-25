# Investigation 文档索引

> 本目录存放 ThinkingArena 项目对外部成熟项目的深度调研报告（Investigation）。
> 调研方法：源码静态分析 + 架构文档交叉验证 + 可复用模式提取。
> 调研纪律：不 fork、不复制任何代码（含片段），只移植经过验证的设计判断。

---

## 文档清单

| 文件名 | 调研对象 | 核心定位 | 规模/影响力 |
|--------|---------|---------|------------|
| `pi-agent-investigation.md` | [Pi Agent](https://github.com/earendil-works/pi) (earendil-works/pi) | **第一参考书**——服务层 / 元组件层 / 干预机制 | 53k+ stars, TypeScript, MIT |
| `masquerade-investigation.md` | [Masquerade](https://github.com/GOODDAYDAY/Masquerade) (GOODDAYDAY/Masquerade) | **第二参考书**——游戏引擎与 Script 记录 | ~98 文件, Python+TS, Apache 2.0 |
| `n8n-investigation.md` | [n8n](https://github.com/n8n-io/n8n) (n8n-io/n8n) | **半份参考书**——编排引擎语义 | 400+ 节点, TypeScript, fair-code |
| `ChatRPG-v2-investigation.md` | ChatRPG v2 (arXiv:2502.19519, ACM CUI 2025) | **专项参照**——Narrator + Archivist 裁判范式 | 学术论文, C#/.NET |
| `SillyTavern-investigation.md` | [SillyTavern](https://github.com/SillyTavern/SillyTavern) (SillyTavern/SillyTavern) | **专项参照**——身份牌 / 世界书 / Prompt 分层 | 活跃社区, AGPL-3.0 |

---

## 每份文档调研了什么

### 1. pi-agent-investigation.md

**调研目标**：为 ThinkingArena 的多 Agent 可并行可交流改造提供信息支撑。

**提取的五大可复用机制**（均已吸收进 [../architecture.md](../architecture.md)）：

| # | 机制 | 源码位置 | ThinkingArena 实现位置 |
|---|------|---------|----------------------|
| 1 | AgentTool 契约（参数 schema 校验前置 / before+after 钩子 / 错误编码进结果 / length 截断拒整批） | `packages/agent/src/types.ts` | `meta/` 元组件层 |
| 2 | JSONL 树持久化（type/id/parentId/timestamp + 分支 + 压缩检查点） | `packages/coding-agent/src/core/session-manager.ts` | `schema/` + `services/event-log` |
| 3 | 两段式接缝（落盘全集 vs 进模型投影） | `packages/agent/src/agent.ts` (context 管线) | `services/` 存储与上下文注入 |
| 4 | Turn 快照 + 安全点（干预只在循环安全点生效） | `packages/agent/src/agent-loop.ts` | `components/director-gate` |
| 5 | Steering / Follow-up 双队列（运行时控制流） | `packages/agent/src/agent.ts` | `components/director-gate` |

**关键判断**：Pi 明确不做 Multi-Agent，这恰恰说明多 Agent 的复杂性不能通过简单堆叠单 Agent 解决——ThinkingArena 的自研核心价值区正在于此。

---

### 2. masquerade-investigation.md

**调研目标**：为 ThinkingArena 的运行引擎架构提供信息支撑。

**提取的八大可复用模式**：

| # | 模式 | 来源 | ThinkingArena 映射 |
|---|------|------|-------------------|
| 1 | Engine 抽象基类 + 注册表装饰器 | `engine/base.py`, `engine/registry.py` | `components/` 组件注册 |
| 2 | TCAS 并发批处理（Think-Concurrent-Apply-Serial） | `orchestrator/runner.py` | `orchestrator/` DAG 执行器并行分支 |
| 3 | Script 时间轴 + 记忆快照 | `script/schema.py` | `schema/` 事件契约 |
| 4 | 三级信息分离（Public / Private / God） | `engine/base.py` | `services/agent` 上下文投影 |
| 5 | 策略注入契约（AgentStrategy） | `agent/strategy.py` | [../design/overview.md](../design/overview.md) §5.3 L0–L9 分层 |
| 6 | EventBus 发布订阅 | `orchestrator/event_bus.py` | `meta/` 事件发射元组件 |
| 7 | 共享图推理架构（SharedGraph + PrivateOverlay） | `reasoning/shared_graph.py` | `services/blackboard` + `reasoning/` |
| 8 | Pydantic 契约层（Schema-First） | `script/schema.py` + `frontend/src/types/game-script.ts` | `schema/` 四份契约 |

**关键判断**：Masquerade 的 Engine/Orchestrator/Script 三层分离已验证可行，但 0 star 状态意味着设计质量未经社区检验。ThinkingArena 采取"只读不复制"策略——吸收架构判断，自研实现。

---

### 3. n8n-investigation.md

**调研目标**：为多 LLM 模拟推演器的编排语义研究提供生产验证的参考。

**借鉴模式（Adopt）**：
- A1: 节点两元结构（声明式 Schema + 命令式 Handler）
- A2: 执行上下文注入（通过 `this` 注入能力）
- A3: 显式 Join 等待表（多输入节点的显式等待）
- A4: 端口命名与类型化（Main / Tool / Memory）
- A5: 节点执行快照（Step 级状态记录）
- A6: 凭证声明与测试（LLM 绑定冒烟）

**排除模式（Exclude）**：
- E1: Items/PairedItem 数据血缘（ETL 遗产）
- E2: 可执行表达式引擎（`={{...}}` 语法，非确定性 + 安全沙箱复杂度）
- E3: 执行级挂起恢复（Wait/Resume）
- E4: Queue Mode 分布式执行
- E5: UI 耦合的参数系统

**关键判断**：N8N 是编排引擎语义的"半份设计参考书"——节点抽象、执行调度、连接语义可直接借鉴；ETL 数据模型、可执行表达式引擎、执行级挂起恢复与 LLM 模拟推演器的核心需求存在本质冲突。

---

### 4. ChatRPG-v2-investigation.md

**调研目标**：为 ThinkingArena 的 Narrator + Archivist 裁判范式提供信息输入。

**提取的七张模式卡片**：
- P1: 叙事-状态分离（Narrative-State Separation）
- P2: ReAct 工具链标准化描述（四组件：Usage Instructions + Example Usages + Input Format + Number of Uses）
- P3: 结构化状态权威（Structured State Authority）——数据库为唯一权威，防 LLM "吃书"
- P4: Few-shot 工具引导（Few-shot Tool Guidance）
- P5: 双 Agent 裁判范式（Dual-Agent Referee Paradigm）——裁判与参与者同构
- P6: 动态角色/环境发现（Dynamic Entity Discovery）
- P7: 命中率累积惩罚（Cumulative Hit Penalty）

**关键判断**：ChatRPG v2 的 PXI 评估数据显示，双 Agent 设计在所有维度上显著优于单 Agent（p < 0.05）。ThinkingArena 的"裁判与参与者同构"原则在此得到独立验证。

---

### 5. SillyTavern-investigation.md

**调研目标**：为 ThinkingArena 的身份牌系统与 Prompt 工程提供成熟参照。

**提取的六大可复用模式**：
- 模式 1: 自包含资产容器（PNG 元数据嵌入角色卡）
- 模式 2: 分层预算管理（TokenHandler 按优先级截断）
- 模式 3: 条件化上下文注入（World Info 关键词触发引擎）
- 模式 4: 策略化格式转换（Prompt Converters 多后端适配）
- 模式 5: 指令模板序列（Instruct Mode 模板化对话格式）
- 模式 6: 事件驱动扩展系统（Extension 生命周期钩子）

**关键判断**：SillyTavern 的 Prompt 分层模型（Layer 1-7）和 World Info 触发引擎是该问题域最成熟的参照。ThinkingArena 的 L0-L9 Prompt 分层 + identity_card_v1 直接继承此设计域的成熟实践。

---

## 与项目整体性文档的关系

```
../Vision.md          → 为什么做这个项目（指导思想）
../core-loop.md       → 系统里有什么、怎么运转（领域模型）
../architecture.md    → 怎么实现（总体架构 + 关键机制）
../research.md        → 用什么技术、为什么选它（选型依据）

./                  → 外部项目的深度调研（知识级嫁接的来源）
```

**衔接关系**：[../architecture.md](../architecture.md) 和 [../research.md](../research.md) 中的每一个"吸收点"都指向一份 Investigation 文档的具体章节和源码位置。Investigation 是"论据库"，architecture/research 是"结论文档"。

---

## 推荐阅读顺序

1. **先读项目整体性文档**（建立上下文）：
   - [../Vision.md](../Vision.md) → [../core-loop.md](../core-loop.md) → [../architecture.md](../architecture.md) → [../research.md](../research.md)

2. **再按需读 Investigation**（根据你正在实现的模块）：
   - 实现服务层 / 元组件层 / 导演门 → `pi-agent-investigation.md`
   - 实现编排层 / DAG 执行器 → `n8n-investigation.md`
   - 实现游戏引擎 / Script 记录 / 并发控制 → `masquerade-investigation.md`
   - 实现裁判组件 / 工具描述 → `ChatRPG-v2-investigation.md`
   - 实现身份牌 / Prompt 分层 → `SillyTavern-investigation.md`

3. **交叉验证**：任何设计决策先在 Investigation 中找"有没有已验证的参照"，再在 [../architecture.md](../architecture.md) 中确认"本项目怎么裁剪"。

---

## 调研纪律

1. **知识级嫁接，非代码级复制**：不 fork、不复制任何代码片段，只移植经过验证的设计判断。
2. **每个吸收点带出处**：architecture.md 中的每个机制都标注了 Investigation 文档的章节和源码位置。
3. **排除清单与理由同等重要**：不采纳什么、为什么排除，与采纳什么同样关键（见各文档的"排除清单"章节）。
4. **版本锁定**：Investigation 基于特定时间点的源码快照，后续外部项目演进不自动跟进，除非主动重新调研。

---

> 最后更新：2026-07-24
> 调研范围：pi @ main, Masquerade @ main, n8n @ main, ChatRPG v2 (arXiv:2502.19519), SillyTavern @ 1.18.0
