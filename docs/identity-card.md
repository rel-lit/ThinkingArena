# 身份牌（Identity Card）模块：调研与设计

> 2026-07-23 v1：解决"多 LLM 接入层"与"身份牌提示词层"未显式区分的问题。身份牌与 LLM 服务商配置完全解耦是本模块的第一原则。

---

# Part 1 调研事实

## 1.1 Tavern v2 角色卡规范

**规范来源**：社区规范仓库 `malfoyslastname/character-card-spec-v2`（2023 年 5 月批准，非官方但为事实标准，SillyTavern / Agnai / RisuAI 共同采用）。
来源：https://github.com/malfoyslastname/character-card-spec-v2

### 字段结构（TypeScript 定义，引自规范原文）

```typescript
// V1（TavernAI 时代，扁平六字段）
type TavernCardV1 = {
  name: string; description: string; personality: string;
  scenario: string; first_mes: string; mes_example: string;
}

// V2：外层 envelope + data 嵌套（嵌套是为了防止 V1-only 编辑器静默吞掉 V2 字段）
type TavernCardV2 = {
  spec: 'chara_card_v2'
  spec_version: '2.0'
  data: {
    name, description, personality, scenario, first_mes, mes_example   // 沿用 V1
    creator_notes: string            // 永不进 prompt，给人类看的作者备注（如"适配 GPT-4"）
    system_prompt: string            // 卡级系统提示；规范要求默认覆盖用户全局 system prompt，
                                     // 空串则回落；支持 {{original}} 引用被覆盖的原文
    post_history_instructions: string// 卡级"历史后指令"（即 SillyTavern Jailbreak / Agnai UJB），
                                     // 默认覆盖用户全局值；同样支持 {{original}}
    alternate_greetings: string[]    // 备选开场白（swipe 切换）
    character_book?: CharacterBook   // 内嵌 lorebook（角色绑定的世界书）
    tags: string[]; creator: string; character_version: string  // 元数据，规范明确禁止进 prompt
    extensions: Record<string, any>  // 应用私有扩展；导入方不得销毁未知键（重要惯例）
  }
}
```

关键设计动机（规范 README 明确写出）：`system_prompt` / `post_history_instructions` 是为了**把体验控制权还给卡的作者**，因为"历史之后的系统指令对当代模型的影响力远强于历史之前的"。

### 内嵌角色书（CharacterBook）结构

```typescript
type CharacterBook = {
  name?, description?, scan_depth?, token_budget?, recursive_scanning?,
  extensions: Record<string, any>,
  entries: Array<{
    keys: string[]; content: string; enabled: boolean;
    insertion_order: number;        // 数值越小插得越靠前
    case_sensitive?: boolean; name?; priority?; id?; comment?;
    selective?: boolean;            // true 时要求 keys 与 secondary_keys 同时命中
    secondary_keys?: string[];
    constant?: boolean;             // 常亮条目，免关键词
    position?: 'before_char' | 'after_char';
  }>
}
```

### PNG 嵌卡格式

JSON 经 base64 编码后写入 PNG 的 `tEXt` chunk，关键字为 `chara`；V3 规范（`chara_card_v3`，kwaroran 提出）使用独立 `ccv3` chunk。SillyTavern 导出时**两个 chunk 都写**，旧新客户端通吃。图片即头像即定义文件，单体分发。

来源：https://honeychat.bot/en/blog/ai-character-cards-guide-v2-v3-2026/ ，https://foreverse.cn/docs/character-cards

### 中文角色卡生态现状

中文角色卡核心创作者高度集中于 Discord 社区**类脑（ΟΔΥΣΣΕΙΑ）**（全球最大中文 ST 社区）与**旅程（ΟΡΙΖΟΝΤΑΣ）**，需答题解锁下载，社区有意限制外传（防盗卖）；聚合站 Chub.ai、JanitorAI、aicharactercards.com、Risu Realm（与 ST 完全兼容）以英文卡为主。结论：**中文卡资源存在但封闭、无稳定公开 API**，做导入兼容应面向 Tavern v2 PNG/JSON 文件本身，而不是某个站点。

来源：https://www.erocraft.com/docs/sillytavern/11-resources ，https://czkm.github.io/2025/03/03/%E4%BB%8E%E9%9B%B6%E5%AE%9E%E7%8E%B0SillyTavern%E6%8E%A5%E5%85%A5DeepSeek%E5%AE%8C%E6%88%90%E6%B2%89%E6%B5%B8%E5%BC%8F%E8%B7%91%E5%9B%A2%E4%BD%93%E9%AA%8C/

