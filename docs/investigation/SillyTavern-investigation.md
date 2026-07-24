# SillyTavern 架构核心设计调研

> **项目**：SillyTavern
> **仓库**：https://github.com/SillyTavern/SillyTavern
> **许可证**：AGPL-3.0
> **版本**：1.18.0（截至调研时）
> **调研日期**：2026-07-24

---

## 1. 架构概览：设计理念与系统边界

### 1.1 核心设计理念

SillyTavern 的设计哲学可以概括为 **"极致控制的前端编排器"**：

- **BYOAI（Bring Your Own AI）**：本身不做任何推理，仅作为与各类 LLM 后端（OpenAI、Claude、KoboldAI、Ollama、OpenRouter 等）交互的编排层。
- **Prompt 工程优先**：将 Prompt 的组装、分层、注入、截断作为一等公民，而非简单的 "系统提示词 + 用户输入" 拼接。
- **无审查与可扩展**：通过开源与本地部署，确保用户对内容、数据、模型选择的完全控制。
- **资产即代码**：角色卡（Character Card）与世界书（World Book / Lorebook）是可移植的结构化数据资产，采用 PNG 元数据嵌入实现 "自包含文件"。

### 1.2 系统边界与部署架构

```
+---------------------------------------------+
|                  浏览器前端                    |
|  (public/ - jQuery/Vanilla JS 单页应用)       |
|  - PromptManager (Prompt 组装)              |
|  - WorldInfo (关键词触发注入)                 |
|  - MessageCollection (ChatML 构造)          |
|  - TokenHandler (Token 预算分配)             |
+------------------+--------------------------+
                   | HTTP / SSE
+------------------v+--------------------------+
|              Node.js + Express 后端          |
|  (src/ - ES Module 结构)                    |
|  - Endpoints (characters, chats, worldinfo) |
|  - Prompt Converters (多后端格式转换)        |
|  - Character Card Parser (PNG 元数据读写)  |
|  - Plugin Loader (扩展系统)                  |
+------------------+--------------------------+
                   | API 调用
+------------------v+--------------------------+
|           外部 LLM 后端 / 本地推理引擎        |
|  (OpenAI, Claude, KoboldCPP, Ollama...)    |
+---------------------------------------------+
```

**关键边界特征：**
- **前后端不分离为独立服务**：后端同时充当静态文件服务器与 API 代理，前端直接通过 `fetch` 调用后端端点，后端再转发至各 LLM API。
- **用户数据隔离**：通过 `data/` 目录与 `users.js` 实现多用户目录模板（`USER_DIRECTORY_TEMPLATE`），支持多用户隔离（虽主要面向单用户本地使用）。
- **Webpack 仅用于库打包**：`webpack.config.js` 主要用于打包前端第三方库（`lib.js`），核心业务逻辑为原生 ES Module。

---

## 2. 核心架构组件

### 2.1 后端核心模块（`src/`）

| 模块 | 职责 | 可复用模式 |
|------|------|-----------|
| `server-main.js` | Express 应用组装、中间件链（Helmet、CORS、CSRF、Cookie Session）、生命周期管理 | **洋葱模型中间件链** |
| `prompt-converters.js` | ChatML 对象 <-> Claude / OpenAI / 其他后端的格式转换（`PROMPT_PROCESSING_TYPE`） | **策略模式格式转换器** |
| `character-card-parser.js` | PNG `tEXt` chunk 读写（`chara` V2 / `ccv3` V3），base64 JSON 编解码 | **自包含资产容器（PNG 元数据）** |
| `users.js` | 用户目录初始化、迁移、登录中间件、Cookie 安全 | **基于文件系统的用户隔离** |
| `endpoints/` | 按领域划分的 Express Router（characters, chats, worldinfo, openai...） | **领域驱动端点划分** |
| `plugin-loader.js` | 插件发现、加载、生命周期管理 | **动态插件系统** |
| `charx.js` | V3 角色卡专用解析器（ZIP 容器），支持 `assets[]`、多语言字段、SFX 自解压 ZIP | **版本化资产解析器** |

