# 路线图

> 原则：契约先行；每一期有可演示产物；Masquerade 只读不复制。

## Phase 0 — 精读参考书 + 契约初稿（2~3 天）

- 精读 Masquerade 源码（engine / orchestrator / agent / script），产出 `docs/masquerade-walkthrough.md`：回合怎么切、Script 时间轴怎么记、并发阶段怎么调度、TTS/Remotion 数据桥怎么接。细到可直接当实现规格书。
- 精读 pi 的 packages/agent（agent-loop / types / jsonl-storage / agent-harness 文档），吸收 AgentTool 契约、JSONL 树落盘、两段式上下文投影、turn 快照/保存点、steering/follow-up 队列（依据见 research.md 第 1 节），产出并入导读笔记的"服务层与元组件层"章节。
- 四份契约初稿落 `schema/` 目录（Zod + JSON Schema 导出）：
  - **Script 事件契约 v0.1**：发言/独白/骰点/导演干预/服务调用/缓存失效/成本（含原始 usage）；
  - **identity_card_v1**（设计已定稿，见 identity-card.md）；
  - **流程图配置 v0.1**：DAG 组件节点 + 控制边（if/while/并行）+ 导演节点；
  - **元组件接口规范 v0.1**：统一调用面签名 + 事件发射校验入口，按可对外暴露形态设计。
- **产出**：导读笔记 + `schema/` 目录（契约即代码）。

## Phase 1 — 薄核心 MVP（1~2 周）

- 按组件模型自研最小核心：配置化 DAG 执行器 + 元组件层 + 服务层（黑板/记忆/上下文，持久化）+ Vercel AI SDK 接入（含自研薄路由 + 自维护价格表）+ 身份牌层（L0–L9 先实现静态区与动态尾区）+ 首批游戏组件，**用《谁是卧底》验证**（图配置 + 组件组装，不写引擎子类）。
- 规模纪律：核心 ~2500 行内；技术栈 TypeScript（Node LTS），运行时依赖仅 ai + zod + yaml。
- 验证场：不同玩家绑不同服务商（DeepSeek / Claude / Kimi / 豆包）同局竞技 + 双轨成本台账。
- 接入验收清单落地为 dev 工具（cost 非零 / cached_tokens / 工具调用往返 / json_object，不过不进局）。
- **产出**：多服务商对局 Script + 成本报告。—— 本身即可作为第一条 B 站视频题材。

## Phase 2 — Director 组件（3~5 天）

- 导演节点组件（输入门控：依赖分支阻塞、其余并行照常）+ 输入通道（文件/stdin，后续 WebSocket）+ inject / whisper / edit_world / note。
- Agent 私有上下文区 + whisper 走 L8 注入（绝不进静态前缀）+ prompt 分层全量落地（Anthropic 显式 cache_control、静态前缀 SHA256 校验）。
- 干预实验：whisper 诱导某 Agent 跳身份，观察局势演变。
- **产出**：一场"导演操纵版"对局 Script + 干预前后对照复盘。

## Phase 3 — 异世界生存推演 MVP（1~2 周，核心交付）

- 详细设计见 scenarios/isekai-survival.md。口径：单主角、3 个手工世界、每世界 5~8 回合、HP/SAN/技能标签/物资、骰子定档级 + Referee 叙事 + 状态权威防吃书；判定输出走结构化契约（D5）。
- **产出**：完整生存推演 Script + report.md（回答"什么在起作用"）。

## Phase 4 — 演绎视频管线（1~2 周，Agent 工具主场）

- 定义分镜 JSON Schema + 渲染前校验器。
- 用 Kimi 桌面端 / OpenCode 完成：高光提炼 → 视频文案 → Remotion 子项目搭建 → 渲染成片；edge-tts 按 Script 事件对轨；人工剪辑兜底。
- **产出**：第一条"异世界生存推演"成片。

## Phase 5 — 扩展（按兴趣驱动）

- 多 Build 锦标赛（"哪个专业活到最后"）；世界生成器。
- IndexTTS2 语音克隆；生图场景立绘；AI 视频片段素材接入。
- 回放剧场（Agent 工具按契约独立实现）；B 站自动发布（参照 MoneyPrinterPlus）。
- 更多游戏规则（图配置 + 新组件）；元组件层加 Adapter 对外暴露（MCP）。

## 风险登记

| 风险 | 缓解 |
|---|---|
| 契约设计失误导致模块返工 | Phase 0 先落契约；版本化 + CHANGELOG |
| 薄核心重踩 Masquerade 已解决的坑 | Phase 0 精读当答案书，导读笔记细到实现规格 |
| Agent 工具产出质量不稳定 | Schema 校验器兜底；工具侧 prompt 进 git |
| 多服务商并发成本失控 | Phase 1 双轨成本台账先行；D4 缓存约束 Phase 2 前落地 |
| 跨服务商能力差异（tool_choice 语义/结构化输出/缓存字段） | 交集契约（D5）+ 接入验收清单 + fallback 同能力等级 |
| 身份牌渲染漂移破坏缓存 | 渲染器纯函数 + 静态前缀 SHA256 逐回合落 Script 校验 |
| 裁判 LLM 吃书 | 状态权威为唯一事实；骰子承担数值随机性 |
| 导演注入使角色出戏 | whisper 走私有上下文 + 显著性标签；inject 仅用于环境事件 |
| AI 生成组件质量参差 | 元组件层限定 API 面；组件入库前过契约测试 |
