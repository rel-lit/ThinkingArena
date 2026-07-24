# Masquerade 项目深度调研报告（P0-P4 合并终稿）

> 调研目标：理解 Masquerade 的架构核心设计、设计理念与抽象设计，提取可复用模式，为 ThinkingArena 的运行引擎架构提供信息支撑。
> 调研时间：2026-07-24
> 项目地址：https://github.com/GOODDAYDAY/Masquerade
> 协议：Apache 2.0 | 语言：Python + TypeScript | 规模：~59 Python 文件 + ~39 TS/TSX 文件

---

## 一、项目概况与定位

### 1.1 基本信息

| 属性 | 内容 |
|------|------|
| **项目地址** | https://github.com/GOODDAYDAY/Masquerade |
| **Star 数** | 0（未经社区验证） |
| **协议** | Apache 2.0 |
| **定位** | AI agents 玩桌游（谁是卧底、狼人杀）的全自动流水线 |
| **输出** | 交互式网页回放 + Remotion 2K 60fps 视频 |

### 1.2 全链路形态

```
模拟 -> Script JSON -> edge-tts -> React 回放 -> Remotion 出片
  ^_________|___________^
     Engine / Orchestrator / Agent / Script
```

### 1.3 在 ThinkingArena 中的定位

ThinkingArena 的 research.md 将其列为**第二参考书**，管**游戏引擎与 Script 记录**：

> "Masquerade--管游戏引擎与 Script 记录。已实现模拟 -> Script JSON -> edge-tts -> React 回放 -> Remotion 出片全链路；engine（纯规则 LLM 无关）/ orchestrator（回合驱动 + 并发批阶段）/ script（时间轴 + 内心独白 + 记忆快照）分工是已验证的设计。"

---

## 二、架构总览：六层分离

```
+-----------------------------------------------------------------+
|                        Frontend 层                               |
|  React + Vite 交互剧场 | Remotion 帧驱动视频渲染                    |
+-----------------------------------------------------------------+
|                        Script 层                                 |
|  GameScript JSON 契约 -- 时间轴、事件、记忆快照、投票结果              |
+-----------------------------------------------------------------+
|                      Orchestrator 层                             |
|  GameRunner -- 回合循环、并发批控制、事件广播、TTS 触发               |
+-----------------------------------------------------------------+
|                        Agent 层                                  |
|  PlayerAgent -- LangGraph 决策图（Thinker->Evaluator->Optimizer）    |
|  PlayerMemory -- 私有/公共记忆分离                                  |
+-----------------------------------------------------------------+
|                      Reasoning 层                                |
|  GameReasoningGraph -- SharedGraph + PrivateOverlay + Reasoner     |
|  零 LLM 调用的程序化推理层                                         |
+-----------------------------------------------------------------+
|                        Engine 层                                 |
|  GameEngine 抽象基类 -- 纯规则状态机，LLM 完全无关                    |
|  SpyGame / WerewolfGame -- 具体实现                                |
+-----------------------------------------------------------------+
```

**核心纪律**：Engine 与 LLM 完全解耦；Agent 与游戏规则完全解耦；Script 作为跨层唯一契约。

---

## 三、Engine 层深度解析（P1）

### 3.1 设计理念：纯规则状态机

> "Engine is a state machine -- each apply_action call advances the game state. Engines are pure game logic, independent of LLM or any AI framework."

**关键决策**：引擎不调用 LLM，不做任何 AI 相关操作。它只是**状态机 + 规则校验器**。

### 3.2 抽象基类设计（GameEngine）

`backend/engine/base.py` 定义了 14 个抽象方法 + 6 个可选覆盖方法：

