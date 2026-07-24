# N8N 架构深度调研报告：编排引擎设计参考与可复用模式提取（v1.0）

> 面向多 LLM 模拟推演器的编排语义研究（2026-07-24）

---

## 1. 执行摘要（TL;DR）

N8N 是一个开源的**可视化工作流自动化引擎**，其核心定位是**编排引擎**——负责节点依赖图的拓扑执行、数据流转和生命周期管理。本报告对 N8N 的代码库进行了系统性架构研究，目标是为**多 LLM 模拟推演器**（Multi-LLM Simulation Orchestrator）提取可复用的编排语义模式，同时明确需要排除或深度改造的领域。

研究结论：**N8N 是编排引擎语义的"半份设计参考书"**。它在**节点抽象、执行调度、连接语义、执行上下文注入**等方面提供了经过生产验证的模式，可直接借鉴；但其**ETL 数据模型（items/pairedItem）、可执行表达式引擎、执行级挂起恢复、Queue Mode 分布式执行、UI 耦合的参数系统**等，与 LLM 模拟推演器的核心需求（确定性推演、状态机语义、无 ETL 血缘追踪）存在本质冲突，必须排除或根本性改造。

本报告按以下结构展开：
- **第 2 节**：架构核心设计——仓库结构、分层模型、模块边界
- **第 3 节**：设计理念——节点两元结构、数据流哲学、表达式引擎
- **第 4 节**：抽象设计详解——类型系统、执行上下文、调度算法、连接语义
- **第 5 节**：可复用模式提取——借鉴点、排除点、改造点的模式卡片
- **第 6 节**：对多 LLM 模拟推演器的具体建议
- **第 7 节**：行动声明与后续工作

---

## 2. 架构核心设计

### 2.1 仓库结构与包分层

N8N 采用 **Monorepo + 功能分层** 的组织方式，核心包位于 `packages/` 目录下：

| 包名 | 职责 | 关键模块 | 对推演器的相关性 |
|---|---|---|---|
| `packages/workflow/` | **核心类型与 Workflow 图模型** | `Workflow` 类、`interfaces.ts`、表达式引擎、`NodeHelpers` | **高**——编排语义的核心定义 |
| `packages/core/` | **执行引擎与节点上下文** | `WorkflowExecute`、`ExecuteContext`、路由节点、节点执行上下文族 | **高**——调度算法和上下文注入模式 |
| `packages/nodes-base/` | **400+ 内置节点实现** | `If`、`Switch`、`Merge`、`Code`、`HTTP Request` 等 | **中**——控制流节点的实现模式可参考 |
| `packages/cli/` | **API、调度、持久化、认证** | 工作流 CRUD、执行队列、Webhook 服务、凭证管理 | **低**——业务层，与编排语义无关 |
| `packages/editor-ui/` | **可视化编辑器前端** | React 画布、节点属性面板、表达式编辑器 | **低**——前端实现，推演器无需参考 |

**依赖关系**：`workflow` <- `core` <- `cli`，`nodes-base` 依赖 `workflow` + `core`。`workflow` 包是**零外部依赖**（除工具库）的纯类型与算法包，这是其可移植性的关键。

### 2.2 核心类图与模块边界

```
packages/workflow                    packages/core
+-------------------+               +-------------------+
| Workflow          |<-------------| WorkflowExecute   |
|  - nodes          |               |  - run()          |
|  - connections    |               |  - runNode()      |
|  - expression     |               |  - addNodeToBeExecuted()
|  - getStartNode() |               +-------------------+
+-------------------+                       |
        ^                                   v
        |                           +-------------------+
        |                           | ExecuteContext    |
        |                           |  - getInputData() |
        |                           |  - getNodeParameter()
        |                           |  - executeWorkflow()
        |                           +-------------------+
        |                                   |
        |                                   v
        |                           +-------------------+
        |                           | NodeExecutionContext
        |                           |  (基类，多态上下文)
        |                           +-------------------+
        |
        v
+-------------------+
| INodeType         |
|  - description    |  <-- 声明式元数据
|  - execute()      |  <-- 命令式逻辑
|  - poll/trigger   |
+-------------------+
```

### 2.3 关键设计决策（Architectural Decisions）

| # | 决策 | 说明 | 推演器适用性 |
|---|------|------|------------|
| AD-1 | **Workflow 类持有双向连接索引** | `connectionsBySourceNode` + `connectionsByDestinationNode`，O(1) 双向查找 | 直接适用 |
| AD-2 | **表达式引擎内嵌于 Workflow** | `workflow.expression` 是 `WorkflowExpression` 实例，解析 `={{...}}` 语法 | 需排除（见 5.2） |
| AD-3 | **节点类型与节点实例分离** | `INodeType`（类/工厂）vs `INode`（实例配置），支持同一类型多实例 | 直接适用 |
| AD-4 | **执行上下文通过 `this` 注入** | 节点 `execute(this: IExecuteFunctions)`，运行时绑定 `ExecuteContext` | 模式可借鉴，实现需调整 |
| AD-5 | **执行栈 + 等待表的双结构调度** | `nodeExecutionStack`（就绪队列）+ `waitingExecution`（join 等待） | 核心借鉴模式 |

---

## 3. 设计理念

### 3.1 节点两元结构：声明式元数据 + 命令式逻辑

N8N 的节点设计遵循 **Two-Piece Pattern（两元结构）**，这是其最具价值的抽象：

```typescript
// 1. 声明式元数据：INodeTypeDescription
interface INodeTypeDescription {
    name: string;           // 节点类型 ID
    version: number[];      // 支持的版本
    inputs: Array<NodeConnectionType | INodeInputConfiguration>;
    outputs: Array<NodeConnectionType | INodeOutputConfiguration> | ExpressionString;
    properties: INodeProperties[];  // 参数 Schema（UI + 校验）
    credentials?: INodeCredentialDescription[];
    // ...
}

// 2. 命令式逻辑：execute 方法
interface INodeType {
    description: INodeTypeDescription;
    execute?(this: IExecuteFunctions, response?: EngineResponse): Promise<NodeOutput>;
    // 其他生命周期：poll, trigger, webhook, supplyData, hooks, customOperations...
}
```

**设计哲学**：
- **元数据驱动**：`description` 同时服务于 UI 渲染（属性面板）、参数校验、类型生成（workflow-sdk）、文档生成
- **逻辑隔离**：`execute` 只关心"收到什么数据、做什么、返回什么"，不感知 UI、调度、持久化
- **版本共存**：`VersionedNodeType` 包装多个版本实现，支持工作流级版本迁移

