# ThinkingArena 文档地图

多 LLM 模拟推演 + 导演干预 + 事件驱动演绎产出的项目文档体系。

## 阅读顺序（主线五份，自顶向下）

| 顺序 | 文档 | 回答的问题 |
|---|---|---|
| 1 | [Vision.md](Vision.md) | 为什么做：愿景与指导思想（原始构想，不改写） |
| 2 | [core-loop.md](core-loop.md) | 是什么：领域模型——四层存在物、两个循环、导演工作流、一局的生命周期 |
| 3 | [architecture.md](architecture.md) | 怎么实现：模块形态、契约、五大关键机制（事件即真相/导演门/缓存/判定/执行器） |
| 4 | [research.md](research.md) | 为什么这么选：参考书、语言、LLM 接入、编排、工程栈的依据 |
| 5 | [roadmap.md](roadmap.md) | 怎么推进：Phase 0–5 与风险登记 |

## 下沉文档

| 目录 | 内容 |
|---|---|
| [design/](design/) | 设计文档：[overview.md](design/overview.md)——设计与架构综合参考（含 L0–L9 prompt 分层当前定义）；[runtime-architecture.md](design/runtime-architecture.md)——运转架构权威定义（数据流/时序/状态机/接口/错误矩阵） |
| [scenarios/](scenarios/) | 场景设计：[isekai-survival.md](scenarios/isekai-survival.md)——异世界生存推演 Odyssey（MVP 裁剪、流程结构、Build 卡、导演干预点） |

## 引用关系

- 概念只定义一次：四层模型定义于 core-loop.md，实现细节定义于 architecture.md，其余文档只引用不重述。
- L0–L9 分层图是缓存断点与 whisper 注入位置的当前定义，见 design/overview.md §5.3（原 design/identity-card.md 已刻意移除——过于具体的细节易带偏整体设计）。
- scenarios/ 用领域模型语言书写（组件组合、流程图节点、Agent 服务、黑板），不引入模型外的概念。
- roadmap.md 各 Phase 交付物回链上述契约与设计文档。

## 文档纪律

- 只保留定稿态：不留版本修订记录与被否决方案的辩护段落；演进过程查 git 历史。
- 事实性调研结论保留来源链接；选型结论保留一句理由。
- 新模块先定位到领域模型的某一层的某一环；定位不了的，不做。
