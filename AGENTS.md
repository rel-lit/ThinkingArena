# AGENTS.md — ThinkingArena

> 本文写给 AI 编码 Agent。读完这份文件，你应该知道这个项目是什么、权威文档在哪、做事的纪律是什么、有哪些已踩过的坑。

## 项目概述

ThinkingArena 是一个**配置驱动的多 LLM 模拟推演器**：若干不同服务商的 LLM 扮演角色，在配置化流程图中自主推演；导演（用户）在局中通过"导演门"注入干预，在局间调整配置迭代；推演全程以事件落盘（Script JSONL），事件流向下游加工为复盘分析、视频文案与素材，最终产出 B 站视频。详细愿景见 `docs/Vision.md`。

## 当前状态（重要）

**薄核心 MVP 可真实运行**：schema/ 契约层 v1.0.0 已冻结，四层实现 + CLI 全部落地，全仓 `node:test` **392/392 绿**。真实 LLM 已接入（DeepSeek + Kimi Code，见"真实运行与凭证"）；`bundles/isekai-mvp/`（单世界切片）已完成第一局真实推演（completed，线性 3 回合 + 导演门 + 理智检查）。

因此：

- 工程配置：`package.json`（zod 4 + ai 7 + @ai-sdk/deepseek + @ai-sdk/moonshotai，type: module）、Node 24 type stripping 直跑 TS（无 tsconfig/构建步骤）。测试命令：`npm test`（= `node --test` 全 glob；**注意 `node --test <dir>/` 带目录参数的形态在本环境不可用**，须用 glob 或裸 `node --test`）。
- 写代码前先确认对应契约与决策已在文档中定义；本项目的惯例是**契约先行**。实现层的唯一契约权威是 `schema/`，修改契约走版本化 + `schema/CHANGELOG.md`；`services/types.ts` 与 `orchestrator/types.ts` 是架构师冻结的接口钉，不可直接改。
- 冻结接口之外的实现层增量面（鸭子类型/具体实现接口）：`EventLogFileContext`（run 上下文读取）、`BlackboardRunContext.bindExec` / `AgentServiceEx`（bindExec/applyEvent/restoreSpec 等）、`LLMGatewayPricing.priceOf`、`MemoryServiceEx.ingest`、`MutableEnvelopeSource`。
- **exec/run 上下文通道的 MVP 机制 = envelopeSource/RunContext 绑定**：`meta/registry.ts` 接受 `envelopeSource: { current() }`，组合根创建可变信封源注入 meta registry 与 FlowRunnerDeps，FlowRunner 逐节点边界 `set(exec)/set(null)`。

## 真实运行与凭证

- **凭证**：`.env`（gitignored，模板 `.env.example`）填 `DEEPSEEK_API_KEY` / `MOONSHOT_API_KEY`；`cli/run.ts` 与 `cli/dev-smoke.ts` 启动时自动加载（已有环境变量优先）。绝不提交密钥。
- **接入验收**：`node cli/dev-smoke.ts`（cost 非零 / cached_tokens / 结构化往返 / json_object 四项；DeepSeek 与 Kimi Code 均已实测 PASS）。
- **跑局**：`node cli/run.ts --bundle bundles/isekai-mvp --run-dir runs/<新目录>`；彩排用 `--mock-llm bundles/isekai-mvp/mock-llm.script.json`（零费用）。产物在 `runs/<目录>/`（script.jsonl + manifest.json + memory/，gitignored）。
- **查看**：`node cli/observe.ts runs/<目录>`、`node cli/replay.ts runs/<目录>`——只读文件，**不调用 API**。
- **Kimi 双平台端点（坑）**：Kimi Code 会员 key 必须用 `MOONSHOT_BASE_URL=https://api.kimi.com/coding/v1`；Moonshot 开放平台 key 用 `https://api.moonshot.cn/v1`。两套账号不通用，配错全 401。

## 技术栈（已落地）

| 项 | 选型 |
|---|---|
| 语言/运行时 | TypeScript / Node.js ≥ 24 |
| LLM 接入 | Vercel AI SDK（`ai@7` + `@ai-sdk/deepseek` + `@ai-sdk/moonshotai`），薄路由 + 价格表 + 缓存断点；执行器缝 `LlmExecutor`（`services/ai-sdk-executor.ts` 真 / `cli/mock-llm.ts` mock） |
| 校验 | Zod 4（契约定义 + JSON Schema 导出） |
| 配置 | YAML（fixtures/bundle 用 JSON 语法书写，YAML 1.2 兼容） |
| 持久化 | JSONL 事件树（fs）+ 记忆 JSON 文件；`node:sqlite` 预留未用 |
| 外围（局外，未开始） | edge-tts、Remotion（视频）、Kimi 桌面端 / OpenCode（复盘与视频 Agent 工具） |

