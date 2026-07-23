# 总体架构

> 上位文档：core-loop.md（领域模型）。选型依据：research.md。身份牌设计：design/identity-card.md。

## 1. 模块视图

```
                    ┌────────────────────────────────────┐
                    │  Event Contract（事件契约，唯一接口）│
                    │  Script JSONL Schema · 版本化       │
                    │  Zod 定义 + JSON Schema 导出      │
                    └──────────────┬─────────────────────┘
        ┌──────────────────────────┼──────────────────────────┐
        │                          │                          │
┌───────▼────────┐      ┌──────────▼─────────┐      ┌────────▼────────┐
│ M1 模拟核心      │      │ M2 复盘/高光提炼    │      │ M3 视频制作域    │
│ （自研薄核心）    │      │ （成熟 Agent 工具） │      │ （成熟 Agent 工具）│
│ 服务/元组件/    │      │ 读 Script→report/  │      │ 分镜→Remotion   │
│ 组件/编排四层   │      │ 高光清单/文案       │      │ 工程→成片→B站   │
└───────┬────────┘      └────────────────────┘      └────────┬────────┘
        │                                                     │
┌───────▼────────┐                                  ┌────────▼────────┐
│ M4 素材服务     │                                  │ M5 回放可视化    │
│ edge-tts/生图   │                                  │ （后期，Agent    │
│ 封装为服务指令  │                                  │  工具独立实现）  │
└────────────────┘                                  └─────────────────┘
```

**核心原则：模块之间不共享代码、不共享内存，只共享契约。** 衔接层 = 文件系统约定
（Scenario Bundle / Script / 分镜 JSON / 流程图配置的目录规范）+ Zod Schema 校验器 + 少量 CLI 入口。
不引入消息队列、RPC 框架等重设施。

## 2. 模块职责

### M1 模拟核心（自研，唯一必须自己写的部分）

按组件模型分四层（单一仓库、单一进程，按目录分离）：

| 层 | 职责 | 关键约束 |
|---|---|---|
| 服务层 | LLM/Agent 服务、记忆系统、上下文管理（黑板族）、提示词管理 | 非组件，独立实现；持久化；生命周期显式（创建组件建/删除组件杀，不杀则跨局存续）；**落盘全集 ⊃ 进模型上下文投影**——存储是全量，注入 LLM 的上下文是显式投影（pi 两段式接缝） |
| 元组件层 | 服务的唯一规范化调用面（调用 Agent / 注入上下文 / 读写黑板 / 发射事件等） | **AgentTool 式契约**（pi 参照）：参数 schema 校验前置、执行前钩子可拦截、执行后钩子可改写结果、错误编码进结果而非抛异常；`stop_reason=="length"` 时整批调用拒绝执行。按可对外暴露形态设计（加 Adapter 即成 MCP）；事件发射内置事件 schema 校验；AI 生成组件的标准 API 面 |
| 组件层 | 游戏流程节点：**description（名称/版本/参数 schema）+ run（行为）两元结构**，以元组件为唯一能力来源 | 无返回值，只经黑板交互；`version` 字段从第一天存在，Bundle 锁定版本；预期主要由 AI Agent 生成 |
| 编排层 | 配置化 DAG 执行器：**动态就绪调度**（执行栈 + join 等待表），回边即循环；**分支条件是边的属性**（声明式比较算子 DSL，非可执行表达式），遍历瞬间对黑板求值 | 新游戏 = 图配置 + 组件组装；边以节点 id 为键、端口用名字不用魔法下标 |
| +导演组件 | 显式放置的输入门节点：等待导演输入并注入上下文 | 分支级阻塞（依赖分支挂起、其余照常），非执行级挂起（D2） |

- **规模纪律：目标几千行内，唯一开发者通读无障碍。** 复杂度只许长在"游戏规则"（图配置 + 组件）里，不许长在框架里。技术栈 TypeScript（Node LTS），运行时依赖仅 `ai`（Vercel AI SDK 及 providers）+ `zod` + `yaml`（明细见 research.md 第 7 节）。可视化编排 UI 不在路线内，但接口按"将来可被可视化包装"的标准设计。
- 设计参照（只研究、零复制）：**pi**（服务层/元组件层/干预机制的第一参考书）；Masquerade（游戏引擎与 Script 分工）；n8n（DAG 执行引擎、节点契约、明确排除清单）；SillyTavern（角色卡/世界书/prompt 分层）；ChatRPG v2（Narrator+Archivist 裁判范式）。不复制任何参照项目的代码（含片段）。

