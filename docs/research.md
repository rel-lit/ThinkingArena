# 选型与依据

> 调研时间：2026-07。每条结论附核心依据；被否决方案只留结论与一句理由，演进过程见 git 历史。

## 1. 基座：自研薄核心，Masquerade 仅作设计参考书

- **Masquerade**（github.com/GOODDAYDAY/Masquerade，Apache 2.0）：LLM 多智能体桌游竞技场，已实现谁是卧底/狼人杀的"模拟 → Script JSON 记录 → edge-tts → React 回放 → Remotion 出片"全链路。其 engine（纯规则 LLM 无关）/ orchestrator（回合驱动+并发批阶段）/ script（时间轴+内心独白+记忆快照）分工是已验证的设计，值得精读。
- 但 0 star、未经社区验证，不 fork、不复制任何代码（含片段）——不愿为不信任的代码承担担保成本，且要求对仓库每行代码的完全把控。其价值通过精读转移为知识（导读笔记即实现规格）。
- 同理，下游重前端（回放剧场、Remotion 工程）不继承其代码，交给持续进化的成熟 Agent 工具按契约重建。

## 2. 编排：自研配置化 DAG 执行器，不引入框架

- 回合拓扑静态、导演注入在节点边界、可复现性由事件重放承担——编排框架（LangGraph 等）的核心价值区（动态图、任意点 interrupt、checkpoint 持久化）全部用不上，反而引入双真相源与已知坑（interrupt 恢复时节点重跑导致副作用重放；checkpoint 子包高频迭代 + CVE 前科）。
- 方法论佐证：12-Factor Agents 的 Own your control flow——显式主循环 + 事件追加 + 无状态 reducer。
- 设计参照物：n8n / ComfyUI 的节点-图分离（节点是代码、流程是配置图），仅参照不引入。DAG 就绪调度在静态配置下是教科书级算法，自研规模可控。

## 3. LLM 接入：LiteLLM（实测校准后采用）

- 统一 OpenAI 格式调用 100+ 服务商，Router 路由/fallback/重试 + 成本统计。配置下沉到角色级（`llm.model`），与身份牌完全解耦。
- 实测约束（2026-07 验证，必须遵守）：
  - **工具调用取交集**：单工具、`tool_choice` 只用字符串值、禁并行工具调用与 `parallel_tool_calls`（DeepSeek 对象形式报 500、Kimi 不支持 required、Gemini 路由 400）。裁判判定首选 json_schema，DeepSeek/Kimi/豆包降级 json_object + Pydantic 校验重试。
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
| 模拟核心 | 自研四层（服务/元组件/组件/编排），依赖仅 LiteLLM + Pydantic，规模纪律几千行 |
| 身份牌 | 自研 identity_card_v1，与 LLM 配置零耦合，兼容 Tavern v2 导入 |
| 多 LLM | LiteLLM（按第 3 节交集约束使用） |
| 导演 | 显式导演节点组件（输入门控 + 催眠注入） |
| 语音 | edge-tts 起步，IndexTTS2 备选 |
| 视频 | Remotion 独立子项目，Agent 工具搭建维护 |
| 回放 | 后期按需，Agent 工具按契约实现 |
| 配置 | YAML + Pydantic，LLM 配置与身份牌分离 |