**推演器借鉴点**：
- 每个 LLM Agent/Tool/Step 也应分为 **Schema（输入输出端口、参数定义）+ Handler（执行逻辑）**
- Schema 应足够丰富以支持推演器的静态分析（依赖图构建、类型检查）
- 版本化机制对 A/B 测试不同 Prompt 策略有直接价值

### 3.2 数据流哲学：Items 与 ETL 遗产

N8N 的数据模型深植于 **ETL（Extract-Transform-Load）** 范式：

```typescript
interface INodeExecutionData {
    json: IDataObject;              // 主数据载荷
    binary?: IBinaryKeyData;        // 二进制附件
    error?: NodeApiError;           // 错误信息
    pairedItem?: IPairedItemData | IPairedItemData[] | number;  // 数据血缘
    metadata?: { subExecution: RelatedExecution };  // 子执行关联
    // ...
}
```

**核心概念 `pairedItem`**：
- 每个输出 item 携带 `pairedItem`，指向其来源输入 item
- 用于：错误追踪、数据溯源、UI 高亮（点击输出 item 高亮对应输入 item）
- `constructExecutionMetaData()` 辅助函数自动填充血缘

**推演器排除理由**：
- LLM 模拟推演器的核心是 **状态机转换** 和 **确定性推演**，不是 ETL 数据转换
- `pairedItem` 的"逐 item 血缘追踪"在推演器中无意义——推演器关心的是 **Step 级状态快照**，不是数据 item 的血缘
- 强行引入 `pairedItem` 会增加无意义的复杂度，且与"Step 输出是状态变更"的语义冲突

**结论**：推演器应采用 **Step 级状态快照** 替代 item 级血缘追踪。

### 3.3 表达式引擎：双刃剑

N8N 的表达式引擎是其最复杂的子系统之一：
- 语法：`={{ $json.field }}`、`={{ $node['NodeName'].json.field }}`、`={{ $parameter.option }}`
- 解析器：`Expression` 类（基于 `vm2`/`isolated-vm` 的安全沙箱）
- 数据代理：`WorkflowDataProxy` 提供 `$json`, `$node`, `$items`, `$parameter`, `$workflow` 等变量

**推演器排除理由**：
- 可执行表达式引擎引入了 **非确定性** 和 **安全沙箱复杂度**
- 推演器需要的是 **声明式条件**（如 `condition: { type: 'eq', left: 'step.output.score', right: 0.8 }`），不是可执行代码
- N8N 的表达式引擎深度耦合于 UI（表达式编辑器、自动补全、语法高亮），推演器无需这些

**结论**：推演器应采用 **声明式条件语言** 替代可执行表达式引擎。

### 3.4 连接类型系统：从 Main 到 AI 子图

N8N 的连接类型经历了从单一 `main` 到多类型连接的演进：

```typescript
export const NodeConnectionTypes = {
    Main: 'main',           // 主数据流
    AiAgent: 'ai_agent',    // AI Agent 子图
    AiChain: 'ai_chain',    // AI Chain 子图
    AiTool: 'ai_tool',      // AI Tool 调用
    AiMemory: 'ai_memory',  // 记忆模块
    AiLanguageModel: 'ai_languageModel',
    // ... 共 13 种类型
} as const;
```

**关键洞察**：
- `main` 连接用于传统的 ETL 数据流
- AI 相关连接类型（`ai_agent`, `ai_tool` 等）形成了**子图（sub-graph）语义**：AI Agent 节点通过 `ai_tool` 连接挂载 Tool 节点，通过 `ai_memory` 连接挂载 Memory 节点
- 子图在执行时通过 `getInputConnectionData()` 获取子节点数据，而非通过 `main` 数据流

**推演器借鉴点**：
- 推演器的 **Agent <-> Tool <-> Memory** 关系可直接借鉴 N8N 的多类型连接设计
- 但推演器不需要 13 种类型，只需要 **3 种**：`main`（主推演流）、`tool`（工具调用）、`memory`（上下文/记忆）

---

## 4. 抽象设计详解

### 4.1 类型系统：核心接口全景

```typescript
// 工作流定义
interface IWorkflowBase {
    id: string;
    nodes: INode[];           // 节点实例配置
    connections: IConnections; // 连接定义（源视角）
    settings?: IWorkflowSettings;
    staticData?: IDataObject;  // 工作流级持久化状态
}

// 节点实例（配置）
interface INode {
    id: string;
    name: string;              // 实例名称（唯一标识）
    type: string;              // 节点类型 ID
    typeVersion: number;       // 版本
    position: [number, number]; // 画布坐标（UI 用）
    parameters: INodeParameters; // 实例参数
    disabled?: boolean;
    retryOnFail?: boolean;
    maxTries?: number;
    onError?: 'continueErrorOutput' | 'continueRegularOutput' | 'stopWorkflow';
    continueOnFail?: boolean;
    alwaysOutputData?: boolean;
    executeOnce?: boolean;
    // ...
}

// 连接定义（源视角：哪个节点的哪个输出连接到哪个节点的哪个输入）
interface IConnections {
    [sourceNodeName: string]: {
        [connectionType: string]: {
            [outputIndex: number]: Array<{
                node: string;      // 目标节点名
                type: string;      // 连接类型
                index: number;     // 目标输入索引
            }>;
        };
    };
}

// 执行数据（运行时）
interface IRunExecutionData {
    startData?: {
        destinationNode?: IDestinationNode;
        runNodeFilter?: string[];
    };
    resultData: {
        runData: IRunData;
        lastNodeExecuted?: string;
        pinData?: IPinData;
        error?: ExecutionError;
    };
    executionData?: {
        nodeExecutionStack: IExecuteData[];
        waitingExecution: IWaitingForExecution;
        waitingExecutionSource: IWaitingForExecutionSource;
    };
    waitTill?: Date;  // 挂起恢复时间
}

// 执行栈条目
interface IExecuteData {
    node: INode;
    data: ITaskDataConnections;
    source?: ITaskDataConnectionsSource;
    runIndex?: number;
    metadata?: ITaskMetadata;
}
```

### 4.2 执行上下文：能力注入模式

N8N 的节点执行不直接传递参数，而是通过 **上下文对象注入能力**。这是**依赖注入（DI）** 在编排引擎中的典范应用：