### Prompt 组装顺序（两条路径）

- **Text Completion 路径**：核心是 Story String（Handlebars 模板），可用占位符决定字段位置：`{{anchorBefore}}`、`{{system}}`、`{{wiBefore}}`、`{{description}}`、`{{personality}}`、`{{scenario}}`、`{{wiAfter}}`、`{{persona}}`、`{{mesExamples}}`、`{{anchorAfter}}`；渲染后的 Story String 默认放在整个 prompt 最前面，随后是示例对话（`<START>` 分隔）、Chat Start 分隔符、聊天历史；Post-History Instructions 作为最后一条注入（紧随用户消息之后）。模板里没引用的占位符**不会**进 prompt。
  来源：https://github.com/SillyTavern/SillyTavern-Docs/blob/main/Usage/Prompts/context-template.md
- **Chat Completion 路径**：Prompt Manager 以拖拽列表控制发送顺序（靠顶越早发送，列表最底通常是 Post-History Instructions）；每条 prompt 可设 Role（system/user/assistant）、Triggers（Normal/Continue/Swipe 等）、Position（Relative 或 **In-Chat @ Depth**，Depth 0 = 最后一条消息之后，数值越大越深）。默认组件包括 Main Prompt、World Info（before/after）、Char Description、Char Personality、Scenario、Persona Description、Chat History、Post-History Instructions。
  来源：https://docs.sillytavern.app/usage/prompts/prompt-manager/ ，https://docs.sillytavern.app/usage/prompts/

## 1.2 SillyTavern World Info（世界书）机制

来源（本节全部）：https://docs.sillytavern.app/usage/core-concepts/worldinfo/ ，另参考 https://sillycard-web.pages.dev/blog/st-fields-04-character-book

### 触发

- 每条目一组**主关键词**（默认不区分大小写，支持 JS 风格正则）；**Optional Filter（副关键词）**支持四种逻辑：AND ANY / AND ALL / NOT ANY / NOT ALL。
- **Scan Depth**：扫描聊天历史最近 N 条消息（0 = 只扫递归条目和 Author's Note）。
- **递归扫描（Recursive scanning）**：被激活条目的**内容文本**再参与关键词匹配，可链式带出其他条目；每条目有三个递归控制开关（Non-recursable 不被别的条目触发 / Prevent further recursion 自己不再触发别人 / Delay until recursion 只在递归轮次激活），全局有 Max Recursion Steps（与 Min Activations 互斥）。
- **策略标记**：🔵 常亮（constant，免关键词）、🟢 关键词触发、🔗 向量化（Vector Storage 扩展，embedding 相似度替代关键词，其余过滤规则照常生效）。
- **Probability（0–100%）**：命中后按概率实际插入，用于随机事件。
- **Inclusion Group**：同组多条目同时命中时按 Group Weight 随机（或 Prioritize Inclusion 取 Order 最大者）只插一条；Use Group Scoring 可按命中关键词数加权。

### 预算与优先级

Context % / Token Budget 控制世界书总占用；预算耗尽即停止插入。**常亮条目先插，然后按 Insertion Order 从大到小插**（Order 越大越靠近上下文尾部、影响力越强）；由对话直接提及关键词激活的条目优先于被递归带出的条目。

### 按作用域生效

四种来源——全局选择器、**角色绑定（Character Lore，随卡导出内嵌）**、**Persona 绑定**、**单聊天绑定（Chat Lore）**。合并插入策略三选一：Sorted Evenly（默认，按 Order 混排）、Character Lore First、Global Lore First。

### 插入位置（Insertion Position）

1. Before Char Defs / 2. After Char Defs（角色定义前/后，后者影响更大）；
3. Before / 4. After Example Messages（作为示例对话块插入，受示例消息行为规则约束）；
5. Top of AN / 6. Bottom of AN（Author's Note 内部顶/底；AN 禁用时这两个位置的条目被忽略）；
7. **@D（At Depth）**：插到聊天历史的指定深度（**Depth 0 = prompt 最底部**），可选 system / user / assistant 角色——这就是深度注入；
8. **Outlet**：不自动注入，内容挂到命名出口，由 `{{outlet::Name}}` 宏在任意位置手动拉取（不可嵌套、大小写敏感）。

## 1.3 业界参照：system prompt 分层与 prefix caching 实践

**结论先行：不存在一个标准化的"system prompt 分层组装"框架模式，但存在高度一致的缓存导向结构惯例——静态置前、动态置尾、边界打缓存断点。**