### M2 复盘与高光提炼（成熟 Agent 工具）

- 一局结束后的 report.md、戏剧化片段清单、视频文案大纲，由 Kimi 桌面端等 Agent 直接读 Script 生成。
- 此类加工者属任务处理 Agent，与模拟 Agent 不同类型。核心仓只保证 Script 可读性（schema 稳定 + 字段自解释）。

### M3 视频制作域（成熟 Agent 工具）

- Remotion 工程作为独立子项目（`video/` 目录），由 Agent 工具搭建与迭代：分镜 JSON + 素材清单 → 成片。
- 核心仓只定义分镜 JSON Schema（镜头、时长、字幕、配音轨、立绘引用）并提供渲染前校验器。
- B 站发布参照 MoneyPrinterPlus 实现，同样走 Agent 工具操作。

### M4 素材服务（薄封装）

- 音频（edge-tts → IndexTTS2）、图片（SD/ComfyUI/生图 API）、视频片段（可灵/即梦/Vidu 类 API）三类素材统一抽象为"服务指令"：输入文本/参数 → 输出文件 + manifest。
- 每次调用作为 `service_call` 事件写入 Script（成本与素材溯源）。

### M5 回放可视化（后期，最低优先级）

- 前期用 M2 文本复盘 + 事件流直接阅读代替。
- 真需要时由 Agent 工具按契约独立实现回放页。

## 3. 设计决策

### D1. 事件契约是唯一事实源 + 唯一接口

- 模拟过程、导演干预、骰点、服务调用、缓存失效、成本，全部作为事件写入 Script（JSONL，追加式）——由组件内部调用统一的事件发射元组件完成，内置 schema 校验，非法事件拒写。
- **事件骨架（pi 参照）**：每条事件 = `{ type, id, parent_id, timestamp, branch, payload }` 的树结构——分叉/回放/重开一局零成本，天然支撑 D3 的导演迭代工作流。
- Schema 用 Zod 定义、可导出 JSON Schema，带版本号；破坏性变更升版本并登记 CHANGELOG。
- 状态由事件重建：`state = reduce(state, event)` 为纯函数；崩溃恢复 = 重放 JSONL。**分支条件在遍历瞬间求值并把读到的黑板值快照作为事件落盘——重放时分支走向来自事件记录而非重新求值**（重放确定性的刚需）。不存在第二套事实存储（服务层的记忆/上下文持久化是业务数据，事件流是事实记录，职责不重叠）。

### D2. Director（导演组件）

- 形态：显式放置在流程图中的导演节点组件——输入门：触发时等待导演输入，拿到后执行注入（whisper：私有催眠，让 LLM 以为是自己的想法；inject：公开事件）。
- 门控语义：依赖该输入的后续分支阻塞，其余分支照常推进；门控等待点必须可取消（一局可随时终止）。
- **生效语义（pi 参照）**：干预只在循环安全点生效——运行中的 LLM 请求/组件执行绝不突变，注入内容进入下一安全点的新上下文快照；待写事件按确定顺序落盘。
- **两档干预（pi steering/follow-up 参照）**：steering 档打断当前方向立即转向（组件批完成后、下一次 LLM 调用前注入）；follow-up 档排队至自然停止点续作。
- 输入通道：`director_inbox.jsonl`（MVP）/ stdin / 后续 WebSocket；`note` 指令随时可发，仅批注入 Script。
- whisper 写入指定 Agent 的私有上下文（prompt 分层 L8 位，近尾部注入，绝不进静态前缀），带显著性标签；注入文本 hash 落 Script。
- 所有导演干预都是一等事件——"导演如何操纵故事"本身就是视频素材。

### D3. 迭代式模拟（跨局调整）

- 一局 = **Scenario Bundle**（目录）：流程图配置 + 游戏 YAML（规则参数/LLM 绑定）+ `identity_cards/` + 世界书/剧本 + 种子事件，全部进 git。
- 每局结束由 M2 产出 report.md，导演改 Bundle 再开新局；事件树结构支持从任意节点分叉重开。
- Agent 服务默认跨局存续，支持"同一角色多局成长"；角色删除组件显式释放。

