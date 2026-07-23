# ThinkingArena 文档地图

LLM 多智能体模拟推演 + 导演干预 + 事件驱动回放/演绎的项目文档体系。

## 阅读顺序

| 顺序 | 文档 | 职责 |
|---|---|---|
| 1 | [Vision.md](Vision.md) | 项目愿景与指导思想（原始构想，不改写） |
| 2 | [core-loop.md](core-loop.md) | 领域模型：服务/元组件/组件/编排四层 + 导演组件 + 循环与第一公民概念 |
| 3 | [architecture.md](architecture.md) | 总体架构：模块视图、模块职责、设计决策 D1–D7 |
| 4 | [research.md](research.md) | 技术选型与依据：参考书、编排、LLM 接入、工程栈、最终一览 |
| 5 | [roadmap.md](roadmap.md) | 路线图：Phase 0–5 + 风险登记 |

## 下沉文档

| 目录 | 内容 |
|---|---|
| [design/](design/) | 专项设计：[identity-card.md](design/identity-card.md)（身份牌模块：Tavern v2 / World Info / 缓存实践调研 + identity_card_v1 Schema + L0–L9 prompt 分层） |
| [scenarios/](scenarios/) | 场景设计：[isekai-survival.md](scenarios/isekai-survival.md)（异世界生存推演 Odyssey：MVP 裁剪、流程结构、Build 卡、导演干预点） |

## 引用关系

- `architecture.md` 向上定位到 `core-loop.md` 的四层模型；选型理由一律指向 `research.md`。
- `design/identity-card.md` 是架构 D4（缓存/成本）与 D2（导演注入）在 prompt 层的展开；L0–L9 分层图是缓存断点与 whisper 注入位置的权威定义。
- `scenarios/` 下的场景文档用四层模型语言描述（组件组合、流程图节点、Agent 服务），不引入模型外的概念。
- `roadmap.md` 各 Phase 的交付物回链上述契约与设计文档。

## 文档纪律

- 只保留定稿态：不留版本修订记录、被否决方案的辩护段落；演进过程查 git 历史。
- 事实性调研结论保留来源链接与调研时间；选型结论保留一句理由。
- 新增模块先定位到 core-loop 的某一层，定位不了的不做。