```typescript
// 核心执行上下文接口（workflow 包定义）
export type IExecuteFunctions = ExecuteFunctions.GetNodeParameterFn &
    BaseExecutionFunctions & {
        getInputData(inputIndex?: number, connectionType?: NodeConnectionType): INodeExecutionData[];
        getNodeParameter(parameterName: string, itemIndex: number, fallbackValue?: any, options?: IGetNodeParameterOptions): NodeParameterValueType;
        executeWorkflow(workflowInfo: IExecuteWorkflowInfo, ...): Promise<ExecuteWorkflowData>;
        putExecutionToWait(waitTill: Date): Promise<void>;
        helpers: RequestHelperFunctions & BaseHelperFunctions & BinaryHelperFunctions & ...;
        // ... 30+ 方法
    };

// 运行时实现（core 包）
export class ExecuteContext extends BaseExecuteContext implements IExecuteFunctions {
    constructor(
        workflow: Workflow,
        node: INode,
        additionalData: IWorkflowExecuteAdditionalData,
        mode: WorkflowExecuteMode,
        runExecutionData: IRunExecutionData,
        runIndex: number,
        connectionInputData: INodeExecutionData[],
        inputData: ITaskDataConnections,
        executeData: IExecuteData,
        closeFunctions: CloseFunction[],
        abortSignal?: AbortSignal,
    ) {
        // 绑定 helpers、nodeHelpers、getNodeParameter 等
    }
}
```

**上下文分层**：
1. `FunctionsBase`：所有上下文共享（`getNode`, `getWorkflow`, `getCredentials`, `logger`）
2. `BaseExecutionFunctions`：执行相关（`continueOnFail`, `evaluateExpression`, `getContext`）
3. `IExecuteFunctions`：完整执行上下文（`getInputData`, `executeWorkflow`, `helpers`）
4. 其他专用上下文：`ITriggerFunctions`, `IPollFunctions`, `IWebhookFunctions`, `ILoadOptionsFunctions`, `ISupplyDataFunctions`

**推演器借鉴点**：
- 推演器的 Step Handler 也应通过 **上下文对象** 注入能力，而非直接传递参数
- 上下文应提供：`getState()`, `getTool(toolName)`, `getMemory()`, `emitPartialResult()`, `putToWait()`
- 分层设计：基础上下文（所有 Step 共享）+ 专用上下文（Agent Step、Tool Step、Control Step）

### 4.3 调度算法：执行栈 + Join 等待表

这是 N8N 执行引擎最核心的算法，位于 `WorkflowExecute.processRunExecutionData()`。

#### 4.3.1 核心数据结构

```typescript
// 执行栈（就绪队列）—— LIFO（v0）或 位置排序（v1）
nodeExecutionStack: IExecuteData[];

// Join 等待表——多输入节点的数据暂存区
waitingExecution: {
    [nodeName: string]: {
        [runIndex: number]: ITaskDataConnections;
    };
};

// 等待表的数据源追踪
waitingExecutionSource: {
    [nodeName: string]: {
        [runIndex: number]: ITaskDataConnectionsSource;
    };
};
```

#### 4.3.2 主执行循环

```typescript
// 伪代码（基于 workflow-execute.ts 的实际实现）
while (nodeExecutionStack.length > 0) {
    const executionData = nodeExecutionStack.shift(); // 或 pop，取决于 executionOrder
    const { node } = executionData;

    // 1. 检查输入数据是否齐全（多输入节点的 join 语义）
    if (!ensureInputData(workflow, node, executionData)) continue;

    // 2. 运行节点
    const result = await runNode(workflow, executionData, ...);

    // 3. 处理结果，分发到下游节点
    if (result.data) {
        for (const [outputIndex, outputData] of result.data.entries()) {
            const connections = workflow.connectionsBySourceNode[node.name]?.main?.[outputIndex];
            for (const connection of connections ?? []) {
                addNodeToBeExecuted(workflow, connection, outputIndex, node.name, result.data, runIndex);
            }
        }
    }

    // 4. 检查等待表，看是否有节点现在可以执行
    processWaitingNodes();
}
```

#### 4.3.3 `addNodeToBeExecuted`：Join 语义的核心

```typescript
addNodeToBeExecuted(workflow, connectionData, outputIndex, parentNodeName, nodeSuccessData, runIndex) {
    const numberOfInputs = workflow.connectionsByDestinationNode[connectionData.node]?.main?.length ?? 0;

    if (numberOfInputs > 1) {
        // === 多输入节点：进入等待表 ===
        // 1. 查找或创建等待条目
        let waitingNodeIndex = findOrCreateWaitingEntry(connectionData.node);

        // 2. 存储当前输入数据
        waitingExecution[connectionData.node][waitingNodeIndex].main[connectionData.index] = nodeSuccessData[outputIndex];
        waitingExecutionSource[...] = {
            previousNode: parentNodeName,
            previousNodeOutput: outputIndex,
            previousNodeRun: runIndex
        };

        // 3. 检查是否所有输入都已到达
        let allDataFound = true;
        for (let i = 0; i < waitingExecution[nodeName][waitingNodeIndex].main.length; i++) {
            if (waitingExecution[nodeName][waitingNodeIndex].main[i] === null) {
                allDataFound = false; break;
            }
        }

        // 4. 如果全部到达，加入执行栈
        if (allDataFound) {
            nodeExecutionStack.push({
                node: workflow.nodes[connectionData.node],
                data: waitingExecution[connectionData.node][waitingNodeIndex],
                source: waitingExecutionSource[connectionData.node][waitingNodeIndex]
            });
            // 清理等待表
            delete waitingExecution[connectionData.node][waitingNodeIndex];
        }
    } else {
        // === 单输入节点：直接加入执行栈 ===
        nodeExecutionStack.push({
            node: workflow.nodes[connectionData.node],
            data: { main: [nodeSuccessData[outputIndex]] },
            source: { main: [{ previousNode: parentNodeName, previousNodeOutput: outputIndex, previousNodeRun: runIndex }] }
        });
    }
}
```

#### 4.3.4 `requiredInputs`：显式控制 Join 严格度

N8N v1 执行顺序引入了 `requiredInputs` 字段，允许节点声明"需要哪些输入才能执行"：

```typescript
interface INodeTypeDescription {
    requiredInputs?: string | number[] | number;  // v1 专属
}
// 示例：Merge 节点可以只要求 1 个输入（非严格 join）
// 示例：某些节点要求所有输入（严格 join）
```

