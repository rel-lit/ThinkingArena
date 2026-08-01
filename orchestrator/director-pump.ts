// Version: 1.0.0
/**
 * 导演指令消费泵（D27/D37，orchestrator 内部模块；对外形态即 DirectorPump 冻结接口）。
 * 常驻轮询 director_inbox.jsonl：note → 直接落 director_note（exec=null，D18/D27）；
 * 门指令 → 解析等待中的 promise（无门等待则拒绝并记 system，F2 不缓冲）；无效行 → 记 system 跳过。
 * 单门等待运行期兜底（D37）：第二门进入立即 NODE_FAILED。超时策略（D15）：use_default 到期解析
 * 默认输入 / cancel_branch 到期 NODE_FAILED。cancelAll（G4/G6）：唤醒等待门（RUN_CANCELLED）。
 * 消费游标（崩溃恢复不重读）：旁挂游标文件（原子写）为主；缺失/损坏降级为 directive_hash 幂等重读
 * （契约无游标事件类型，此为实现层落地，已上报）。
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { DirectorDirectiveSchema, type BranchId, type DirectorDirective, type EventDraft, type RunId } from '../schema/event.ts';
import type { EventLogErrorKind, Result } from '../schema/errors.ts';
import type { EventLog } from '../services/types.ts';
import type { AwaitDirectiveOpts, DirectorPump } from './types.ts';

export interface DirectorPumpDeps {
  /** inbox 文件路径（约定 <runDir>/director_inbox.jsonl，F1）。 */
  inboxPath: string;
  eventLog: EventLog;
  /** 轮询间隔（默认 200ms；测试可调小）。 */
  pollIntervalMs?: number;
  /** append 失败上报（APPEND_FAILED 为致命，FlowRunner 据此转 EVENTLOG_FATAL）。 */
  onAppendError?: (kind: EventLogErrorKind) => void;
}

/** 泵的控制面（冻结接口之外的装配/测试钩子；FlowRunner 以鸭子类型探测）。 */
export interface DirectorPumpControl {
  start(): Promise<Result<void, EventLogErrorKind>>;
  stop(): void;
  /** FlowRunner 在 run_started 落定后绑定信封上下文；绑定前需落盘的行有界缓冲。 */
  bindRunContext(ctx: { runId: RunId; branch: BranchId }): void;
  /** 确定性单轮消费（测试用）。 */
  pollOnce(): void;
  /** 是否有门等待中（FlowRunner 判「WAITING 门视为安全点」用，§3.3 补充语义）。 */
  isWaiting(): boolean;
}

interface WaitingGate {
  resolve: (r: Result<DirectorDirective, 'RUN_CANCELLED' | 'NODE_FAILED'>) => void;
  cleanup: () => void;
}

const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

