// Version: 1.0.0
/**
 * 总 reduce（§4 恢复纪律）：replay 零副作用——按事件类型分发到 blackboard.applyEvent /
 * agent 生命周期投影 / 调度进度投影 / ledger，不产生新事件、不通知、不调 LLM。
 * 孤儿规则（D36）：重放末尾仍「已开始未结束」节点执行的事件跳过（缓冲后丢弃）；
 * cost（真实花费不作废）与 gate_input_received（门重入查询依据）除外。
 * 快照还原：四段整体替换；调度指针推导式恢复（running → openExec 重跑；最后 completed → 出边重算）。
 */
import type { AgentLifecycleState, BranchId, Event, EventId, NodeExec, RunId } from '../schema/event.ts';
import type { Blackboard } from '../services/types.ts';
import { Ledger } from './ledger.ts';
import { progressKey } from './scheduler.ts';

export interface AgentProjection {
  state: AgentLifecycleState;
  memory_ref: string | null;
}

export interface ProgressEntry {
  status: 'running' | 'waiting' | 'completed' | 'failed';
  detail?: unknown;
}

/** 泵游标计数覆盖的 system code（无门等待拒绝 / 无效行），与 director-pump 约定一致。 */
export const PUMP_COUNTED_SYSTEM_CODES = ['invalid_director_line', 'no_waiting_gate'] as const;

const execKey = (e: NodeExec): string => progressKey(e.node_id, e.iteration);

/** agent 生命周期事件 → 状态投影（§3.1；agent_created 单独处理 memory_ref）。 */
const AGENT_EVENT_STATES = {
  agent_destroyed: 'DESTROYED',
  agent_paused: 'PAUSED',
  agent_resumed: 'RUNNING',
  agent_error: 'ERROR',
  agent_recovered: 'IDLE',
  turn_start: 'RUNNING',
  turn_end: 'IDLE',
} as const satisfies Record<string, AgentLifecycleState>;

export class RunReducer {
  readonly agents = new Map<string, AgentProjection>();
  readonly progress = new Map<string, ProgressEntry>();
  readonly iterations = new Map<string, number>();
  readonly ledger: Ledger;
  /** 门重入查询集（D36）：已落盘 gate_input_received 的 exec key。 */
  readonly gateReceived = new Set<string>();
  consumedInboxLines = 0;
  lastEventId: EventId | null = null;
  lastEnding: string | null = null;
  pendingNext: NodeExec | null = null;
  scheduledNext: NodeExec | null = null;
  openExec: NodeExec | null = null;
  failedExec: NodeExec | null = null;
  /** cost 币种与账本不一致（该条未计入）：FlowRunner 扫描时据此记 system 事件告警。 */
  currencyMismatch = false;
  finished: 'completed' | 'cancelled' | null = null;
  runId: RunId | null = null;
  branch: BranchId = 'main';
  bundleHash: string | null = null;
  startedAt: string | null = null;
  private readonly blackboard: Blackboard;
  private orphanBuffer: Event[] = [];

  constructor(blackboard: Blackboard, ledger?: Ledger) {
    this.blackboard = blackboard;
    this.ledger = ledger ?? new Ledger();
  }

  /** 下一可用迭代计数（重入 = 无状态新执行，回边递增）。 */
  nextIteration(nodeId: string): number {
    return this.iterations.get(nodeId) ?? 0;
  }

  /** 重放喂入一条事件（含孤儿缓冲；lastEventId 无条件续号——含孤儿事件，deep-dive §1.5-6）。 */
  feed(event: Event): void {
    this.lastEventId = event.id;
    if (this.openExec && event.exec && execKey(event.exec) === execKey(this.openExec)) {
      switch (event.type) {
        case 'cost': // 真实花费不作废（D36 例外）
        case 'gate_input_received': // 门输入不作废（D36 门重入查询）
          this.reduceCore(event);
          return;
        case 'node_start': // 崩溃恢复后的 D12 重跑（或损坏流重复开始）：丢弃旧缓冲，重新打开
          this.orphanBuffer = [];
          this.openExec = null;
          this.reduceCore(event);
          return;
        case 'node_end':
        case 'node_failed': { // 节点执行正常闭合：冲刷缓冲后按序 reduce
          const buffered = this.orphanBuffer;
          this.orphanBuffer = [];
          this.openExec = null;
          for (const b of buffered) this.reduceCore(b);
          this.reduceCore(event);
          return;
        }
        default: // 孤儿候选：缓冲，闭合时冲刷、流末丢弃
          this.orphanBuffer.push(event);
          return;
      }
    }
    this.reduceCore(event);
  }

  /** 重放流结束：丢弃孤儿缓冲（D36 跳过语义的唯一生效点）。 */
  finishReplay(): void {
    this.orphanBuffer = [];
  }

