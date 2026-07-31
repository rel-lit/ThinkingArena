# 深度调研：LLM 网关与成本（五服务商对照）

> 调研日期：2026-07-31。调研对象：DeepSeek / Kimi(Moonshot AI) / Anthropic / OpenAI / 豆包（火山方舟）。
> 本文是 `used-reference/` 下的参考素材，**非权威文档**；与 `docs/design/runtime-architecture.md` 冲突时以后者为准。
> 对齐的决策：D13（薄路由 + 同能力级 fallback）、D16（cost 双轨台账 + 静态前缀 SHA256）、D25（否决响应级缓存，"缓存"仅指服务商原生缓存）、D28（成本闸）。
> 说明：Anthropic 官方文档站（docs.claude.com）在本调研环境网络不可达，其结论以 Vercel AI SDK 官方 provider 文档 + 多个二手来源交叉确认，标注 ⚠ 处建议 Schema 阶段人工复核官方原文。

---

## 问题 1：usage 字段格式（D16 双轨台账的契约输入）

### 五家 usage 字段对照表

| 服务商 | 输入 tokens | 输出 tokens | 缓存命中读 | 缓存写入 | reasoning |
|---|---|---|---|---|---|
| DeepSeek | `usage.prompt_tokens`（= hit+miss） | `usage.completion_tokens` | `usage.prompt_cache_hit_tokens` | 无（写不计费，无字段） | `usage.completion_tokens_details.reasoning_tokens` |
| Kimi | `usage.prompt_tokens` | `usage.completion_tokens` | `usage.cached_tokens`（**顶层字段**，非嵌套） | 无（自动缓存无写费字段） | 思考模型返回 `message.reasoning_content` |
| Anthropic | `usage.input_tokens`（**不含**缓存读写） | `usage.output_tokens` | `usage.cache_read_input_tokens` | `usage.cache_creation_input_tokens` ⚠ | thinking blocks（token 计入 output） |
| OpenAI (Chat Completions) | `usage.prompt_tokens` | `usage.completion_tokens` | `usage.prompt_tokens_details.cached_tokens` | `usage.prompt_tokens_details.cache_write_tokens`（仅 GPT-5.6+） | `usage.completion_tokens_details.reasoning_tokens` |
| OpenAI (Responses API) | `usage.input_tokens` | `usage.output_tokens` | `usage.input_tokens_details.cached_tokens` | 同上 | 同上思路 |
| 豆包（火山方舟） | `usage.prompt_tokens` | `usage.completion_tokens` | `usage.prompt_tokens_details.cached_tokens` | 无（隐式缓存无写费字段） | 思考走 `reasoning_content` |

