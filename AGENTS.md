# AGENTS.md — ThinkingArena

> 本文写给 AI 编码 Agent。读完这份文件，你应该知道这个项目是什么、权威文档在哪、做事的纪律是什么。

## 项目概述

ThinkingArena 是一个**配置驱动的多 LLM 模拟推演器**：若干不同服务商的 LLM 扮演角色，在配置化流程图中自主推演；导演（用户）在局中通过"导演门"注入干预，在局间调整配置迭代；推演全程以事件落盘（Script JSONL），事件流向下游加工为复盘分析、视频文案与素材，最终产出 B 站视频。详细愿景见 `docs/Vision.md`。

## 当前状态（重要）

**薄核心 MVP 已全部落地（任务书阶段 3，全仓 `node:test` 378/378 绿）。** 各层现状：`schema/` 契约层（v1.0.0，已冻结）；`services/` 五服务（event-log / blackboard / llm-gateway / memory / agent-service）；`meta/` 元组件层（六内置名册 + 四扩展）；`components/` 六内置组件（role_create / role_destroy / narrative / dice / judge / director_gate）；`orchestrator/` 编排层（graph / scheduler / reducer / director-pump / ledger / flow-runner）；`cli/` 入口（run 组合根 / replay 重放 / observe 事件视图 / mock-llm 执行器缝）。线性首局 e2e（mock LLM：叙事 + 骰子 + 判定 + 条件分支 + 回边 2 轮 + 导演门）与崩溃恢复 e2e（D12/D36/resume）均已跑通。

因此：
- 工程配置：`package.json`（唯一依赖 zod 4，type: module）、Node 24 type stripping 直跑 TS（无 tsconfig/构建步骤）。测试命令：`npm test`（= `node --test` 全 glob 覆盖 schema/services/meta/components/orchestrator/tests；注意 `node --test <dir>/` 带目录参数的形态在本环境不可用，须用 glob 或裸 `node --test`）。
- 写代码前先确认对应契约与决策已在文档中定义；本项目的惯例是**契约先行**。实现层（Phase 1）的唯一契约权威是 `schema/`，修改契约走版本化 + `schema/CHANGELOG.md`；`services/types.ts` 与 `orchestrator/types.ts` 是架构师冻结的接口钉，同样不可直接改。
- 冻结接口之外的实现层增量面（经鸭子类型/具体实现接口暴露）：`EventLogFileContext`（run 上下文读取）、`BlackboardRunContext.bindExec` / `AgentServiceEx`（bindExec/applyEvent/restoreSpec 等）、`LLMGatewayPricing.priceOf`、`MemoryServiceEx.ingest`、`MutableEnvelopeSource`（见下）。
- **exec/run 上下文通道的 MVP 机制 = envelopeSource/RunContext 绑定**：`meta/registry.ts` 接受 `envelopeSource: { current() }`，组合根（`cli/run.ts`）创建可变信封源并同时注入 meta registry 与 FlowRunnerDeps（鸭子类型额外字段），FlowRunner 逐节点边界 `set(exec)/set(null)`（emit 类元组件与服务事实的信封唯一来源）。
- 调研类产出物（报告、导读）放 `docs/`，不引入代码依赖。

## 技术栈（规划，已选定）

| 项 | 选型 |
|---|---|
| 语言/运行时 | TypeScript / Node.js |
| LLM 接入 | Vercel AI SDK（`ai` 及 providers），薄路由 + 价格表 + 缓存断点 |
| 校验 | Zod（契约定义 + JSON Schema 导出） |
| 配置 | YAML |
| 持久化 | JSONL 事件树 + `node:sqlite` |
| 外围（局外） | edge-tts、Remotion（视频）、Kimi 桌面端 / OpenCode（复盘与视频 Agent 工具） |

运行时依赖纪律：核心仅 `ai` + `zod` + `yaml`。核心规模目标几千行内（Phase 1 约 2500 行），唯一开发者通读无障碍。

## 代码组织（`schema/`–`cli/` 均已落地）

单仓库、单进程（一局一进程），按四层分目录：

| 目录 | 层 | 职责 |
|---|---|---|
| `schema/` | 契约层 | 六份契约文件（`event` 事件 / `flow` 流程图配置 / `meta-component` 元组件接口 / `identity-card` 身份牌 / `bundle` Bundle+manifest / `errors` 错误枚举）的 Zod 定义，版本化 + CHANGELOG；`fixtures/isekai/` 示例 Bundle |
| `services/` | 服务层 | agent、memory、blackboard、event-log、llm-gateway；长期子系统，独立持久化 |
| `meta/` | 元组件层 | 服务层的唯一调用面，AgentTool 式契约（校验前置、before/after 钩子、错误编码进结果）；`registry.ts` + `builtins.ts`（六名册 + 四扩展）+ `testkit.ts` |
| `components/` | 组件层 | 内置组件（角色创建/销毁、叙事、判定、骰子、导演门）；description + run 两元结构；`index.ts` 注册表（骰流按种子共享） |
| `orchestrator/` | 编排层 | 流程图加载校验（graph）+ DAG 执行器（FlowRunner 外观；内部 scheduler / reducer / director-pump / ledger） |
| `cli/` | 入口 | `run.ts`（组合根：装配全部服务 → meta → 组件 → FlowRunner；`--bundle/--run-dir/--mock-llm/--resume`）/ `replay.ts`（重放重建状态摘要）/ `observe.ts`（F16 事件视图）/ `mock-llm.ts`（LlmExecutor 缝的 mock 实现） |
| `tests/` | 集成测试 | `smoke.test.ts`（装配冒烟）+ `e2e/`（linear-first-game 线性首局 / resume 崩溃恢复；`test-kit.ts` 共享工具） |