### 2.2 前端核心模块（`public/scripts/`）

| 模块 | 职责 | 可复用模式 |
|------|------|-----------|
| `PromptManager.js` | Prompt 集合管理、注入位置/深度/顺序控制、覆盖机制 | **分层注入管理器** |
| `openai.js` | `Message` / `MessageCollection` / `TokenHandler` 定义，聊天完成请求构造 | **ChatML 抽象与预算分配** |
| `world-info.js` | World Info（Lorebook）扫描、关键词匹配、条件注入、预算竞争 | **条件化上下文注入引擎** |
| `instruct-mode.js` | 指令模板序列（input/output/system sequence）管理 | **模板化对话格式** |
| `authors-note.js` | 浮动作者注释（Author's Note）深度与位置注入 | **元提示注入层** |
| `itemized-prompts.js` | 每条消息的 Prompt 构成 itemization（Token 统计与可视化） | **可观测性组装日志** |
| `macros.js` | 宏替换系统（`{{user}}`, `{{char}}`, `{{pick}}` 等） | **动态模板宏系统** |
| `extensions.js` | 扩展系统通过 `extension_prompt_types`（IN_CHAT / IN_PROMPT / BEFORE_PROMPT）与 `extension_prompt_roles`（SYSTEM / USER / ASSISTANT）向 Prompt 管道注入第三方内容 | **扩展注入点抽象** |

---

## 3. 角色卡 / 世界书 / Prompt 分层抽象

这是 SillyTavern 最具架构价值的部分。其本质是一个 **分层上下文组装管道（Layered Context Assembly Pipeline）**。

> **注**：Layer 编号表示语义层级（Layer 1 为基础模型参数层，Layer 7 为顶层系统语义层），**不表示注入优先级**。优先级由 `injection_order`、`depth` 及 `TokenHandler` 预算截断策略共同决定。

### 3.1 资产分层模型

```
+-------------------------------------------------------------+
|  Layer 7: System / Jailbreak / NSFW / Main Prompt (Preset)   |
|           -> 由 PromptManager 管理，可设置 injection_position |
|           -> 通常作为 system 角色或顶部指令注入                |
+-------------------------------------------------------------+
|  Layer 6: Author's Note (Floating Prompt)                     |
|           -> 按 interval/depth/position 动态插入对话流        |
+-------------------------------------------------------------+
|  Layer 5: World Info / Lorebook (条件知识层)                  |
|           -> 关键词触发、概率控制、预算竞争、递归扫描           |
|           -> 支持 global (世界书) 与 character_book (角色卡内)|
+-------------------------------------------------------------+
|  Layer 4: Character Card Core (角色核心身份)                |
|           -> description (always injected)                    |
|           -> personality, scenario, first_mes, mes_example    |
+-------------------------------------------------------------+
|  Layer 3: Chat History / Examples (对话历史与示例对话)        |
|           -> MessageCollection 按 role 组装                  |
|           -> 示例对话可解析为独立消息或合并为系统提示           |
+-------------------------------------------------------------+
|  Layer 2: User Persona / Persona Description (用户身份)       |
|           -> 用户自定义身份注入                                |
+-------------------------------------------------------------+
|  Layer 1: Model / API 参数与后处理 (Preset)                   |
|           -> temperature, top_p, context length, stop strings |
+-------------------------------------------------------------+
```

### 3.2 Prompt 注入控制原语

`PromptManager.js` 定义了精细的注入控制语义：

| 属性 | 类型 | 语义 |
|------|------|------|
| `injection_position` | `RELATIVE` (0) / `ABSOLUTE` (1) | 相对位置（按顺序插入）或绝对深度（按消息深度插入） |
| `injection_depth` | number | 在聊天历史中的深度（0 = 最近消息） |
| `injection_order` | number | 同层内的排序权重 |
| `injection_trigger` | string[] | 仅在特定生成类型触发（如 `normal`, `continue`, `impersonate`） |
| `role` | string | `system`, `user`, `assistant` |
| `forbid_overrides` | boolean | 禁止被覆盖 |
| `marker` | boolean | 标记型 Prompt（不携带内容，仅作位置标记） |