**必须实现（状态查询）**：
- `setup()` -- 初始化游戏、分配角色
- `get_player_ids()` -- 玩家列表
- `get_public_state()` -- 全员可见信息
- `get_private_info(player_id)` -- 玩家私有信息（NOT 角色，只是该玩家能看到的额外信息）
- `get_role_info(player_id)` -- 上帝视角信息（仅用于记录，绝不给 Agent）
- `get_available_actions(player_id)` -- 当前可执行动作
- `apply_action(player_id, action)` -- 执行动作、推进状态
- `get_current_player()` -- 当前回合玩家
- `is_ended()` / `get_result()` -- 结束判断与结果
- `get_game_rules_prompt()` -- 游戏规则提示词（给 LLM）
- `get_tools_schema()` -- 当前阶段工具定义（OpenAI function calling 格式）
- `get_agent_strategy(player_id)` -- 游戏特定策略模板

**可选覆盖（Runner 集成）**：
- `get_actionable_players()` -- **并发批控制的核心**：返回多个玩家时 Runner 并行思考
- `format_action_log()` -- 日志格式化
- `get_broadcast_targets()` -- 广播目标控制（None=全员, []=不广播, [ids]=指定）
- `format_public_summary()` -- 公共摘要格式化
- `get_round_end_summary()` -- 回合结束摘要
- `get_vote_result()` -- 投票结果

### 3.3 注册表装饰器模式

```python
_REGISTRY: dict[str, type[GameEngine]] = {}

def register_game(name: str):
    def decorator(cls: type[GameEngine]) -> type[GameEngine]:
        _REGISTRY[name] = cls
        return cls
    return decorator

# 使用
@register_game("spy")
class SpyGame(GameEngine): ...
```

**新增游戏 = 继承 + 装饰器 + 配置 YAML**，无需修改引擎核心。

### 3.4 状态机实现对比

| 维度 | SpyGame（谁是卧底） | WerewolfGame（狼人杀） |
|------|-------------------|----------------------|
| 阶段数 | 4（waiting->speaking->voting->eliminating->ended） | 12（复杂日夜循环） |
| 并发点 | 投票阶段全员并行 | 投票阶段全员并行 |
| 特殊机制 | 空白牌、连续平局 | 角色技能（预言家/女巫/猎人/守卫）、遗言、猎人开枪 |
| 私有信息 | 仅词（不暴露角色） | 角色 + 阵营 + 角色特定信息（狼队友/查验结果/药水状态） |

### 3.5 关键设计：public / private / role_info 三级信息分离

```python
get_public_state()   # 全员可见 -> 给所有 Agent
get_private_info()   # 该玩家可见（不含角色）-> 给特定 Agent
get_role_info()      # 上帝视角（含角色）-> 仅给 Recorder，绝不给 Agent
```

**这是防"吃书"和防提示词注入的关键机制**。Werewolf 中 `private_info` 会暴露角色，因为狼人杀规则要求玩家知道自己的角色；但 Spy 中 `private_info` 只给词，不给角色（卧底不知道自己是不是卧底）。

---

## 四、Orchestrator 层深度解析（P1）

### 4.1 GameRunner：游戏无关的通用驱动器

`backend/orchestrator/runner.py` 的 `GameRunner` 是**完全游戏无关**的。它通过 Engine 的接口方法驱动任意游戏。

### 4.2 核心循环结构

```python
async def run(self) -> GameScript:
    engine, player_configs = self._setup_engine()      # 1. 创建引擎
    self._setup_grg(player_configs)                     # 2. 初始化推理图
    agents = self._create_agents(player_configs)        # 3. 创建 Agent
    recorder = self._setup_recorder(engine, player_configs)  # 4. 创建记录器
    await self._run_game_loop(engine, agents, recorder) # 5. 主循环
    return self._finalize_game(engine, recorder)        # 6. 收尾
```

### 4.3 主循环：Round -> Batch -> Action

```python
while not engine.is_ended():
    recorder.start_round(current_round)
    
    # 处理回合内所有动作批次
    while not engine.is_ended() and same_round:
        batch = engine.get_actionable_players()
        if len(batch) == 1:
            await self._process_serial(...)   # 串行
        else:
            await self._process_batch(...)    # 并发批
```

