# schema/ CHANGELOG

契约版本化规则（used-reference/design/overview.md §7.6）：四份契约各自独立版本化；
破坏性变更升主版本，非破坏性变更升次版本。每份契约文件头标注 `// Version: x.y.z`。

## v1.0.0（2026-07-31）

首次冻结（任务书阶段 2 产出，对应 runtime-architecture.md v1.0 决策 D1–D37）：

- `errors.ts` v1.0.0 —— §4 七组错误枚举 + ErrorCode 并集 + D13 可重试判定表
- `event.ts` v1.0.0 —— 事件契约：信封 + 38 类型内核封闭集（D32/D35）+ 命名空间前缀开放注册
- `flow.ts` v1.0.0 —— 流程图配置：节点/边/封闭算子条件 DSL（D7）/导演门参数（D15）
- `meta-component.ts` v1.0.0 —— 元组件契约（§4.7）+ 内置名册六个 parameters + TurnOutcome
- `identity-card.ts` v1.0.0 —— identity_card_v1（MVP 字段集）+ 拒模型字段运行时守卫
- `bundle.ts` v1.0.0 —— Bundle 目录结构 + D33 hash 输入集 + run manifest（D24）