- **OpenAI 自动前缀缓存**：≥1024 token 自动生效（GPT-4o 起），按前缀哈希路由到曾处理过相同前缀的机器；官方最佳实践明确"静态内容（指令、示例）放在开头，可变内容放在结尾，图片和 tools 也必须逐字一致"；`prompt_cache_key` 可提升同前缀请求的路由命中率；用量看 `prompt_tokens_details.cached_tokens`。
  来源：https://developers.openai.com/api/docs/guides/prompt-caching
- **Anthropic 显式缓存**：`cache_control: {"type":"ephemeral"}` 标记，**每请求最多 4 个断点**，评估顺序 tools → system → messages；最小可缓存 1024 token（Haiku 2048）；TTL 5 分钟 / 1 小时（长 TTL 必须排在短 TTL 之前）；缓存是**前缀字节级精确匹配**，断点前任何 token 变化即全失效；生产范式是 system+静态文档各一个断点、最后一个 assistant 消息一个滚动断点。Claude Code 实际结构：`system` 数组 + `tools` 数组 + `messages`，静态 system/tools 打 ephemeral 标记，命中读取价约 1 折。
  来源：https://www.developersdigest.tech/blog/prompt-caching-claude-api-production-guide ，https://www.claudecodecamp.com/p/inside-claude-code-s-system-prompt ，https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/context-compression-and-caching.md
- **DeepSeek 硬盘上下文缓存**：全自动、零代码改动；以"cache prefix unit"为持久化单位（请求边界、公共前缀检测、固定 token 间隔三种持久化时机），后续请求**完整匹配**某前缀单元即命中；用量字段 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`；缓存构建需数秒、best-effort、数小时至数天清理。
  来源：https://api-docs.deepseek.com/guides/kv_cache
- **Gemini**：显式 context caching，需单独建缓存对象，最小 32,768 token，门槛最高。
  来源：https://github.com/dimagi/open-chat-studio/issues/3621
- **模式化总结（agent patterns 目录）**："Prompt Caching"被归纳为正式模式——所有稳定内容（system、工具定义、规则章程）置前，可变内容（当前状态、用户消息）置尾，边界处打缓存断点；收益 70–90% 输入成本下降；**典型失效 footgun：工具定义顺序在调用间漂移、时间戳/UUID/关联 ID 泄漏进缓存前缀**、超出服务商断点规则。已知使用者：Anthropic/OpenAI/Gemini/Cursor。
  来源：https://github.com/agentpatternscatalog/patterns/blob/main/patterns/prompt-caching.md
- **框架侧**：LangChain 提供的是组合原语而非分层规范——`ChatPromptTemplate` + `MessagesPlaceholder` 拼装消息序列，LangSmith 管 prompt 版本（commit/tag）（https://docs.langchain.com/langsmith/prompt-engineering-concepts ）；AgentScope 每个 Agent 一个 `sys_prompt` 字符串 + Formatter（`MultiAgentFormatter` 把多方历史折叠进单条 user 消息、加名字前缀），1.0 起有中间件钩子（含 `on_system_prompt`）可在调用前改写 system prompt（https://docs.agentscope.io/versions/1.0.21/en/building-blocks/orchestration ，https://blog.75live.com/archives/2923.html ）。两者都**没有**"角色卡文件格式 + 分层装配 + 缓存标注"的现成抽象——SillyTavern 的 Prompt Manager + 角色卡/世界书体系反而是该问题域最成熟的参照。

---

# Part 2 设计方案

## 2.0 设计原则（从调研提炼）

1. **身份牌与 LLM 服务商配置完全解耦**（第一原则）：卡内零模型信息。绑定关系发生在游戏 YAML：`player.identity_ref` + `player.llm.model` 两个独立字段。
2. **共享层在前、个体层在后**：同一服务商下的多个 Agent，其 prompt 的 L0–L2（输出契约/游戏规则/世界设定）若渲染逐字一致，可跨 Agent 复用服务商前缀缓存；身份牌渲染块（L3）是每 Agent 前缀的分叉点。这是把"静态置前"惯例推广到多 Agent 场景的关键排布。

4. **whisper 走 ST 的 @D 深度注入范式**：私有、近尾部、绝不进静态前缀——同时满足缓存稳定与注意力显著性（调研证实历史之后的指令权重更高）。

## 2.1 身份牌 Schema 草案（`identity_card_v1`）

```yaml
spec: identity_card_v1
spec_version: "1.0"
id: odyssey-build-a            # 稳定标识，游戏 YAML 以 identity_ref 引用
kind: build                    # persona | build —— 两类游戏形态共用外壳
name: "林昭"
meta:                          # 永不进 prompt（creator_notes 惯例）
  creator: "forgo"
  version: "1.0"
  tags: [odyssey, survival]
  notes: "均衡生存流 Build；配 Referee 引擎使用"
  source:                      # 导入溯源（Tavern 卡导入时填充）
    format: null               # "chara_card_v2" | null
    imported_from: null        # 文件名/URL