### 3.3 World Info（世界书）触发引擎

`world-info.js` 实现了一个 **基于关键词的条件上下文注入引擎**，核心机制：

1. **扫描源（Scan Sources）**：
   - 当前消息文本
   - 角色描述（Description / Personality / Depth Prompt）
   - 场景（Scenario）
   - 创作者注释（Creator Notes）
   - 用户人格（Persona Description）

2. **触发逻辑（Activation Logic）**：
   - `AND_ANY` / `AND_ALL` / `NOT_ANY` / `NOT_ALL` 组合条件
   - 主键（`key`）与次键（`keysecondary`）的二级筛选
   - 概率（Probability）、冷却（Cooldown）、延迟（Delay）、粘性（Sticky）

3. **预算竞争（Budget Competition）**：
   - `world_info_budget`：Token 预算上限
   - `depth`：优先级（高 depth 优先保留）
   - `order`：同 depth 下的排序
   - 当上下文不足时，低 depth / 低 order 的条目被截断

4. **递归扫描（Recursion）**：
   - 注入的 World Info 内容可触发其他条目（`world_info_recursive`）
   - 受 `MAX_SCAN_DEPTH` 与 `world_info_max_recursion_steps` 限制

5. **插入策略（Insertion Strategy）**：
   - `evenly` (0)：角色卡世界书与全局世界书条目均匀交错插入
   - `character_first` (1)：优先插入角色卡绑定的世界书条目
   - `global_first` (2)：优先插入全局世界书条目
   - 该策略决定多个世界书来源竞争同一预算池时的排序优先级

---

## 4. 可复用架构模式提取

### 模式 1：自包含资产容器（Self-Contained Asset Container）

**来源**：`character-card-parser.js` / V2+V3 Spec
**问题**：如何分发可移植的 AI 角色定义，避免 "复制粘贴 JSON"？
**方案**：
- 将结构化数据（JSON）编码为 base64，嵌入标准 PNG `tEXt` chunk。
- 图像即文件，文件即数据。任何图像宿主都不会破坏元数据（只要不 re-encode）。
- 支持双版本并存（V2 `chara` + V3 `ccv3`），确保向后兼容。

**可复用点**：
- 任何需要 "带元数据的媒体文件" 的场景（如带 prompt 的生成图像、带配置的工作流文件）。
- 实现简单：PNG chunk 读写 + base64 JSON。

---

### 模式 2：分层预算管理（Layered Budget Management）

**来源**：`TokenHandler` (openai.js) + `PromptManager` + `itemized-prompts.js`
**问题**：LLM 上下文有限，如何在多层提示（系统提示、角色、世界书、历史）之间分配 Token？
**方案**：
- 将每层内容视为 **Budget Item**，各自申请 Token 预算。
- `TokenHandler` 按优先级截断：通常聊天历史可被截断，核心身份与系统提示保留。
- `itemizedPrompts` 记录每次生成的精确 Token 占用，支持可视化审计。

**可复用点**：
- 任何复杂 RAG 或 Agent 系统的 Prompt 组装管道。
- 关键抽象：`TokenBudgetItem { content, priority, maxTokens, actualTokens }`。

---

### 模式 3：条件化上下文注入（Conditional Context Injection）

**来源**：`world-info.js`
**问题**：知识库太大无法全量注入，如何只注入当前相关的知识？
**方案**：
- 条目化知识（Entry），每条带 **触发键（Trigger Keys）** 与 **内容载荷（Content）**。
- 扫描阶段：在输入 + 状态中提取关键词，匹配条目。
- 注入阶段：按 `depth` + `order` 排序，在预算内填充到 Prompt 的指定位置（Before / After Chat / Relative）。
- 支持时间效应：Sticky（持续多轮）、Cooldown（冷却）、Delay（延迟激活）。

