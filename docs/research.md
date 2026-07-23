# 选型与依据

> 每条结论附核心依据与来源；被否决方案只留结论与一句理由。调研时间 2026-07。

## 1. 设计参考书：两份半

核心架构是**知识级嫁接**的产物：不 fork、不复制任何代码（含片段），但每个关键机制都移植自已验证的实现，价值通过精读转移为知识。嫁接对象如下——

- **pi**（github.com/earendil-works/pi，MIT，TypeScript，53k+ star）——第一参考书，管**服务层 / 元组件层 / 干预机制**。"薄核心 + 事件即全部 + 分层接缝"哲学在单 Agent 编码助手域的成熟实现：统一 LLM 调用层 + 约 790 行 agent loop + 会话 JSONL 树持久化 + AgentTool 规范化工具契约 + steering/follow-up 干预队列。不改造、不依赖（域错位：无多 Agent/黑板/DAG 编排；其 pi-ai 调用层与 AI SDK 职责重复）。五个吸收点（均带源码位置）：
  ① AgentTool 契约（参数 schema 校验前置、before 钩子可拦截、after 钩子可改写、错误编码进结果、length 截断拒执行整批）→ 元组件层形态模板；
  ② JSONL 树（type/id/parentId/timestamp）+ 自包含压缩检查点 → 事件落盘骨架；
  ③ 落盘全集 ⊃ 进模型投影两段式接缝 → 黑板与上下文注入分层；
  ④ turn 快照 + 保存点（干预只在循环安全点生效）→ 导演注入一致性；
  ⑤ steering/follow-up 双队列 → 导演门两档干预原型。
- **Masquerade**（github.com/GOODDAYDAY/Masquerade，Apache 2.0）——管**游戏引擎与 Script 记录**。已实现"模拟 → Script JSON → edge-tts → React 回放 → Remotion 出片"全链路；engine（纯规则 LLM 无关）/ orchestrator（回合驱动 + 并发批阶段）/ script（时间轴 + 内心独白 + 记忆快照）分工是已验证的设计。但 0 star、未经社区验证，且用户要求完全把控——只读不复制，下游前端不继承，交给成熟 Agent 工具按契约重建。
- **n8n**——半份，管**编排引擎语义**。节点 = 描述 + 行为两元（参数 schema + execute，带 version）；边 =（源节点，源端口）→（目标节点，目标端口）；执行 = 动态就绪调度（执行栈 + 多输入等待表），无需静态拓扑排序；回边即循环；分支语义 = 往哪个输出端口放数据，引擎不理解 if。借鉴：两元结构、端口命名、join 显式等待、节点执行快照（→ 条件判别值快照落盘）、凭证 test 声明（→ LLM 绑定冒烟）。排除：items/pairedItem 数据模型（ETL 遗产）、可执行表达式引擎（沙箱 CVE 连环，条件走声明式比较算子 DSL）、执行级挂起恢复、queue mode、UI 耦合参数系统、画布位置参与执行语义。
- 另有两个专项参照：**SillyTavern**（角色卡/世界书/prompt 分层，见 design/identity-card.md）；**ChatRPG v2**（arXiv:2502.19519，Narrator + Archivist 裁判范式——叙事与状态归档分离，结构化状态为唯一权威防吃书）。

## 2. 语言与运行时：TypeScript（Node LTS）

- 唯一开发者 C# 母语，TS 为最短迁移路径（同设计师、类型系统与 async/await 神似）。
- Agent 工具层新项目密度向 TS 倾斜（pi、n8n、AI SDK 均 TS）；与下游 Remotion 同栈。
- 运行时依赖收敛为三个：`ai` + `zod` + `yaml`（工程栈明细见第 7 节）。

## 3. LLM 接入：Vercel AI SDK + 自研薄路由

**候选审查**（实测）：litellmts-core 不存在；Amux 太早期（周下载 12、仅 3 家适配器）；NeuroLink 无 Moonshot/豆包且 50 依赖的重平台；multi-llm-ts 无 Moonshot/豆包；OpenRouter 无国内豆包端点且为托管形态；Portkey 无火山方舟且 2.0 改版动荡中；LiteLLM 为 Python 生态、TS 侧无等效移植；pi-ai 缓存/成本开箱最强但 TypeBox 与 Zod 纪律摩擦、结构化输出路径不明——**列为第一退路**。

**选定 Vercel AI SDK**（`ai` + `@ai-sdk/deepseek` + `@ai-sdk/moonshotai`(或 openai-compatible) + `@ai-sdk/anthropic` + `@ai-sdk/openai-compatible` 直连火山方舟豆包；18.3M 周下载、Apache-2.0、3 依赖）：
- 五家服务商全覆盖且**全部直连**——透传路由类 bug（缓存计费归一化错误）整类消失。
- 缓存：Anthropic 消息级 `providerOptions.anthropic.cacheControl` 显式断点；cache read/write tokens 入标准 usage；DeepSeek/Kimi 原始字段经 metadataExtractor 抓原始响应体——原始 usage 轨完整保留，成本对账不缺字段。
- 结构化输出：`generateObject` 原生吃 Zod schema，与项目 schema 纪律零摩擦；降级路径（json_object + Zod 校验重试）原样保留。
- 无内置 Router/价格表 → **自研薄路由**（按模型名路由 + 同能力级 fallback 链 + 指数退避 + 熔断，约百行，行为完全可控）+ **自维护 YAML 价格表**（双轨台账的覆盖轨）。