### 4.4 并发批处理：Think-Concurrent-Apply-Serial（核心模式）

这是 Masquerade 最核心的并发控制模式：

```python
async def _process_batch(engine, agents, batch, phase, recorder, max_concurrency):
    # 1. 公平性：在任何动作前快照所有 Agent 的上下文
    contexts = self._snapshot_contexts(engine, batch)
    
    # 2. 并发思考：所有 Agent 同时调用 LLM（带信号量限流）
    results = await self._think_concurrent(agents, contexts, max_concurrency)
    
    # 3. 串行应用：逐个将结果写入引擎状态、记录、广播
    self._apply_and_record_results(engine, agents, results, contexts, phase, recorder)
```

**为什么必须串行应用**：
- 引擎状态机是单线程的，`apply_action` 会改变游戏状态
- 并发应用会导致状态竞争（如两个玩家同时投票，各自看到不同的票数）

**上下文快照的公平性**：
```python
def _snapshot_contexts(self, engine, batch):
    for pid in batch:
        contexts[pid] = {
            "strategy": engine.get_agent_strategy(pid),
            "public_state": engine.get_public_state(),      # 同一时刻的公共状态
            "private_info": engine.get_private_info(pid),   # 各玩家私有信息
            "available_actions": engine.get_available_actions(pid),
            "rules_prompt": engine.get_game_rules_prompt(),
            "tools_schema": engine.get_tools_schema(),
            "grg_thinker_ctx": self.grg.get_thinker_context(pid, alive_players),
            "grg_evaluator_ctx": self.grg.get_evaluator_context(pid),
        }
```

所有 Agent 基于**同一时刻**的公共状态做决策，避免后决策者获得信息优势。

### 4.5 事件广播机制

```python
def _broadcast_action(self, engine, agents, player_id, action):
    targets = engine.get_broadcast_targets(player_id, action)
    summary = engine.format_public_summary(player_id, action)
    for pid in targets:
        agents[pid].update_public_memory(summary)
```

**广播规则由 Engine 控制**：
- 发言 -> 全员可见
- 投票 -> 秘密（[]）
- 狼人讨论 -> 仅狼人可见
- 夜晚动作 -> 不可见（[]）

### 4.6 EventBus：发布订阅解耦

```python
class EventBus:
    def subscribe(self, event_type: str, callback: Callable) -> None
    def emit(self, event_type: str, data: Any = None) -> None
```

用于组件间松耦合通信（如 game_start / round_start / player_action / game_end）。

---

## 五、Agent 层深度解析（P2）

### 5.1 PlayerAgent：LangGraph 决策工作流

每个玩家一个 `PlayerAgent`，内部运行一个编译后的 LangGraph：

```python
class PlayerAgent:
    def __init__(self, player_id: str, config: PlayerConfig):
        self.memory = PlayerMemory()
        self.llm_client = LLMClient(...)
        self.graph = build_player_graph(self.llm_client)
```

### 5.2 三节点决策图（Thinker -> Evaluator -> Optimizer）

```
+---------+     +-----------+     +-----------+
| Thinker |---->| Evaluator |---->| Optimizer |--> END
| 局势分析 |     | 策略评估   |     | 内容优化   |
| 策略生成 |     | 评分+反馈  |     | 表情选择   |
+---------+     +-----+-----+     +-----------+
       ^--------------+（评分低于阈值时重试）
```

**Thinker** (`backend/agent/nodes/thinker.py`)：
- 使用游戏特定的 `thinker_prompt` 模板
- 调用 LLM 进行局势分析和策略生成
- 输出：situation_analysis, strategy, action_type, action_content, expression

**Evaluator**：
- 评估 Thinker 输出的策略质量
- 评分低于 `evaluation_threshold` 时触发重试
- 输出：evaluation_score, evaluation_feedback

**Optimizer**：
- 优化最终输出内容
- 选择表情（expression）
- 生成 strategy_tip

