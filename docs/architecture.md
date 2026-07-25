# 总体架构

> 领域模型见 core-loop.md；选型依据见 research.md；prompt 分层（L0–L9）当前定义见 design/overview.md §5.3。

## 1. 总体形态：薄核心 + 外围工具域，契约衔接

```
                    ┌────────────────────────────────────┐
                    │  契约层（唯一接口，版本化）           │
                    │  事件 / 流程图 / 元组件 / 身份牌      │
                    │  Zod 定义 + JSON Schema 导出        │
                    └──────────────┬─────────────────────┘
        ┌──────────────────────────┼──────────────────────────┐
        │                          │                          │
┌───────▼────────┐      ┌──────────▼─────────┐      ┌────────▼────────┐
│ M1 模拟核心     │      │ M2 复盘/高光提炼    │      │ M3 视频制作域    │
│ （自研薄核心）   │      │ （成熟 Agent 工具） │      │ （成熟 Agent 工具）│
│ 服务/元组件/    │      │ 读 Script→report/  │      │ 分镜→Remotion   │
│ 组件/编排四层   │      │ 高光清单/文案       │      │ 工程→成片→B站   │
└───────┬────────┘      └────────────────────┘      └────────┬────────┘
        │                                                     │
┌───────▼────────┐                                  ┌────────▼────────┐
│ M4 素材服务     │                                  │ M5 回放可视化    │
│ edge-tts/生图   │                                  │ （后期，Agent    │
│ 薄封装          │                                  │  工具独立实现）  │
└────────────────┘                                  └─────────────────┘
```

**核心原则：模块之间不共享代码、不共享内存，只共享契约。** 衔接层 = 文件系统约定（Bundle / Script / 分镜 JSON 的目录规范）+ Zod 校验器 + 少量 CLI 入口。不引入消息队列、RPC 框架等重设施。

**为什么是这个形态**：Vision 指导思想要求"嫁接成熟项目优于从零开始"，本架构在两个层级上执行它——

1. **知识级嫁接（核心）**：M1 不是从零设计，而是精读三份已验证实现后对其架构判断的整体转移——pi 出服务层/元组件层/干预机制（五个吸收点均带源码位置），Masquerade 出游戏引擎与 Script 分工，n8n 出编排执行语义（吸收与排除清单均见 research.md 第 1 节）。每一个关键机制都有出处；自研的只是粘合、裁剪与契约。**薄，是因为参考书替我们承担了试错。**
2. **代码级嫁接（外围）**：复盘、视频、发布等下游环节成熟工具充分，直接嫁接 Kimi 桌面端 / OpenCode / Remotion 生态与 MoneyPrinter 系参照项目，核心仓只出契约与校验器。

因此自研范围收敛为 M1 薄核心 + M4 薄封装 + 各契约校验器——这不是"没有合适的成熟项目故不得不自研"，而是"嫁接的对象从代码换成了经过验证的设计"。

## 2. M1 模拟核心（自研）

单仓库、单进程，按四层分目录。各层实现细节唯一定义于此，core-loop.md 只保留概念：

| 目录 | 层 | 职责与关键约束 |
|---|---|---|
| `schema/` | 契约 | 四份契约的 Zod 定义 + JSON Schema 导出，版本化，破坏性变更升版本并登记 CHANGELOG |
| `services/` | 服务层 | agent（实例生命周期、私有上下文、身份牌渲染）、memory（滚动摘要）、blackboard、event-log、llm-gateway（AI SDK + 薄路由 + 价格表 + 缓存断点）。**落盘全集 ⊃ 进模型上下文投影**：存储是全量，注入 LLM 的上下文是显式投影（pi 两段式接缝） |
| `meta/` | 元组件层 | 服务调用面，AgentTool 式契约：参数 schema 校验前置、before 钩子可拦截、after 钩子可改写结果、错误编码进结果而非抛异常、`stop_reason=="length"` 整批拒执行。事件发射经此并内置 schema 校验，非法事件拒写 |
| `components/` | 组件层 | 内置组件：角色创建/销毁、叙事、判定、骰子、导演门等。**description（名称/版本/参数 schema）+ run（行为）两元结构**；`version` 字段从第一天存在，Bundle 锁定版本。预期主要由 AI Agent 生成——元组件层是其创作边界 |
| `orchestrator/` | 编排层 | 流程图加载校验、DAG 执行器（见 4.5） |
| `cli/` | 入口 | run / replay / dev 冒烟 |

