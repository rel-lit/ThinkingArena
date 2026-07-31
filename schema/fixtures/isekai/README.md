# fixtures/isekai —— 最小可解析示例 Bundle

对应 `docs/scenarios/isekai-survival.md`（MVP 裁剪版：3 手工世界 × 1 预设 Build）。

## 文件语法说明（重要）

本目录的 `.yaml` 文件以 **JSON 语法**书写——YAML 1.2 是 JSON 的超集，
任何 YAML 解析器（js-yaml / PyYAML / yaml）都能原样读出相同结构。
这样契约测试可以用零依赖的 `JSON.parse` 加载 fixtures（阶段 2 硬约束：
package.json 只允许 zod 一个依赖）。Phase 1 实现层接入真正的 YAML 解析器后，
这些文件无需任何改动；新写的 Bundle 可以自由使用块式 YAML 语法。

## 目录形态（对齐 bundle.ts BUNDLE_LAYOUT）

- `flow.yaml` —— 流程图：isekai §2 六步回合（情境呈现 → 主角决策 → 判定 → 后果结算
  →（条件）理智检查 → 世界切换）+ 导演门节点 + 回边（回边即循环，无循环原语）
  + 两条条件边（SAN 触发理智检查 / 世界序列完成退出循环）。
- `game.yaml` —— 规则参数（状态表初始值、世界序列、d20 档级阈值、隐藏停留骰程）
  + 三个 Agent 的 LLM 绑定 + 成本闸（D28）+ 统一迭代上限 + 快照策略。
- `identity_cards/build-a.yaml` —— Build 卡（任务书要求的最小一张）。
- `worldbook.yaml` —— 三个手工世界（加载期导入黑板 `worldbook.*`，D34）。
- `seeds.yaml` —— 种子（参与 D33 版本身份）。

## 已知的最小化缺口（有意为之）

`game.yaml` 的 `agents` 名册引用了 `narrator.yaml` / `archivist.yaml` 两张身份卡，
本 fixture 未包含（任务书只要求「一张 Build 身份卡」）。
装配态 `ScenarioBundleSchema` 不做跨文件引用校验——那是 D20 加载期图校验的职责；
真实 Bundle 必须补齐这两张卡才能通过加载期校验开局。