### 5.3 策略注入：AgentStrategy 契约

```python
class AgentStrategy(BaseModel):
    thinker_prompt: str
    evaluator_prompt: str
    optimizer_prompt: str
    evaluation_threshold: float = 6.0
    max_retries: int = 2
```

**游戏特定策略通过 Engine.get_agent_strategy() 注入**，Agent 层完全不知道游戏细节。这是"配置驱动行为"的典型实现。

### 5.4 PlayerMemory：公私分离

```python
class PlayerMemory:
    def __init__(self):
        self.private_memory: list[str] = []  # 内心独白
        self.public_memory: list[str] = []   # 观察到的事件
    
    def build_context_messages(self) -> list[dict]:
        # 公共记忆 -> user 消息
        # 私有记忆 -> assistant 消息
```

**记忆注入 LangGraph 初始状态**：
```python
initial_state = {
    "memory_context": self.memory.build_context_messages(),
    # ... 其他上下文
}
```

### 5.5 错误恢复机制

```python
async def _invoke_graph(self, initial_state, available_actions, start_time):
    try:
        return await self.graph.ainvoke(initial_state)
    except Exception as e:
        return self._build_fallback_result(available_actions)
```

Graph 执行失败时回退到默认响应，确保游戏不会因单个 Agent 故障而中断。

---

## 六、Reasoning 层深度解析（P2）

### 6.1 GameReasoningGraph（GRG）：零 LLM 的程序化推理

GRG 是 Masquerade 的一个独特设计：**在 LLM 调用之外，维护一个公共事实图谱，进行程序化推理**。

```python
class GameReasoningGraph:
    def setup(self, player_ids, personas) -> None
    def update_round(self, round_number, public_state) -> None
    def update_private(self, player_id, round_number, private_info) -> None
    def record_action(self, player_id, action_type, payload) -> None
    def get_thinker_context(self, player_id, alive_players) -> str
    def get_evaluator_context(self, player_id) -> str
```

### 6.2 SharedGraph：公共事实图谱

使用 NetworkX 维护多关系有向图：

```python
class SharedGraph:
    def update(self, round_number, edges: list[GraphEdge]) -> None
    def get_public_conflicts(self) -> list[Conflict]
    def get_faction_clusters(self) -> dict[str, list[str]]
    def get_vote_alignment(self) -> dict[tuple[str, str], int]
```

**边类型**：VOTES_FOR / ACCUSES / DEFENDS / CLAIMS_ROLE / CONTRADICTS / VERIFIED / TEAMMATE / KILLED

**缓存分析结果**（每轮刷新一次，N 个玩家读取零成本）：
- 矛盾检测（发言-投票矛盾、角色声称冲突、态度翻转）
- 投票对齐矩阵（哪些玩家连续投票给同一目标）
- 阵营聚类（基于模块度的社区发现）

### 6.3 PrivateOverlay：私有知识覆盖

```python
class PrivateOverlay:
    def get_known_wolves(self) -> list[str]      # 狼人知道队友
    def get_known_good(self) -> list[str]        # 预言家查验结果
    def get_teammates(self) -> list[str]         # 队友关系
    def get_inferences(self) -> list[ReasoningChain]
```

### 6.4 Reasoner：信任/怀疑评分引擎

```python
class Reasoner:
    def reason(self, player_id, shared, overlay, bias, alive_players):
        # 返回：(trust_map, suspicion_map, reasoning_chains)
```

**推理流程**：
1. 从公共图计算基础信任/怀疑分数
2. 用私有知识覆盖（狼队友 -> 信任 1.0，查验狼 -> 怀疑 1.0）
3. 应用认知偏差调整（从众偏差等）
4. 构建推理链（前提 -> 结论 -> 置信度）

### 6.5 认知偏差模型

```python
@dataclass
class CognitiveBias:
    evidence_weights: dict[str, float]  # 各类证据的权重
    conclusion_threshold: float         # 结论阈值
    attention_focus: AttentionFocus     # 关注焦点（近期/长期/社交/细节）
    stubbornness: float                 # 固执程度
```