### D4. 多服务商与缓存命中率（成本设计）

- 每个角色在游戏 YAML 声明 `llm.model`（provider/模型标识）+ `identity_ref`（身份卡引用）——两层解耦是硬约束，身份卡 schema 校验器拒绝卡内出现模型字段。LLM 绑定声明自带验收测试（可用性冒烟），类比 n8n 凭证的 test 声明。
- 缓存硬约束：
  1. **Prompt 分层**：按 design/identity-card.md 的 L0–L9 组装；L0–L3 静态前缀逐字稳定（共享层在前、身份层在后，同服务商跨 Agent 复用前缀缓存）；渲染器为纯函数，输出 SHA256 落 Script 验证逐字稳定；改写静态前缀记 `cache_invalidation` 事件。
  2. **记忆滚动摘要**：长记忆压缩为稳定摘要段保持在静态区（L5），由记忆系统负责；压缩检查点自包含，重建上下文不必回放全量历史。
  3. **服务商原生缓存**：DeepSeek/Kimi/OpenAI 自动缓存零代码收益；Anthropic 必须显式断点（AI SDK 消息级 `providerOptions.anthropic.cacheControl`），断点规划见 design/identity-card.md；豆包短局只用隐式缓存。批量阶段同服务商并发最大化前缀复用。
  4. **成本台账（双轨）**：自维护 YAML 价格表计算值 + 原始 usage（prompt/completion/cached tokens）重算值同时落 Script，互相对账。
- fallback 链只做同能力等级降级，由自研薄路由执行（按模型名路由 + 指数退避 + 熔断计数）；跨服务商 fallback 前过冒烟测试。

### D5. 裁判与结构化判定

- 裁判是组件组合（规则/骰子/状态权威/叙事），经流程图编排进游戏，不是特殊架构。
- 判定 = 骰子（带种子 RNG，种子进 Bundle；参考海豹骰表达式）+ Referee LLM 叙事；骰点入 Script。
- 判定输出契约（跨服务商实测交集）：首选 `response_format` json_schema；DeepSeek/Kimi/豆包降级 json_object + Zod 校验 + 失败重试（记 `judge_retry`）。工具调用仅作备选且遵守交集：单工具、`tool_choice` 只用字符串值、禁并行工具调用与 `parallel_tool_calls`；`finish_reason=="length"` 先检查再解析（截断时整批调用拒绝执行并告知重发）。
- 新服务商接入验收清单（dev 工具）：cost 非零 / cached_tokens / 工具调用往返 / json_object，一次调用跑完，不过不进 Bundle。

### D6. 外部工具集成的风险护栏

- Agent 工具（M2/M3）产出必须过 Schema 校验，不合格退回重生成。
- 核心仓只承诺契约稳定；工具侧 prompt/技能文件进 git 版本管理。

### D7. 编排执行器

- 自研配置化 DAG 执行器，无框架。核心形态：

```
FlowRunner.run(bundle):
    services = init_services(bundle)        # 黑板/记忆/上下文/提示词
    state    = replay_or_init(script)       # 重放 JSONL 即恢复
    graph    = parse(bundle.flow_config)    # DAG：组件节点 + 条件边 + 回边
    while not graph.finished(state):
        for node in graph.ready_nodes(state):       # 动态就绪：执行栈 + join 等待表
            if node.is_director_gate:
                node.input = await director_inbox   # 分支级门控，可取消
            events = node.component.run(meta_components, blackboard)
            for e in events:
                emit(e)                              # 发射元组件，schema 校验
                state = reduce(state, e)
```

- 回合、阶段只是图的形状；多 Agent 并发 = 并行分支 + `Promise.all`；导演门等待点用 AbortController 保证可取消；join 节点显式声明等待哪些输入口，齐了才就绪。
- 循环 = 回边 + 条件边，无循环原语；重跑判定规则（n8n 参照）：参数变/图变 → 下游 stale；循环内任意节点 stale → 循环首节点 stale。
- 若未来出现"任意点暂停并跨进程恢复"的需求，届时给 reduce/事件层加适配（n8n 挂起-恢复机制可作参考），现在不做。
