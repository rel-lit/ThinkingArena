# 路线图

> 原则：契约先行；每一期有可演示产物；参考书只读不复制。
> 分期语义以 `design/runtime-architecture.md` §0.2 为准：首局线性 → 多人并行 → 锦标赛。

## Phase 0 — 契约落地（Schema，3~5 天）

- 以 `design/runtime-architecture.md` 为唯一输入，四份契约落 `schema/` 目录（Zod + JSON Schema 导出，版本化 + CHANGELOG）：
  - **事件契约**：信封含节点执行标识（D36）与墙钟时间戳（D31）；类型空间 = 内核封闭集 + 组件开放注册（D32）；必需事件族（D31）。
  - **流程图配置**：组件节点 + 控制边 + 封闭算子条件 DSL（D7）。
  - **元组件接口**：AgentTool 式契约（校验前置 / before-after 钩子 / 错误编码进结果，§4.7）。
  - **identity_card_v1**：要点见 used-reference/design/overview.md §5.3/§7.5，从精简重定义；校验器拒绝卡内出现模型字段。
  - 附带：Scenario Bundle 与 run manifest 约定（D24/D33）。
- **产出**：`schema/` 目录（契约即代码）+ 校验器。
- ~~精读参考书 + masquerade-walkthrough~~（已废除：知识转移已完成于 runtime-architecture.md，重复劳动）。

## Phase 1 — 薄核心 MVP + 线性首局（2~3 周）

- 按 §0.2 首局范围自研最小核心：
  - **EventLog**：append/replay/branch/snapshot + **崩溃恢复**（§2.3，不分期项）+ applyEvent 恢复双路径。
  - **服务层**：黑板写穿（D1）/ Agent 服务（状态机 + 双队列 + runTurn）/ 记忆（F17 沉淀）/ LLM 网关（薄路由 + 双轨台账 D16）。
  - **元组件层 + 线性 DAG 执行器**：线性 + 回边 + 条件分支即可；join/TCAS 不在本期。
  - **组件**：骰子、叙事、判定（Narrator + Archivist 最小版）、角色创建/销毁、**最小导演门**（线性模式 = 全局暂停，D27 消费泵）。
  - **CLI**：run / cancel / 观察视图（F16）+ run manifest 写出（D24）。
  - **成本闸最小实现**（D28：累计切片 + 阈值可设极大值，机制必须在场）。
- 验证场：**线性单主角场景**（isekai 的单世界切片），裁判逻辑提前练手；不同服务商各跑一遍 + 双轨成本对账。
- 规模纪律：核心约 2500 行内；运行时依赖仅 ai + zod + yaml。
- **产出**：线性首局 Script + run manifest + 成本报告。
- 出口检查：接入验收清单落地为 dev 工具（cost 非零 / cached_tokens / 工具调用往返 / json_object，不过不进局）。

## Phase 2 — 多人并行与完整导演门（1~2 周）

- **并行机制群**：执行栈 + join 等待表（D8）、TCAS 批协议（D9：快照读 + 发射缓冲 + 分支序提交）。
- **完整导演门**：分支级阻塞、steering/follow-up 双档、inject / whisper / edit_world / note / agent_broadcast 五型（D18）、超时三策略（D15）。
- **缓存硬约束落地**：Anthropic 显式 cache_control、静态前缀 SHA256 逐回合校验（D16）。
- 验证场：**《谁是卧底》**，不同玩家绑不同服务商（DeepSeek / Claude / Kimi / 豆包）同局竞技；干预实验：whisper 诱导某 Agent 跳身份。
- **产出**：多服务商对局 Script + 导演操纵版对局 Script + 干预前后对照复盘。——本身即可作为第一条 B 站视频题材。
- 出口检查：核心行数审计（规模纪律），超预算触发砍机制评审。

## Phase 3 — 异世界生存推演 MVP（1~2 周，核心交付）

- 详细设计见 scenarios/isekai-survival.md。口径：单主角、3 个手工世界、每世界 5~8 回合、HP/SAN/技能标签/物资、骰子定档级 + Referee 叙事 + 状态权威防吃书（D26 命名空间）；判定走结构化输出交集契约。
- **产出**：完整生存推演 Script + report.md（回答"什么在起作用"）。

## Phase 4 — 演绎视频管线（1~2 周，Agent 工具主场）

- 定义分镜 JSON Schema + 渲染前校验器；M4 素材服务薄封装（局外，D14）。
- 用 Kimi 桌面端 / OpenCode 完成：高光提炼 → 视频文案 → Remotion 子项目搭建 → 渲染成片；edge-tts 按 Script 事件对轨；人工剪辑兜底。
- **产出**：第一条"异世界生存推演"成片。

## Phase 5 — 扩展（按兴趣驱动）

- 多 Build 锦标赛（多进程编排，D23/D29；错峰限速由外部编排者负责）。
- 世界生成器；IndexTTS2 语音克隆；生图场景立绘；AI 视频片段素材接入。
- 回放剧场（Agent 工具按契约独立实现）；B 站自动发布（参照 MoneyPrinterPlus）。
- 更多游戏规则（图配置 + 新组件）；元组件层加 Adapter 对外暴露（MCP）。

## 风险登记

| 风险 | 缓解 |
|---|---|
| 契约设计失误导致模块返工 | Phase 0 先落契约；版本化 + CHANGELOG |
| 规模膨胀突破"几千行"纪律 | §0.2 分期；Phase 2 出口行数审计；超预算触发砍机制评审 |
| Agent 工具产出质量不稳定 | Schema 校验器兜底；工具侧 prompt 进 git |
| 多服务商并发成本失控 | D16 双轨台账 + D28 成本闸 Phase 1 即在场；缓存硬约束 Phase 2 前落地 |
| 跨服务商能力差异（tool_choice 语义/结构化输出/缓存字段） | 交集契约 + 接入验收清单 + fallback 同能力等级 |
| 身份牌渲染漂移破坏缓存 | 渲染器纯函数 + 静态前缀 SHA256 逐回合落 Script 校验 |
| 裁判 LLM 吃书 | 状态权威为唯一事实（D26 写者声明）；骰子承担数值随机性 |
| 导演注入使角色出戏 | whisper 走私有上下文 + 显著性标签；inject 仅用于环境事件 |
| AI 生成组件质量参差 | 元组件层限定 API 面；组件入库前过契约测试 |
| pi 演进（pi-orchestrator 多 Agent 实验包，2026-05 起） | 定期复审其成熟度；成熟前坚持自研编排层（Phase 2 前第一次复审） |