**推演器核心借鉴**：
- **显式等待表（waitingExecution）**：比隐式 join 更清晰，易于调试和状态可视化
- **按 runIndex 隔离**：同一节点的多次运行（不同分支）数据互不干扰
- **requiredInputs 语义**：推演器的并行分支合并（如多 Agent 投票）可直接借鉴此模式

### 4.4 条件求值与分支路由

#### 4.4.1 If 节点：条件分支

```typescript
class IfV2 implements INodeType {
    description = {
        inputs: [NodeConnectionTypes.Main],
        outputs: [NodeConnectionTypes.Main, NodeConnectionTypes.Main],  // true, false
        outputNames: ['true', 'false'],
        properties: [
            {
                name: 'conditions',
                type: 'filter',  // 内置 Filter 类型，支持 and/or 组合
                default: {}
            }
        ]
    };

    async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
        const trueItems: INodeExecutionData[] = [];
        const falseItems: INodeExecutionData[] = [];

        this.getInputData().forEach((item, itemIndex) => {
            const pass = this.getNodeParameter('conditions', itemIndex, false, { extractValue: true });
            if (pass) trueItems.push(item); else falseItems.push(item);
        });

        return [trueItems, falseItems];  // [true 分支数据, false 分支数据]
    }
}
```

**关键设计**：
- If 节点是**普通节点**，不是引擎内置概念——条件求值在节点内部完成，引擎只负责"按输出索引分发"
- `outputIndex 0` -> `true` 分支，`outputIndex 1` -> `false` 分支
- 每个 item 独立判断，实现 item 级细粒度路由

**推演器借鉴**：
- 推演器的条件分支也应是**普通 Step**，不是引擎内置概念
- 但推演器不需要 item 级路由，只需要**Step 级路由**（整个 Step 输出走哪个分支）
- 条件表达式应使用**声明式条件语言**，不是可执行代码

#### 4.4.2 Switch 节点：多路分支

```typescript
// Switch 节点的 outputs 可以是表达式动态决定
outputs: `={{ ((parameters) => {
    const rules = parameters.rules?.rules ?? [];
    const mode = parameters.mode;
    if (mode === 'expression') {
        return Array.from({ length: parameters.outputsAmount }, (_, i) =>
            ({ type: NodeConnectionTypes.Main, displayName: i.toString() }));
    }
    return rules.map(value => ({ type: NodeConnectionTypes.Main, displayName: value.outputKey }));
})($parameter) }}`,
```

Switch 节点展示了**动态输出端口**的能力——输出数量和名称由参数决定。推演器的动态分支（如根据配置生成 N 个并行 Agent）可借鉴此模式。

### 4.5 错误处理与重试

#### 4.5.1 错误处理策略

N8N 在三个层面处理错误：
1. **节点级**：`continueOnFail`（布尔）、`onError`（`'continueErrorOutput' | 'continueRegularOutput' | 'stopWorkflow'`）
2. **执行级**：`retryOnFail` + `maxTries` + `waitBetweenTries`
3. **工作流级**：`errorWorkflow`（指定错误处理工作流）

**关键机制**：
- `continueOnFail = true`：节点错误时，将输入数据原样传递到下游（失败透传）
- `onError = 'continueErrorOutput'`：节点输出分为"成功输出"和"错误输出"两个端口（最后一个端口专用于错误）
- 错误 item 通过 `pairedItem` 追踪到原始输入 item

**推演器借鉴**：
- `onError` 的三种策略可直接映射到推演器：
  - `stopWorkflow` -> 推演终止
  - `continueRegularOutput` -> 错误忽略，继续推演
  - `continueErrorOutput` -> 错误分流到专用处理 Step（如"反思 Step"）
- `retryOnFail` 对 LLM 调用的重试（指数退避）有直接价值

#### 4.5.2 重试机制

```typescript
// workflow-execute.ts 中的重试逻辑
if (executionData.node.retryOnFail === true && !isResumedError) {
    maxTries = Math.min(5, Math.max(2, executionData.node.maxTries || 3));
    waitBetweenTries = Math.min(5000, Math.max(0, executionData.node.waitBetweenTries || 1000));
}

for (let tryIndex = 0; tryIndex < maxTries; tryIndex++) {
    try {
        result = await runNode(...);
        if (!checkFailure(result)) break;
    } catch (error) {
        if (tryIndex === maxTries - 1) throw error;
        await sleep(waitBetweenTries);
    }
}
```

**推演器借鉴**：
- LLM 调用的重试应支持：最大重试次数、退避策略（固定/指数）、可重试错误类型判定
- 但推演器的重试应更智能：区分"模型超时"（可重试）vs"逻辑错误"（不可重试）

### 4.6 执行级挂起恢复（Wait）

N8N 支持节点将执行挂起（`putExecutionToWait`），等待外部事件恢复：

```typescript
// BaseExecuteContext 中的方法
async putExecutionToWait(waitTill: Date): Promise<void> {
    this.runExecutionData.waitTill = waitTill;
    if (this.additionalData.setExecutionStatus) {
        this.additionalData.setExecutionStatus('waiting');
    }
}

// 恢复时
handleWaitingState(workflow) {
    if (this.runExecutionData.waitTill) {
        this.runExecutionData.waitTill = undefined;
        // 禁用当前节点（防止重复执行）
        executionStackEntry.node.disabled = true;
        // 移除上次执行记录
        this.runExecutionData.resultData.runData[lastNodeExecuted].pop();
    }
}
```

**推演器排除理由**：
- 推演器是**确定性模拟**，不应有"挂起等待外部事件"的语义
- 如果需要人机交互（HITL），应在 Step 级别实现（如 `HumanReviewStep`），不是引擎级挂起恢复
- 执行级挂起引入了持久化、超时、恢复令牌等复杂度，与推演器无关

---

## 5. 可复用模式提取

### 5.1 借鉴模式（Adopt）

#### 模式卡片 A1：节点两元结构（Two-Piece Node Pattern）

| 属性 | 内容 |
|------|------|
| **名称** | Two-Piece Node Pattern（声明式 Schema + 命令式 Handler） |
| **来源** | N8N `INodeTypeDescription` + `INodeType.execute` |
| **问题** | 如何设计可扩展、可版本化、UI 友好的 Step 抽象？ |
| **解决方案** | 每个 Step 类型分为两部分：1) `StepSchema`（端口定义、参数 Schema、版本、显示元数据）；2) `StepHandler`（执行逻辑，通过上下文接口注入依赖）。Schema 与 Handler 通过类型系统绑定。 |
| **推演器应用** | `AgentStepSchema`（定义输入端口 `user_query`、输出端口 `response`、参数 `model`, `temperature`, `system_prompt`）+ `AgentStepHandler`（通过 `StepContext` 调用 LLM、更新状态）。 |
| **代码参考** | `packages/workflow/src/interfaces.ts:INodeTypeDescription` + `INodeType` |

