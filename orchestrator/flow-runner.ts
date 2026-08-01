// Version: 1.0.0
/**
 * FlowRunner 外观（§4.5，状态机 §3.3）：加载校验（D20）→ replayOrInit（D12）→ 调度循环 → 落定。
 * 内部分解（§3.3 补充语义）：graph / scheduler / reducer / director-pump（deps 注入）/ ledger。
 * 实现级裁决：run() 只在 COMPLETED/cancel 后落定，ERROR 为挂起态；服务/组件落盘事件无订阅通道
 * （D10），采用节点边界增量重扫喂 reducer 投影（成本闸实时性通道，34 万事件/s 量级 MVP 无压力）；
 * R7=重试失败节点（跳过决策接口无参）；bundle_path 权宜填 runDir（deps 无 bundlePath）。均见汇报。
 * 3-D 集成补丁（架构师裁决）：exec/run 上下文通道 = MutableEnvelopeSource + 服务侧 bindExec，
 * FlowRunner 逐节点边界绑定/解绑（组合根经 deps 鸭子类型额外字段注入）；worldbook 加载期导入
 * 改走 blackboard.applyEvent 确定性初始化（D34/裁决 3-D-5：不经 set、不落 bb_set 事件——冻结
 * 契约 bb_set 信封 exec 必填，加载期无节点 exec 上下文；Script 载体 = 快照黑板段）。
 */
import { createHash, randomBytes } from 'node:crypto';
import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ErrorCode, FlowRunnerErrorKind, Result } from '../schema/errors.ts';
import type { BranchId, Event, EventDraft, EventId, NodeExec, RunId } from '../schema/event.ts';
import type { RunManifest, RunManifestStatus, ScenarioBundle } from '../schema/bundle.ts';
import type { FlowConfig, FlowNode } from '../schema/flow.ts';
import type { Component } from '../schema/meta-component.ts';
import { parseFlowConfig, validateFlowConfig } from './graph.ts';
import { decideOutEdge, progressKey } from './scheduler.ts';
import { RunReducer } from './reducer.ts';
import { Ledger } from './ledger.ts';
import type { DirectorPumpControl } from './director-pump.ts';
import type { FlowRunner, FlowRunnerDeps, FlowRunOptions, RunReport } from './types.ts';
import type { EnvelopeSource, MetaEnvelope } from '../meta/registry.ts';
import type { BlackboardRunContext } from '../services/blackboard.ts';
import type { AgentServiceEx } from '../services/agent-service.ts';

/**
 * 可变信封源（架构师裁决 3-D-1：exec/run 上下文通道的 MVP 机制）。
 * 组合根创建并同时注入 meta registry（envelopeSource）与 FlowRunnerDeps（鸭子类型额外字段，
 * 冻结 types.ts 无此通道）；FlowRunner 在每个节点执行边界 set(exec) / set(null)。
 */
export interface MutableEnvelopeSource extends EnvelopeSource {
  set(env: MetaEnvelope | null): void;
}

type Phase = 'IDLE' | 'RUNNING' | 'PAUSED' | 'ERROR' | 'COMPLETED';
type DraftBody = Omit<EventDraft, 'ts' | 'run_id' | 'branch'>;

const DEFAULT_SNAPSHOT_POLICY = { every_node_boundaries: 10, min_events: 500 } as const;
const DEFAULT_ITERATION_LIMIT = 16; // D28 统一迭代上限缺省（实现层裁决）

const seqOf = (id: EventId): number => Number(id.slice(1));
const idOfSeq = (seq: number): EventId => `e${String(seq).padStart(7, '0')}`;

