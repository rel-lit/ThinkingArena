## 阶段 0：运转架构设计（1 个 Agent）

### 任务名称

```
thinkingarena-architect
```

### 输入

- `docs/overview.md`（全文）
- `docs/investigation/` 下 5 份调研报告（pi、Masquerade、n8n、ChatRPG-v2、SillyTavern）
- `docs/scenarios/isekai-survival.md`（MVP 场景需求）
- `docs/core-loop.md`（领域模型）
- `docs/architecture.md`（总体架构）

### 任务

产出《运转架构文档》（`docs/design/runtime-architecture.md`），必须包含以下 5 个章节，缺一不可：

#### 章节 1：数据流图

画出完整的系统数据流图，标注每条数据流的：

- 格式（JSON / YAML / 二进制 / 流）
- 同步性（sync / async）
- 错误时行为（重试 / 降级 / 终止 / 记录）
- 是否落盘为事件

必须覆盖以下流：

- 导演输入 → 导演门 → 编排器
- 编排器 → 组件 → 元组件 → 服务层
- Agent 间通信（agent_to_agent）
- 服务调用（TTS / 生图 / 视频）
- 状态变更 → 黑板 → 事件流

#### 章节 2：关键时序图

用文本时序图（Mermaid 语法）描述以下 3 个核心场景：

1. **导演门完整生命周期**：到达 → 阻塞分支 → 其他分支继续 → 导演注入 → 解除阻塞 → 继续执行
2. **Agent 单回合执行**：编排器调用 → 上下文组装 → LLM 调用 → 工具调用 → 状态更新 → 事件落盘
3. **崩溃恢复**：启动 → 读取最新快照 → 重放 JSONL → 恢复到崩溃前状态

#### 章节 3：状态机定义

为以下 3 个实体定义精确状态机（状态 + 转移条件 + 触发事件）：

- Agent 实例（CREATED / IDLE / RUNNING / PAUSED / ERROR / DESTROYED）
- 导演门（IDLE / WAITING / RECEIVED / INJECTED / CANCELLED）
- DAG 执行器（IDLE / RUNNING / PAUSED / ERROR / COMPLETED）

每个转移必须标注：触发条件、执行动作、是否落盘事件。

#### 章节 4：接口草图

用 TypeScript 伪代码（非实现，仅签名）定义以下模块间接口：

- `AgentService`（create / destroy / steer / runTurn）
- `Blackboard`（get / set / emit / subscribe / snapshot）
- `EventLog`（append / replay / branch / snapshot）
- `LLMGateway`（route / call / fallback）
- `FlowRunner`（run / pause / resume / cancel）

每个接口方法标注：参数类型、返回类型、错误类型、是否异步。

#### 章节 5：错误处理矩阵

一张表格，覆盖所有模块间调用：

表格





| 调用方 | 被调用方 | 错误类型 | 处理策略 | 是否落盘 | 是否通知导演 |
| :----- | :------- | :------- | :------- | :------- | :----------- |
| ...    | ...      | ...      | ...      | ...      | ...          |

必须覆盖：超时、Schema 校验失败、LLM 调用失败、缓存失效、并发冲突。

### 验收标准

1. 文档中每个设计决策都有来源标注（如"参考 pi 的 Turn 快照机制"或"基于 isekai-survival 的 6 步流程"）
2. 数据流图中没有"魔法箭头"——每条流都有明确的格式和错误处理
3. 状态机没有死状态（任意状态都有出边或明确为终止态）
4. 接口草图中每个方法的错误类型都是枚举，不是 `Error`

### 禁止

- 不写实现代码
- 不定义具体字段（留给 Schema Agent）
- 不引入新框架或库