规模纪律：核心目标几千行内，唯一开发者通读无障碍。运行时依赖仅 `ai`（Vercel AI SDK 及 providers）+ `zod` + `yaml`。可视化编排 UI 不在路线内，但接口按"将来可被可视化包装"的标准设计。

## 3. 契约与 Bundle

四份契约，Zod 定义、版本化、可导出 JSON Schema：

| 契约 | 内容 |
|---|---|
| **事件契约** | Script JSONL，树结构 `{ type, id, parent_id, timestamp, branch, payload }`；类型含发言/独白/骰点/导演干预/服务调用/缓存失效/成本（含原始 usage） |
| **流程图配置** | 组件节点 + 控制边；条件是边的属性（声明式比较算子 DSL，非可执行表达式）；边以节点 id 为键、端口用名字不用魔法下标；join 显式声明等待哪些输入口 |
| **元组件接口** | 统一调用面签名 + 事件发射校验入口；按可对外暴露形态设计，加 Adapter 即成 MCP |
| **identity_card_v1** | 设计要点见 design/overview.md §5.3/§7.5，字段级契约留待 Schema 阶段定义；校验器拒绝卡内出现模型字段（身份与 LLM 解耦的机械保证） |

**Scenario Bundle** = 一局的全部输入（目录，进 git）：流程图配置 + 游戏 YAML（规则参数 / LLM 绑定）+ `identity_cards/` + 世界书 + 种子事件。

## 4. 关键机制

### 4.1 事件即真相

- 模拟过程、导演干预、骰点、服务调用、缓存失效、成本，全部经发射元组件写入 Script（JSONL 追加式）。
- 状态由事件重建：`state = reduce(state, event)` 纯函数；崩溃恢复 = 重放 JSONL。
- **分支条件在遍历瞬间求值，读到的黑板值快照作为事件落盘**——重放时分支走向来自记录而非重新求值（重放确定性的刚需）。
- 事件树的 parent_id 结构支持从任意节点分叉重开——这是导演局间迭代工作流的机制基础。
- 不存在第二套事实存储：服务层的记忆/上下文持久化是业务数据，事件流是事实记录，职责不重叠。

### 4.2 导演门

- 形态：显式放置在流程图中的门组件。到达即等待导演输入；**依赖该输入的分支阻塞，其余分支照常推进**（分支级阻塞，非执行级挂起）；等待点可取消（一局可随时终止）。
- 两档干预（pi steering/follow-up 参照）：**steering** 打断当前方向立即转向（组件批完成后、下一次 LLM 调用前注入）；**follow-up** 排队至自然停止点续作。
- 生效语义：干预只在循环安全点生效——运行中的 LLM 请求/组件执行绝不突变，注入内容进入下一安全点的新上下文快照；待写事件按确定顺序落盘。
- 注入类型：**whisper**（私有催眠，写目标 Agent 私有上下文，prompt L8 位近尾部注入，绝不进静态前缀，带显著性标签，注入文本 hash 落 Script）；**inject**（公开环境事件）；**edit_world**（改世界设定，记 `cache_invalidation`）；**note**（仅批注 Script，随时可发）。
- 输入通道：`director_inbox.jsonl`（MVP）/ stdin / 后续 WebSocket。
- 所有导演干预都是一等事件——"导演如何操纵故事"本身就是视频素材。

### 4.3 Prompt 分层与缓存（成本硬约束）

- 分层与断点规划的当前定义见 design/overview.md §5.3（L0–L9）。架构侧约束：
  1. L0–L3 静态前缀**逐字稳定**：共享层在前、身份层在后，同服务商跨 Agent 复用前缀缓存；渲染器为纯函数（字段顺序固定、无时间戳/UUID/回合计数、YAML 序列化器固定），输出 SHA256 逐回合落 Script 验证逐字稳定；改写静态前缀记 `cache_invalidation` 事件。
  2. 长记忆压缩为稳定摘要段保持在静态区（L5），压缩检查点自包含，重建上下文不必回放全量历史。
  3. 服务商原生缓存：DeepSeek/Kimi/OpenAI 自动缓存零代码收益；Anthropic 显式断点（AI SDK `providerOptions.anthropic.cacheControl`）；豆包短局只用隐式缓存。批量阶段同服务商并发最大化前缀复用。
