# 选型与依据

> 调研时间：2026-07。每条结论附核心依据；被否决方案只留结论与一句理由，演进过程见 git 历史。

## 1. 基座：自研薄核心，Masquerade 仅作设计参考书

- **Masquerade**（github.com/GOODDAYDAY/Masquerade，Apache 2.0）：LLM 多智能体桌游竞技场，已实现谁是卧底/狼人杀的"模拟 → Script JSON 记录 → edge-tts → React 回放 → Remotion 出片"全链路。其 engine（纯规则 LLM 无关）/ orchestrator（回合驱动+并发批阶段）/ script（时间轴+内心独白+记忆快照）分工是已验证的设计，值得精读。
- 但 0 star、未经社区验证，不 fork、不复制任何代码（含片段）——不愿为不信任的代码承担担保成本，且要求对仓库每行代码的完全把控。其价值通过精读转移为知识（导读笔记即实现规格）。
- 同理，下游重前端（回放剧场、Remotion 工程）不继承其代码，交给持续进化的成熟 Agent 工具按契约重建。

**pi**（github.com/earendil-works/pi，MIT，TypeScript，53k+ star，2026 年活跃）——"AI agent toolkit"：统一 LLM 调用层 + 约 790 行 agent loop 核心 + 会话 JSONL 树持久化 + AgentTool 规范化工具契约 + steering/follow-up 干预队列。它是"薄核心 + 事件即全部 + 分层接缝"**同一哲学在单 Agent 编码助手域的成熟实现**，与本项目服务层/元组件层高度同构，与 Masquerade 并列为第一设计参考书（pi 管服务层/元组件层/干预机制，Masquerade 管游戏引擎与记录）。
- 不改造、不依赖：全仓 16MB 超薄核心预算；域错位（无多 Agent/黑板/DAG 编排）；其 pi-ai 调用层与 LiteLLM 职责重复。只精读吸收（同栈 TS，精读时可直接对照实现）。
- 五个吸收点（均带源码位置，详见调研）：① **AgentTool 契约**（参数 schema 校验前置、before 钩子可拦截、after 钩子可改写结果、错误编码进结果而非异常、length 截断拒执行整批）→ 元组件层形态模板；② **JSONL 树**（type/id/parentId/timestamp）+ 自包含压缩检查点 → 事件落盘骨架，分叉/回放零成本；③ **落盘全集 ⊃ 进模型投影**的两段式接缝 → 黑板与上下文注入的分层；④ **turn 快照 + 保存点**（干预只在循环安全点生效，绝不突变在飞请求）→ 导演注入一致性；⑤ **steering/follow-up 双队列** → 导演输入门机制原型。

## 2. 编排：自研配置化 DAG 执行器，不引入框架

- 回合拓扑静态、导演注入在节点边界、可复现性由事件重放承担——编排框架（LangGraph 等）的核心价值区（动态图、任意点 interrupt、checkpoint 持久化）全部用不上，反而引入双真相源与已知坑（interrupt 恢复时节点重跑导致副作用重放；checkpoint 子包高频迭代 + CVE 前科）。
- 方法论佐证：12-Factor Agents 的 Own your control flow——显式主循环 + 事件追加 + 无状态 reducer。

**n8n 引擎调研结论**（实现视角，2026-07）——节点-图分离的成熟参照物，仅参照不引入：
- 节点 = **描述 + 行为两元**（参数 schema + execute），带 version 字段多版本共存；边 =（源节点，源端口）→（目标节点，目标端口）。
- 执行 = **动态就绪调度**（执行栈 + 多输入等待表），无需静态拓扑排序；**回边即循环**，无循环原语；分支语义 = 往哪个输出端口放数据，引擎本身不理解 if。
- 借鉴：组件 description/behavior 分离 + version 字段；边以节点 id 为键、端口命名；join 显式等待语义；节点执行快照（对应我们的条件判别值快照落盘，重放确定性的关键）；凭证"配置存引用、运行时解析、自带 test 声明"（对应 LLM 绑定与身份牌解耦 + 接入验收）。
- 排除（明确不做）：items/pairedItem 数据模型（ETL 遗产，我们用黑板）、**可执行表达式引擎**（沙箱 CVE 连环，条件走声明式比较算子 DSL）、执行级挂起恢复（导演门是分支级阻塞）、queue mode/多 worker、UI 耦合参数系统、画布位置参与执行语义。

