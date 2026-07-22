# AI Agent 思维实验竞技场 — 全局技术方案

> **版本**: v1.0  
> **日期**: 2026-07-22  
> **目标**: 构建一个可复用的AI Agent对抗内容生产系统，输入思维实验话题，自动产出多LLM对抗过程视频，适配B站发布。  
> **核心约束**: 最小化造轮子，最大化复用现有开源项目。

---

## 一、核心任务定义

### 1.1 业务目标

构建一个**"AI Agent思维实验沙盒"**：
- **输入**: 一个脑洞话题（如"末日到来，10种物品只能选一样，8种LLM谁能活到最后"）
- **处理**: N个不同LLM（GPT-4o、DeepSeek、Claude、豆包等）作为独立Agent，在自定义规则下进行多轮对抗/辩论/决策
- **输出**: 完整的对抗过程视频（含角色立绘、对话气泡、状态面板、TTS语音、字幕），可直接上传B站

### 1.2 关键场景示例

| 场景 | 话题 | Agent数 | 核心机制 |
|------|------|---------|---------|
| 末日求生 | 10种物品选1，谁能活到最后 | 8 | 物品选择 + 环境事件 + 冲突判定 |
| 伦理困境 | 电车难题变体，各模型如何决策 | 6 | 道德推理 + 互相质疑 |
| 资源博弈 | 有限资源分配，合作还是背叛 | 8 | 囚徒困境 + 动态联盟 |
| 历史重演 | 如果你是XX历史人物，如何决策 | 5 | 角色扮演 + 策略推演 |

### 1.3 非功能性需求

- **多LLM供应商支持**: OpenAI、DeepSeek、Anthropic、字节跳动（豆包）等，可灵活扩展
- **规则可配置**: 话题、物品、事件、胜负条件均通过YAML配置，无需改代码
- **流程可自定义**: 回合制、自由辩论、淘汰制等模式可切换
- **视频自动化**: 从对抗过程到成片视频，一键生成
- **成本可控**: 支持大小模型混合策略，降低Token消耗

---

## 二、系统架构

### 2.1 总体架构图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              视频输出层 (Video Output)                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │   Remotion   │  │  edge-tts    │  │   字幕生成   │  │   封面生成   │   │
│  │  帧驱动渲染  │  │  语音合成    │  │  弹幕优化    │  │  标题优化    │   │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
                                      ↑
┌─────────────────────────────────────────────────────────────────────────────┐
│                              编排控制层 (Orchestration)                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │  话题模板引擎 │  │  LangGraph   │  │  JSON Script │  │  关键帧提取  │   │
│  │  YAML配置驱动 │  │  状态机控制  │  │  结构化日志  │  │  高潮标记    │   │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
                                      ↑
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Agent对抗层 (Battle Arena)                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │   GPT-4o     │  │  DeepSeek    │  │   Claude     │  │    豆包      │   │
│  │   Agent 1    │  │   Agent 2    │  │   Agent 3    │  │   Agent 8    │   │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                      │
│  │   裁判Agent   │  │   叙事Agent   │  │   环境Agent   │                      │
│  │  规则仲裁    │  │  氛围渲染    │  │  事件触发    │                      │
│  └──────────────┘  └──────────────┘  └──────────────┘                      │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 数据流

```
话题配置(YAML) ──→ GameEngine ──→ Agent对抗 ──→ JSON Script ──→ Remotion ──→ MP4视频
                      ↑              ↑              ↑
                  LangGraph      LiteLLM        结构化日志
                  状态机控制     多模型接入      完整可回放
```

---

## 三、技术选型与理由

### 3.1 核心框架: Masquerade（Fork改造）

**GitHub**: `https://github.com/GOODDAYDAY/Masquerade`

**选型理由**:
1. **最接近需求**: 已完整实现"多Agent对抗 -> 结构化日志 -> 视频渲染"全链路
2. **架构清晰**: GameEngine / Agent / Orchestrator / Script / Frontend 分层解耦
3. **扩展友好**: 新增游戏只需继承`GameEngine`基类 + 写YAML配置
4. **视频内置**: 基于Remotion的帧驱动渲染，2K 60fps输出，无需额外视频工具
5. **开源协议**: Apache 2.0，可自由修改分发