**偏差从玩家 persona 量化提取**，使不同性格的玩家有不同的推理风格。

---

## 七、Script 层深度解析（P3）

### 7.1 Script 作为单一事实源

```python
class GameScript(BaseModel):
    game: GameInfo
    players: list[PlayerInfo]
    rounds: list[RoundData]
    result: GameResult | None

class GameEvent(BaseModel):
    player_id: str
    phase: str
    timestamp: datetime
    thinking_duration_ms: int
    thinking: str           # 内心独白
    expression: str         # 表情
    action: Action
    strategy_tip: str
    memory_snapshot: MemorySnapshot  # 记录时刻的记忆状态
```

### 7.2 关键设计：MemorySnapshot

每个事件都包含**记录时刻的记忆快照**：
```python
class MemorySnapshot(BaseModel):
    private: list[str]   # 该玩家当时的私有记忆（最近 3 条）
    public: list[str]    # 该玩家当时的公共记忆（最近 5 条）
```

这使得下游可以**精确重建玩家在任何时刻的认知状态**，对复盘和视频生成至关重要。

### 7.3 Recorder：被动观察者

```python
class GameRecorder:
    """Operates as a passive observer -- recording failures do not affect game logic."""
```

Recorder 的失败不会中断游戏，这是事件记录系统的关键纪律。

### 7.4 前后端契约共享

`backend/script/schema.py`（Pydantic）与 `frontend/src/types/game-script.ts`（TypeScript 接口）**手动保持同步**：

```typescript
export interface GameScript {
  game: GameInfo;
  players: PlayerInfo[];
  rounds: RoundData[];
  result: GameResultData | null;
}
```

### 7.5 下游消费

Script JSON 被三个下游消费：
1. **交互式回放**：React 剧场直接读取
2. **TTS 生成**：edge-tts 按事件生成音频
3. **视频渲染**：Remotion 按时间轴渲染

---

## 八、Frontend 层深度解析（P3）

### 8.1 游戏无关的 React 组件

> "Frontend scenes are game-agnostic -- new games work automatically"

核心组件：
- `Theater` -- 主剧场容器
- `PlaybackControls` -- 播放控制
- `Timeline` -- 时间轴控制器
- `AudioManager` -- 音频管理

场景组件：
- `OpeningScene` -- 开场
- `SpeakingScene` -- 发言场景
- `VotingScene` -- 投票场景
- `ActionScene` -- 动作场景
- `FinaleScene` -- 结局

### 8.2 Remotion 视频渲染

```typescript
// frontend/src/remotion/Video.tsx
// 帧驱动、确定性渲染
// Same input = same output, every time
```

### 8.3 前后端分离原则

Frontend 不直接连接 Backend。它通过**文件拖放**加载 Script JSON：

```typescript
// 用户拖放 game_xxx.json 到浏览器
// frontend 独立运行，无后端依赖
```

---

## 九、可复用模式提取（P4）

### 模式 1：抽象引擎 + 注册表装饰器（Engine Registry Pattern）

```python
class GameEngine(ABC):
    @abstractmethod
    def apply_action(self, player_id, action): ...

_REGISTRY: dict[str, type[GameEngine]] = {}

def register_game(name: str):
    def decorator(cls): 
        _REGISTRY[name] = cls
        return cls
    return decorator
```

**适用场景**：任何需要"规则驱动 + 可扩展游戏类型"的模拟系统。
**ThinkingArena 映射**：编排层的组件节点注册、游戏流程图的节点类型注册。

### 模式 2：Think-Concurrent-Apply-Serial（TCAS）

```
[快照上下文] -> [并发思考 LLM 调用] -> [串行应用状态变更]
```

**核心纪律**：
1. 思考前快照所有上下文（公平性）
2. LLM 调用完全并发（效率）
3. 状态变更严格串行（正确性）