prompt:                        # 全部进 prompt 的文本资产（渲染进 L3 静态块）
  description: ""              # 角色是谁（外貌/背景/身份）
  personality: ""              # 行为方式与说话风格
  mes_example: ""              # 示例言行（few-shot，可选）
  first_mes: ""                # 开场白/首回合内心独白种子（可选）
  overrides:                   # 卡级覆盖，空则回落到游戏默认（V2 惯例）
    system_prompt_suffix: ""   # 追加而非整体替换（多 Agent 共享 L1 前提下的妥协）
    post_history_instructions: ""
lorebook_ref: null             # 外挂世界书文件（同目录 .yaml），或内嵌 entries
kind_payload:                  # 按 kind 多态（extensions 命名空间惯例）
  build:                       # kind=build：裁判型引擎主角 Build 卡
    education:                 # 本/硕/博三段，真实院校专业+课题（Odyssey 场景要求）
      - stage: 本科
        school: "中国地质大学（武汉）"
        major: "地质学"
        topic: "野外地质填图"
    derived_skills:            # 派生技能标签，Archivist 状态表 seeds
      - { name: "野外生存", level: 2, source: "本科-中国地质大学(武汉)-地质学" }
    mental_anchors_seed: []    # 初始精神锚点
  persona:                     # kind=persona：社交演绎类玩家身份
    alignment: ""              # 阵营（如狼人杀身份），注入私有上下文
    secret_goals: []
    public_profile: ""         # 其他 Agent 可见的部分（inject 到公共上下文用）