运行时依赖纪律：核心仅 `ai` + `zod` + `yaml`（yaml 尚未引入，fixtures 以 JSON 语法规避）。核心规模目标几千行内，唯一开发者通读无障碍。

## 代码组织

单仓库、单进程（一局一进程），按四层分目录：

| 目录 | 层 | 职责 |
|---|---|---|
| `schema/` | 契约层 | 六份契约（`event` / `flow` / `meta-component` / `identity-card` / `bundle` / `errors`）Zod 定义，版本化 + CHANGELOG；`fixtures/isekai/` 示例 Bundle |
| `services/` | 服务层 | agent、memory、blackboard、event-log、llm-gateway、ai-sdk-executor（真适配器） |
| `meta/` | 元组件层 | 服务层唯一调用面；`registry.ts` + `builtins.ts`（六名册 + 四扩展）+ `testkit.ts` |
| `components/` | 组件层 | role_create / role_destroy / narrative / dice / judge / director_gate；`index.ts` 注册表（骰流按种子共享） |
| `orchestrator/` | 编排层 | graph（加载校验）+ FlowRunner 外观（scheduler / reducer / director-pump / ledger） |
| `cli/` | 入口 | `run.ts`（组合根）/ `replay.ts` / `observe.ts` / `dev-smoke.ts`（接入验收）/ `env.ts`（.env 加载）/ `mock-llm.ts` |
| `bundles/` | 场景包 | `isekai-mvp/`（flow.yaml + game.yaml + identity_cards/ + worldbook.yaml + seeds.yaml + mock 脚本） |
| `tests/` | 集成测试 | `smoke.test.ts` + `e2e/`（linear-first-game / resume / isekai-mvp-bundle；`test-kit.ts` 共享工具） |

架构细节的唯一权威定义在 `docs/design/runtime-architecture.md`（接口 §4、状态机 §3、数据流 F1–F18 §1、错误矩阵 §5）。模块之间不共享代码、不共享内存，只共享契约。

## 文档体系与阅读顺序

权威文档按序阅读（`docs/README.md` 是文档地图）：

1. `docs/Vision.md` — 愿景与三条指导思想（原始构想，不改写）
2. `docs/core-loop.md` — 领域模型：四层存在物、两个循环、导演工作流、五条设计原则
3. `docs/design/runtime-architecture.md` — 运转架构权威定义：决策表 D1–D37、时序、状态机、接口、错误矩阵
4. `docs/design/layers.md` — 全部设计元素的分解树与决策覆盖索引
5. `docs/roadmap.md` — Phase 0–5 与风险登记

其他：`docs/scenarios/` 场景设计（如 `isekai-survival.md`）；`docs/used-reference/` 调研归档（**非权威**，含两份 deep-dive 调研）；`task/` 设计任务书。

## 已踩过的坑（修改前必读）

1. **flow.yaml 与 game.yaml 双写名册**：`role_create` 节点参数内联了身份牌与模型绑定（与 game.yaml 名册各存一份）。**改模型必须两处同步**，否则路由落空报 NO_FALLBACK_AVAILABLE。后续改进：role_create 支持按名册 id 引用。
2. **名册模型 id 必须是真实 API id**：`deepseek-chat/deepseek-v4-flash`（DeepSeek）、`k3`（Kimi Code 端点）。调研文档里的 2026 名册名（deepseek-v4、kimi-k3 等）未实测勿直接用；dev-smoke 是最低验证。
3. **一文件一局**：`--run-dir` 已有 script.jsonl 时不可直接重跑（EventLog 拒绝），换新目录或 `--resume`。
4. **运行时缺键 ≠ 配置错误**（D7）：分支条件引用的键多为 LLM 运行时产出，缺席时求值为 false 并记 system 告警，不会判节点失败；但要保证控制流关键键由 prompt 契约（judge 的 `state_contract` 参数）或确定性路径产出。
5. **wait_forever 门 = 纯 promise 挂起**：CLI 自持保活句柄（库 timer 是 unref 的）；投喂门指令一次一条，被 `no_waiting_gate` 拒收则重投。
6. **Kimi Code 端点**：不支持 response_format（json_schema 走 prompt 引导降级，D17 路径）；会员是限流额度（约 300–1200 请求/5h 窗口），长回合/批量注意。
7. **成本是占位费率**：`cli/run.ts` 的 buildMockPriceTable 用占位费率（2/8 CNY 每 1M tokens），manifest 成本非真实报价——真实价格表未建。