引用：
- DeepSeek [Chat Completions API 参考](https://api-docs.deepseek.com/api/create-chat-completion/)（`prompt_tokens` 等于 `prompt_cache_hit_tokens + prompt_cache_miss_tokens`，原文明确写出）；[Context Caching 指南](https://api-docs.deepseek.com/guides/kv_cache/)
- Kimi [创建对话补全 API 参考](https://platform.kimi.com/docs/api/chat)（响应示例中 `usage` 含顶层 `cached_tokens`，流式末 chunk 同样带 `usage`）
- Anthropic：字段名经 [Vercel AI SDK Anthropic provider 文档](https://ai-sdk.dev/providers/ai-sdk-providers/anthropic)交叉确认——SDK 把 API 的 `cache_read_input_tokens` / `cache_creation_input_tokens` 映射为标准 `usage.inputTokenDetails.cacheReadTokens` / `cacheWriteTokens` ⚠
- OpenAI [Prompt Caching 官方指南](https://developers.openai.com/api/docs/guides/prompt-caching)（含 `cached_tokens` 与 `cache_write_tokens` 的 usage 示例 JSON）
- 豆包 [上下文缓存原理及选型](https://docs.volcengine.com/docs/82379/1398933)（"通过 API 响应字段 `usage.prompt_tokens_details` 判断是否命中隐式缓存：`cached_tokens > 0`"）

### 计费口径（cached read / write 怎么计费）

| 服务商 | 缓存读 | 缓存写 | 备注 |
|---|---|---|---|
| DeepSeek | 命中价：V4-Flash ¥0.02/M（=未命中 ¥1 的 **2%**）、V4-Pro ¥0.025/M（=未命中 ¥3 的 **0.83%**） | **不计费** | **即将上线峰谷定价：高峰时段（北京时间 9:00–12:00、14:00–18:00）所有计费项 2 倍**，生效日期待公告 |
| Kimi | K3 ¥2/M（=¥20 的 10%）；K2.5 ¥0.7/M（=¥4 的 17.5%）；K2.6/K2.7 ¥1.1–1.3/M（≈17–20%） | 自动缓存不计费 | 另有 2024 年显式 Context Caching API（创建 ¥24/M + 存储费），当前官方指南主推自动缓存（见问题 3） |
| Anthropic | 读 = 输入价 **0.1x**（如 Opus 4.7：$0.50/M） | 5 分钟 TTL = **1.25x**；1 小时 TTL = **2x** | 读命中会刷新 5m TTL ⚠ |
| OpenAI | 读 = 输入价 **10%**（GPT-5.6 Sol：$0.50/M vs $5/M） | GPT-5.6 起写 = **1.25x**；更早模型写免费 | 写入量报在 `cache_write_tokens` |
| 豆包 | 命中按"缓存命中输入单价"，**随输入长度分段变化**（如 Seed 2.0 系 [0,32k]/[32k,128k]/[128k,256k] 各档命中价不同） | 隐式缓存存储不计费；**显式缓存收存储费** | 豆包全线按输入长度分段计价（如 Seed 2.1 Pro [0,256k] 档输入 ¥3/M、命中 ¥1.2/M、输出 ¥15/M） |

引用：
- DeepSeek [模型与价格（官方）](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)（表格原文：缓存命中 0.02/0.025 元、未命中 1/3 元、输出 2/6 元，峰谷定价公告）
- Kimi [K3 价格页（官方）](https://www.kimi.com/zh-cn/resources/kimi-k3-pricing)；[DevTk K2.5 价格（二手，2026-07 更新）](https://devtk.ai/zh/models/kimi-k2-5/)
- Anthropic [EvoLink Claude 价格整理（2026-07-20 校对，含 cache write/read 逐项）](https://evolink.ai/blog/claude-api-pricing-guide-2026)；[OpenRouter Prompt Caching 说明](https://openrouter.ai/docs/guides/best-practices/prompt-caching#anthropic-claude)（write 1.25x / read 0.1x）⚠
- OpenAI [Prompt Caching 官方指南](https://developers.openai.com/api/docs/guides/prompt-caching)；[GPT-5.6 价格对比（二手）](https://theplanettools.ai/compare/gpt-5-6-sol-vs-gpt-5-5)
- 豆包 [上下文缓存原理及选型](https://docs.volcengine.com/docs/82379/1398933)；[模型价格页（官方）](https://www.volcengine.com/docs/82379/1544106)

### 对架构/契约的影响

- **cost 事件的统一 usage 契约需要五个字段**：`input`、`output`、`cached_read`、`cached_write`、`reasoning`（后两者可缺省为 0）。Anthropic 的 `input_tokens` 不含缓存读写（总输入 = input + creation + read），DeepSeek/Kimi/OpenAI 的 `prompt_tokens` 含命中——**归一化语义必须在网关层写死**：建议契约存"计费口径 tokens"（即 cached_read 单独、cached_write 单独、未命中输入单独），不要只存原始 `prompt_tokens`，否则 Anthropic 与 OpenAI 的总账会算岔。
- **D16 的"原始 usage 双轨"**：原始 usage JSON 原样落 Script（五家字段名不同，这正是 D16 要求双轨的原因），价格表计算值走统一五字段。
- **价格表需要三个维度**：`(model, token_kind)` 之外，豆包需要 `(input_length_tier)` 分段函数，DeepSeek 即将需要 `(peak/off-peak)` 时段维度——建议价格表接口设计为 `price(model) → (usage) → money` 的函数而非静态表，Schema 阶段把分段/峰谷留为扩展点。
- DeepSeek 峰谷 2x 是 D28 成本闸的直接风险项：同一局在高峰时段成本翻倍，预算阈值配置需提示导演。

---

## 问题 2：结构化输出支持矩阵

| 服务商 | `json_object` | `json_schema`（strict） | 工具调用 | 约束解码 | 关键限制 |
|---|---|---|---|---|---|
| DeepSeek | ✅ 官方支持 | ❌ Chat Completions 仅 `text`/`json_object` 两种 | ✅（`strict` 为 Beta） | ❌（json_object 只保合法 JSON） | 用 json_object 必须自己在 prompt 里引导 JSON，否则可能输出无尽空白直到打满 token（官方原文警告） |
| Kimi | ✅ | ✅（`strict:true` + **MFJS** 方言；K3 / K2.7-code 稳定，**K2.6 复杂 schema 不稳定**：`$ref` 可能返回 Markdown 块、`oneOf` 可能被忽略） | ✅（支持 `strict` 参数） | ✅（CFG token 级约束，官方明示） | MFJS 约束可用 `walle` CLI 静态校验 |
| Anthropic | ❌（无传统 JSON mode） | ✅ 走 `output_config.format`（2025-11 beta → 2026 GA，约束解码编译 grammar） | ✅（`strict:true` 工具参数保证 schema 合法） | ✅ | strict 面拒绝 13 个校验关键字（`minLength`/`maxLength`/`pattern`/`format`/`minimum`/`maximum`/`minItems`/`maxItems`/`uniqueItems` 等）⚠ |
| OpenAI | ✅ | ✅（strict 要求**全部字段进 required** + `additionalProperties:false`；schema 作为前缀可参与缓存） | ✅ strict | ✅（官方称 100% 合规） | — |
| 豆包 | ✅（prompt 需含"json"字样） | ✅（**beta**；支持 `$ref` 本地引用、`anyOf`/`oneOf`（不保证 exactly-one）、`allOf`（不严格）；不支持的关键字显式报错） | ✅ | ✅（strict 模式） | beta 不建议生产；**禁止与 `frequency_penalty`/`presence_penalty` 共用**；TPM 保障包下不可用 |

引用：
- DeepSeek [Chat Completions API 参考](https://api-docs.deepseek.com/api/create-chat-completion/)（`response_format.type` 枚举仅 `text`/`json_object`）；[JSON Output 指南](https://api-docs.deepseek.com/guides/json_mode/)
- Kimi [使用 response_format 控制模型输出格式（官方，2026-07-23 更新）](https://platform.kimi.com/docs/guide/response_format)
- Anthropic：[AI SDK Anthropic provider 文档](https://ai-sdk.dev/providers/ai-sdk-providers/anthropic)（`structuredOutputMode: outputFormat | jsonTool | auto`）；[rebar 结构化输出调研（GitHub，2026-06）](https://github.com/navapbc/rebar/blob/main/docs/experiments/workflow-remediation-pocs/structured-output-research.md)；[schemafit 关键字矩阵](https://github.com/OrionArchitekton/schemafit) ⚠
- OpenAI [Structured Outputs 官方指南](https://developers.openai.com/api/docs/guides/structured-outputs)
- 豆包 [结构化输出（beta）（官方）](https://www.volcengine.com/docs/82379/1568221)

### 两个已知怪癖的验证结果

1. **"DeepSeek 对象形式报 500"——未能在官方文档复现或证实。** 当前官方 API 参考明确支持 `json_object`；[错误码页](https://api-docs.deepseek.com/zh-cn/quick_start/error_codes/) 中 500 仅为通用服务器故障。该怪癖可能来自早期版本（或与 `max_tokens` 缺省/prompt 未引导 JSON 导致的挂起混淆）。**结论：降级为待实测项，冒烟时加一个 DeepSeek `json_object` 往返用例即可定论**（见未决问题 1）。
2. **"Kimi 不支持 required 字段"——已不成立。** Kimi 当前官方 response_format 文档的示例大量使用 `required`（含嵌套数组内对象的 required），并明确"声明在 `required` 中的字段必然出现在输出中"。真实的现行约束是 **MFJS 方言 + K2.6 复杂 schema 不稳定**，建议默认用 K3 / K2.7-code 做结构化输出。

### 对架构/契约的影响

- **判定/骰子等结构化组件的契约 schema 要按"最严交集"设计**：全字段 required、`additionalProperties:false`、避免 Anthropic 拒绝的 13 个关键字、避免深层 `$ref` 与 `oneOf`。这个交集能同时过 OpenAI/Anthropic/Kimi(MFJS)/豆包四家的 strict 面；DeepSeek 反正只走 json_object + Zod 业务层校验，不受交集约束。
- **DeepSeek 是结构化输出能力洼地**（无 json_schema、无约束解码）：凡用 DeepSeek 出 JSON 的组件，契约层必须保留"业务层 Zod 二次校验 + 解析失败重试"路径——这与 D6（整批拒执行并重发）的失败语义衔接，重试计入 D28 统一迭代上限。
- 接入验收清单（roadmap 的 dev 工具）应包含：每服务商 `json_object` 往返、`json_schema` strict 往返（除 DeepSeek）、工具调用往返三个冒烟用例。
- Kimi 官方明示"设置 `response_format` **不会破坏前缀缓存**"——动态段（L6–L9）按需开关 JSON 模式不影响 D16 静态前缀的缓存命中，这个性质对渲染器契约有用。

---

## 问题 3：缓存机制现状

### 缓存策略矩阵

| 服务商 | 模式 | 断点/配置 | TTL | 最小可缓存 | 读价 | 写价 |
|---|---|---|---|---|---|---|
| DeepSeek | **全自动**（磁盘缓存，默认开启） | 无断点概念；按"缓存前缀单元"整体匹配（请求边界/公共前缀检测/定长间隔三种持久化时机） | 不用即清，数小时~数天 | 未明示 | 2% / 0.83%（Flash/Pro） | 免费 |
| Kimi | **全自动前缀缓存** | 可选 `prompt_cache_key`（session/task id）提升命中 | 系统管理 | prompt > 256 tokens 才参与 | 10%–20% | 免费 |
| Anthropic | **显式断点** | `cache_control: {type:"ephemeral"}`，**每请求最多 4 个断点** | 默认 5 分钟（读命中刷新），可选 1h | 1024–4096 tokens 因模型（Opus 4.5/Haiku 4.5 为 4096） | 0.1x | 1.25x（5m）/ 2x（1h） |
| OpenAI | **自动**（GPT-5.6 起加显式断点） | 自动：前缀哈希路由 + `prompt_cache_key`；GPT-5.6+：`prompt_cache_breakpoint`，**每请求最多写 4 个、读最多考虑 50 个** | 旧模型 5–10 分钟（可 24h 扩展保留）；GPT-5.6+ `ttl=30m`（唯一支持值） | ≥1024 tokens | 10% | GPT-5.6+ 1.25x；更早免费 |
| 豆包 | **隐式自动（不可关闭）+ 显式两套 API** | 隐式无需配置；显式走 Responses API `caching` 字段或 Context Create/Chat API（Session 缓存 / 前缀缓存，缓存 ID 生命周期自理） | 隐式不承诺；显式可配（最长 7 天 / 168h TTL） | 隐式 ≥1024 tokens | 分段计价（低于未命中价） | 隐式免费；**显式收存储费** |

引用：
- DeepSeek [Context Caching 指南](https://api-docs.deepseek.com/guides/kv_cache/)
- Kimi [使用 Context Caching 功能（官方，2026-07-29 更新）](https://platform.kimi.com/docs/guide/use-context-caching-feature-of-kimi-api)、[创建对话补全（`prompt_cache_key` 参数说明）](https://platform.kimi.com/docs/api/chat)
- Anthropic：[AI SDK Anthropic provider 文档 Cache Control 节](https://ai-sdk.dev/providers/ai-sdk-providers/anthropic)；[OpenRouter 说明（4 断点上限、TTL）](https://openrouter.ai/docs/guides/best-practices/prompt-caching#anthropic-claude)；[Franklin issue #73（超 4 断点 → HTTP 400 实证）](https://github.com/BlockRunAI/Franklin/issues/73) ⚠
- OpenAI [Prompt Caching 官方指南](https://developers.openai.com/api/docs/guides/prompt-caching)
- 豆包 [上下文缓存原理及选型](https://docs.volcengine.com/docs/82379/1398933)、[上下文缓存使用指南](https://www.volcengine.com/docs/82379/1602228)

### 对架构/契约的影响

- **五家的缓存都是"前缀"语义，这直接验证了 D16"静态前缀逐字稳定置前"的渲染器不变量**——它就是本项目缓存命中率的全部杠杆。每回合静态前缀 SHA256（D16）除了防漂移，还应用作缓存命中率归因指标：SHA256 变化 → 预期命中率归零。
- **断点放置是渲染器契约的新需求**：Anthropic（必须显式）与 OpenAI GPT-5.6+（可选显式）需要在 prompt 内容块上打 `cacheControl`/`prompt_cache_breakpoint` 标记。L0–L9 的四区结构（静态共享 / 静态每 Agent / 动态注入 / 回合上下文）天然给出 2–3 个合理断点位置（静态共享区末尾、静态每 Agent 区末尾），**不超过 Anthropic 的 4 断点上限**；whisper 绝不进静态前缀（既有安全约束）同时也保护了断点稳定性。豆包显式缓存的"缓存 ID 生命周期管理"与薄核心纪律不符，**建议豆包只用隐式缓存**。
- **写费不对称是成本模型的变量**：Anthropic 5m 写 1.25x 意味着"静态前缀频繁变化"不仅丢命中率还倒贴写费——渲染器稳定性从"优化"变成"硬约束"；D28 成本闸的账本应把 cached_write 单列，便于发现"写费倒贴"异常。
- OpenAI GPT-5.6 的 `prompt_cache_key` 与 Kimi 的 `prompt_cache_key` 同语义：契约层 LLMRequest 可加一个可选 `cacheKey` 字段（建议取值 = 局 ID + Agent ID），一次抽象覆盖两家。

---

## 问题 4：fallback 能力分级建议（D13 薄路由用）

> 原则：只同能力级降级；跨服务商 fallback 前过冒烟（D13 既有纪律）。以下分级以 2026-07 各家旗舰定位 + 价格档近似，**能力等价性需冒烟与基准实测确认**。

### 当前模型名册（2026-07-31 核实）

| 服务商 | 旗舰 | 中坚 | 轻量/高速 | 旗舰价格（输入/输出，每 M tokens） |
|---|---|---|---|---|
| DeepSeek | `deepseek-v4-pro`（1M 上下文，思考默认开） | — | `deepseek-v4-flash` | ¥3 / ¥6（命中 ¥0.025） |
| Kimi | `kimi-k3`（2.8T MoE，1M 上下文，恒思考） | `kimi-k2.7-code`（256K，structured output 最稳） | `kimi-k2.7-code-highspeed`、`kimi-k2.6` | ¥20 / ¥100（命中 ¥2） |
| Anthropic | `claude-fable-5`（$10/$50）、`claude-opus-4-8`（$5/$25） | `claude-sonnet-5`（推广价 $2/$10 至 2026-08-31，之后 $3/$15）、`claude-sonnet-4-6` | `claude-haiku-4-5`（$1/$5） | 见左 |
| OpenAI | `gpt-5.6-sol`（$5/$30，命中 $0.50） | `gpt-5.5`（$5/$30）、`gpt-5.4`（$2.5/$20） | mini 系 | 见左 |
| 豆包 | `doubao-seed-2.1-pro`（≤256k 档 ¥3/¥15） | `doubao-seed-2.1-turbo`（¥1.5/¥7.5） | `doubao-seed-2.0-lite`（≤32k 档 ¥0.6/¥3.6） | 分段计价 |

引用：[DeepSeek 价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)；[Kimi 快速开始/模型选择](https://platform.kimi.com/docs/api/chat)、[K3 价格](https://www.kimi.com/zh-cn/resources/kimi-k3-pricing)；[EvoLink Claude 价格（2026-07-20 校对）](https://evolink.ai/blog/claude-api-pricing-guide-2026)；[AI SDK Anthropic provider（模型 ID：claude-opus-4-8 / claude-fable-5 / claude-sonnet-5）](https://ai-sdk.dev/providers/ai-sdk-providers/anthropic)；[GPT-5.6 vs 5.5](https://theplanettools.ai/compare/gpt-5-6-sol-vs-gpt-5-5)；[火山方舟模型价格](https://www.volcengine.com/docs/82379/1544106)、[TokenPlan 豆包价格整理](https://tokenplan.vip/doubao-token-api/)

### fallback 链建议表

| 能力级 | 链 A（中文叙事优先） | 链 B（推理/判定优先） | 链 C（成本极限） |
|---|---|---|---|
| 旗舰推理 | `kimi-k3` → `claude-opus-4-8` → `gpt-5.6-sol` | `claude-fable-5` → `gpt-5.6-sol` → `kimi-k3` | `deepseek-v4-pro` → `doubao-seed-2.1-pro` |
| 中坚均衡 | `kimi-k2.7-code` → `claude-sonnet-5` → `doubao-seed-2.1-turbo` | `claude-sonnet-5` → `gpt-5.4` → `kimi-k2.7-code` | `doubao-seed-2.1-turbo` → `deepseek-v4-pro` |
| 轻量群演 | `kimi-k2.6` → `claude-haiku-4-5` | `claude-haiku-4-5` → `kimi-k2.7-code-highspeed` | `deepseek-v4-flash` → `doubao-seed-2.0-lite` |

注意：`claude-fable-5` 有安全分类器拦截面（网络/生物/化学话题），被拒时返回 200 + `refusal`——扮演类内容一般不触碰，但 D13 的错误枚举应把 `content-filter`/`refusal` 归为"不可重试、直接 fallback"类（AI SDK 把它映射为 `content-filter` finish reason；Anthropic API 另有服务端 `fallbacks` 参数可自动降级，不建议用——绕过本项目 D13 的归因与熔断计数）。

### 对架构/契约的影响

- D13 的 `RouteDecision` 需要显式 `tier`（能力级）字段，fallback 链配置按 tier 组织而非平铺模型列表；身份牌与模型解耦（AGENTS.md 安全边界）保证 fallback 只换模型不换角色身份。
- **fallback 不改变 cost 事件的字段结构，但改变价格表查找键**——cost 事件必须落"实际出账模型"而非"请求模型"（Anthropic 服务端 fallback 会在 `usage.iterations` 里记 `fallback_message`，若启用需注意；建议不启用，见上）。
- 冒烟清单按链配置：每条链的首个跨服务商跳转对（如 `kimi-k3 → claude-opus-4-8`）都要过 json 往返 + 工具往返 + usage 非零三项验收，因为消息格式映射（尤其 system 消息、tool 结果消息）各家不同。

---

## 问题 5：Vercel AI SDK generateObject 的实际行为

**版本前提：AI SDK 6（2026-01 stable）已弃用 `generateObject`/`streamObject`（[PR 10754](https://ai-sdk.dev/docs/migration-guides/migration-guide-6-0)），官方路径是 `generateText`/`streamText` + `output: Output.object({ schema })`，schema 直接吃 Zod（FlexibleSchema，亦支持 Valibot/JSON Schema）。** 新项目（ThinkingArena Phase 1）应直接对齐 Output API，不要再引入 generateObject。

各 provider 的结构化输出实现路径（引用均为官方 provider 文档）：

| Provider 包 | 结构化输出路径 | 降级行为 | Zod 兼容 |
|---|---|---|---|
| `@ai-sdk/openai` | `response_format: json_schema + strict` | 老模型可降级 json mode | ✅ |
| `@ai-sdk/anthropic` | `structuredOutputMode: "auto"`（默认）→ 支持时走原生 `output_format`，否则降级 `"jsonTool"`（用名为 `json` 的工具承载 schema） | auto 自动降级 | ✅ |
| `@ai-sdk/deepseek` | 走 OpenAI 兼容层，**无 json_schema**，object 生成实际落到 `json_object` + prompt 引导 | 本质是 JSON mode | ✅（SDK 层校验） |
| `@ai-sdk/moonshotai` | `kimi-*` 前缀模型**启用原生 structured outputs**；其他模型（moonshot-v1 系）**降级 JSON mode**；官方明确建议"除 Output 外在 prompt 中同时描述 schema" | 按模型 ID 前缀分流 | ✅ |
| 豆包 | **无官方 provider 包**；走 `@ai-sdk/openai-compatible` 指 `baseURL=https://ark.cn-beijing.volces.com/api/v3`，能力取决于该兼容层如何映射 `response_format`（方舟原生支持 json_schema beta，见问题 2） | 未实测，列入未决问题 | ✅（SDK 层校验） |

usage 提取差异（对 D16 关键）：
- DeepSeek 的缓存指标**不在标准 usage 字段**，而在 `providerMetadata.deepseek.promptCacheHitTokens` / `promptCacheMissTokens`（[DeepSeek provider 文档](https://ai-sdk.dev/providers/ai-sdk-providers/deepseek)）。
- Anthropic 的缓存读写在标准 `usage.inputTokenDetails.cacheReadTokens` / `cacheWriteTokens`（[Anthropic provider 文档](https://ai-sdk.dev/providers/ai-sdk-providers/anthropic)）。
- Kimi 的 `cached_tokens` 是顶层字段，经 OpenAI 兼容层时是否被保留进标准 usage 未在文档中明示（未决问题）。

引用：除上述 provider 文档外，[Generating Structured Data（AI SDK 官方）](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data)、[Output API 参考](https://ai-sdk.dev/docs/reference/ai-sdk-core/generate-object)（该 URL 已重定向为 Output 文档）、[AI SDK 6 迁移指南](https://ai-sdk.dev/docs/migration-guides/migration-guide-6-0)。

### 对架构/契约的影响

- **网关不能只用 AI SDK 标准化 usage**：DeepSeek 的缓存字段藏在 `providerMetadata`，网关需要 per-provider 的 usage 提取器（薄适配函数），把五家的原始 usage 归一到问题 1 的五字段契约——这正是 D16"原始 usage 双轨"的实现落点：原始 JSON 落盘 + 归一字段算账。
- 结构化组件统一用 `Output.object({ schema: zodSchema })`：Zod schema 一处定义，既是运行时校验又是 JSON Schema 导出源（对齐 AGENTS.md"Zod 契约定义 + JSON Schema 导出"的技术选型）；对 DeepSeek/豆包这类走 JSON mode 的路径，SDK 层的 `NoObjectGeneratedError` 与 Zod 校验失败要映射到 D6 的"整批拒执行并重发"错误枚举。
- Anthropic 的 `structuredOutputMode` 保持默认 `auto` 即可，但 Schema 阶段应把"实际走了 outputFormat 还是 jsonTool"记入 debug 元数据（降级路径的输出格式在事件流里表现不同：工具调用 vs 文本）。
- 依赖纪律提示：核心需新增 `@ai-sdk/openai`、`@ai-sdk/anthropic`、`@ai-sdk/deepseek`、`@ai-sdk/moonshotai`、`@ai-sdk/openai-compatible` 五个 provider 包（AGENTS.md 目前只写了 `ai` + `zod` + `yaml`，这五个是 `ai` 生态的一等公民，建议 Phase 0 契约评审时确认）。

---

## 未决问题

1. **DeepSeek `json_object` 报 500 怪癖未证实**：当前官方文档支持 `json_object`，历史怪癖无法从文档复现。需要实测冒烟（带/不带 `max_tokens`、带/不带 prompt 引导）定论。
2. **Anthropic 官方文档未直接抓取**（docs.claude.com 在本环境网络不可达）：usage 原始字段名（`cache_creation_input_tokens`/`cache_read_input_tokens`）、4 断点上限、1h TTL 写价 2x 均经 AI SDK 官方 provider 文档 + OpenRouter + 二手价格整理交叉确认，**建议 Schema 阶段人工复核官方原文**。
3. **Kimi 显式 Context Caching（2024 年 API，创建 ¥24/M + 存储费）与现行自动前缀缓存的并存关系不明**：当前官方指南只讲自动缓存，旧 API 是否仍可用/计费未确认；对薄核心无影响（只用自动），但价格表若引用旧缓存价会出错。
4. **豆包显式缓存的存储费率、Seed 2.1 系完整分段价目未抓全**（火山价格页 JS 渲染，抓取不完整）；豆包经 `@ai-sdk/openai-compatible` 接入时 `json_schema` 与 `cached_tokens` 的实际行为未实测。
5. **问题 4 的"同能力级"是价格档 + 发布定位的近似**：真正的能力等价（尤其中文叙事/角色扮演一致性，这是本项目的核心体验）无公开基准可直接引用，需要 Phase 1 冒烟 + 小样本对比实测后修正 fallback 链。