extensions: {}                 # 任意私有扩展；导入器不得销毁未知键
```

要点：

- **`kind` 多态但外壳统一**：`prompt.*` 四字段对齐 Tavern v2 语义，保证导入映射无损；`kind_payload` 承载 Build 卡的结构化数据（教育经历、技能种子），这部分**渲染为 YAML 块进 L3**，同时作为 Archivist 状态表的初始值来源——一份数据两处消费，消除"人设散在游戏 YAML"的重复定义。
- **alignment/secret_goals 属私有**：每个 Agent 本来就有独立私有上下文区，身份牌的私有字段只进该 Agent 的 L3，不进公共 inject。
- **显式不支持 `llm.*`**：schema 校验器应拒绝卡内出现模型字段，从机制上保证解耦。

## 2.2 Prompt 组装分层图

```
┌─ 静态前缀区（跨回合逐字稳定；同服务商 Agent 间共享）─────────────────
│ L0 输出契约        响应格式/结构化输出协议/全局禁令        缓存:全局静态 ★★★
│ L1 游戏规则        GameEngine 契约、回合协议、骰点档级      缓存:每局静态 ★★★
│ L2 世界设定        场景 YAML 静态部 + 世界书常亮条目        缓存:每局静态 ★★☆
│    ── Anthropic 断点①（tools/system 边界）──
├─ 半静态区（单 Agent 内稳定；同服务商跨 Agent 在此分叉）─────────────
│ L3 身份牌渲染块    description+personality+mes_example
│                    +kind_payload 渲染(YAML)+私有身份         缓存:每 Agent 静态 ★★☆
│    ── Anthropic 断点②（身份牌块末尾，本 Agent 主缓存点）──
├─ 亚动态区（低频变化，变化即记 cache_invalidation 事件）────────────
│ L4 触发式世界书    关键词命中条目（ST World Info 机制复刻）   缓存:回合间可能抖动 ★☆☆
│ L5 滚动摘要        长记忆压缩摘要（稳定段落化，只追加式更新）  缓存:低频率失效 ★★☆
├─ 动态尾区（每回合重写，永远不入缓存前缀）─────────────────────────
│ L6 运行时状态      Archivist 状态表快照(HP/SAN/物资/时间线)  缓存:不缓存 ✗✗✗
│ L7 聊天/事件历史   最近 N 回合公开历史 + 该 Agent 私有历史    缓存:滚动前缀可命中 ★☆☆
│ L8 导演 whisper    [潜意识暗示]+权重，@D 深度注入(仅目标Agent) 缓存:绝不进前缀 ✗✗✗
│ L9 回合推动指令    本轮情境呈现 + post_history_instructions  缓存:不缓存 ✗✗✗
└─ 生成触发          "以{name}身份输出内心独白+行动声明:"
```

### 关键决策说明

- **whisper 在 L8**（近尾部、@D 式）：
  1. 调研证实历史之后的指令权重最高，催眠暗示需要显著性；
  2. 若 whisper 进静态前缀，每次 whisper 都会炸掉该 Agent 的全部缓存——这是 whisper 机制的缓存硬约束；
  3. whisper 按定义只对目标 Agent 可见，放在其私有尾区天然满足隔离。
  whisper 事件写入 Script（`director_whisper`），与注入文本 hash 一起落盘。
- **L4 世界书采用 ST 机制子集**：关键词触发 + 常亮条目 + scan depth + token 预算 + insertion order 足够 MVP；递归扫描、概率、Inclusion Group 后期再加。注意 ST 默认把触发条目插在角色定义前后（静态区），但**本项目应把触发条目整体下移到自己的 L4 段**，否则触发与否会造成前缀逐字漂移、缓存命中率随机化——这是对 ST 设计的有意偏离，原因是 ST 单用户不在乎缓存，本项目在乎。
- **edit_world 与 cache_invalidation 对齐**：导演 `edit_world` 改 L2/L4 → 记 `cache_invalidation` 事件（架构文档 D2/D4 已定义），成本归因链路闭合。
- **渲染确定性纪律**（防 footgun，见调研 1.3）：L0–L5 由一个纯函数渲染器产出，字段顺序固定、无时间戳/UUID/回合计数、YAML 序列化器固定（key 排序、缩进固定）；渲染器输出静态前缀的 SHA256 写入每回合事件，用于验证"逐字稳定"是否被破坏。
- **断点预算**：Anthropic 仅 4 个断点，方案用 2 个静态断点（L2 末、L3 末），余量留给 L7 滚动历史断点；OpenAI/DeepSeek 自动缓存无需标记，只需保证结构。

## 2.3 文件格式建议

- **YAML，一卡一文件**，存放于 Scenario Bundle 的 `identity_cards/` 子目录，随 Bundle 进 git（与架构文档 D3 一致）。选 YAML 而非 JSON：人写人设需要多行文本与注释，且项目现有配置已是 YAML。
- **Tavern v2 导入兼容**：提供一次性转换器 `tavern_import`（输入 PNG/JSON → 输出身份牌 YAML）：

| Tavern v2 字段 | 身份牌字段 | 备注 |
|---|---|---|
| `data.description` / `personality` / `scenario` / `first_mes` / `mes_example` | `prompt.*` 同名平移 | 无损 |
| `data.system_prompt` | `overrides.system_prompt_suffix` | **语义降级**：Tavern 是整体替换，本项目为保共享前缀只能追加；转换器须在 `meta.notes` 记录此降级 |
| `data.post_history_instructions` | `overrides.post_history_instructions` | 平移 |
| `data.character_book.entries` | 外挂 `lorebook.yaml` + `lorebook_ref` | 键/副键/常亮/位置/Order 平移 |
| `data.creator` / `tags` / `character_version` | `meta.creator` / `meta.tags` / `meta.version` | 元数据 |
| `data.creator_notes` | `meta.notes` | 元数据，不进 prompt |
| `data.extensions` | `extensions` 原样透传 | 不得销毁未知键 |
| `data.alternate_greetings` | `extensions.tavern.alternate_greetings` | 本项目无 swipe 概念，归档保留 |
| PNG `chara` tEXt chunk（base64） | 转换器入口 | 可选优先读 `ccv3` chunk |

  不承诺 PNG 导出（MVP 不需要），只承诺导入。
- **世界书文件**：独立 `lorebook.yaml`（entries: keys / secondary_keys / constant / position / order / content），身份牌以 `lorebook_ref` 引用；Bundle 级世界书与卡级世界书合并策略照搬 ST 的 Sorted Evenly。

## 2.4 待决策点

1. `overrides.system_prompt_suffix`（追加）vs Tavern 的整体替换语义——追加保缓存、替换保作者控制力，目前选追加。
2. L4 触发条目下移偏离 ST 惯例，对"条目贴角色定义更有效"的经验法则有损耗，需要实测戏剧质量。
3. 身份牌私有字段（alignment/secret_goals）是否进 L3 静态块：进则缓存友好但换身份即失效；社交演绎类游戏身份一局不变，建议进。