#### 模式卡片 A2：执行上下文注入（Context Injection Pattern）

| 属性 | 内容 |
|------|------|
| **名称** | Context Injection Pattern（通过 `this` 注入能力） |
| **来源** | N8N `ExecuteContext` 实现 `IExecuteFunctions` |
| **问题** | Step Handler 如何获取运行时能力（状态访问、工具调用、日志记录）而不引入全局依赖？ |
| **解决方案** | 定义 `StepContext` 接口，包含所有 Step 需要的能力。执行引擎在调用 Handler 前构造 Context 实例，通过 `handler.call(context, ...)` 或 `handler(context, ...)` 注入。Context 按层级设计：基础上下文（所有 Step）+ 专用上下文（Agent/Tool/Control）。 |
| **推演器应用** | `AgentStepContext` 提供 `callLLM()`, `getMemory()`, `emitTrace()`；`ToolStepContext` 提供 `executeTool()`, `getArgs()`。 |
| **代码参考** | `packages/core/src/execution-engine/node-execution-context/execute-context.ts` |

#### 模式卡片 A3：显式 Join 等待表（Explicit Join Waiting Table）

| 属性 | 内容 |
|------|------|
| **名称** | Explicit Join Waiting Table（多输入节点的显式等待） |
| **来源** | N8N `waitingExecution` + `waitingExecutionSource` |
| **问题** | 多输入节点（如 Merge、多 Agent 投票）如何知道所有上游分支已就绪？ |
| **解决方案** | 维护两个运行时结构：1) `waitingExecution`：按 `{ nodeName: { runIndex: { inputType: [data] } } }` 存储部分到达的数据；2) `waitingExecutionSource`：追踪每份数据的来源（上游节点名、输出索引、runIndex）。当某节点的某 runIndex 的所有 requiredInputs 都到达时，从等待表移入执行栈。 |
| **推演器应用** | 并行 Agent 分支（如"同时调用 GPT-4 和 Claude，然后投票"）的合并节点使用此模式。`requiredInputs` 可配置为"全部到达"或"任意 N 个到达"。 |
| **代码参考** | `packages/core/src/execution-engine/workflow-execute.ts:addNodeToBeExecuted()` |

#### 模式卡片 A4：端口命名与类型化（Typed Named Ports）

| 属性 | 内容 |
|------|------|
| **名称** | Typed Named Ports（类型化命名端口） |
| **来源** | N8N `NodeConnectionTypes` + `outputNames`/`inputNames` |
| **问题** | 如何区分不同语义的数据流（主数据 vs 工具调用 vs 记忆）？ |
| **解决方案** | 连接类型从单一 `main` 扩展为多类型（`main`, `ai_tool`, `ai_memory` 等）。每个端口可命名（`outputNames: ['true', 'false']`）。类型系统确保端口只能连接到兼容类型。 |
| **推演器应用** | 定义 `StepConnectionTypes = { Main: 'main', Tool: 'tool', Memory: 'memory' }`。Agent Step 的 `tool` 端口只能连接到 Tool Step，`memory` 端口只能连接到 Memory Step。 |
| **代码参考** | `packages/workflow/src/interfaces.ts:NodeConnectionTypes` |

#### 模式卡片 A5：节点执行快照（Node Execution Snapshot）

| 属性 | 内容 |
|------|------|
| **名称** | Node Execution Snapshot（节点执行结果快照） |
| **来源** | N8N `IRunData` + `ITaskData` |
| **问题** | 如何记录每次 Step 执行的完整上下文和结果，以支持重放、调试、审计？ |
| **解决方案** | 每个节点的每次执行（runIndex）记录为 `TaskData`：包含输入数据、输出数据、执行时间、错误信息、元数据（子执行关联、token 用量、tracing）。所有 TaskData 按 `{ nodeName: TaskData[] }` 组织。 |
| **推演器应用** | `StepExecutionRecord`：包含 `inputState`, `outputState`, `llmCalls`（模型调用详情）, `tokensUsed`, `executionTimeMs`, `timestamp`。支持按 `runIndex` 追踪同一 Step 的多次执行（如重试）。 |
| **代码参考** | `packages/workflow/src/interfaces.ts:ITaskData` + `IRunData` |

#### 模式卡片 A6：凭证声明与测试（Credential Declaration + Test）

| 属性 | 内容 |
|------|------|
| **名称** | Credential Declaration + Test（凭证声明与连通性测试） |
| **来源** | N8N `INodeCredentialDescription` + `ICredentialTestFunction` |
| **问题** | 如何管理 LLM API Key、数据库连接等敏感凭证，并在配置时验证有效性？ |
| **解决方案** | 节点 Schema 声明所需凭证类型（`credentials: [{ name: 'openAiApi', required: true }]`）。凭证系统独立于节点，支持加密存储、权限控制、连通性测试（`test` 函数在保存时验证 API Key 是否有效）。 |
| **推演器应用** | LLM Provider 凭证（OpenAI API Key、Anthropic API Key）作为独立实体管理。配置时调用 `testCredential()` 验证（发送一个廉价请求如 `model=list`）。支持多凭证切换（A/B 测试不同 Key 的配额）。 |
| **代码参考** | `packages/workflow/src/interfaces.ts:INodeCredentialDescription` + `ICredentialTestFunctions` |

### 5.2 排除模式（Exclude）

#### 模式卡片 E1：Items/PairedItem 数据血缘

| 属性 | 内容 |
|------|------|
| **名称** | Items/PairedItem Lineage Tracking |
| **排除理由** | ETL 范式遗产。LLM 推演器不需要逐 item 的血缘追踪，Step 级状态快照已足够。引入 pairedItem 会增加无意义复杂度，且与"Step 输出是状态变更"的语义冲突。 |
| **替代方案** | Step 级 `ExecutionRecord`，记录 `inputState -> outputState` 的完整状态转换。 |
| **代码参考** | `packages/workflow/src/interfaces.ts:IPairedItemData` + `constructExecutionMetaData` |

#### 模式卡片 E2：可执行表达式引擎