架构细节的唯一权威定义在 `docs/design/runtime-architecture.md`（接口 §4、状态机 §3、数据流 F1–F18 §1、错误矩阵 §5）。模块之间不共享代码、不共享内存，只共享契约。

## 文档体系与阅读顺序

权威文档按序阅读（`docs/README.md` 是文档地图）：

1. `docs/Vision.md` — 愿景与三条指导思想（原始构想，不改写）
2. `docs/core-loop.md` — 领域模型：四层存在物、两个循环、导演工作流、五条设计原则
3. `docs/design/runtime-architecture.md` — 运转架构权威定义：决策表 D1–D37、时序、状态机、接口、错误矩阵
4. `docs/design/layers.md` — 全部设计元素的分解树与决策覆盖索引
5. `docs/roadmap.md` — Phase 0–5 与风险登记

其他：`docs/scenarios/` 场景设计（如 `isekai-survival.md`）；`docs/used-reference/` 调研归档（**非权威**，与核心文档冲突时以核心文档为准）；`task/` 设计任务书。

## 核心设计原则（做事前必读）

1. **没有银弹**：不一切皆组件；跨流程、有独立生命周期的元素独立成服务。
2. **显式优于自动**：Agent 显式销毁才关闭；导演干预显式放置才生效；配置在外、逻辑在内。
3. **事件即事实**：一切状态变化落盘为事件，可重放、可归因、可分叉。
4. **规模纪律**：复杂度只许长在游戏规则（图 + 组件）里，不许长在框架里。
5. **新元素先定位**：任何新模块必须能定位到 `layers.md` 分解树的某个父节点；定位不了的，不做。

## 文档维护纪律

本项目目前是文档仓，改文档就是主要工作，纪律如下（详见 `docs/README.md` 与 `docs/design/layers.md` 末节）：

- **概念只定义一次**：领域模型定义于 `core-loop.md`，运转实现定义于 `design/runtime-architecture.md`，其余文档只引用不重述。
- 新设计元素必须能挂为 `layers.md` 分解树某父节点的子节点，并在"决策覆盖索引"登记决策挂点；新决策同样必须登记。
- **只保留定稿态**：不留版本修订记录与被否决方案的辩护段落，演进查 git 历史（`runtime-architecture.md` 附录 B 的分歧/审查记录除外）。
- `scenarios/` 用领域模型语言书写，不引入模型外的概念。
- 文档语言为**中文**；图表用 Mermaid。Markdown 文件统一 LF 换行（见 `.gitattributes`）。
- Git 提交信息风格：`docs：描述` / `docs: 描述`（中文描述，如 `docs：完成真正的运行架构文档`）。

## 测试与验证

全仓 `node:test`（Node 24 type stripping 直跑 TS，无编译步骤）：`npm test`（glob 覆盖 `schema/ services/ meta/ components/ orchestrator/ tests/`）。契约文件配同名 `*.test.ts`（正向/反向/round-trip/JSON Schema 导出）；服务/元组件/组件/编排各层配单元测试（依赖全 mock）；`tests/` 为组合根冒烟与 e2e（mock LlmExecutor 脚本化响应，无外部 LLM）。规划中的验证策略（见 `roadmap.md`）：

- 契约（Zod Schema）即代码，组件入库前过契约测试。
- Phase 1 用线性单主角场景验证薄核心（Phase 2 起用《谁是卧底》验证多人并行与完整导演门）；接入验收清单（cost 非零 / cached_tokens / 工具调用往返 / json_object）落地为 dev 工具——e2e 已覆盖 cost 非零与工具调用往返（mock 侧），cached_tokens / json_object 待真实适配器接入。
- 渲染器纯函数 + 静态前缀 SHA256 逐回合落 Script 校验，防缓存漂移。

## 安全与边界注意事项

- 身份牌（identity_card_v1）校验器须拒绝卡内出现模型字段——身份与 LLM 解耦是机械保证，不得绕过。
- 导演 whisper 只走 Agent 私有上下文（L8 注入），绝不进静态前缀；inject 仅用于环境事件。
- 记忆系统无外部写入面（D22），只能经沉淀通道（回合 → 记忆）写入。
- 多服务商 LLM API key 预计走环境变量/本地配置，**不要提交密钥**；成本有双轨台账与成本闸（D28）硬约束。