**服务商侧怪癖（与接入层无关，必须遵守的交集）**：
- 工具调用取交集：单工具、`tool_choice` 只用字符串值、禁并行工具调用与 `parallel_tool_calls`（DeepSeek 对象形式报 500、Kimi 不支持 required）。裁判判定首选 json_schema，DeepSeek/Kimi/豆包降级 json_object + Zod 校验重试。
- 缓存：DeepSeek/Kimi/OpenAI 自动缓存零代码收益（命中价 ≈2%~17%）；Anthropic 必须显式 cache_control（每请求限 4 断点）；豆包短局只用隐式缓存。
- 成本双轨：自维护价格表计算值 + 原始 usage 重算值同时落 Script；价格表即 `model_info` 覆盖轨。
- 换层前置动作：五家按接入验收清单重跑冒烟（cost 非零 / cached_tokens / 工具往返 / json_object）。

## 4. 编排：自研配置化 DAG 执行器，不引入框架

- 回合拓扑静态、导演注入在节点边界、可复现性由事件重放承担——编排框架（LangGraph 等）的核心价值区（动态图、任意点 interrupt、checkpoint 持久化）全部用不上，反而引入双真相源。
- 方法论佐证：12-Factor Agents 的 Own your control flow。图库（graphlib 等）只提供静态拓扑排序；Temporal/Inngest 类持久化引擎要引入重基础设施——均与本模型不符。
- 执行语义参照 n8n（见第 1 节），实现自研，规模数百行。

## 5. 身份与 prompt：身份牌层

设计详见 design/identity-card.md。要点结论：

- **SillyTavern** 体系是该问题域最成熟参照：Tavern v2 角色卡规范、World Info 世界书、Prompt Manager 分层组装。
- 业界缓存实践一致：静态内容置前、动态置尾、边界打断点；防 footgun（工具序漂移、时间戳/UUID 泄漏进前缀）。
- 结论：自研 identity_card_v1（与 LLM 配置零耦合）+ L0–L9 prompt 分层 + Tavern v2 卡导入兼容。

## 6. 裁判范式：Narrator + Archivist

- ChatRPG v2 验证的双 Agent 分工：叙事与状态归档分离，结构化状态为唯一权威防吃书。
- 骰点/规则表达式参考海豹骰（SealDice），表达式解析自研（约 100 行递归下降，属领域逻辑）；种子 RNG 手写 mulberry32（约 20 行，Node 无可播种内置随机源）。

## 7. 下游链路：成熟 Agent 工具 + 参照项目

- 视频脚本创作、Remotion 工程搭建与迭代、B 站发布：交给 Kimi 桌面端 / OpenCode 等 Agent 工具，经事件契约与分镜 Schema 衔接，校验器兜底。
- 参照：**MoneyPrinterTurbo**（全链路工程参照）、**NarratoAI**（IndexTTS2 语音克隆备选）、**MoneyPrinterPlus**（B 站自动发布模块参照）。

## 8. 工程栈明细（原生内置优先）

| 模块 | 选型 | 一句理由 |
|---|---|---|
| Schema | **Zod 4** | 原生 `z.toJSONSchema()`；**对外契约 schema 禁用 transform/refine**（保证导出无损），自定义校验放运行时守卫 |
| 持久化 | **node:sqlite**（Node 内置，封约 50 行 Store 接口） | 零依赖零原生编译；实验状态可接受，换 better-sqlite3 成本低；事件流 JSONL 纯 `fs` 追加无依赖 |
| YAML | **yaml**（eemeli） | 唯一注释往返保留，利于 Agent 改写 Bundle 配置 |
| CLI | **node:util parseArgs** | 两三个命令不配拥有框架 |
| 日志 | **手写 JSONL logger**（约 40 行） | 与"一切皆事件"同构，schema 可进 Zod 契约 |
| 测试 | **node:test**（Node 24 直接跑 TS） | 契约/组件测试零依赖 |
| 并发/取消 | **原生 Promise + AbortController + 手写信号量** | AbortSignal.timeout 内置；p-limit 是唯一值得破例的微库但手写才 25 行 |
| TTS | **edge-tts-universal**（TS 原生，活跃） | 仓库保持纯 TS；Python edge-tts 子进程为备选（协议漂移时参照实现总是最先修） |

## 9. 最终选型一览

| 层 | 选型 |
|---|---|
| 架构 | 薄核心 + 契约衔接；模块间只共享版本化 Schema |
| 技术栈 | TypeScript（Node LTS）；运行时依赖仅 ai(providers) + zod + yaml |
| 模拟核心 | 自研四层（服务/元组件/组件/编排），规模纪律几千行 |
| 多 LLM | Vercel AI SDK + 自研薄路由 + 自维护价格表（pi-ai 为第一退路） |
| 身份牌 | 自研 identity_card_v1，与 LLM 配置零耦合，兼容 Tavern v2 导入 |
| 导演干预 | 导演门组件（分支级输入门 + steering/follow-up 两档 + whisper 深度注入） |
| 持久化 | 事件流 JSONL（fs）+ node:sqlite（Store 接口） |
| 语音 | edge-tts-universal 起步，IndexTTS2 备选 |
| 视频 | Remotion 独立子项目，Agent 工具搭建维护 |
| 回放 | 后期按需，Agent 工具按契约实现 |
| 配置 | YAML + Zod，LLM 配置与身份牌分离 |