| 属性 | 内容 |
|------|------|
| **名称** | Executable Expression Engine（`={{...}}` 语法） |
| **排除理由** | 引入非确定性和安全沙箱复杂度。推演器需要确定性条件求值，不应允许任意代码执行。 |
| **替代方案** | 声明式条件语言（JSON Schema 条件）：`{ type: 'eq', left: 'step.output.confidence', right: 0.8 }`。支持 `and`, `or`, `gt`, `lt`, `contains`, `regex` 等操作符。 |
| **代码参考** | `packages/workflow/src/workflow-expression.ts` + `Expression` 类 |

#### 模式卡片 E3：执行级挂起恢复（Wait/Resume）

| 属性 | 内容 |
|------|------|
| **名称** | Execution-Level Wait/Resume（`putExecutionToWait`） |
| **排除理由** | 推演器是确定性模拟，不应有挂起等待外部事件的语义。人机交互应在 Step 级别实现（如 `HumanReviewStep`），不是引擎级机制。 |
| **替代方案** | Step 级暂停：`HumanReviewStep` 执行时返回 `status: 'paused'` 和 `resumeToken`，引擎将推演状态标记为 `PAUSED`，等待外部通过 API 恢复。 |
| **代码参考** | `packages/core/src/execution-engine/node-execution-context/base-execute-context.ts:putExecutionToWait` |

#### 模式卡片 E4：Queue Mode 分布式执行

| 属性 | 内容 |
|------|------|
| **名称** | Queue Mode Distributed Execution（Bull/BullMQ 队列） |
| **排除理由** | N8N 的 Queue Mode 用于水平扩展工作流执行，涉及 Redis、Worker 进程、Job 分发等复杂基础设施。推演器初期不需要分布式执行，单进程事件循环足够。 |
| **替代方案** | 单进程异步执行引擎（类似 N8N 的 `main` 模式）。未来如需扩展，优先考虑 Step 级并行（Promise.all）而非分布式队列。 |
| **代码参考** | `packages/cli/src/services/orchestration/` |

#### 模式卡片 E5：UI 耦合的参数系统

| 属性 | 内容 |
|------|------|
| **名称** | UI-Coupled Parameter System（`displayOptions`, `typeOptions`, `builderHint`） |
| **排除理由** | N8N 的参数 Schema 深度耦合于前端 UI（属性面板的显示/隐藏、条件渲染、Builder Hint 用于 LLM 工作流生成）。推演器无需可视化编辑器，这些字段是噪音。 |
| **替代方案** | 纯数据 Schema（JSON Schema 或 Zod），用于校验和类型生成。UI 相关字段全部剔除。 |
| **代码参考** | `packages/workflow/src/interfaces.ts:INodeProperties`（`displayOptions`, `builderHint` 等） |

### 5.3 改造模式（Adapt）

#### 模式卡片 R1：条件求值从 Item 级到 Step 级

| 属性 | 内容 |
|------|------|
| **名称** | Step-Level Conditional Routing（条件路由从 Item 级到 Step 级） |
| **来源** | N8N If/Switch 节点的 item 级路由 |
| **改造点** | N8N 的 If 节点对每个 item 独立判断，输出 `[trueItems, falseItems]`。推演器不需要 item 级粒度，只需要 Step 级决策（整个 Step 输出走哪个分支）。 |
| **改造方案** | 简化 If Step：输入单个 `state` 对象，输出 `boolean`（或 `number` 表示分支索引）。引擎根据输出值选择下游分支。无需 item 循环。 |
| **代码参考** | `packages/nodes-base/nodes/If/V2/IfV2.node.ts:execute()` |

#### 模式卡片 R2：数据模型从 ETL Items 到 State 对象

| 属性 | 内容 |
|------|------|
| **名称** | State-Object Data Model（数据模型从 Items 到 State） |
| **来源** | N8N `INodeExecutionData`（`json` + `binary` + `pairedItem`） |
| **改造点** | N8N 的数据模型假设每个节点处理 item 数组（ETL 范式）。推演器的每个 Step 处理的是**状态对象**（当前推演上下文）。 |
| **改造方案** | 定义 `StepInput = { state: SimulationState; metadata: StepMetadata }`，`StepOutput = { state: SimulationState; status: 'success' | 'error' | 'paused'; trace: StepTrace }`。State 是任意 JSON 对象，由 Step Schema 定义其结构。 |
| **代码参考** | `packages/workflow/src/interfaces.ts:INodeExecutionData` |

#### 模式卡片 R3：执行顺序从画布位置到拓扑排序

| 属性 | 内容 |
|------|------|
| **名称** | Topological Execution Order（执行顺序从画布位置到拓扑排序） |
| **来源** | N8N `executionOrder: 'v0' | 'v1'`（v1 按画布位置排序） |
| **改造点** | N8N v1 按节点画布坐标排序（top-left first），这是为了 UI 可预测性。推演器不需要 UI 坐标，应按纯拓扑顺序执行。 |
| **改造方案** | 推演器使用**拓扑排序 + 动态就绪**确定执行顺序。并行分支（同一层级的多个节点）按声明顺序或随机顺序执行（对推演结果无影响时）。 |
| **代码参考** | `packages/core/src/execution-engine/workflow-execute.ts:executionOrder` |

#### 模式卡片 R4：错误处理从 Item 级到 Step 级

| 属性 | 内容 |
|------|------|
| **名称** | Step-Level Error Handling（错误处理从 Item 级到 Step 级） |
| **来源** | N8N `continueOnFail` + `onError`（支持 item 级错误隔离） |
| **改造点** | N8N 可以在 item 级别隔离错误（某些 item 失败不影响其他 item）。推演器的错误是 Step 级的（整个 LLM 调用失败）。 |
| **改造方案** | 简化错误策略：`onError: 'stop' | 'continue' | 'retry' | 'fallback'`。`fallback` 指定备用 Step（如主模型失败时切换到备用模型）。 |
| **代码参考** | `packages/workflow/src/interfaces.ts:OnError` + `packages/core/src/execution-engine/workflow-execute.ts` |

---

## 6. 对多 LLM 模拟推演器的具体建议

### 6.1 推演器编排引擎的参考架构

基于 N8N 的研究，建议推演器的编排引擎采用以下架构：

```
+-------------------+     +-------------------+     +-------------------+
|   Workflow 图模型  |---->| SimulationEngine  |---->|  SimulationState  |
|  (节点 + 连接 + 状态)|     |  (执行引擎)        |     |  (全局状态树)      |
+-------------------+     +-------------------+     +-------------------+
         |                         |
         v                         v
+-------------------+     +-------------------+
| StepSchema 注册表  |     | StepContext 族     |
| (类型安全)         |     | (上下文注入)       |
+-------------------+     +-------------------+
```

