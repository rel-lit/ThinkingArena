# ThinkingArena 设计与架构 Overview

> **文档定位**：本文档是 ThinkingArena 项目的权威设计与架构参考，整合所有 Investigation 调研成果、领域模型、架构决策与技术选型，目标是让后续开发者**无需再查阅 Investigation 原文**即可理解全部设计依据与实现细节。
> 
> **文档纪律**：概念只定义一次；事实性结论保留来源链接；选型结论保留一句理由；被否决方案只留结论与一句理由。
> 
> **版本**：v1.0 | **日期**：2026-07-24

---

## 目录

1. [项目概述与愿景](#1-项目概述与愿景)
2. [设计思想](#2-设计思想)
3. [领域模型](#3-领域模型)
4. [总体架构](#4-总体架构)
5. [关键机制详解](#5-关键机制详解)
6. [技术选型与依据](#6-技术选型与依据)
7. [实现细节](#7-实现细节)
8. [下游链路与产出管线](#8-下游链路与产出管线)
9. [知识嫁接来源总结](#9-知识嫁接来源总结)

---

## 1. 项目概述与愿景

### 1.1 目标简述

ThinkingArena 是一个支持多服务商 LLM 参与的跑团游戏/思维实验模拟器。核心能力包括：

- **多 LLM 模拟推演**：不同服务商的 LLM 扮演角色，在配置化流程图中自主推演
- **导演干预**：用户在局中以注入方式引导戏剧走向，在局间以调整配置方式迭代
- **事件驱动演绎**：推演全程以事件落盘，事件流向下游加工为复盘分析与视频素材
- **外部服务扩展**：接入音频（TTS）、视频素材、图片素材的功能扩展
- **视频产出**：整理全局模拟的戏剧化和预期化内容，进行视频文案、素材调用，结合人工剪辑产出视频发布 B 站

### 1.2 指导思想理论

| # | 思想 | 阐述 |
|---|------|------|
| 1 | **唯一开发者即唯一使用者** | 完全理解把控项目，而非纯粹 Vibe Coding。架构决策必须可被单个人类完全理解。 |
| 2 | **嫁接优于从零开始** | 由于 Agent 协作 Coding 的不可控性和开发者水平限制，采用现有框架、复制现成代码、嫁接成熟项目比从零开始更好。 |
| 3 | **参考已有设计** | 新建或修改或提出任何一个功能时，都需要去详细参考业界已有设计和成熟项目，评判价值，而不是反复造轮子。 |

---

## 2. 设计思想

### 2.1 核心设计哲学：薄核心 + 事件即全部 + 分层接缝

**思想**：复杂度只许长在游戏规则里，不许长在框架里。一个唯一开发者必须能在几小时内通读核心代码。

**选择**：采用"薄核心 + 外围工具域"的总体形态，核心自研范围收敛为 M1 模拟核心 + M4 素材服务薄封装 + 各契约校验器。

**内容**：
- 核心目标几千行内，运行时依赖仅 `ai`（Vercel AI SDK 及 providers）+ `zod` + `yaml`
- 外围域（复盘、视频、发布）直接嫁接成熟 Agent 工具，核心仓只出契约与校验器
- 复杂度通过四层模型（服务/元组件/组件/编排）分层控制，每层职责单一

### 2.2 知识级嫁接 vs 代码级嫁接

**思想**：Vision 指导思想要求"嫁接成熟项目优于从零开始"，本架构在两个层级上执行它。

**选择**：
1. **知识级嫁接（核心）**：不 fork、不复制任何代码（含片段），但每个关键机制都移植自已验证的实现。
2. **代码级嫁接（外围）**：复盘、视频、发布等下游环节成熟工具充分，直接嫁接。

**内容**：
- **第一参考书 pi**（53k+ stars）：提供单 Agent 域的服务层/元组件层/干预机制的成熟设计——AgentTool 契约、JSONL 树持久化、两段式接缝、Turn 快照+安全点、Steering/Follow-up 双队列
- **第二参考书 Masquerade**：提供游戏引擎与 Script 记录的已验证设计——Engine/Orchestrator/Script 三层分离、TCAS 并发模式、三级信息分离
- **半份参考书 n8n**：提供编排引擎语义——节点两元结构、执行上下文注入、显式 Join 等待表、端口命名与类型化
- **专项参照 SillyTavern**：提供身份牌系统与 Prompt 工程的最成熟参照——Tavern v2 角色卡、World Info 世界书、Prompt Manager 分层组装
- **专项参照 ChatRPG v2**（ACM CUI 2025 论文）：提供 Narrator + Archivist 裁判范式的学术验证——双 Agent 分工、结构化状态权威、ReAct 工具链标准化

### 2.3 事件即真相

**思想**：不存在第二套事实存储。一切状态变化落盘为事件，可重放、可归因、可分叉。

**选择**：所有模拟过程、导演干预、骰点、服务调用、缓存失效、成本，全部经发射元组件写入 Script（JSONL 追加式）。

**内容**：
- 状态由事件重建：`state = reduce(state, event)` 纯函数
- 崩溃恢复 = 重放 JSONL
- 分支条件在遍历瞬间求值，读到的黑板值快照作为事件落盘——重放时分支走向来自记录而非重新求值（重放确定性的刚需）
- 事件树的 parent_id 结构支持从任意节点分叉重开——导演局间迭代工作流的机制基础
- 服务层的记忆/上下文持久化是业务数据，事件流是事实记录，职责不重叠

### 2.4 显式优于自动

**思想**：系统的职责是让一切可配置、一切可归因，而不是把导演建模进循环。

**选择**：
- Agent 不显式销毁不关闭
- 导演干预不显式放置不生效
- 配置在外、逻辑在内

**内容**：
- 导演门必须显式放置在流程图中，绝无全局自动生效
- 导演是循环外的人，不是系统内的角色
- 新游戏规则 = 一张图 + 一组组件，不写新引擎

### 2.5 没有银弹

**思想**：不一切皆组件。跨流程、有独立生命周期的元素独立成服务，不套用组件范式。

**选择**：
- 记忆、上下文、LLM 接入独立成服务层
- 组件层只处理游戏逻辑的最小单元

**内容**：
- 服务层：Agent 服务、记忆系统、黑板、事件流、LLM 网关——独立实现、独立持久化，不参与编排
- 元组件层：服务层的唯一调用面，构成 AI 生成组件时的标准 API 面
- 组件层：内部逻辑代码硬编码，以元组件为唯一能力来源
- 编排层：游戏流程的配置化表达，流程图 = 组件节点 + 控制边

---

## 3. 领域模型

### 3.1 系统是什么

一个配置驱动的多 LLM 模拟推演器：若干 LLM 扮演角色，在一张配置化流程图中自主推演；导演（用户）在局中以注入方式引导戏剧走向，在局间以调整配置方式迭代；推演全程以事件落盘，事件流向下游加工为复盘分析与视频素材。

### 3.2 存在物：四层

```
┌─────────────────────────────────────────────────────────────┐
│  编排层（Orchestrator）                                       │
│  流程图 = 组件节点 + 控制边（顺序/条件/并行/回边即循环）         │
│  新游戏规则 = 一张图 + 一组组件，不写新引擎                      │
├─────────────────────────────────────────────────────────────┤
│  组件层（Components）                                         │
│  游戏逻辑的最小单元：角色创建/销毁、叙事、判定、骰子、导演门      │
│  description + run 两元结构；version 字段从第一天存在            │
├─────────────────────────────────────────────────────────────┤
│  元组件层（Meta Components）                                  │
│  服务层的唯一调用面：调用 Agent-X、注入上下文、读写黑板、发射事件  │
│  AgentTool 式契约：参数 schema 校验前置、before/after 钩子      │
├─────────────────────────────────────────────────────────────┤
│  服务层（Services）                                           │
│  长期子系统：Agent 服务、记忆系统、黑板、事件流、LLM 网关        │
│  独立实现、独立持久化，不参与编排                               │
└─────────────────────────────────────────────────────────────┘
```

#### 3.2.1 服务层（Services）

**思想**：跨流程、有独立生命周期的元素独立成服务，不套用组件范式。

**选择**：五个核心服务，各自独立实现、独立持久化。

**内容**：

| 服务 | 职责 | 关键约束 |
|------|------|---------|
| **Agent 服务** | LLM 调用 + 身份牌渲染 + 私有上下文管理 | 实例显式创建、显式销毁；不销毁则跨局存续，记忆长期积累 |
| **记忆系统** | 滚动摘要 + 长期记忆压缩 | 长记忆压缩为稳定摘要段保持在静态区（L5），压缩检查点自包含 |
| **黑板** | 跨组件数据面 | 键值存储 + 事件发布/订阅 + 快照（用于分支条件求值） |
| **事件流** | Script JSONL 追加式持久化 | 树结构（id + parent_id），支持分支、恢复、压缩 |
| **LLM 网关** | 多服务商接入 + 缓存 + 成本台账 | AI SDK + 薄路由 + 价格表 + 缓存断点 |

**核心原则**：**落盘全集 ⊃ 进模型上下文投影**。存储是全量，注入 LLM 的上下文是显式投影（pi 两段式接缝）。

#### 3.2.2 元组件层（Meta Components）

**思想**：服务实现全局唯一、行为统一可审计；同时构成 AI 生成组件时的标准 API 面。

**选择**：AgentTool 式契约，参数 schema 校验前置。

**内容**：

```typescript
interface MetaComponent {
  name: string;
  version: string;                    // 从第一天存在，Bundle 锁定版本
  description: string;
  parameters: ZodSchema;              // Zod 替代 TypeBox

  beforeCall?: (args, context) => Promise<void | BlockReason>;
  afterCall?: (args, result, context) => Promise<Result>;

  run: (args, context) => Promise<Result>;
}
```

关键约束：
1. 参数 schema 校验前置：工具执行前必须过 schema 校验，失败不执行
2. before 钩子可拦截：可在执行前阻断工具调用
3. after 钩子可改写结果：可在执行后修改/过滤结果
4. 错误编码进结果，不抛异常：工具错误是正常返回值的一部分，不破坏循环
5. `stop_reason=="length"` 整批拒执行：截断时拒绝整批工具调用，防止部分执行导致状态不一致

#### 3.2.3 组件层（Components）

**思想**：游戏逻辑的最小单元，内部逻辑代码硬编码，以元组件为唯一能力来源。

**选择**：内置组件 + 预期主要由 AI Agent 生成。

**内容**：

| 组件 | 职责 |
|------|------|
| **角色创建/销毁** | 显式创建/销毁 Agent 实例 |
| **叙事** | 驱动 LLM 生成叙事文本 |
| **判定** | 骰子 + Referee LLM 叙事裁决 |
| **骰子** | 带种子 RNG，种子进 Bundle；表达式参考海豹骰 |
| **导演门** | 到达即等待导演输入，分支级阻塞 |

**导演门详解**：
- 形态：显式放置在流程图中的门组件
- 到达即等待导演输入；**依赖该输入的分支阻塞，其余分支照常推进**（分支级阻塞，非执行级挂起）
- 等待点可取消（一局可随时终止）
- 两档干预（pi steering/follow-up 参照）：
  - **steering**：打断当前方向立即转向（组件批完成后、下一次 LLM 调用前注入）
  - **follow-up**：排队至自然停止点续作
- 生效语义：干预只在循环安全点生效——运行中的 LLM 请求/组件执行绝不突变
- 注入类型：
  - **whisper**：私有催眠，写目标 Agent 私有上下文，prompt L8 位近尾部注入，绝不进静态前缀，带显著性标签，注入文本 hash 落 Script
  - **inject**：公开环境事件
  - **edit_world**：改世界设定，记 `cache_invalidation`
  - **note**：仅批注 Script，随时可发

#### 3.2.4 编排层（Orchestrator）

**思想**：新游戏规则 = 一张图 + 一组组件，不写新引擎。

**选择**：自研配置化 DAG 执行器，无框架。

**内容**：
- 流程图 = 组件节点 + 控制边（顺序 / 条件 / 并行 / 回边即循环）
- 条件是对黑板接口数据的声明式求值（声明式比较算子 DSL，非可执行表达式）
- 边以节点 id 为键、端口用名字不用魔法下标
- join 显式声明等待哪些输入口
- 回边即循环，无循环原语
- 分支语义 = 往哪个输出端口放数据，引擎不理解 if

### 3.3 运转：两个循环、一条工作流、一条管线

#### 3.3.1 系统内：两个嵌套循环

```
决策循环（组件内部）
└── Agent 的多步感知、思考、交互
    └── 游戏循环（编排层）
        └── 一张流程图的完整执行
```

- **决策循环**（组件内部）：Agent 的多步感知、思考、交互
- **游戏循环**（编排层）：一张流程图的完整执行。回合、阶段、幕都只是图的形状；多 Agent 并发 = 并行分支
- 裁判与参与者同构——裁判也是 Agent 服务实例 + 组件组合，只是身份牌与所用元组件不同

#### 3.3.2 系统外：两条人的链路

```
导演工作流（迭代节奏）
├── 开局（Bundle）
├── 观察并在导演门干预
├── 复盘
└── 调整 Bundle 再开
        ↓
产出管线（下游加工）
├── 事件流
├── 复盘/高光提炼
├── 文案分镜
├── 素材合成
└── 剪辑发布
```

- **导演工作流**（迭代节奏）：导演是循环外的人，不是系统内的角色；系统的职责是让一切可配置、一切可归因
- **产出管线**（下游加工）：加工者是任务处理 Agent，与局内模拟 Agent 不同类型，优先接入成熟 Agent 工具完成

### 3.4 一局的生命周期

```
Bundle 加载（流程图 + 身份牌 + LLM 绑定 + 世界书 + 种子）
    ↓
角色创建组件显式创建 Agent 实例
    ↓
流程图执行，事件全量落盘，导演门可介入
    ↓
局结束
    ↓
未销毁的 Agent 可携带记忆进入下一局
```

### 3.5 设计原则总结

| # | 原则 | 含义 |
|---|------|------|
| 1 | **没有银弹** | 不一切皆组件。跨流程、有独立生命周期的元素独立成服务 |
| 2 | **显式优于自动** | Agent 不显式销毁不关闭；导演干预不显式放置不生效；配置在外、逻辑在内 |
| 3 | **事件即事实** | 一切状态变化落盘为事件，可重放、可归因、可分叉 |
| 4 | **规模纪律** | 核心几千行内，唯一开发者通读无障碍；复杂度只许长在游戏规则里 |
| 5 | **新元素先定位** | 任何新模块、新选型必须能定位到某一层的某一环；定位不了的，不做 |

---

## 4. 总体架构

### 4.1 总体形态：薄核心 + 外围工具域，契约衔接

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

**核心原则：模块之间不共享代码、不共享内存，只共享契约。**

衔接层 = 文件系统约定（Bundle / Script / 分镜 JSON 的目录规范）+ Zod 校验器 + 少量 CLI 入口。不引入消息队列、RPC 框架等重设施。

### 4.2 M1 模拟核心（自研）

**思想**：单仓库、单进程，按四层分目录。各层实现细节唯一定义于此。

**选择**：自研四层架构，规模纪律几千行内。

**内容**：

| 目录 | 层 | 职责与关键约束 |
|------|---|--------------|
| `schema/` | 契约 | 四份契约的 Zod 定义 + JSON Schema 导出，版本化，破坏性变更升版本并登记 CHANGELOG |
| `services/` | 服务层 | agent、memory、blackboard、event-log、llm-gateway。**落盘全集 ⊃ 进模型上下文投影** |
| `meta/` | 元组件层 | 服务调用面，AgentTool 式契约：参数 schema 校验前置、before/after 钩子、错误编码进结果、`stop_reason=="length"` 整批拒执行 |
| `components/` | 组件层 | 内置组件：角色创建/销毁、叙事、判定、骰子、导演门等。**description + run 两元结构**；`version` 字段从第一天存在，Bundle 锁定版本 |
| `orchestrator/` | 编排层 | 流程图加载校验、DAG 执行器 |
| `cli/` | 入口 | run / replay / dev 冒烟 |

### 4.3 契约与 Bundle

**思想**：四份契约，Zod 定义、版本化、可导出 JSON Schema。模块之间只共享版本化 Schema。

**选择**：定义四份核心契约 + Scenario Bundle 目录规范。

**内容**：

| 契约 | 内容 |
|------|------|
| **事件契约** | Script JSONL，树结构 `{ type, id, parent_id, timestamp, branch, payload }`；类型含发言/独白/骰点/导演干预/服务调用/缓存失效/成本（含原始 usage） |
| **流程图配置** | 组件节点 + 控制边；条件是边的属性（声明式比较算子 DSL）；边以节点 id 为键、端口用名字不用魔法下标；join 显式声明等待哪些输入口 |
| **元组件接口** | 统一调用面签名 + 事件发射校验入口；按可对外暴露形态设计，加 Adapter 即成 MCP |
| **identity_card_v1** | 身份牌 Schema；校验器拒绝卡内出现模型字段（身份与 LLM 解耦的机械保证） |

**Scenario Bundle** = 一局的全部输入（目录，进 git）：
- 流程图配置（YAML）
- 游戏 YAML（规则参数 / LLM 绑定）
- `identity_cards/` 目录
- 世界书
- 种子事件

---

## 5. 关键机制详解

### 5.1 事件即真相

#### 思想

不存在第二套事实存储。模拟过程、导演干预、骰点、服务调用、缓存失效、成本，全部经发射元组件写入 Script。状态由事件重建，崩溃恢复 = 重放 JSONL。

#### 选择

- 所有状态变化经发射元组件写入 Script（JSONL 追加式）
- 分支条件在遍历瞬间求值，读到的黑板值快照作为事件落盘
- 事件树的 parent_id 结构支持从任意节点分叉重开

#### 内容

**事件结构**：
```typescript
interface Event {
  type: string;           // 事件类型
  id: string;             // 唯一标识
  parent_id: string | null; // 父事件 ID，支持树结构
  timestamp: number;      // 时间戳
  branch: string;         // 分支标识
  payload: any;           // 载荷
  source?: string;        // 来源 Agent ID
  target?: string;        // 目标 Agent ID（null = 广播）
}
```

**事件类型**：
| 类型 | 说明 |
|------|------|
| `speech` | 角色发言 |
| `monologue` | 内心独白 |
| `dice` | 骰点结果 |
| `director_intervention` | 导演干预 |
| `service_call` | 服务调用（TTS/生图/视频） |
| `cache_invalidation` | 缓存失效 |
| `cost` | 成本记录（含原始 usage） |
| `agent_to_agent` | Agent 间通信 |

**状态重建**：
```typescript
const state = events.reduce((s, e) => reduce(s, e), initialState);
```

**关键纪律**：
- 分支条件在遍历瞬间求值，快照落盘保证重放确定性
- 重放时分支走向来自记录而非重新求值
- 服务层的记忆/上下文持久化是业务数据，事件流是事实记录，职责不重叠

### 5.2 导演门

#### 思想

导演是循环外的人，不是系统内的角色。系统的职责是让一切可配置、一切可归因，而不是把导演建模进循环。导演干预必须显式放置，绝无全局自动生效。

#### 选择

- 形态：显式放置在流程图中的门组件
- 两档干预：steering（打断转向）/ follow-up（排队续作）
- 四种注入类型：whisper / inject / edit_world / note
- 输入通道：`director_inbox.jsonl`（MVP）/ stdin / 后续 WebSocket

#### 内容

**导演门语义**：
```typescript
interface DirectorGate {
  type: "director_gate";
  waitingBranches: string[];    // 等待导演输入的分支 ID
  intervention: "steering" | "follow-up";
  injectType: "whisper" | "inject" | "edit_world" | "note" | "agent_broadcast";
  targetAgents: string[];
}
```

**干预生效语义**：
- 干预只在循环安全点生效——运行中的 LLM 请求/组件执行绝不突变
- 注入内容进入下一安全点的新上下文快照
- 待写事件按确定顺序落盘

**注入类型详解**：

| 类型 | 目标 | 位置 | 可见性 | 用途 |
|------|------|------|--------|------|
| **whisper** | 指定 Agent 私有上下文 | prompt L8 位近尾部注入，绝不进静态前缀 | 仅目标 Agent | 私有催眠，让 LLM 以为那是自己的想法 |
| **inject** | 公开环境 | 黑板/公共记忆 | 所有 Agent | 公开环境事件 |
| **edit_world** | 世界设定 | 世界书 | 所有 Agent | 改世界设定，记 `cache_invalidation` |
| **note** | Script 批注 | Script JSONL | 导演可见 | 仅批注，随时可发 |
| **agent_broadcast** | 多个 Agent | 各 Agent 私有上下文 | 指定 Agents | 导演向多个 Agent 同时广播指令 |

**安全点边界**：
```
├─ turn_start
├─ message_start → message_update* → message_end
├─ tool_execution_start → tool_execution_update* → tool_execution_end
├─ turn_end          ← 安全点：steering 检查
└─ agent_end         ← 安全点：follow-up 检查
```

**所有导演干预都是一等事件**——"导演如何操纵故事"本身就是视频素材。

### 5.3 Prompt 分层与缓存（成本硬约束）

#### 思想

成本是硬约束。缓存是成本优化的核心手段。静态前缀逐字稳定是缓存命中的前提。

#### 选择

- L0–L9 prompt 分层，权威定义见 design/identity-card.md
- 自研 identity_card_v1（与 LLM 配置零耦合）
- 兼容 Tavern v2 卡导入
- 成本双轨台账

#### 内容

**L0–L9 Prompt 分层**：

| 层级 | 内容 | 稳定性 | 缓存策略 |
|------|------|--------|---------|
| **L0** | 模型 API 参数（temperature, top_p 等） | 稳定 | 不涉及 |
| **L1** | 系统级预设（System Preset） | 稳定 | 静态前缀 |
| **L2** | 身份牌核心（Description / Personality / Scenario） | 每 Agent 稳定 | 静态前缀 |
| **L3** | 世界书全局条目 | 全局稳定 | 静态前缀 |
| **L4** | 示例对话（Mes Examples） | 每 Agent 稳定 | 静态前缀 |
| **L5** | 滚动记忆摘要 | 压缩检查点自包含 | 静态前缀（摘要段） |
| **L6** | 情境示例（Few-shot） | 动态 | 动态注入 |
| **L7** | 工具示例 | 随工具版本变化 | 动态注入 |
| **L8** | Whisper 注入（导演干预） | 高度动态 | 近尾部注入，带显著性标签 |
| **L9** | 当前回合上下文（对话历史） | 每回合变化 | 动态 |

**缓存断点规划**：
1. L0–L3 静态前缀**逐字稳定**：共享层在前、身份层在后，同服务商跨 Agent 复用前缀缓存
2. 渲染器为纯函数（字段顺序固定、无时间戳/UUID/回合计数、YAML 序列化器固定），输出 SHA256 逐回合落 Script 验证逐字稳定
3. 改写静态前缀记 `cache_invalidation` 事件
4. 长记忆压缩为稳定摘要段保持在静态区（L5），压缩检查点自包含，重建上下文不必回放全量历史

**服务商原生缓存**：
- DeepSeek/Kimi/OpenAI：自动缓存零代码收益（命中价 ≈2%~17%）
- Anthropic：显式断点（AI SDK `providerOptions.anthropic.cacheControl`）；每请求限 4 断点
- 豆包：短局只用隐式缓存

**成本双轨台账**：
- 自维护 YAML 价格表计算值 + 原始 usage（prompt/completion/cached tokens）重算值同时落 Script
- 互相对账
- fallback 只做同能力等级降级，自研薄路由执行（按模型名路由 + 指数退避 + 熔断计数）
- LLM 绑定声明自带验收测试（可用性冒烟，类比 n8n 凭证的 test 声明）

### 5.4 结构化判定（跨服务商交集契约）

#### 思想

裁判是组件组合，不是特殊架构。判定 = 骰子（带种子 RNG）+ Referee LLM 叙事。结构化状态为唯一权威防吃书。

#### 选择

- 裁判是组件组合（规则 / 骰子 / 状态权威 / 叙事），经流程图编排进游戏
- 判定输出首选 `response_format` json_schema
- 工具调用仅作备选且遵守交集

#### 内容

**判定流程**：
```
玩家输入/Agent 行动
    ↓
骰子组件（mulberry32 RNG，种子进 Bundle）
    ↓
Referee LLM 叙事裁决
    ↓
结构化状态更新（Archivist 模式）
    ↓
骰点入 Script
```

**骰子表达式**：参考海豹骰（SealDice），表达式解析自研（约 100 行递归下降，属领域逻辑）
**RNG**：手写 mulberry32（约 20 行，Node 无可播种内置随机源）

**判定输出降级路径**：
1. 首选：`response_format` json_schema（OpenAI/Anthropic 原生支持）
2. 降级：json_object + Zod 校验 + 失败重试（记 `judge_retry`）
3. 备选：工具调用（仅作备选且遵守交集）

**工具调用交集约束**：
- 单工具
- `tool_choice` 只用字符串值
- 禁并行工具调用与 `parallel_tool_calls`
- `finish_reason=="length"` 先检查再解析（截断整批拒执行并告知重发）

**新服务商接入验收清单**（dev 工具）：
- cost 非零
- cached_tokens 正确返回
- 工具调用往返正常
- json_object 输出正常
- 一次调用跑完，不过不进 Bundle

### 5.5 DAG 执行器

#### 思想

回合拓扑静态、导演注入在节点边界、可复现性由事件重放承担——编排框架的核心价值区（动态图、任意点 interrupt、checkpoint 持久化）全部用不上，反而引入双真相源。

#### 选择

自研配置化执行器，无框架。执行语义参照 n8n，实现自研，规模数百行。

#### 内容

**核心形态**：
```typescript
class FlowRunner {
  async run(bundle: ScenarioBundle): Promise<void> {
    const services = initServices(bundle);        // 黑板/记忆/上下文/提示词
    const state    = replayOrInit(script);         // 重放 JSONL 即恢复
    const graph    = parse(bundle.flowConfig);     // 组件节点 + 条件边 + 回边

    while (!graph.finished(state)) {
      for (const node of graph.readyNodes(state)) {       // 动态就绪：执行栈 + join 等待表
        if (node.isDirectorGate) {
          node.input = await directorInbox;   // 分支级门控，可取消
        }

        const events = node.component.run(metaComponents, blackboard);
        for (const e of events) {
          emit(e);                              // 发射元组件，schema 校验
          state = reduce(state, e);
        }
      }
    }
  }
}
```

**动态就绪调度**：
- 执行栈 + join 等待表，无需静态拓扑排序
- 回边即循环，无循环原语
- 分支语义 = 往哪个输出端口放数据，引擎不理解 if（条件是边的属性，遍历瞬间求值）

**多 Agent 并发**：
- 并行分支 + `Promise.all`
- 导演门等待用 `AbortController` 保证可取消

**重跑判定**（n8n 参照）：
- 参数变/图变 → 下游 stale
- 循环内任意节点 stale → 循环首节点 stale

**TCAS 并发模式**（Masquerade 参照）：
```
[快照上下文] -> [并发思考 LLM 调用] -> [串行应用状态变更]
```
- 思考前快照所有上下文（公平性）
- LLM 调用完全并发（效率）
- 状态变更严格串行（正确性）

---

## 6. 技术选型与依据

### 6.1 设计参考书：两份半

| 参考书 | 定位 | 吸收点 | 排除点 |
|--------|------|--------|--------|
| **pi**（53k+ stars, TS, MIT） | 第一参考书——服务层/元组件层/干预机制 | ①AgentTool 契约 ②JSONL 树 ③两段式接缝 ④Turn 快照+安全点 ⑤Steering/Follow-up | 明确不做 Multi-Agent；pi-ai 调用层与 AI SDK 职责重复 |
| **Masquerade**（~98 文件, Python+TS, Apache 2.0） | 第二参考书——游戏引擎与 Script 记录 | Engine/Orchestrator/Script 三层分离、TCAS 并发、三级信息分离、EventBus | 0 star 未经社区验证；LangGraph 依赖；无导演干预；无成本追踪 |
| **n8n**（400+ 节点, TS, fair-code） | 半份参考书——编排引擎语义 | 节点两元结构、执行上下文注入、显式 Join 等待表、端口命名、节点执行快照、凭证 test 声明 | Items/PairedItem 数据血缘、可执行表达式引擎、执行级挂起恢复、Queue Mode、UI 耦合参数系统 |

**专项参照**：
- **SillyTavern**：身份牌/世界书/Prompt 分层（L0–L9 直接继承此设计域的成熟实践）
- **ChatRPG v2**（arXiv:2502.19519, ACM CUI 2025）：Narrator + Archivist 裁判范式（PXI 评估数据显示双 Agent 在所有维度显著优于单 Agent，p < 0.05）

### 6.2 语言与运行时

**思想**：唯一开发者 C# 母语，TS 为最短迁移路径；Agent 工具层新项目密度向 TS 倾斜。

**选择**：TypeScript（Node LTS）

**内容**：
- 同设计师、类型系统与 async/await 神似 C#
- pi、n8n、AI SDK 均 TS；与下游 Remotion 同栈
- 运行时依赖收敛为三个：`ai` + `zod` + `yaml`

### 6.3 LLM 接入：Vercel AI SDK + 自研薄路由

**思想**：Provider 是实现细节，不是用户 API。统一接口消除透传路由类 bug。

**选择**：Vercel AI SDK（`ai` + providers）+ 自研薄路由 + 自维护 YAML 价格表

**内容**：

**候选审查**（实测排除）：
- litellmts-core：不存在
- Amux：太早期（周下载 12、仅 3 家适配器）
- NeuroLink：无 Moonshot/豆包且 50 依赖的重平台
- multi-llm-ts：无 Moonshot/豆包
- OpenRouter：无国内豆包端点且为托管形态
- Portkey：无火山方舟且 2.0 改版动荡中
- LiteLLM：Python 生态、TS 侧无等效移植
- pi-ai：缓存/成本开箱最强但 TypeBox 与 Zod 纪律摩擦、结构化输出路径不明——**列为第一退路**

**选定 Vercel AI SDK**（18.3M 周下载、Apache-2.0、3 依赖）：
- 五家服务商全覆盖且**全部直连**——透传路由类 bug（缓存计费归一化错误）整类消失
- 缓存：Anthropic 消息级 `providerOptions.anthropic.cacheControl` 显式断点；cache read/write tokens 入标准 usage；DeepSeek/Kimi 原始字段经 metadataExtractor 抓原始响应体
- 结构化输出：`generateObject` 原生吃 Zod schema，与项目 schema 纪律零摩擦；降级路径（json_object + Zod 校验重试）原样保留
- 无内置 Router/价格表 → **自研薄路由**（按模型名路由 + 同能力级 fallback 链 + 指数退避 + 熔断，约百行）+ **自维护 YAML 价格表**

**服务商侧怪癖**（与接入层无关，必须遵守的交集）：
- 工具调用取交集：单工具、`tool_choice` 只用字符串值、禁并行工具调用
- DeepSeek 对象形式报 500、Kimi 不支持 required
- 裁判判定首选 json_schema，DeepSeek/Kimi/豆包降级 json_object + Zod 校验重试
- 成本双轨：自维护价格表计算值 + 原始 usage 重算值同时落 Script

### 6.4 编排：自研配置化 DAG 执行器

**思想**：编排框架的核心价值区（动态图、任意点 interrupt、checkpoint 持久化）全部用不上，反而引入双真相源。12-Factor Agents 的 Own your control flow。

**选择**：自研配置化 DAG 执行器，不引入框架。

**内容**：
- 图库（graphlib 等）只提供静态拓扑排序——不满足动态就绪需求
- Temporal/Inngest 类持久化引擎要引入重基础设施——与本模型不符
- 执行语义参照 n8n，实现自研，规模数百行

### 6.5 身份与 Prompt：身份牌层

**思想**：SillyTavern 体系是该问题域最成熟参照。业界缓存实践一致：静态内容置前、动态置尾、边界打断点。

**选择**：自研 identity_card_v1 + L0–L9 prompt 分层 + Tavern v2 卡导入兼容。

**内容**：
- **SillyTavern** 的 Prompt 分层模型（Layer 1-7）和 World Info 触发引擎是该问题域最成熟的参照
- 业界缓存实践一致：静态内容置前、动态置尾、边界打断点；防 footgun（工具序漂移、时间戳/UUID 泄漏进前缀）
- identity_card_v1 与 LLM 配置零耦合，校验器拒绝卡内出现模型字段

### 6.6 裁判范式：Narrator + Archivist

**思想**：ChatRPG v2 验证的双 Agent 分工：叙事与状态归档分离，结构化状态为唯一权威防吃书。

**选择**：裁判与参与者同构——裁判也是 Agent 服务实例 + 组件组合，只是身份牌与所用元组件不同。

**内容**：
- **Narrator（叙事裁判）**：负责裁决叙事结果，通过工具调用请求状态变更
- **Archivist（状态裁判）**：负责裁决状态变更的合法性，执行实际的状态更新
- 两者都是同构的 LLM Agent，差异仅在于：身份牌、工具集、输入源
- ChatRPG v2 PXI 评估：双 Agent 在所有维度显著优于单 Agent（p < 0.05）

### 6.7 工程栈明细

| 模块 | 选型 | 一句理由 |
|------|------|---------|
| Schema | **Zod 4** | 原生 `z.toJSONSchema()`；对外契约 schema 禁用 transform/refine（保证导出无损），自定义校验放运行时守卫 |
| 持久化 | **node:sqlite**（Node 内置，封约 50 行 Store 接口） | 零依赖零原生编译；实验状态可接受，换 better-sqlite3 成本低；事件流 JSONL 纯 `fs` 追加无依赖 |
| YAML | **yaml**（eemeli） | 唯一注释往返保留，利于 Agent 改写 Bundle 配置 |
| CLI | **node:util parseArgs** | 两三个命令不配拥有框架 |
| 日志 | **手写 JSONL logger**（约 40 行） | 与"一切皆事件"同构，schema 可进 Zod 契约 |
| 测试 | **node:test**（Node 24 直接跑 TS） | 契约/组件测试零依赖 |
| 并发/取消 | **原生 Promise + AbortController + 手写信号量** | AbortSignal.timeout 内置；p-limit 是唯一值得破例的微库但手写才 25 行 |
| TTS | **edge-tts-universal**（TS 原生，活跃） | 仓库保持纯 TS；Python edge-tts 子进程为备选 |
| 视频 | **Remotion**（独立子项目 `video/`） | React 框架程序化视频，Agent 工具搭建维护 |

### 6.8 最终选型一览

| 层 | 选型 |
|---|------|
| 架构 | 薄核心 + 契约衔接；模块间只共享版本化 Schema |
| 技术栈 | TypeScript（Node LTS）；运行时依赖仅 ai(providers) + zod + yaml |
| 模拟核心 | 自研四层（服务/元组件/组件/编排），规模纪律几千行 |
| 多 LLM | Vercel AI SDK + 自研薄路由 + 自维护价格表（pi-ai 为第一退路） |
| 身份牌 | 自研 identity_card_v1，与 LLM 配置零耦合，兼容 Tavern v2 导入 |
| 导演干预 | 导演门组件（分支级输入门 + steering/follow-up 两档 + whisper 深度注入） |
| 持久化 | 事件流 JSONL（fs）+ node:sqlite（Store 接口） |
| 语音 | edge-tts-universal 起步，IndexTTS2 备选 |
| 视频 | Remotion 独立子项目，Agent 工具搭建维护 |
| 回放 | 后期按需，Agent 工具按契约实现 |
| 配置 | YAML + Zod，LLM 配置与身份牌分离 |

---

## 7. 实现细节

### 7.1 服务层实现

#### 7.1.1 Agent 服务

```typescript
class AgentService {
  private agents: Map<string, AgentInstance> = new Map();

  createAgent(id: string, identityCard: IdentityCard, modelBinding: ModelBinding): AgentInstance;
  destroyAgent(id: string): void;
  getAgent(id: string): AgentInstance;
  broadcast(event: AgentEvent): void;
  sendTo(targetId: string, event: AgentEvent): void;
}

class AgentInstance {
  private state: AgentState;
  private steeringQueue: AgentMessage[] = [];   // 高优先级，LIFO
  private followUpQueue: AgentMessage[] = [];   // 低优先级，FIFO
  private inbox: AgentMessage[] = [];           // 来自其他 Agent 的消息

  steer(message: AgentMessage): void;           // 中断当前任务，立即响应
  followUp(message: AgentMessage): void;        // 当前任务完成后处理
  receive(message: AgentMessage): void;         // 接收来自其他 Agent 的消息
  async runTurn(blackboard: Blackboard): Promise<Event[]>;
}
```

**关键设计**：
- 每个 Agent 实例保留 Pi 的完整语义（steering/followUp/abort）
- 新增 `inbox` 接收来自其他 Agent 的消息（通过黑板或事件总线）
- Agent 实例显式创建、显式销毁，不销毁则跨局存续

#### 7.1.2 黑板系统

```typescript
interface Blackboard {
  // 键值存储（跨 Agent 共享）
  get(key: string): any;
  set(key: string, value: any): void;

  // 事件发布（广播/定向）
  emit(event: BlackboardEvent): void;
  subscribe(filter: EventFilter, handler: EventHandler): void;

  // 快照（用于分支条件求值）
  snapshot(): BlackboardSnapshot;
}
```

**关键设计**：
- 黑板 = Pi 的 "context" 扩展为跨 Agent 共享
- 黑板事件 = Pi 的 "AgentEvent" 扩展为跨 Agent 路由
- 黑板快照 = Pi 的 "turn 快照" 扩展为全局快照

#### 7.1.3 事件流（Script JSONL）

```typescript
interface TreeEntry {
  id: string;
  parentId: string | null;
  type: string;
  timestamp: number;
  payload: any;
}

// 能力：分支、恢复、压缩、导航
// 崩溃恢复 = 重放 JSONL
// 分支 = 从任意 parentId 创建新分支
```

#### 7.1.4 LLM 网关

```typescript
// 自研薄路由
class LLMRouter {
  async route(modelName: string, request: LLMRequest): Promise<LLMResponse>;
  // 按模型名路由
  // 同能力级 fallback 链
  // 指数退避
  // 熔断计数
}

// 自维护 YAML 价格表
interface PriceTable {
  [modelId: string]: {
    inputPrice: number;      // per 1M tokens
    outputPrice: number;     // per 1M tokens
    cacheReadPrice?: number; // per 1M tokens
    cacheWritePrice?: number;// per 1M tokens
  };
}
```

### 7.2 元组件层实现

**统一调用面**：
```typescript
interface MetaComponent {
  name: string;
  version: string;
  description: string;
  parameters: ZodSchema;

  beforeCall?: (args, context) => Promise<void | BlockReason>;
  afterCall?: (args, result, context) => Promise<Result>;

  run: (args, context) => Promise<Result>;
}
```

**事件发射校验**：
```typescript
function emit(event: Event): void {
  // schema 校验前置
  const validated = EventSchema.parse(event);
  // 非法事件拒写
  if (!validated) throw new Error("Invalid event");
  // 追加写入 JSONL
  appendToScript(validated);
}
```

### 7.3 组件层实现

**两元结构**：
```typescript
interface Component {
  description: ComponentDescription;  // 名称/版本/参数 schema
  run: (args: any, context: ComponentContext) => Promise<Event[]>;  // 行为
}

interface ComponentDescription {
  name: string;
  version: string;  // 从第一天存在，Bundle 锁定版本
  parameters: ZodSchema;
  inputs: PortDefinition[];
  outputs: PortDefinition[];
}
```

### 7.4 编排层实现

**流程图配置**：
```yaml
# flow.yaml
nodes:
  - id: "start"
    type: "narrative"
    parameters:
      prompt: "开场叙事"

  - id: "director_gate_1"
    type: "director_gate"
    parameters:
      waitingBranches: ["branch_a"]

  - id: "battle"
    type: "battle"
    parameters:
      ruleSet: "standard"

edges:
  - from: "start"
    to: "director_gate_1"

  - from: "director_gate_1"
    to: "battle"
    condition:
      type: "eq"
      left: "director_input.type"
      right: "continue"
```

**DAG 执行器核心循环**：
```typescript
class FlowRunner {
  async run(bundle: ScenarioBundle): Promise<void> {
    const services = initServices(bundle);
    const state    = replayOrInit(script);
    const graph    = parse(bundle.flowConfig);

    while (!graph.finished(state)) {
      for (const node of graph.readyNodes(state)) {
        if (node.isDirectorGate) {
          node.input = await directorInbox;  // 分支级门控，可取消
        }

        // 多 Agent 并发 = 并行分支 + Promise.all
        if (node.isParallelBranch) {
          const results = await Promise.all(
            node.branches.map(b => b.component.run(metaComponents, blackboard))
          );
          // join 聚合
        } else {
          const events = node.component.run(metaComponents, blackboard);
        }

        for (const e of events) {
          emit(e);           // 发射元组件，schema 校验
          state = reduce(state, e);
        }
      }
    }
  }
}
```

### 7.5 身份牌系统（identity_card_v1）

**Schema 设计**：
```typescript
const IdentityCardV1 = z.object({
  name: z.string(),
  version: z.literal("1.0"),
  description: z.string(),           // 角色核心描述
  personality: z.string().optional(), // 性格特征
  scenario: z.string().optional(),    // 场景设定
  firstMes: z.string().optional(),    // 首条消息
  mesExample: z.string().optional(),  // 示例对话
  creatorNotes: z.string().optional(), // 创作者注释
  // 明确禁止出现模型字段
  // 校验器拒绝卡内出现 model / apiKey / baseUrl 等字段
});
```

**与 LLM 配置解耦**：
- 身份牌只定义"角色是谁"
- LLM 绑定在 Bundle 的游戏 YAML 中定义"用什么模型扮演这个角色"
- 同一身份牌可绑定不同模型（A/B 测试、成本优化）

### 7.6 契约版本化管理

**版本化规则**：
- 四份契约各自独立版本化
- 破坏性变更升主版本（v1 → v2），登记 CHANGELOG
- 非破坏性变更升次版本（v1.0 → v1.1）
- Bundle 锁定组件版本，确保可复现性

---

## 8. 下游链路与产出管线

### 8.1 M2 复盘与高光提炼（成熟 Agent 工具）

**思想**：此类加工者属任务处理 Agent，与模拟 Agent 不同类型。核心仓只保证 Script 可读性。

**选择**：一局结束后的 report.md、戏剧化片段清单、视频文案大纲，由 Kimi 桌面端等 Agent 直接读 Script 生成。

**内容**：
- 核心仓只保证 Script 可读性（schema 稳定 + 字段自解释）
- Agent 工具产出必须过 Schema 校验，不合格退回重生成
- 工具侧 prompt/技能文件进 git 版本管理

### 8.2 M3 视频制作域（成熟 Agent 工具）

**思想**：Remotion 工程为独立子项目，由 Agent 工具搭建与迭代。

**选择**：Remotion 独立子项目（`video/`），分镜 JSON + 素材清单 → 成片。

**内容**：
- 核心仓只定义分镜 JSON Schema（镜头、时长、字幕、配音轨、立绘引用）并提供渲染前校验器
- Remotion 2026 年推出 Agent Skills，支持 Claude Code/Codex/Cursor 自动生成 Remotion 代码
- B 站发布参照 MoneyPrinterPlus，走 Agent 工具操作

### 8.3 M4 素材服务（薄封装）

**思想**：统一抽象为"服务指令"，每次调用作为事件写入 Script。

**选择**：音频（edge-tts → IndexTTS2）、图片（SD/ComfyUI/生图 API）、视频片段（可灵/即梦/Vidu 类 API）。

**内容**：
```typescript
interface ServiceCall {
  type: "service_call";
  service: "tts" | "image" | "video";
  parameters: Record<string, any>;
  output: {
    filePath: string;
    manifest: MediaManifest;
  };
  cost: number;  // 素材生成成本
}
```

### 8.4 M5 回放可视化（后期，最低优先级）

**思想**：前期用 M2 文本复盘 + 事件流直接阅读代替。

**选择**：真需要时由 Agent 工具按契约独立实现。

**内容**：
- 前期：M2 文本复盘 + 事件流直接阅读
- 后期：Agent 工具按契约独立实现交互式回放

---

## 9. 知识嫁接来源总结

### 9.1 pi Agent（第一参考书）

| # | 机制 | 源码位置 | ThinkingArena 实现位置 |
|---|------|---------|----------------------|
| 1 | AgentTool 契约 | `packages/agent/src/types.ts` | `meta/` 元组件层 |
| 2 | JSONL 树持久化 | `packages/coding-agent/src/core/session-manager.ts` | `schema/` + `services/event-log` |
| 3 | 两段式接缝 | `packages/agent/src/agent.ts` (context 管线) | `services/` 存储与上下文注入 |
| 4 | Turn 快照 + 安全点 | `packages/agent/src/agent-loop.ts` | `components/director-gate` |
| 5 | Steering / Follow-up 双队列 | `packages/agent/src/agent.ts` | `components/director-gate` |

**关键判断**：Pi 明确不做 Multi-Agent，这恰恰说明多 Agent 的复杂性不能通过简单堆叠单 Agent 解决——ThinkingArena 的自研核心价值区正在于此。

### 9.2 Masquerade（第二参考书）

| # | 模式 | 来源 | ThinkingArena 映射 |
|---|------|------|-------------------|
| 1 | Engine 抽象基类 + 注册表装饰器 | `engine/base.py`, `engine/registry.py` | `components/` 组件注册 |
| 2 | TCAS 并发批处理 | `orchestrator/runner.py` | `orchestrator/` DAG 执行器并行分支 |
| 3 | Script 时间轴 + 记忆快照 | `script/schema.py` | `schema/` 事件契约 |
| 4 | 三级信息分离 | `engine/base.py` | `services/agent` 上下文投影 |
| 5 | 策略注入契约 | `agent/strategy.py` | `design/identity-card.md` L0-L9 |
| 6 | EventBus 发布订阅 | `orchestrator/event_bus.py` | `meta/` 事件发射元组件 |
| 7 | 共享图推理架构 | `reasoning/shared_graph.py` | `services/blackboard` + `reasoning/` |
| 8 | Pydantic 契约层 | `script/schema.py` + `frontend/src/types/game-script.ts` | `schema/` 四份契约 |

**关键判断**：Masquerade 的 Engine/Orchestrator/Script 三层分离已验证可行，但 0 star 状态意味着设计质量未经社区检验。ThinkingArena 采取"只读不复制"策略。

### 9.3 n8n（半份参考书）

| 模式 | 决策 |
|------|------|
| A1: 节点两元结构（声明式 Schema + 命令式 Handler） | ✅ 借鉴 |
| A2: 执行上下文注入（通过 `this` 注入能力） | ✅ 借鉴 |
| A3: 显式 Join 等待表（多输入节点的显式等待） | ✅ 借鉴 |
| A4: 端口命名与类型化（Main / Tool / Memory） | ✅ 借鉴 |
| A5: 节点执行快照（Step 级状态记录） | ✅ 借鉴 |
| A6: 凭证声明与测试（LLM 绑定冒烟） | ✅ 借鉴 |
| E1: Items/PairedItem 数据血缘 | ❌ 排除（ETL 遗产） |
| E2: 可执行表达式引擎 | ❌ 排除（非确定性 + 安全沙箱复杂度） |
| E3: 执行级挂起恢复 | ❌ 排除（推演器是确定性模拟） |
| E4: Queue Mode 分布式执行 | ❌ 排除（单进程足够） |
| E5: UI 耦合的参数系统 | ❌ 排除（推演器无需可视化编辑器） |

### 9.4 SillyTavern（专项参照）

| 模式 | 应用 |
|------|------|
| 自包含资产容器（PNG 元数据嵌入角色卡） | 参考，ThinkingArena 增加 JSON/YAML 原生支持 |
| 分层预算管理（TokenHandler 按优先级截断） | 吸收进 L0-L9 分层 |
| 条件化上下文注入（World Info 关键词触发引擎） | 吸收进世界书设计 |
| 策略化格式转换（Prompt Converters 多后端适配） | 吸收进 Prompt 渲染器 |
| 指令模板序列（Instruct Mode 模板化对话格式） | 吸收进 L1 系统预设 |
| 事件驱动扩展系统（Extension 生命周期钩子） | 参考，元组件层提供类似能力 |

### 9.5 ChatRPG v2（专项参照）

| 模式 | 应用 |
|------|------|
| P1: 叙事-状态分离 | 裁判组件设计核心原则 |
| P2: ReAct 工具链标准化描述 | 元组件层 AgentTool 契约扩展 |
| P3: 结构化状态权威 | 事件即真相原则的学术验证 |
| P4: Few-shot 工具引导 | L6/L7 Prompt 分层内容 |
| P5: 双 Agent 裁判范式 | 裁判与参与者同构原则 |
| P6: 动态角色/环境发现 | 组件层"角色创建"组件 |
| P7: 命中率累积惩罚 | 骰子组件规则参考 |

**关键验证**：ChatRPG v2 PXI 评估数据显示，双 Agent 设计在所有维度上显著优于单 Agent（p < 0.05）。ThinkingArena 的"裁判与参与者同构"原则在此得到独立验证。

---

## 附录 A：术语表

| 术语 | 定义 |
|------|------|
| **Bundle** | Scenario Bundle，一局的全部输入（流程图 + 身份牌 + LLM 绑定 + 世界书 + 种子） |
| **Script** | 事件流 JSONL，模拟过程的完整记录，唯一的真相源 |
| **导演门** | 显式放置在流程图中的门组件，到达即等待导演输入 |
| **Whisper** | 私有催眠注入，写目标 Agent 私有上下文，让 LLM 以为那是自己的想法 |
| **Steering** | 高优先级干预，打断当前方向立即转向 |
| **Follow-up** | 低优先级干预，排队至自然停止点续作 |
| **TCAS** | Think-Concurrent-Apply-Serial，并发思考-串行应用模式 |
| **黑板** | 跨组件数据面，键值存储 + 事件发布订阅 |
| **身份牌** | identity_card_v1，角色定义，与 LLM 配置零耦合 |
| **元组件** | 服务层的唯一调用面，AgentTool 式契约 |

## 附录 B：参考资源

### 核心项目
- **pi**: https://github.com/earendil-works/pi (MIT, 53k+ stars)
- **Masquerade**: https://github.com/GOODDAYDAY/Masquerade (Apache 2.0)
- **n8n**: https://github.com/n8n-io/n8n (fair-code, 400+ nodes)
- **SillyTavern**: https://github.com/SillyTavern/SillyTavern (AGPL-3.0)
- **ChatRPG v2**: arXiv:2502.19519 (ACM CUI 2025)

### 技术栈
- **Vercel AI SDK**: https://github.com/vercel/ai (Apache-2.0, 18.3M 周下载)
- **Zod**: https://github.com/colinhacks/zod (MIT)
- **Remotion**: https://github.com/remotion-dev/remotion (Remotion License)
- **edge-tts-universal**: npm package

### 方法论
- **12-Factor Agents**: Own your control flow
- **事件溯源（Event Sourcing）**: state = reduce(state, event)

---

> **文档生成声明**：本文档基于 ThinkingArena 项目全部 Investigation 调研成果（pi、Masquerade、n8n、SillyTavern、ChatRPG v2）及项目整体性文档（Vision、core-loop、architecture、research）综合编写，旨在提供无需回溯原文的完整设计与架构参考。