- **成本双轨台账**：自维护 YAML 价格表计算值 + 原始 usage（prompt/completion/cached tokens）重算值同时落 Script，互相对账。
- fallback 只做同能力等级降级，自研薄路由执行（按模型名路由 + 指数退避 + 熔断计数）；跨服务商 fallback 前过冒烟测试。
- LLM 绑定声明自带验收测试（可用性冒烟，类比 n8n 凭证的 test 声明）。

### 4.4 结构化判定（跨服务商交集契约）

- 裁判是组件组合（规则 / 骰子 / 状态权威 / 叙事），经流程图编排进游戏，不是特殊架构。判定 = 骰子（带种子 RNG，种子进 Bundle；表达式参考海豹骰）+ Referee LLM 叙事；骰点入 Script。
- 判定输出：首选 `response_format` json_schema；DeepSeek/Kimi/豆包降级 json_object + Zod 校验 + 失败重试（记 `judge_retry`）。
- 工具调用仅作备选且遵守交集：单工具、`tool_choice` 只用字符串值、禁并行工具调用；`finish_reason=="length"` 先检查再解析（截断整批拒执行并告知重发）。
- 新服务商接入验收清单（dev 工具）：cost 非零 / cached_tokens / 工具调用往返 / json_object，一次调用跑完，不过不进 Bundle。

### 4.5 DAG 执行器

自研配置化执行器，无框架。核心形态：

```
FlowRunner.run(bundle):
    services = init_services(bundle)        # 黑板/记忆/上下文/提示词
    state    = replay_or_init(script)       # 重放 JSONL 即恢复
    graph    = parse(bundle.flow_config)    # 组件节点 + 条件边 + 回边
    while not graph.finished(state):
        for node in graph.ready_nodes(state):       # 动态就绪：执行栈 + join 等待表
            if node.is_director_gate:
                node.input = await director_inbox   # 分支级门控，可取消
            events = node.component.run(meta_components, blackboard)
            for e in events:
                emit(e)                              # 发射元组件，schema 校验
                state = reduce(state, e)
```

- **动态就绪调度**（执行栈 + join 等待表），无需静态拓扑排序；**回边即循环**，无循环原语；分支语义 = 往哪个输出端口放数据，引擎不理解 if（条件是边的属性，遍历瞬间求值）。
- 多 Agent 并发 = 并行分支 + `Promise.all`；导演门等待用 AbortController 保证可取消。
- 重跑判定（n8n 参照）：参数变/图变 → 下游 stale；循环内任意节点 stale → 循环首节点 stale。
- 若未来出现"任意点暂停并跨进程恢复"的需求，届时给 reduce/事件层加适配，现在不做。

## 5. 外围域

### M2 复盘与高光提炼（成熟 Agent 工具）

- 一局结束后的 report.md、戏剧化片段清单、视频文案大纲，由 Kimi 桌面端等 Agent 直接读 Script 生成。
- 此类加工者属任务处理 Agent，与模拟 Agent 不同类型。核心仓只保证 Script 可读性（schema 稳定 + 字段自解释）。

### M3 视频制作域（成熟 Agent 工具）

- Remotion 工程为独立子项目（`video/`），由 Agent 工具搭建与迭代：分镜 JSON + 素材清单 → 成片。
- 核心仓只定义分镜 JSON Schema（镜头、时长、字幕、配音轨、立绘引用）并提供渲染前校验器。
- B 站发布参照 MoneyPrinterPlus，走 Agent 工具操作。

### M4 素材服务（薄封装）

- 音频（edge-tts → IndexTTS2）、图片（SD/ComfyUI/生图 API）、视频片段（可灵/即梦/Vidu 类 API）统一抽象为"服务指令"：输入文本/参数 → 输出文件 + manifest。
- 每次调用作为 `service_call` 事件写入 Script（成本与素材溯源）。

### M5 回放可视化（后期，最低优先级）

- 前期用 M2 文本复盘 + 事件流直接阅读代替；真需要时由 Agent 工具按契约独立实现。

### 护栏

Agent 工具产出必须过 Schema 校验，不合格退回重生成；核心仓只承诺契约稳定；工具侧 prompt/技能文件进 git 版本管理。