### 6.2 核心类型设计（推演器适配版）

```typescript
// === 推演器核心类型（借鉴 N8N，去除 ETL 遗产）===

// Step Schema（声明式元数据）
interface StepSchema {
    name: string;                    // Step 类型 ID
    version: number;                // 版本
    inputs: Array<StepConnectionType | StepInputConfig>;
    outputs: Array<StepConnectionType | StepOutputConfig>;
    parameters: ParameterSchema[];   // 参数定义（JSON Schema 子集）
    requiredCredentials?: string[];  // 所需凭证
}

// Step 实例（配置）
interface StepInstance {
    id: string;
    name: string;              // 实例名（唯一）
    type: string;
    typeVersion: number;
    parameters: Record<string, unknown>;
    disabled?: boolean;
    retryPolicy?: RetryPolicy;
    onError?: 'stop' | 'continue' | 'retry' | 'fallback';
    fallbackStep?: string;     // 备用 Step 名
}

// 连接类型
enum StepConnectionType {
    Main = 'main',
    Tool = 'tool',
    Memory = 'memory',
}

// 推演状态（全局）
interface SimulationState {
    [key: string]: unknown;    // 开放结构，Step 可读写
}

// Step 上下文（执行时注入）
interface StepContext {
    getState(): SimulationState;
    getStatePath(path: string): unknown;
    setState(path: string, value: unknown): void;
    getTool(toolName: string): ToolDefinition;
    getMemory(): MemoryContext;
    log(level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: unknown): void;
    emitTrace(event: TraceEvent): void;
    executeSubWorkflow(workflowId: string, input: SimulationState): Promise<SimulationState>;
}

// Agent Step 专用上下文
interface AgentStepContext extends StepContext {
    callLLM(params: LLMCallParams): Promise<LLMResponse>;
    getAvailableModels(): string[];
}

// 执行记录
interface StepExecutionRecord {
    stepName: string;
    runIndex: number;
    inputState: SimulationState;
    outputState: SimulationState;
    status: 'success' | 'error' | 'paused';
    llmCalls: LLMCallRecord[];
    tokensUsed: { input: number; output: number };
    executionTimeMs: number;
    timestamp: Date;
    error?: ExecutionError;
}

// 执行引擎状态
interface ExecutionState {
    stepExecutionStack: ExecuteData[];
    waitingExecution: WaitingTable;
    completedRecords: Record<string, StepExecutionRecord[]>;
    globalState: SimulationState;
    status: 'running' | 'paused' | 'completed' | 'error';
}
```

### 6.3 调度算法伪代码（推演器适配版）

```typescript
class SimulationEngine {
    async run(workflow: Workflow, initialState: SimulationState): Promise<ExecutionResult> {
        const executionState = this.initializeExecution(workflow, initialState);

        while (executionState.stepExecutionStack.length > 0) {
            const executeData = executionState.stepExecutionStack.shift();
            const step = executeData.step;

            // 1. 检查输入就绪（多输入 Step 的 join 语义）
            if (!this.ensureInputReady(workflow, step, executeData)) continue;

            // 2. 构建 Step 上下文
            const context = this.buildContext(workflow, executionState, executeData);

            // 3. 执行 Step
            const result = await this.executeStep(step, context, executeData);

            // 4. 记录执行
            this.recordExecution(executionState, step.name, result);

            // 5. 更新全局状态
            if (result.status === 'success') {
                this.mergeState(executionState.globalState, result.outputState);
            }

            // 6. 分发到下游 Steps
            if (result.status === 'success' && result.outputs) {
                for (const [outputIndex, outputData] of result.outputs.entries()) {
                    const connections = workflow.getConnections(step.name, outputIndex);
                    for (const conn of connections) {
                        this.scheduleStep(workflow, executionState, conn, outputData, step.name);
                    }
                }
            }

            // 7. 处理等待表（检查是否有 Step 现在可以执行）
            this.processWaitingSteps(executionState);
        }

        return this.buildResult(executionState);
    }

    scheduleStep(workflow, executionState, connection, outputData, parentStepName) {
        const targetStep = workflow.getStep(connection.targetStep);
        const numInputs = workflow.getInputCount(targetStep.name);

        if (numInputs > 1) {
            // === 多输入：进入等待表 ===
            const entry = this.getOrCreateWaitingEntry(executionState, targetStep.name);
            entry.inputs[connection.targetInputIndex] = outputData;
            entry.sources[connection.targetInputIndex] = {
                previousStep: parentStepName,
                previousOutputIndex: connection.sourceOutputIndex
            };

            // 检查是否所有 requiredInputs 都已到达
            if (this.allRequiredInputsReady(targetStep, entry)) {
                executionState.stepExecutionStack.push({
                    step: targetStep,
                    inputs: entry.inputs,
                    sources: entry.sources
                });
                this.clearWaitingEntry(executionState, targetStep.name);
            }
        } else {
            // === 单输入：直接入栈 ===
            executionState.stepExecutionStack.push({
                step: targetStep,
                inputs: [outputData],
                sources: [{ previousStep: parentStepName }]
            });
        }
    }
}
```

### 6.4 与 N8N 的逐项对照表

| 维度 | N8N 原始设计 | 推演器适配设计 | 决策 |
|------|-------------|---------------|------|
| **数据模型** | `INodeExecutionData[]`（item 数组） | `SimulationState`（状态对象） | 改造 |
| **血缘追踪** | `pairedItem`（item 级） | `StepExecutionRecord`（Step 级） | 排除 + 替代 |
| **条件语言** | 可执行表达式 `={{...}}` | 声明式条件 JSON | 排除 + 替代 |
| **连接类型** | 13 种（Main + AI 子图） | 3 种（Main + Tool + Memory） | 简化 |
| **Join 语义** | `waitingExecution` + `requiredInputs` | 同构，但按 State 对象而非 Item 数组 | 借鉴 |
| **错误处理** | `continueOnFail` + `onError`（item 级） | `onError: 'stop' | 'continue' | 'retry' | 'fallback'`（Step 级） | 改造 |
| **重试机制** | `retryOnFail` + `maxTries` + 固定退避 | 同构 + 指数退避 + 可重试错误类型判定 | 借鉴 + 增强 |
| **挂起恢复** | `putExecutionToWait`（引擎级） | Step 级 `status: 'paused'` + 外部恢复 API | 排除 + 替代 |
| **凭证管理** | `INodeCredentialDescription` + 测试函数 | 同构，支持 LLM Provider API Key | 借鉴 |
| **执行上下文** | `IExecuteFunctions`（30+ 方法） | `StepContext`（精简，推演专用） | 借鉴 + 简化 |
| **执行顺序** | 画布坐标排序（v1） | 拓扑排序 + 动态就绪 | 改造 |
| **版本管理** | `VersionedNodeType` | 同构，`VersionedStepType` | 借鉴 |
| **子工作流** | `executeWorkflow()` | `executeSubWorkflow()` | 借鉴 |

