# ThinkingArena

配置驱动的多 LLM 模拟推演器：若干不同服务商的 LLM 扮演角色，在配置化流程图中自主推演；导演（你）在局中通过导演门注入干预，在局间调整配置迭代；推演全程以事件落盘（Script JSONL），事件流向下游加工为复盘与视频素材。

当前状态：**薄核心 MVP 已可真实运行**（单主角线性局 + 导演门 + 崩溃恢复，392 个自动化测试）。

## 环境要求

- **Node.js ≥ 24**（直跑 TypeScript，无编译步骤）
- 至少一家服务商的 API key（当前已适配：DeepSeek / Kimi(Moonshot)）

## 快速开始

### 1. 安装

```bash
npm install
```

### 2. 配置凭证

```bash
cp .env.example .env   # 然后编辑 .env 填入你的 key
```

`.env` 已被 gitignore，key 不会进 git。CLI 启动时自动加载（已有环境变量优先）。

### 3. 接入验收（真实冒烟）

```bash
node cli/dev-smoke.ts                    # 两家都跑
node cli/dev-smoke.ts --provider deepseek   # 或单跑一家
```

四项验收：cost 非零 / cached_tokens 正确返回 / 结构化输出往返 / json_object 正常。全部 PASS 才能进入下一步（Kimi 缓存 >256 tokens 才参与，② 偶发 FAIL 时隔分钟重跑再判定）。

### 4. 跑第一局

```bash
node cli/run.ts --bundle bundles/isekai-mvp --run-dir runs/first-real
```

局会在导演门处暂停等你。另开一个终端：

```bash
node cli/observe.ts runs/first-real      # 实时观察事件流（只读文件，不调用 API、不产生费用）

# 注入干预（whisper = 私有催眠，主角会以为那是自己的想法）
echo '{"kind":"whisper","text":"你隐约记得菌林的低语在唤你的名字。","targets":["protagonist"],"mode":"steering"}' >> runs/first-real/director_inbox.jsonl
```

投喂纪律：一次一条，等 `gate_input_received` 落盘再投下一条；被 `no_waiting_gate` 拒收则重投。

> **费用边界**：只有 `cli/run.ts`（真实局）会调用 LLM 产生费用；`observe` / `replay` / `dev-smoke` 之外的查看操作都只读本地文件。名册当前全绑 deepseek-v4-flash（k3 备用），改 `bundles/isekai-mvp/game.yaml` 可换模型。

### 5. 看结果

```bash
runs/first-real/script.jsonl    # 完整事件流（唯一的真相源）
runs/first-real/manifest.json   # 结局 + 成本汇总 + 版本指纹
node cli/replay.ts runs/first-real   # 重放重建任意时刻状态
```

### 不花钱的彩排（mock LLM）

```bash
node cli/run.ts --bundle bundles/isekai-mvp --run-dir runs/rehearsal \
  --mock-llm bundles/isekai-mvp/mock-llm.script.json
```

## 测试

```bash
npm test          # 全仓 392 个测试（node:test，LLM 全部 mock）
```

## 文档与架构

- **文档地图**：`docs/README.md`（核心文档阅读顺序）
- **运转架构权威**：`docs/design/runtime-architecture.md`（决策表 D1–D37）
- **设计层级地图**：`docs/design/layers.md`（全部元素的分解树）
- **场景设计**：`docs/scenarios/isekai-survival.md`
- **路线图**：`docs/roadmap.md`

给 AI 编码 Agent 的项目说明见 `AGENTS.md`。

## 仓库结构

```
schema/        契约层（Zod，v1.0.0 冻结）：事件/流程图/元组件/身份牌/Bundle/错误码
services/      服务层：event-log / blackboard / llm-gateway / memory / agent-service
meta/          元组件层（服务层唯一调用面）
components/    组件层：叙事 / 骰子 / 判定 / 导演门 / 角色创建销毁
orchestrator/  编排层：FlowRunner（graph/scheduler/reducer/director-pump/ledger）
cli/           入口：run / replay / observe / dev-smoke
bundles/       场景包（isekai-mvp：单世界切片）
docs/          文档体系（核心 + used-reference 调研归档）
```