**适用场景**：多 Agent 同时决策但状态必须顺序更新的任何系统。
**ThinkingArena 映射**：并行分支的 Agent 调用必须遵循此模式；导演门阻塞时其他分支照常推进。

### 模式 3：Script-as-Source-of-Truth（事件即事实）

```python
state = reduce(state, event)  # 纯函数
# 崩溃恢复 = 重放 JSONL
```

**关键设计**：
- 一切状态变化落盘为事件
- 可重放、可归因、可分叉
- 分支条件在遍历瞬间求值，快照作为事件落盘

**适用场景**：任何需要可复现、可审计、可分叉的模拟系统。
**ThinkingArena 映射**：事件即真相（architecture.md 4.1），Script JSONL 树结构。

### 模式 4：SharedGraph + PrivateOverlay（分层推理）

```
SharedGraph（公共事实） <- 所有玩家可读
    ^
PrivateOverlay（私有知识） <- 仅该玩家可读
    ^
Reasoner（推理引擎） <- 零 LLM 调用
```

**适用场景**：多 Agent 共享公共环境但各有私有信息的推理场景。
**ThinkingArena 映射**：黑板（公共数据面）+ Agent 私有上下文的分层设计。

### 模式 5：LangGraph 三节点决策循环（TEO Pattern）

```
Thinker（生成）-> Evaluator（评估）-> [重试] -> Optimizer（优化）
```

**关键机制**：评估阈值 + 重试次数限制 + 反馈注入。

**适用场景**：任何需要"生成-评估-优化"闭环的 Agent 决策。
**ThinkingArena 映射**：组件内部的决策循环；裁判判定也可采用类似模式。

### 模式 6：三级信息分离（Public / Private / God）

| 级别 | 可见范围 | 用途 |
|------|---------|------|
| public_state | 所有 Agent | 公共环境 |
| private_info | 特定 Agent | 该角色的私有信息（不含角色本身） |
| role_info | 仅记录器 | 上帝视角，用于 Script 和复盘 |

**适用场景**：任何需要防止信息泄露的多 Agent 模拟。
**ThinkingArena 映射**：黑板（公共）+ Agent 私有上下文 + 导演上帝视角。

### 模式 7：策略注入（Strategy Injection）

```python
class AgentStrategy(BaseModel):
    thinker_prompt: str
    evaluator_prompt: str
    optimizer_prompt: str
```

**Agent 层通用，游戏特定策略通过配置注入**。

**适用场景**：通用 Agent 框架 + 领域特定提示模板。
**ThinkingArena 映射**：身份牌（identity_card_v1）+ L0-L9 prompt 分层。

### 模式 8：Pydantic 契约层（Schema-First）

前后端共享 Pydantic/TypeScript 类型定义，作为**唯一数据契约**。

**适用场景**：任何前后端分离的项目。
**ThinkingArena 映射**：schema/ 目录下的四份契约（事件/流程图/元组件/身份牌）。

---

## 十、与 ThinkingArena 的映射关系

| Masquerade | ThinkingArena | 关系 |
|-----------|--------------|------|
| Engine | 组件层（components/） | **知识级嫁接**：Engine 抽象 -> 组件抽象；状态机 -> 组件行为 |
| Orchestrator | 编排层（orchestrator/） | **知识级嫁接**：Runner 循环 -> DAG 执行器；TCAS -> 并行分支执行 |
| Agent | 服务层（services/agent） | **知识级嫁接**：PlayerAgent -> Agent 服务实例；LangGraph -> 决策循环参考 |
| Script | 事件契约（schema/事件） | **知识级嫁接**：GameScript -> Script JSONL 树；MemorySnapshot -> 事件 payload |
| Reasoning (GRG) | 黑板 + 记忆系统 | **知识级嫁接**：SharedGraph -> 黑板数据面；PrivateOverlay -> 私有上下文 |
| EventBus | 事件总线 / 发射元组件 | **知识级嫁接**：emit -> 发射元组件 |
| Strategy | 身份牌 + prompt 分层 | **知识级嫁接**：AgentStrategy -> identity_card_v1 + L0-L9 |