**复用范围**:
| 组件 | 复用度 | 说明 |
|------|--------|------|
| Orchestrator | 100% | 并发调度、回合控制 |
| Agent基类 | 90% | LangGraph + 记忆机制，只需扩展多模型配置 |
| Script/JSON日志 | 100% | 结构化记录格式 |
| TTS (edge-tts) | 100% | 免费微软语音 |
| 前端React剧场 | 100% | 游戏无关，拖入JSON即播放 |
| Remotion渲染 | 100% | 帧驱动，确定性输出 |

**需改造部分**:
| 组件 | 工作量 | 说明 |
|------|--------|------|
| 新增GameEngine | 2-3天 | 继承基类，定义思维实验规则 |
| Agent多模型配置 | 0.5天 | 每个Agent独立指定LLM供应商 |
| 话题模板化 | 1天 | YAML驱动，支持批量话题 |

### 3.2 Agent编排: LangGraph

**选型理由**:
- Masquerade已基于LangGraph实现Agent，无需引入新框架
- 状态机模型天然适合**回合制思维实验**的流程控制
- 支持条件分支（如淘汰判定、环境事件触发）
- 与LangChain生态兼容，工具调用成熟

**核心状态机设计**:
```
[初始化话题] -> [各Agent选择/决策] -> [裁判仲裁] -> [环境事件] -> [状态更新]
                                              ↓
                                        [是否结束?]
                                              ↓
                                        [是] -> [生成叙事] -> [输出JSON]
                                              ↓
                                        [否] -> [下一轮]
```

### 3.3 多LLM接入: LiteLLM

**选型理由**:
- 统一接口访问OpenAI、DeepSeek、Anthropic、字节跳动等所有主流供应商
- 支持模型路由、负载均衡、失败重试
- 与LangChain/LangGraph无缝集成
- 内置成本追踪，便于控制预算

**配置示例**:
```yaml
model_list:
  - model_name: gpt-4o
    litellm_params:
      model: openai/gpt-4o
      api_key: os.environ/OPENAI_API_KEY
  - model_name: deepseek-chat
    litellm_params:
      model: deepseek/deepseek-chat
      api_key: os.environ/DEEPSEEK_API_KEY
  - model_name: claude-sonnet
    litellm_params:
      model: anthropic/claude-3-5-sonnet-20241022
      api_key: os.environ/ANTHROPIC_API_KEY
```

### 3.4 视频渲染: Remotion

**选型理由**:
- Masquerade已集成，无需额外选型
- React组件化定义视频，开发者友好
- 帧驱动渲染，**确定性输出**（相同输入=相同视频）
- 支持2K 60fps、H.264编码、GPU加速
- 可编程动画（Framer Motion），适合对话气泡、状态面板等UI元素

### 3.5 语音合成: edge-tts

**选型理由**:
- Masquerade已集成，免费使用微软Azure TTS
- 支持多语言、多音色
- 离线可用，无需额外API成本

### 3.6 配置管理: YAML + Pydantic

**选型理由**:
- Masquerade已使用Pydantic做配置校验
- YAML便于非技术人员编写话题模板
- 支持继承和引用，批量生成话题效率高

---

## 四、目录结构

