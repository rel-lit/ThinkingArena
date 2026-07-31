# ThinkingArena 文档地图

多 LLM 模拟推演 + 导演干预 + 事件驱动演绎产出的项目文档体系。

## 核心文档（权威，按阅读顺序）

| 顺序 | 文档 | 回答的问题 |
|---|---|---|
| 1 | [Vision.md](Vision.md) | 为什么做：愿景与指导思想（原始构想，不改写） |
| 2 | [core-loop.md](core-loop.md) | 是什么：领域模型——四层存在物、两个循环、导演工作流、一局的生命周期 |
| 3 | [design/runtime-architecture.md](design/runtime-architecture.md) | 怎么运转：运转架构权威定义——决策表 D1–D37、数据流 F1–F18、时序、状态机、接口、错误矩阵 |
| 4 | [design/layers.md](design/layers.md) | 全貌在哪：全部设计元素的分解树与导航（决策覆盖索引 D1–D37 全挂点） |
| 5 | [roadmap.md](roadmap.md) | 怎么推进：Phase 0–5 与风险登记 |

## 场景

| 目录 | 内容 |
|---|---|
| [scenarios/](scenarios/) | 场景设计：[isekai-survival.md](scenarios/isekai-survival.md)——异世界生存推演 Odyssey（MVP 裁剪、流程结构、Build 卡、导演干预点） |

## 已用参考（`used-reference/`，非权威）

调研与素材的归档：architecture.md、research.md、design/overview.md（含 L0–L9 prompt 分层当前定义）、investigation/（pi / Masquerade / n8n / SillyTavern / ChatRPG v2 五份调研报告）、review/（多 Agent 审查记录）。

- 这些文件**不再作为后续权威**；与核心文档冲突时以核心文档为准。
- 保留价值：决策溯源（runtime-architecture.md 的每条决策标注了调研出处）。

## 引用关系与纪律

- 概念只定义一次：领域模型定义于 core-loop.md，运转实现定义于 design/runtime-architecture.md，其余文档只引用不重述。
- L0–L9 分层图是缓存断点与 whisper 注入位置的当前定义，见 used-reference/design/overview.md §5.3（原 design/identity-card.md 已刻意移除——过于具体的细节易带偏整体设计）。
- scenarios/ 用领域模型语言书写（组件组合、流程图节点、Agent 服务、黑板），不引入模型外的概念。
- 新模块先定位到 layers.md 分解树的某个父节点；定位不了的，不做。
- 只保留定稿态：不留版本修订记录与被否决方案的辩护段落；演进过程查 git 历史（runtime-architecture.md 附录 B 的分歧/审查记录除外——它是架构裁决的组成部分）。