**可复用点**：
- 动态 RAG 前端、游戏剧情系统、交互式小说引擎。
- 可替代简单的 "向量检索 + TopK" 方案，提供更细粒度的业务规则控制。

---

### 模式 4：策略化格式转换（Strategy Pattern Format Converter）

**来源**：`prompt-converters.js`
**问题**：不同 LLM API 对消息格式要求不同（OpenAI ChatML、Claude 系统提示、传统文本补全）。
**方案**：
- 内部统一使用类 ChatML 的 `Message[]` 结构（`role`, `content`, `name`）。
- 输出时通过 `PROMPT_PROCESSING_TYPE` 选择转换策略：
  - `MERGE`：合并相邻同角色消息
  - `STRICT`：严格角色交替，用占位符填充空缺
  - `SINGLE`：合并为单条文本（传统补全模式）
  - `CLAUDE`：转换为 Claude 的 Human/Assistant 格式

**可复用点**：
- 任何需要同时支持多后端 LLM 的中间件或前端。
- 将 "业务消息流" 与 "传输格式" 解耦。

---

### 模式 5：指令模板序列（Instruct Template Sequences）

**来源**：`instruct-mode.js`
**问题**：不同模型对 "系统/用户/助手" 的包装方式不同（如 Alpaca、Vicuna、Llama-2-Chat）。
**方案**：
- 定义模板序列：`story_string_prefix`, `input_sequence`, `output_sequence`, `system_sequence`, `stop_sequence` 等。
- 在组装最终文本时，按模型模板包裹消息内容。
- 支持 `names_behavior`（是否强制添加角色名前缀）。

**可复用点**：
- 本地模型前端、需要兼容多种微调模型格式的应用。
- 将 "对话逻辑" 与 "格式模板" 解耦。

---

### 模式 6：事件驱动扩展（Event-Driven Extension System）

**来源**：`events.js` / `extensions.js` / `server-events.js`
**问题**：核心功能之外，如何允许第三方扩展在不修改核心代码的情况下介入流程？
**方案**：
- 前端 `eventSource` 与后端 `serverEvents` 双事件总线。
- 关键生命周期钩子（`event_types` 常量）：
  - `SETTINGS_LOADED` / `OAI_PRESET_CHANGED_BEFORE`：配置变更前介入
  - `GENERATE_BEFORE_COMBINE_PROMPTS` / `GENERATE_AFTER_COMBINE_PROMPTS`：Prompt 组装前后修改
  - `CHAT_COMPLETION_PROMPT_READY`：最终 Prompt 就绪，可拦截或追加
  - `MESSAGE_RECEIVED` / `MESSAGE_SENT`：消息收发前后处理
  - `WORLD_INFO_ACTIVATED` / `WORLDINFO_UPDATED`：世界书触发后响应
- 扩展通过注册事件监听器，可修改 Prompt、拦截请求、添加 UI。

**可复用点**：
- 任何需要插件化的桌面/前端应用。
- 注意：SillyTavern 的实现较为传统（基于 EventEmitter），可升级为更现代的 Hook 系统。

---

## 5. 排除清单与改造建议

| 组件 | 建议 | 原因 |
|------|------|------|
| **jQuery 前端** | 排除复用 | 现代项目应使用 React/Vue/Svelte；SillyTavern 的 jQuery 代码量巨大（`script.js` 494KB），耦合度高 |
| **基于文件的数据层** | 排除复用 | `users.js` 使用文件系统直接读写 JSON/YAML，无数据库抽象；高并发或团队协作场景不适用 |
| **Webpack 构建** | 改造为 Vite/Rollup | 当前 Webpack 配置仅用于库打包，业务代码无构建步骤，现代化改造可提升开发体验 |
| **Cookie-Session 认证** | 排除复用 | 已发现 CVE-2026-44648（无状态 Cookie 无法失效会话），生产环境应使用 JWT + Redis/DB 会话 |
| **PNG 作为唯一容器** | 扩展支持 | V3 引入 `assets[]` 与多语言，但 PNG 对大文本（如长篇小说世界书）效率低；建议增加 JSON/YAML 原生支持 |
| **World Info 关键词匹配** | 增强为混合检索 | 当前仅支持关键词 + Fuse.js 模糊匹配，建议叠加向量检索作为召回层，关键词作为精排规则 |