export function createDirectorPump(deps: DirectorPumpDeps): DirectorPump & DirectorPumpControl {
  const cursorPath = `${deps.inboxPath}.cursor.json`;
  let consumedLines = 0;
  const knownHashes = new Set<string>();
  let waiting: WaitingGate | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let runCtx: { runId: RunId; branch: BranchId } | null = null;
  let dedupeActive = false; // 游标缺失降级恢复期间为 true（首轮消费后关闭）
  const pendingAppends: EventDraft[] = []; // run context 绑定前的有界缓冲

  function append(body: Omit<EventDraft, 'ts' | 'run_id' | 'branch'>): void {
    if (!runCtx) {
      if (pendingAppends.length < 256) pendingAppends.push({ ...body, ts: '', run_id: '' as RunId, branch: '' } as EventDraft);
      return;
    }
    const r = deps.eventLog.append({ ...body, ts: new Date().toISOString(), run_id: runCtx.runId, branch: runCtx.branch } as EventDraft);
    if (!r.ok) deps.onAppendError?.(r.error);
  }

  const noteSystem = (code: string, message: string, severity: 'info' | 'warning' | 'error'): void =>
    append({ exec: null, type: 'system', payload: { code, message, severity } });

  function handleLine(line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      noteSystem('invalid_director_line', `无效 JSON 行: ${line.slice(0, 120)}`, 'warning');
      return;
    }
    const r = DirectorDirectiveSchema.safeParse(raw);
    if (!r.success) {
      noteSystem('invalid_director_line', `导演指令不符合契约: ${line.slice(0, 120)}`, 'warning');
      return;
    }
    // 降级恢复去重：按指令正文 hash（D18 落盘校验值）比对已消费指令；仅首轮启用
    const hash = sha256Hex(r.data.text);
    if (dedupeActive && knownHashes.has(hash)) return;
    knownHashes.add(hash);
    const d = r.data;
    if (d.kind === 'note') {
      append({ exec: null, type: 'director_note', payload: { text: d.text, directive_hash: hash } });
      return;
    }
    const gate = waiting;
    if (gate) {
      waiting = null;
      gate.cleanup();
      gate.resolve({ ok: true, value: d }); // gate_input_received 由门组件落（D35）
    } else {
      noteSystem('no_waiting_gate', `无门等待，拒绝门指令（MVP 不缓冲）: ${d.kind}`, 'warning');
    }
  }

  function writeCursor(): void {
    const tmp = `${cursorPath}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, JSON.stringify({ consumed_lines: consumedLines }), 'utf8');
    renameSync(tmp, cursorPath); // 临时文件 + rename 原子写（D29 精神）
  }

  function pollOnce(): void {
    let text: string;
    try {
      text = readFileSync(deps.inboxPath, 'utf8');
    } catch {
      return; // inbox 尚未创建（导演未写过）
    }
    const lines = text.split('\n');
    lines.pop(); // 末元素恒弃：有尾换行则为 ''，无尾换行则为未完成的半行（§2.3 尾部半行纪律）
    if (lines.length < consumedLines) consumedLines = 0; // inbox 被外部重建：从头消费（hash 幂等兜底）
    while (consumedLines < lines.length) {
      const line = lines[consumedLines];
      consumedLines += 1; // 无论结局（落盘/拒绝/无效）该行都算已消费
      if (line.trim().length > 0) handleLine(line);
      writeCursor();
    }
  }

  return {
    async start() {
      // 恢复游标：优先旁挂游标文件；缺失/损坏 → 降级 hash 幂等集（replay 可见事件）
      try {
        consumedLines = (JSON.parse(readFileSync(cursorPath, 'utf8')) as { consumed_lines: number }).consumed_lines;
      } catch {
        consumedLines = 0;
        dedupeActive = true;
        const rr = await deps.eventLog.replay();
        if (rr.ok) {
          for await (const e of rr.value) {
            if (e.type === 'director_note' || e.type === 'gate_input_received') knownHashes.add(e.payload.directive_hash);
          }
        }
      }
      pollOnce();
      dedupeActive = false;
      timer = setInterval(pollOnce, deps.pollIntervalMs ?? 200);
      timer.unref?.();
      return { ok: true, value: undefined };
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },

    bindRunContext(ctx) {
      runCtx = ctx;
      for (const d of pendingAppends.splice(0)) append(d); // 冲刷缓冲
    },

    pollOnce,

    isWaiting: () => waiting !== null,

    awaitDirective(opts: AwaitDirectiveOpts) {
      if (waiting) return Promise.resolve({ ok: false as const, error: 'NODE_FAILED' as const }); // 第二门（D37）
      return new Promise((resolve) => {
        let timeout: ReturnType<typeof setTimeout> | null = null;
        const cleanup = () => {
          if (timeout) clearTimeout(timeout);
          opts.signal.removeEventListener('abort', onAbort);
        };
        const finish = (r: Result<DirectorDirective, 'RUN_CANCELLED' | 'NODE_FAILED'>) => {
          if (waiting?.resolve !== resolve) return;
          waiting = null;
          cleanup();
          resolve(r);
        };
        const onAbort = () => finish({ ok: false, error: 'RUN_CANCELLED' }); // 取消链 G4/G6
        opts.signal.addEventListener('abort', onAbort, { once: true });
        const tp = opts.timeoutPolicy;
        if (tp?.policy === 'use_default') timeout = setTimeout(() => finish({ ok: true, value: tp.default_input }), tp.after_ms);
        if (tp?.policy === 'cancel_branch') timeout = setTimeout(() => finish({ ok: false, error: 'NODE_FAILED' }), tp.after_ms);
        waiting = { resolve, cleanup };
      });
    },

    cancelAll() {
      const gate = waiting;
      if (gate) {
        waiting = null;
        gate.cleanup();
        gate.resolve({ ok: false, error: 'RUN_CANCELLED' });
      }
    },
  };
}