## 已知缺口与下一步（接手工作清单）

- **状态表无初始化**：`rules.initial_state` 只是文档声明，无组件在加载期写入黑板（技能表开局为空）。需要一个状态初始化组件或加载期导入机制。
- **控制流关键键由 LLM 写**：`state.rounds` 依赖裁判自觉递增（真实首局被一步写到 3 导致回合被跳）。应给 judge 或结算节点加确定性递增参数。
- **milestone 组件未实现**：结局落默认 `finished`。
- **真实价格表**：usage 五字段已归一（deep-dive-llm-gateway.md），按它建真实费率表替换占位。
- **记忆压缩（F18）未启用**：MVP 为截断模式。
- **Phase 2（roadmap）**：并行分支 join/TCAS 批协议（D8/D9）+ 完整导演门（多门）+《谁是卧底》验证。

## 核心设计原则（做事前必读）

1. **没有银弹**：不一切皆组件；跨流程、有独立生命周期的元素独立成服务。
2. **显式优于自动**：Agent 显式销毁才关闭；导演干预显式放置才生效；配置在外、逻辑在内。
3. **事件即事实**：一切状态变化落盘为事件，可重放、可归因、可分叉。
4. **规模纪律**：复杂度只许长在游戏规则（图 + 组件）里，不许长在框架里。
5. **新元素先定位**：任何新模块必须能定位到 `layers.md` 分解树的某个父节点；定位不了的，不做。

## 文档维护纪律

- **概念只定义一次**：领域模型定义于 `core-loop.md`，运转实现定义于 `design/runtime-architecture.md`，其余文档只引用不重述。
- 新设计元素必须能挂为 `layers.md` 分解树某父节点的子节点，并在"决策覆盖索引"登记决策挂点；新决策同样必须登记。
- **只保留定稿态**：不留版本修订记录与被否决方案的辩护段落，演进查 git 历史（`runtime-architecture.md` 附录 B 的分歧/审查记录除外）。
- `scenarios/` 用领域模型语言书写，不引入模型外的概念。
- 文档语言为**中文**；图表用 Mermaid。Markdown 文件统一 LF 换行（见 `.gitattributes`）。
- Git 提交信息风格：`docs：描述`（中文），代码类用 `impl：` / `fix：` / `chore：`。

## 测试与验证

全仓 `node:test`（Node 24 type stripping 直跑 TS，无编译步骤）：`npm test`（glob 覆盖 `schema/ services/ meta/ components/ orchestrator/ tests/`，当前 392 个）。契约文件配同名 `*.test.ts`（正向/反向/round-trip/JSON Schema 导出）；各层单元测试依赖全 mock；`tests/` 为组合根冒烟与 e2e（mock LlmExecutor 脚本化响应，无外部 LLM）。验证策略（见 `roadmap.md`）：

- 契约（Zod Schema）即代码，组件入库前过契约测试。
- 接入验收清单（cost 非零 / cached_tokens / 工具调用往返 / json_object）已落地为 `cli/dev-smoke.ts`，DeepSeek 与 Kimi Code 实测 PASS。
- 渲染器纯函数 + 静态前缀 SHA256 逐回合落 Script 校验，防缓存漂移。

## 安全与边界注意事项

- 身份牌（identity_card_v1）校验器须拒绝卡内出现模型字段——身份与 LLM 解耦是机械保证，不得绕过。
- 导演 whisper 只走 Agent 私有上下文（L8 注入），绝不进静态前缀；inject 仅用于环境事件。
- 记忆系统无外部写入面（D22），只能经沉淀通道（回合 → 记忆）写入。
- 多服务商 LLM API key 走 `.env`/环境变量，**不要提交密钥**；成本有双轨台账与成本闸（D28）硬约束。
- 错误事件只记枚举与元数据，原始响应体不进 Script（F7 凭证消毒）。