```
ai-arena/
├── backend/
│   ├── main.py                 # CLI入口
│   ├── engine/
│   │   ├── base.py             # GameEngine抽象基类 [复用Masquerade]
│   │   ├── spy/                # 谁是卧底 [示例]
│   │   ├── werewolf/           # 狼人杀 [示例]
│   │   └── survival/           # 新增: 末日求生
│   │       ├── __init__.py
│   │       ├── game.py         # 核心规则引擎
│   │       └── strategy.py     # Agent策略提示词
│   ├── agent/
│   │   ├── base.py             # Agent基类 [复用Masquerade]
│   │   ├── player.py           # LLM玩家Agent [扩展多模型]
│   │   ├── referee.py          # 新增: 裁判Agent
│   │   ├── narrator.py         # 新增: 叙事Agent
│   │   └── environment.py      # 新增: 环境Agent
│   ├── orchestrator/
│   │   └── runner.py           # 游戏运行器 [复用Masquerade]
│   ├── script/
│   │   └── recorder.py         # JSON日志记录 [复用Masquerade]
│   ├── tts/
│   │   └── generate.py         # TTS生成 [复用Masquerade]
│   └── core/
│       ├── config.py           # 配置管理 [复用Masquerade]
│       └── models.py           # Pydantic模型
├── frontend/
│   ├── src/
│   │   ├── components/         # 交互剧场组件 [复用Masquerade]
│   │   ├── remotion/           # 视频渲染组件 [复用Masquerade]
│   │   └── core/               # 时间轴/音频管理 [复用Masquerade]
│   └── package.json
├── config/
│   ├── app_config.yaml         # 全局配置(LLM/并发/日志)
│   └── games/
│       ├── survival_base.yaml  # 末日求生基础配置
│       └── topics/             # 话题模板库
│           ├── survival_forest.yaml
│           ├── survival_city.yaml
│           └── ethical_trolley.yaml
├── scripts/
│   ├── run.bat                 # Windows一键流水线
│   ├── run.sh                  # Linux/Mac一键流水线
│   └── render-video.mjs        # Remotion渲染脚本 [复用Masquerade]
├── output/
│   ├── scripts/                # JSON对抗日志
│   ├── audio/                  # TTS音频文件
│   └── videos/                 # 最终MP4视频
└── requirements.txt
```

---

## 五、核心模块设计

### 5.1 GameEngine（新增）

```python
# backend/engine/survival/game.py
from backend.engine.base import GameEngine, register_game
from pydantic import BaseModel
from typing import List, Dict, Optional

class SurvivalState(BaseModel):
    round: int
    agents: List[AgentState]
    environment: EnvironmentState
    eliminated: List[str]
    events: List[Event]
    winner: Optional[str]

@register_game("survival")
class SurvivalGame(GameEngine):
    """末日求生思维实验引擎"""

    def __init__(self, config: dict):
        super().__init__(config)
        self.items = config["items"]           # 可选物品列表
        self.max_rounds = config["rounds"]     # 最大轮数
        self.events_pool = config["events"]    # 环境事件池
        self.agents = []

    def initialize(self) -> SurvivalState:
        # 1. 各Agent选择物品
        for agent in self.agents:
            agent.choose_item(self.items)
        # 2. 初始化环境
        env = self.generate_environment()
        return SurvivalState(
            round=1,
            agents=self.agents,
            environment=env,
            eliminated=[],
            events=[],
            winner=None
        )

    def run_round(self, state: SurvivalState) -> SurvivalState:
        # 1. 触发环境事件
        event = self.draw_event(state)
        state.events.append(event)

        # 2. 各Agent决策（并发调用）
        actions = self.orchestrator.parallel_decide(state.agents, event)

        # 3. 裁判仲裁
        eliminated = self.referee.judge(state, actions, event)
        state.eliminated.extend(eliminated)

        # 4. 检查结束条件
        if len(state.agents) - len(state.eliminated) <= 1:
            state.winner = self.determine_winner(state)

        state.round += 1
        return state

    def is_finished(self, state: SurvivalState) -> bool:
        return state.winner is not None or state.round > self.max_rounds
```

### 5.2 Agent多模型配置（扩展）

```yaml
# config/games/survival_base.yaml
game_type: survival
players:
  - name: "GPT-4o"
    persona: "理性分析型，擅长逻辑推理和资源整合"
    model: "gpt-4o"
    api_base: "https://api.openai.com/v1"
    temperature: 0.7

  - name: "DeepSeek"
    persona: "策略型，善于长远规划和风险评估"
    model: "deepseek-chat"
    api_base: "https://api.deepseek.com/v1"
    temperature: 0.8

  - name: "Claude"
    persona: "谨慎型，重视道德约束和团队生存"
    model: "claude-3-5-sonnet-20241022"
    api_base: "https://api.anthropic.com/v1"
    temperature: 0.6

  - name: "豆包"
    persona: "实用型，注重当下利益和快速决策"
    model: "doubao-pro-32k"
    api_base: "https://ark.cn-beijing.volces.com/api/v3"
    temperature: 0.9
    # ... 可扩展到8个Agent

items:
  - name: "打火机"
    description: "可生火取暖、照明、驱赶野兽"
    durability: 100
  - name: "抗生素"
    description: "治疗感染，关键时刻救命"
    durability: 5
  # ... 共10种

round_events:
  - id: "storm"
    description: "突发暴雨，体温下降，需要避雨或生火"
    effects: ["cold_damage", "fire_bonus"]
  - id: "bandits"
    description: "遭遇其他幸存者团伙，可能合作或冲突"
    effects: ["social_encounter"]
  # ... 更多事件
```