  private reduceCore(event: Event): void {
    switch (event.type) {
      case 'run_started':
        this.runId = event.run_id;
        this.branch = event.branch;
        this.bundleHash = event.payload.bundle_hash;
        this.startedAt = event.ts;
        return;
      case 'run_completed':
        this.finished = 'completed';
        this.lastEnding = event.payload.ending;
        return;
      case 'run_cancelled':
        this.finished = 'cancelled';
        return;
      case 'node_start': {
        if (this.openExec) this.orphanBuffer = []; // 防御：损坏流中前执行未闭合，按孤儿丢弃
        this.openExec = event.exec;
        this.progress.set(execKey(event.exec), { status: 'running' });
        this.iterations.set(event.exec.node_id, Math.max(this.nextIteration(event.exec.node_id), event.exec.iteration + 1));
        this.pendingNext = null;
        this.scheduledNext = null; // 节点实际启动即消费调度指针（重放路径无 takeStep 消费方）
        this.failedExec = null;
        return;
      }
      case 'node_end':
        this.progress.set(execKey(event.exec), { status: 'completed' });
        this.pendingNext = event.exec; // 出边未决：崩溃恢复时重新求值（确定性重算，D12）
        return;
      case 'node_failed':
        this.progress.set(execKey(event.exec), { status: 'failed' });
        this.failedExec = event.exec; // R7：ERROR 后 resume 重跑该执行
        this.pendingNext = null;
        return;
      case 'branch_decision':
        if (event.payload.result) {
          this.scheduledNext = { node_id: event.payload.target_node, iteration: this.nextIteration(event.payload.target_node) };
          this.pendingNext = null;
        }
        return;
      case 'bb_set':
        this.blackboard.applyEvent(event);
        return;
      case 'snapshot':
        this.restoreSnapshot(event);
        return;
      case 'milestone':
        if (event.payload.kind === 'run_ending') this.lastEnding = event.payload.label;
        return;
      case 'cost':
        if (!this.ledger.apply(event)) this.currencyMismatch = true;
        return;
      case 'gate_input_received':
        this.gateReceived.add(execKey(event.exec));
        if (event.payload.source === 'director_inbox') this.consumedInboxLines += 1;
        return;
      case 'director_note':
        this.consumedInboxLines += 1;
        return;
      case 'system':
        if ((PUMP_COUNTED_SYSTEM_CODES as readonly string[]).includes(event.payload.code)) this.consumedInboxLines += 1;
        return;
      case 'fork':
        this.branch = event.payload.new_branch;
        return;
      case 'agent_created':
        this.agents.set(event.payload.agent_id, { state: 'IDLE', memory_ref: event.payload.memory_ref });
        return;
      case 'agent_destroyed':
      case 'agent_paused':
      case 'agent_resumed':
      case 'agent_error':
      case 'agent_recovered':
      case 'turn_start':
      case 'turn_end': {
        const state = AGENT_EVENT_STATES[event.type];
        this.agents.set(event.payload.agent_id, { state, memory_ref: this.agents.get(event.payload.agent_id)?.memory_ref ?? null });
        return;
      }
      default:
        return; // 游戏语义族（speech/dice/gate_waiting…）与自定义事件：无调度投影
    }
  }

  /** snapshot 四段整体还原 + progress detail 内的调度指针标记（deep-dive §2.4-1 四段组织）。 */
  private restoreSnapshot(event: Extract<Event, { type: 'snapshot' }>): void {
    const p = event.payload;
    this.runId ??= event.run_id; // 兜底：replay 窗口未含 run_started 时从信封恢复身份（branch 恒取最新）
    this.branch = event.branch;
    this.blackboard.applyEvent(event); // 黑板全量键值检查点（恢复路径，不写穿）
    this.agents.clear();
    for (const [id, a] of Object.entries(p.agents)) this.agents.set(id, { ...a });
    this.progress.clear();
    this.iterations.clear();
    this.pendingNext = null;
    this.scheduledNext = null;
    this.openExec = null;
    this.orphanBuffer = [];
    for (const [key, entry] of Object.entries(p.progress)) {
      this.progress.set(key, { status: entry.status, detail: entry.detail });
      const cut = key.lastIndexOf('#');
      const iter = Number(key.slice(cut + 1));
      if (!Number.isInteger(iter)) continue;
      this.iterations.set(key.slice(0, cut), Math.max(this.nextIteration(key.slice(0, cut)), iter + 1));
      const exec: NodeExec = { node_id: key.slice(0, cut), iteration: iter };
      // 快照切割的在飞执行（如 pause 于门等待期）：恢复后按 D12 重跑；其快照后事件走孤儿缓冲
      if (entry.status === 'running') this.openExec = exec;
      // 调度指针推导：最后 completed = 出边未决（恢复后确定性重算，黑板同点 → 同结果，D12 重新发生语义）
      if (entry.status === 'completed') this.pendingNext = exec;
    }
    this.ledger.restore(p.ledger);
    this.lastEventId = p.last_event_id;
  }
}