---

## 十一、局限性与风险

### 11.1 项目自身局限

| 局限 | 说明 |
|------|------|
| 0 star，未经社区验证 | 设计已验证但未经大规模测试 |
| Python 实现 | ThinkingArena 选型为 TypeScript，需知识级移植 |
| LangGraph 依赖 | Agent 层强耦合 LangGraph，ThinkingArena 计划自研薄核心 |
| 手动前后端同步 | Script schema 无自动生成，前后端类型靠人工维护 |
| 无导演干预 | 全自动运行，无人类导演介入机制 |
| 无成本追踪 | Script 不包含 LLM 调用成本信息 |

### 11.2 与 ThinkingArena 的域错位

| 错位点 | Masquerade | ThinkingArena |
|--------|-----------|---------------|
| 控制流 | 回合制状态机 | 配置化 DAG |
| 干预 | 无 | 导演门（核心机制） |
| 多局记忆 | 无 | Agent 跨局存续 |
| 成本约束 | 无 | 缓存双轨台账 |
| 编排语义 | 硬编码循环 | YAML 配置流程图 |
| 裁判 | 无（胜负条件在引擎） | Narrator + Archivist 双 Agent |

---

## 十二、结论

### 12.1 核心价值

Masquerade 作为 ThinkingArena 的**第二参考书**，其已验证的设计价值在于：

1. **Engine/Orchestrator/Script 的分工边界** -- 证明了"纯规则引擎 + LLM Agent + 结构化记录"三层分离的可行性
2. **TCAS 并发模式** -- 并发思考-串行应用是多 Agent 模拟的核心纪律
3. **Script 作为跨层契约** -- 结构化事件记录使下游完全解耦
4. **GRG 分层推理** -- 公共图 + 私有覆盖 + 程序化推理是高效的多 Agent 认知架构

### 12.2 吸收清单（ThinkingArena 采纳点）

| # | 吸收点 | 来源文件 | 实现位置 |
|---|--------|---------|---------|
| 1 | Engine 抽象基类 + 注册表装饰器 | `engine/base.py`, `engine/registry.py` | `components/` 组件注册 |
| 2 | TCAS 并发批处理 | `orchestrator/runner.py` `_process_batch` | `orchestrator/` DAG 执行器并行分支 |
| 3 | Script 时间轴 + 记忆快照 | `script/schema.py` `MemorySnapshot` | `schema/` 事件契约 |
| 4 | 三级信息分离 | `engine/base.py` `get_public/private/role_info` | `services/agent` 上下文投影 |
| 5 | 策略注入契约 | `agent/strategy.py` `AgentStrategy` | `design/identity-card.md` L0-L9 |
| 6 | EventBus 发布订阅 | `orchestrator/event_bus.py` | `meta/` 事件发射元组件 |
| 7 | 共享图推理架构 | `reasoning/shared_graph.py` | `services/blackboard` + `reasoning/` |

### 12.3 排除清单（ThinkingArena 不采纳）

| # | 排除项 | 理由 |
|---|--------|------|
| 1 | LangGraph 依赖 | ThinkingArena 自研薄核心，不引入重框架 |
| 2 | 硬编码回合循环 | ThinkingArena 用配置化 DAG |
| 3 | Python 实现 | 选型 TypeScript |
| 4 | 无导演干预 | ThinkingArena 核心机制是导演门 |
| 5 | 手动前后端类型同步 | ThinkingArena 用 Zod -> JSON Schema 生成 |

---

> **最终判定**：Masquerade 的架构设计在 Engine/Orchestrator/Script 三层有**已验证的参考价值**，但其 0 star 状态意味着设计质量未经社区检验。ThinkingArena 采取"只读不复制"策略——吸收其架构判断，但自研实现，不继承代码。