## 3. LLM 接入：LiteLLM（实测校准后采用）

- 统一 OpenAI 格式调用 100+ 服务商，Router 路由/fallback/重试 + 成本统计。配置下沉到角色级（`llm.model`），与身份牌完全解耦。
- **技术栈：TypeScript**（Node LTS）。理由：唯一开发者 C# 母语，TS 为最短迁移路径（同设计师、类型系统与 async/await 神似）；Agent 工具层新项目密度向 TS 倾斜；与参考书（pi/n8n）及下游（Remotion）同栈。LiteLLM 以 **Proxy sidecar** 模式接入（本地服务进程，OpenAI 兼容 HTTP），本节全部实测结论在 Proxy 模式下保留。Schema 层用 **Zod**（校验 + JSON Schema 导出）。
- 实测约束（2026-07 验证，必须遵守）：
  - **工具调用取交集**：单工具、`tool_choice` 只用字符串值、禁并行工具调用与 `parallel_tool_calls`（DeepSeek 对象形式报 500、Kimi 不支持 required、Gemini 路由 400）。裁判判定首选 json_schema，DeepSeek/Kimi/豆包降级 json_object + Zod 校验重试。
  - **缓存**：DeepSeek/Kimi/OpenAI 自动缓存零代码收益（命中价 ≈2%~17%）；Anthropic 必须显式 cache_control（每请求限 4 断点）；豆包短局只用隐式缓存。透传路由有缓存计费归一化 bug，用直连路由。
  - **成本双轨**：价格表有滞后与个别计费错误前科——LiteLLM cost + 原始 usage 重算同时落 Script；预留 `model_info` 价格覆盖。
  - **fallback**：同能力等级内配置；监控重试次数（已知循环 bug #19985）。

## 4. 身份与 prompt：身份牌层（设计详见 identity-card.md）

- **SillyTavern** 体系是该问题域最成熟参照：Tavern v2 角色卡规范（字段语义、PNG 嵌卡、社区生态）、World Info 世界书（关键词触发/常亮/插入位置/预算）、Prompt Manager 分层组装。
- 业界缓存实践一致：静态内容置前、动态置尾、边界打断点；防 footgun（工具序漂移、时间戳/UUID 泄漏进前缀）。
- 结论：自研 identity_card_v1（与 LLM 配置零耦合）+ L0–L9 prompt 分层 + Tavern v2 卡导入兼容。

## 5. 裁判范式：Narrator + Archivist

- ChatRPG v2（arXiv:2502.19519）验证的双 Agent 分工：叙事与状态归档分离，结构化状态为唯一权威防吃书。
- 骰点/规则表达式参考海豹骰（SealDice）。组件模型下，裁判是组件组合而非特殊架构（core-loop.md）。

## 6. 下游链路：成熟 Agent 工具 + 参照项目

- 视频脚本创作、Remotion 工程搭建与迭代、B 站发布：交给 Kimi 桌面端 / OpenCode 等 Agent 工具，经事件契约与分镜 Schema 衔接，校验器兜底。
- 参照：**MoneyPrinterTurbo**（文案→素材→配音→字幕→合成全链路工程参照）、**NarratoAI**（IndexTTS2 语音克隆备选）、**MoneyPrinterPlus**（B 站自动发布模块参照）。

## 7. 最终选型一览

| 层 | 选型 |
|---|---|
| 架构 | 薄核心 + 事件契约 + 衔接层；模块间只共享版本化 Schema |
| 模拟核心 | 自研四层（服务/元组件/组件/编排），TypeScript（Node LTS），依赖仅 LiteLLM（Proxy sidecar）+ Zod，规模纪律几千行 |
| 身份牌 | 自研 identity_card_v1，与 LLM 配置零耦合，兼容 Tavern v2 导入 |
| 多 LLM | LiteLLM（按第 3 节交集约束使用） |
| 导演 | 显式导演节点组件（输入门控 + 催眠注入） |
| 语音 | edge-tts 起步，IndexTTS2 备选 |
| 视频 | Remotion 独立子项目，Agent 工具搭建维护 |
| 回放 | 后期按需，Agent 工具按契约实现 |
| 配置 | YAML + Zod，LLM 配置与身份牌分离 |