---

## 7. 行动声明

### 7.1 已完成工作

1. **代码结构勘察**：完成了 N8N 仓库的 packages/ 目录分析，理清了 workflow/core/cli/editor-ui 四层架构的边界与依赖关系。
2. **核心类型精读**：深入阅读了 `interfaces.ts`（~4200 行）、`workflow.ts`、`workflow-execute.ts`（~2900 行）、`execute-context.ts` 等核心文件，提取了关键类型定义和算法逻辑。
3. **节点抽象分析**：以 `If`、`Switch`、`Code`、`Merge` 节点为例，理解了节点两元结构（description + execute）、版本化管理、参数 Schema 系统。
4. **执行引擎分析**：完整理解了 `processRunExecutionData` 主循环、`addNodeToBeExecuted` 调度算法、`waitingExecution` join 等待表机制。
5. **模式提取**：基于代码分析，产出了 6 个借鉴模式卡片、5 个排除模式卡片、4 个改造模式卡片。

### 7.2 已确认的关键发现

- **N8N 的编排语义是生产验证的**：其执行栈 + 等待表调度、节点两元结构、上下文注入、端口类型化等模式经过 400+ 节点和百万级工作流的检验，可直接作为推演器编排引擎的设计参考。
- **N8N 的 ETL 遗产与推演器冲突**：`items/pairedItem`、可执行表达式引擎、执行级挂起恢复等是 N8N 作为自动化工具的核心特性，但与 LLM 模拟推演器的"状态机 + 确定性推演"语义不兼容，必须排除。
- **N8N 的 AI 子图设计有参考价值**：其 `ai_agent`/`ai_tool`/`ai_memory` 多类型连接的设计，为推演器的 Agent-Tool-Memory 关系建模提供了直接参考。

### 7.3 后续建议行动

1. **设计推演器核心类型系统**：基于本报告的"推演器适配版"类型设计，定义 `StepSchema`、`StepInstance`、`SimulationState`、`StepContext`、`ExecutionState` 等核心接口。
2. **实现最小可行调度器**：基于 `addNodeToBeExecuted` 算法，实现支持单输入直通、多输入 join、条件分支、错误处理的最小执行引擎。
3. **定义声明式条件语言**：设计 JSON 格式的条件表达式规范，支持 `eq`, `gt`, `lt`, `and`, `or`, `contains`, `regex` 等操作符，替代 N8N 的可执行表达式。
4. **构建 Step 注册表**：实现 `StepTypeRegistry`，支持 Step Schema 注册、版本管理、Handler 绑定，验证两元结构的可行性。
5. **对比验证**：选取 N8N 的一个典型工作流（如"Webhook -> If -> HTTP Request -> Merge"），在推演器中复现其拓扑结构和执行语义，验证调度算法的正确性。
6. **文档化架构决策**：将本报告中的 AD-1~AD-5 和模式卡片转化为正式的 Architecture Decision Records（ADRs），纳入项目文档。

---

## 附录 A：关键代码引用索引

| 文件路径 | 行号范围 | 内容摘要 | 本报告引用节 |
|---------|---------|---------|------------|
| `packages/workflow/src/interfaces.ts` | 1-4200 | 核心类型定义（INode, INodeType, IExecuteFunctions, ITaskData, IRunExecutionData 等） | 4.1, 4.2, 5.1, 5.2 |
| `packages/workflow/src/workflow.ts` | 1-930 | Workflow 类（图模型、连接管理、节点查询） | 2.2, 4.1 |
| `packages/workflow/src/workflow-expression.ts` | 1-200 | 表达式解析引擎 | 3.3, 5.2-E2 |
| `packages/core/src/execution-engine/workflow-execute.ts` | 1-2903 | 执行引擎主类（processRunExecutionData, addNodeToBeExecuted, runNode） | 4.3, 4.5, 5.1-A3 |
| `packages/core/src/execution-engine/node-execution-context/execute-context.ts` | 1-200 | ExecuteContext 实现 | 4.2, 5.1-A2 |
| `packages/core/src/execution-engine/node-execution-context/base-execute-context.ts` | 1-200 | BaseExecuteContext（putExecutionToWait, executeWorkflow） | 4.6, 5.2-E3 |
| `packages/nodes-base/nodes/If/V2/IfV2.node.ts` | 1-154 | If 节点实现（条件分支） | 4.4.1, 5.3-R1 |
| `packages/nodes-base/nodes/Switch/V2/SwitchV2.node.ts` | 1-200 | Switch 节点实现（多路分支） | 4.4.2 |
| `packages/nodes-base/nodes/Code/Code.node.ts` | 1-236 | Code 节点实现（JS/Python 沙箱） | 3.1 |
| `packages/workflow/src/versioned-node-type.ts` | 1-31 | VersionedNodeType（版本化管理） | 3.1, 5.1-A1 |
| `packages/workflow/src/index.ts` | 1-50 | workflow 包导出 | 2.1 |

---

## 附录 B：术语对照表

| N8N 术语 | 推演器对应术语 | 说明 |
|---------|--------------|------|
| Workflow | Simulation / Scenario | 工作流 = 推演场景 |
| Node | Step | 节点 = 推演步骤 |
| Node Type | Step Type | 节点类型 = 步骤类型 |
| Item | State Snapshot | 数据项 = 状态快照 |
| Connection | Connection / Edge | 连接 = 边 |
| Execution | Simulation Run | 执行 = 推演运行 |
| TaskData | StepExecutionRecord | 任务数据 = 执行记录 |
| Pin Data | Mock State | 固定数据 = 模拟状态 |
| Expression | Condition | 表达式 = 条件 |

---

*报告完成时间：2026-07-24*
*调研范围：n8n-io/n8n @ main（commit 日期 2026-07-24）*
*调研方法：代码静态分析（interfaces.ts, workflow.ts, workflow-execute.ts, execute-context.ts, 节点实现）+ 架构文档交叉验证*