---

## 6. 架构决策记录（ADR）摘要

1. **ADR-001：前后端不分离为独立服务**
   选择将 Express 与前端 SPA 打包在同一仓库，简化本地部署（单 `npm start`）。代价是前后端版本强耦合。

2. **ADR-002：PNG 元数据作为角色卡标准格式**
   选择 PNG `tEXt` chunk 而非独立 JSON，实现 "一图一卡" 的便携性。代价是编辑需专用工具，且大文本会膨胀 PNG 体积。

3. **ADR-003：前端组装 Prompt，后端仅做代理与转换**
   核心 Prompt 组装逻辑（PromptManager、WorldInfo 扫描）全部在浏览器端完成，后端仅负责格式转换与 API 转发。代价是前端代码极重（`openai.js` 299KB），但好处是后端无状态，易于扩展。

4. **ADR-004：基于 Token 预算的硬截断**
   当上下文超长时，按固定优先级截断聊天历史，而非压缩或摘要（除非启用 Summary 扩展）。保证确定性，但可能丢失早期关键信息。

---

## 7. 参考文件区映射

| 调研维度 | 源码位置 | 关键导出/类 |
|----------|----------|-------------|
| Prompt 组装 | `public/scripts/PromptManager.js` | `Prompt`, `PromptCollection`, `PromptManager`, `INJECTION_POSITION` |
| 消息抽象 | `public/scripts/openai.js` | `Message`, `MessageCollection`, `TokenHandler` |
| 世界书引擎 | `public/scripts/world-info.js` | `WorldInfoBuffer`, `world_info_logic`, `scan_state` |
| 系统提示 | `public/scripts/sysprompt.js` | `loadSystemPrompts`, `system_prompts` |
| 指令模板 | `public/scripts/instruct-mode.js` | `instruct_presets`, `names_behavior_types` |
| Prompt 转换 | `src/prompt-converters.js` | `PROMPT_PROCESSING_TYPE`, `convertClaudeMessages`, `postProcessPrompt` |
| 角色卡解析 | `src/character-card-parser.js` | `read`, `write`, `parse` |
| 条目化审计 | `public/scripts/itemized-prompts.js` | `itemizedPrompts`, `itemizedParams` |
| 作者注释 | `public/scripts/authors-note.js` | `metadata_keys`, `shouldWIAddPrompt` |
| 服务端入口 | `src/server-main.js` | Express 应用组装、中间件链 |
| 端点路由 | `src/endpoints/` | `characters.js`, `chats.js`, `worldinfo.js`, `openai.js` |

---

## 8. 简要行动声明

### 已完成
- 仓库结构梳理（`src/` 后端 + `public/` 前端）
- 核心模块边界识别（PromptManager、WorldInfo、TokenHandler、MessageCollection）
- 角色卡/世界书/Prompt 分层模型抽象
- 6 大可复用架构模式提取
- 排除清单与改造建议

### 建议后续行动
1. **源码精读**：对 `TokenHandler` 的精确预算截断算法、`WorldInfoBuffer` 的递归扫描实现进行逐行追踪。
2. **模式迁移**：将 **Prompt 分层模型** 与 **World Info 触发引擎** 作为独立模块抽象，提取到项目架构知识库。
3. **现代化改造**：若需基于此架构构建新项目，优先复用 PNG 元数据容器模式与分层预算管理，排除 jQuery 与文件系统数据层。