### 5.3 裁判Agent（新增）

```python
# backend/agent/referee.py
class RefereeAgent:
    """裁判Agent: 负责规则仲裁、冲突判定、淘汰决策"""

    def __init__(self, model: str, rules: dict):
        self.llm = create_llm(model)
        self.rules = rules

    def judge(self, state: GameState, actions: List[Action], event: Event) -> List[str]:
        """
        输入: 当前状态 + 所有Agent行动 + 环境事件
        输出: 本轮淘汰的Agent名单
        """
        prompt = f"""
        你是末日求生裁判。根据以下信息判定本轮淘汰:

        环境事件: {event.description}
        各Agent行动: {actions}
        当前状态: {state}

        判定规则:
        1. 物品与环境事件的相性（如暴雨中火机优势）
        2. Agent决策的合理性
        3. 随机因素（模拟真实不确定性）

        输出JSON格式: {{"eliminated": ["AgentName"], "reason": "...", "highlights": [...]}}
        """
        result = self.llm.invoke(prompt)
        return parse_elimination(result)
```

### 5.4 一键流水线脚本

```bash
#!/bin/bash
# scripts/run.sh

TOPIC_CONFIG=$1

# 1. 运行对抗
python -m backend.main survival --config $TOPIC_CONFIG

# 2. 获取最新生成的script
LATEST_SCRIPT=$(ls -t output/scripts/game_survival_*.json | head -1)

# 3. 生成TTS
python -m backend.tts.generate $LATEST_SCRIPT

# 4. 渲染视频
node scripts/render-video.mjs $LATEST_SCRIPT

echo "视频已生成: output/videos/"
```

---

## 六、开发路线图

| 阶段 | 时间 | 目标 | 交付物 |
|------|------|------|--------|
| **Phase 1** | Week 1-2 | 环境搭建 + 跑通Masquerade | 成功运行spy/werewolf示例 |
| **Phase 2** | Week 3-4 | 新增首个GameEngine | 末日求生引擎可运行 |
| **Phase 3** | Week 5-6 | 多LLM接入 + 裁判Agent | 8个不同LLM同时参与 |
| **Phase 4** | Week 7-8 | 视频渲染优化 | 首个完整视频产出 |
| **Phase 5** | Week 9-10 | 话题模板化 + 批量生成 | 10个话题配置可一键跑 |
| **Phase 6** | Week 11-12 | B站发布辅助 | 标题/封面/标签自动生成 |

---

## 七、风险与应对

| 风险 | 影响 | 应对策略 |
|------|------|---------|
| LLM API成本过高 | 高 | 引入"审计Agent"，小模型做初步筛选，大模型做最终决策 |
| 视频渲染耗时 | 中 | GPU加速(NVENC/AMF); 支持低分辨率预览模式 |
| Agent决策同质化 | 中 | 通过persona差异化提示词; 引入随机性参数 |
| 内容审核风险 | 中 | 裁判Agent内置内容过滤; 输出前人工抽检 |
| Remotion学习曲线 | 低 | Masquerade已提供完整示例，参考改造 |

---

## 八、依赖清单

### Python后端
```
langgraph>=0.2.0
langchain>=0.3.0
langchain-openai
langchain-anthropic
litellm>=1.0.0
pydantic>=2.0
pyyaml
edge-tts
```

### Node前端
```
remotion@4.x
react@18.x
framer-motion
tailwindcss
vite
```

### 系统
```
Python 3.11+
Node.js 18+
ffmpeg (H.264编码)
GPU (可选，用于视频渲染加速)
```

---

## 九、关键设计原则

1. **最小改造原则**: Masquerade已有组件100%复用，只新增必要模块
2. **配置驱动原则**: 话题、规则、角色全部YAML化，非技术人员可参与
3. **确定性原则**: 相同输入产生相同输出，便于调试和回放
4. **可观测原则**: 完整JSON日志记录，每一步决策可追溯
5. **成本可控原则**: 支持模型分级策略，非关键决策用小模型

---

*本文档可直接作为技术方案提交，无需额外上下文。*