/** run id = UUID v7（deep-dive §1.4；crypto.randomUUID 仅 v4，手写 v7 布局）。 */
function uuidV7(): RunId {
  const b = randomBytes(16);
  const ms = Date.now();
  for (let i = 0; i < 6; i += 1) b[i] = Math.floor(ms / 2 ** (8 * (5 - i))) & 0xff;
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}` as RunId;
}

/** 规范化序列化（递归排序对象键）：D33 Bundle 版本 hash 的确定性输入。 */
function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonicalize((v as Record<string, unknown>)[k])]));
  }
  return v;
}

export function createFlowRunner(deps: FlowRunnerDeps): FlowRunner {
  const { eventLog, blackboard } = deps.services;
  const ledger = new Ledger();
  let phase: Phase = 'IDLE';
  let hasRun = false;
  let bundle: ScenarioBundle | null = null;
  let flow: FlowConfig | null = null;
  let reducer: RunReducer | null = null;
  let bundleHash = '';
  let runId = '' as RunId;
  let branch: BranchId = 'main';
  let startedAt = '';
  let lastSeq = 0;
  let scannedSeq = 0;
  const ownFed = new Set<EventId>(); // 自己 append 已喂 reducer 的事件（增量扫描跳过）
  let cancelRequested = false;
  let pauseRequested = false;
  let pauseReason: string | undefined;
  let nodeAbort: AbortController | null = null;
  let wake: (() => void) | null = null;
  const waiters: Array<(r: Result<void, FlowRunnerErrorKind>) => void> = []; // pause/cancel 会合点
  let retryQueue: NodeExec | null = null;
  const retryAttempts = new Map<string, number>();
  let boundariesSinceSnap = 0;
  let eventsSinceSnap = 0;
  let lastError: { code: FlowRunnerErrorKind; detail?: string } | null = null;
  let manifest: RunManifest | null = null;
  const err = <T>(error: FlowRunnerErrorKind): Result<T, FlowRunnerErrorKind> => ({ ok: false, error });
  const pump = deps.directorPump as Partial<DirectorPumpControl>;
  // 组合根注入的运行上下文通道（冻结 FlowRunnerDeps 之外的鸭子类型字段，裁决 3-D-1）：
  // envelopeSource = 组件侧 emit 类元组件的信封来源；bindExec = 服务事实（agent/blackboard）信封 exec 来源
  const envSource = (deps as { envelopeSource?: MutableEnvelopeSource }).envelopeSource;
  const bbRunCtx = deps.services.blackboard as Partial<BlackboardRunContext>;
  const agentEx = deps.services.agentService as Partial<AgentServiceEx>;

  /** 节点执行边界绑定运行信封（执行前 exec / 执行后 null）；meta 与服务两侧同源。 */
  function bindRunEnvelope(exec: NodeExec | null): void {
    envSource?.set(exec === null ? null : { run_id: runId, branch, exec });
    bbRunCtx.bindExec?.(exec);
    agentEx.bindExec?.(exec);
  }

  function append(body: DraftBody): Event | null {
    const r = eventLog.append({ ...body, ts: new Date().toISOString(), run_id: runId, branch } as EventDraft);
    if (!r.ok) {
      enterError('EVENTLOG_FATAL', null, `append ${body.type} 失败: ${r.error}`);
      return null;
    }
    lastSeq = seqOf(r.value.id);
    ownFed.add(r.value.id);
    reducer?.feed(r.value); // 实时投影与回放同一代码路径（事件即事实）
    eventsSinceSnap += 1;
    return r.value;
  }

  function enterError(kind: FlowRunnerErrorKind, nodeId: string | null, detail?: string): void {
    if (phase === 'ERROR') return;
    phase = 'ERROR'; // 先置态：EVENTLOG_FATAL 时 run_error 也落不了，防递归
    lastError = { code: kind, detail };
    append({ exec: null, type: 'run_error', payload: { error: kind, node_id: nodeId, detail } });
    writeManifest('error'); // D24：ERROR 挂起也写一份，恢复后幂等重写
    wake?.();
  }

  /** 节点失败统一处理：落 node_failed → on_error（stop→ERROR / retry 有界→耗尽转 stop / continue 继续求值）。 */
  function handleNodeFailure(exec: NodeExec, node: FlowNode, error: ErrorCode, detail?: string, fromEval = false): void {
    append({ exec, type: 'node_failed', payload: { component_type: node.type, component_version: node.version, error, detail } });
    if (phase === 'ERROR') return;
    if (node.on_error === 'retry') {
      const key = progressKey(exec.node_id, exec.iteration);
      const used = retryAttempts.get(key) ?? 0;
      if (used < Math.min(node.max_retries ?? 1, bundle?.game.iteration_limit ?? DEFAULT_ITERATION_LIMIT)) {
        retryAttempts.set(key, used + 1);
        retryQueue = exec; // 同 exec 标识重跑（重入 = 无状态新执行，D36）
        return;
      }
    }
    if (node.on_error === 'continue') {
      if (!fromEval) resolveOutEdges(exec); // 求值失败 + continue：跳过全部出边 = 图走完（防循环）
      return;
    }
    enterError('NODE_FAILED', node.id, detail); // stop（R5）
  }

  /** 出边求值（D7）：落 branch_decision；求值失败 = 配置错误走 on_error（F14）。 */
  function resolveOutEdges(exec: NodeExec): void {
    const node = flow!.nodes.find((n) => n.id === exec.node_id)!;
    const r = decideOutEdge(exec.node_id, flow!.edges, (k) => blackboard.get(k));
    if (!r.ok) {
      handleNodeFailure(exec, node, 'BUNDLE_INVALID', `分支条件求值失败: ${r.error}`, true);
      return;
    }
    for (const d of r.value.decisions) if (!append({ exec, type: 'branch_decision', payload: d })) return;
    reducer!.pendingNext = null; // 出边已决（含全部不成立 = 图走完）
    reducer!.scheduledNext = r.value.next ? { node_id: r.value.next, iteration: reducer!.nextIteration(r.value.next) } : null;
  }

  function takeStep(): { kind: 'run' | 'eval'; exec: NodeExec } | null {
    const r = reducer!;
    if (retryQueue) {
      const exec = retryQueue;
      retryQueue = null;
      return { kind: 'run', exec };
    }
    if (r.openExec) return { kind: 'run', exec: r.openExec }; // 崩溃恢复：重跑未完成执行（D12）
    if (r.scheduledNext) {
      const exec = r.scheduledNext;
      r.scheduledNext = null;
      return { kind: 'run', exec };
    }
    if (r.pendingNext) {
      const exec = r.pendingNext;
      r.pendingNext = null;
      return { kind: 'eval', exec };
    }
    if (r.progress.size === 0) return { kind: 'run', exec: { node_id: flow!.entry, iteration: 0 } }; // 全新启动
    return null; // 无就绪节点且无等待分支 → finished（R4）
  }

  async function execNode(exec: NodeExec): Promise<void> {
    const node = flow!.nodes.find((n) => n.id === exec.node_id)!;
    const comp: Component | undefined = deps.components.get(node.type, node.version);
    if (!comp) {
      handleNodeFailure(exec, node, 'BUNDLE_INVALID', '组件运行期缺失（加载期已验，防御）');
      return;
    }
    if (!append({ exec, type: 'node_start', payload: { component_type: node.type, component_version: node.version, params: node.params } })) return;
    nodeAbort = new AbortController();
    bindRunEnvelope(exec); // 裁决 3-D-1：组件/服务在本次执行期间的信封来源
    let result: Awaited<ReturnType<Component['run']>>;
    try {
      result = await comp.run(node.params ?? {}, { meta: deps.meta, signal: nodeAbort.signal });
    } catch {
      result = { ok: false, error: 'COMPONENT_FAILED' }; // 组件抛异常 = 编程错误，按失败编码兜底（D5 防御）
    }
    nodeAbort = null;
    bindRunEnvelope(null); // 节点间无执行上下文：emit 类元组件与服务事实此后不可落（防御纵深）
    if (cancelRequested) {
      append({ exec, type: 'node_failed', payload: { component_type: node.type, component_version: node.version, error: 'ABORTED', detail: 'run cancelled（安全点优雅终止，R8）' } });
      return;
    }
    if (!result.ok) {
      handleNodeFailure(exec, node, result.error);
      return;
    }
    if (!append({ exec, type: 'node_end', payload: { component_type: node.type, component_version: node.version } })) return;
    await onNodeBoundary();
    if (phase === 'RUNNING' && !cancelRequested) resolveOutEdges(exec);
  }

  /** 节点边界：增量重扫服务/组件事件（成本闸 D28 的实时性通道）→ 快照策略（D30）。 */
  async function onNodeBoundary(): Promise<void> {
    const rr = await eventLog.replay();
    if (!rr.ok) {
      enterError('EVENTLOG_FATAL', null, `增量重扫失败: ${rr.error}`);
      return;
    }
    for await (const e of rr.value) {
      const s = seqOf(e.id);
      if (s <= scannedSeq) continue;
      scannedSeq = s;
      if (ownFed.delete(e.id) || e.type === 'snapshot') continue; // 自己喂过 / 快照内容源自实时状态
      reducer!.feed(e);
      if (reducer!.currencyMismatch) {
        reducer!.currencyMismatch = false;
        append({ exec: null, type: 'system', payload: { code: 'cost_currency_mismatch', message: 'cost 事件币种与账本不一致，该条未计入（成本失真）', severity: 'warning' } });
      }
    }
    boundariesSinceSnap += 1;
    const policy = bundle?.game.snapshot ?? DEFAULT_SNAPSHOT_POLICY;
    if (boundariesSinceSnap >= policy.every_node_boundaries || eventsSinceSnap >= policy.min_events) takeSnapshot();
  }

  async function scheduleLoop(): Promise<Result<RunReport, FlowRunnerErrorKind>> {
    for (;;) {
      if (cancelRequested) return finalize('cancelled');
      if (phase === 'PAUSED' || phase === 'ERROR') {
        await new Promise<void>((r) => {
          wake = r;
        });
        wake = null;
        continue;
      }
      if (pauseRequested) {
        effectuatePause();
        continue;
      }
      const step = takeStep();
      if (step === null) return finalize('completed');
      if (step.kind === 'eval') resolveOutEdges(step.exec);
      else await execNode(step.exec);
    }
  }

  function finalize(status: 'completed' | 'cancelled'): Result<RunReport, FlowRunnerErrorKind> {
    takeSnapshot(); // 先落局末快照（D30）：replay 窗口必含其后的落定事件，resume 的 finished 判定不丢
    if (status === 'completed') {
      const ending = reducer!.lastEnding ?? 'finished'; // 场景经 milestone(kind=run_ending) 标记结局（实现级约定）
      append({ exec: null, type: 'run_completed', payload: { ending, cost: ledger.summary() } });
      phase = 'COMPLETED';
    } else {
      append({ exec: null, type: 'run_cancelled', payload: {} });
      phase = 'IDLE';
    }
    writeManifest(status);
    const report: RunReport = { runId, status, manifest: manifest! };
    for (const w of waiters.splice(0)) w({ ok: true, value: undefined });
    return { ok: true, value: report };
  }

  function effectuatePause(): void {
    if (phase !== 'RUNNING') return;
    pauseRequested = false;
    phase = 'PAUSED'; // R2
    append({ exec: null, type: 'run_paused', payload: { reason: pauseReason } });
    pauseReason = undefined;
    takeSnapshot(); // D30：pause 必落
    for (const w of waiters.splice(0)) w({ ok: true, value: undefined });
  }

  function takeSnapshot(): void {
    const r = reducer;
    if (!r || lastSeq === 0) return;
    const res = eventLog.snapshot({
      last_event_id: idOfSeq(lastSeq),
      blackboard: blackboard.snapshot(),
      agents: Object.fromEntries(r.agents),
      progress: Object.fromEntries(r.progress),
      ledger: ledger.summary(),
    });
    if (!res.ok) {
      enterError('EVENTLOG_FATAL', null, `snapshot 失败: ${res.error}`);
      return;
    }
    lastSeq = Math.max(lastSeq, seqOf(res.value));
    scannedSeq = Math.max(scannedSeq, lastSeq);
    boundariesSinceSnap = 0;
    eventsSinceSnap = 0;
  }

  function writeManifest(status: RunManifestStatus): void {
    manifest = {
      run_id: runId,
      scenario: bundle!.flow.name,
      bundle_hash: bundleHash,
      bundle_path: deps.runDir, // 权宜：FlowRunnerDeps 无 bundlePath（已上报）
      started_at: startedAt,
      ended_at: status === 'error' ? null : new Date().toISOString(),
      status,
      ending: status === 'completed' ? (reducer!.lastEnding ?? 'finished') : null,
      cost: ledger.summary(),
      genealogy: null, // 跨版本族谱由 CLI 开新局时填写（D24）；同版本 fork 由 fork 控制条目表达
      schema_version: '1.0.0',
      ...(status === 'error' && lastError ? { error: { code: lastError.code, detail: lastError.detail } } : {}),
    };
    try {
      const tmp = join(deps.runDir, `manifest.json.${randomBytes(4).toString('hex')}.tmp`);
      writeFileSync(tmp, JSON.stringify(manifest, null, 2), 'utf8');
      renameSync(tmp, join(deps.runDir, 'manifest.json')); // 临时文件 + rename 原子写（D29）
    } catch {
      /* manifest 是 Script 派生物，缺失可由 CLI 重扫补写（D24） */
    }
  }

  async function restore(replayOpts: { until?: EventId }): Promise<FlowRunnerErrorKind | null> {
    const rr = await eventLog.replay(replayOpts);
    if (!rr.ok) return 'RUN_STATE_CORRUPT';
    reducer = new RunReducer(blackboard, ledger);
    for await (const e of rr.value) {
      reducer.feed(e);
      agentEx.applyEvent?.(e); // §2.3：Agent 生命周期投影同步重建（恢复纪律：不发射、不沉淀）
    }
    reducer.finishReplay();
    if (!reducer.runId || reducer.finished) return 'RUN_STATE_CORRUPT'; // 无 run_started / 已落定局不可恢复
    if (reducer.bundleHash !== bundleHash) return 'RUN_STATE_CORRUPT'; // 版本不匹配拒绝恢复（D21/D33）
    // 名册回填（3-D 集成补丁）：占位实例按 Bundle 填实 spec——replay 只重建生命周期，
    // 身份牌/模型绑定来自 Bundle（D33 已锁同版本）；名册是声明面，未创建的实例幂等跳过
    for (const a of bundle!.game.agents) {
      const card = bundle!.identity_cards[a.identity_card];
      if (card !== undefined) agentEx.restoreSpec?.({ id: a.id, identityCard: card, modelBinding: a.model });
    }
    runId = reducer.runId;
    branch = reducer.branch;
    startedAt = reducer.startedAt!;
    lastSeq = reducer.lastEventId ? seqOf(reducer.lastEventId) : 0;
    scannedSeq = lastSeq;
    return null;
  }

  return {
    async run(bundleInput: ScenarioBundle, options?: FlowRunOptions) {
      if (hasRun || phase !== 'IDLE') return err('RUN_STATE_CORRUPT');
      hasRun = true;
      bundle = bundleInput;
      const parsed = parseFlowConfig(bundle.flow);
      if (!parsed.ok) return err('BUNDLE_INVALID');
      const issues = validateFlowConfig(parsed.value, deps.components);
      if (!issues.ok || issues.value.length > 0) return err('BUNDLE_INVALID');
      flow = parsed.value;
      bundleHash = createHash('sha256')
        .update(JSON.stringify(canonicalize({
          graph: bundle.flow,
          component_versions: bundle.flow.nodes.map((n) => `${n.type}@${n.version}`).sort(),
          identity_cards: bundle.identity_cards,
          llm_bindings: bundle.game.agents,
          worldbook: bundle.worldbook,
          seeds: bundle.seeds,
        })))
        .digest('hex'); // D33 全输入 hash
      if (bundle.game.cost_budget) {
        const budget = bundle.game.cost_budget;
        ledger.setBudget({
          maxTotal: budget.max_total,
          currency: budget.currency,
          onExceed: (s) => {
            pauseRequested = true;
            pauseReason = `cost_budget_exceeded: total ${s.total} ${s.currency} > max ${budget.max_total}（D28）`;
          },
        });
      }

      let mode: 'fresh' | 'resume' | 'fork' = 'fresh';
      // D34 加载期导入（裁决 3-D-5）：worldbook 是 Bundle 的确定性派生，经 blackboard.applyEvent
      // 初始化——不经 set()，也不落 bb_set 事件（冻结契约 bb_set 信封 exec 必填，加载期无节点 exec
      // 上下文）。Script 中的载体 = 快照黑板段（D11）；resume/fork 先铺底、replay（含导演 edit_world
      // 的 bb_set 事件）在其上覆盖，语义等价且不失真。
      for (const entry of bundle.worldbook.entries) {
        blackboard.applyEvent({
          id: 'e0000000', parent_id: null, ts: startedAt, run_id: runId, branch, // 占位信封：仅供 applyEvent 双路径复用，不落盘
          exec: null, type: 'bb_set',
          payload: { key: `worldbook.${entry.key}`, value: { title: entry.title, content: entry.content } },
        } as Event);
      }
      if (options?.resume) {
        const e = await restore({});
        if (e) return err(e);
        mode = 'resume';
      } else if (options?.forkFrom) {
        const e = await restore({ until: options.forkFrom });
        if (e) return err(e);
        const newBranch = `fork-${randomBytes(3).toString('hex')}`;
        if (!eventLog.branch(options.forkFrom, newBranch).ok) return err('RUN_STATE_CORRUPT');
        branch = newBranch;
        reducer!.branch = newBranch;
        mode = 'fork';
      } else {
        reducer = new RunReducer(blackboard, ledger);
        runId = uuidV7();
        startedAt = new Date().toISOString();
      }
      pump.bindRunContext?.({ runId, branch });
      if (!append({ exec: null, type: 'run_started', payload: { bundle_hash: bundleHash, bundle_path: deps.runDir, mode, fork_from_event_id: options?.forkFrom ?? null } })) {
        return err('EVENTLOG_FATAL');
      }
      if (ledger.isExceeded()) {
        pauseRequested = true; // 恢复时账本已超阈（D28 恢复后不清零）：先 pause 等导演决策
        pauseReason = 'cost_budget_exceeded: 恢复时账本已超阈';
      }
      phase = 'RUNNING'; // R1
      return scheduleLoop();
    },

    async pause() {
      if (phase !== 'RUNNING') return err('RUN_STATE_CORRUPT');
      const p = new Promise<Result<void, FlowRunnerErrorKind>>((r) => waiters.push(r));
      if (!pauseRequested) {
        pauseRequested = true;
        if (pump.isWaiting?.()) effectuatePause(); // WAITING 门视为已在安全点（§3.3 补充语义）
      }
      return p;
    },

    async resume() {
      if (phase !== 'PAUSED' && phase !== 'ERROR') return err('RUN_STATE_CORRUPT');
      if (phase === 'ERROR' && reducer?.failedExec) retryQueue = reducer.failedExec; // R7：重试失败节点
      append({ exec: null, type: 'run_resumed', payload: { from_state: phase === 'PAUSED' ? 'paused' : 'error' } });
      phase = 'RUNNING';
      ledger.rearm();
      wake?.();
      return { ok: true, value: undefined };
    },

    async cancel() {
      if (phase === 'COMPLETED') return err('RUN_STATE_CORRUPT');
      if (phase === 'IDLE') return err(hasRun ? 'RUN_CANCELLED' : 'RUN_STATE_CORRUPT');
      if (!cancelRequested) {
        cancelRequested = true;
        nodeAbort?.abort(); // 取消链：FlowRunner → 组件（§4.7）
        deps.directorPump.cancelAll(); // 导演门转 CANCELLED（G4/G6）
        wake?.();
      }
      return new Promise<Result<void, FlowRunnerErrorKind>>((r) => waiters.push(r));
    },
  };
}
