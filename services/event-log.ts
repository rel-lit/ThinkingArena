// Version: 1.0.0
/**
 * EventLog 服务（§4.3）：Script JSONL 的唯一写者（D23 一局一进程单写者，D32 同信封 append-only 树）。
 *
 * 实现要点：
 * - id = 文件内全局零填充单调序号（e0000001+，deep-dive §1.4），提交时才取号，保证「id 序 =
 *   文件物理序」；parent_id 由本服务盖章（写者不自带 id——EventDraftSchema strictObject 机械拒写）。
 * - 打开时同步全量扫描（恢复续号/建索引）：尾部半行与无法解析行物理丢弃并记 system 事件
 *   （§2.3；EventLog 是损坏的唯一知情方）。
 * - branch() 与 fork 控制条目原子完成（§2.4-3：fork 必落控制条目）：fork 条目挂到锚点之下，
 *   新分支路径经 parent_id 链共享前缀事实，旧分支封存不再增长。
 * - snapshot() 写内联快照条目（D11），last_event_id 由本服务注入（deep-dive §1.5-6 续号锚点）。
 * - replay() 只吐有序事件序列（首条可为快照检查点），reduce 归调用方（§4.3 边界克制）；
 *   定位失败编码进 Result，不在迭代中途抛错（D5）。重放窗口 = 分支 run_started + 最新快照 +
 *   后续事件（裁决 3-D-4：run_started 在快照窗口外时前置补上，恢复侧 D33 版本校验的事实来源）。
 *
 * 实现级裁决（冻结接口之外的增量面）：
 * - EventLogFileContext：暴露 currentRunId/currentBranch/lastEventId——服务事实（cost、turn 系、
 *   bb_set 等）的信封 run_id/branch 唯一来源（types.ts 工厂签名无 run 上下文通道，见汇报）。
 * - 分支一致性：append 草稿的 branch 必须等于当前活跃分支（branch() 切换），否则拒写——
 *   parent 链 = 分支路径的不变量靠它守住。一文件一局：跨 run_id 草稿拒写。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, truncateSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  EventDraftSchema,
  KernelEventSchema,
  type BranchId,
  type Event,
  type EventDraft,
  type EventId,
  type RunId,
} from '../schema/event.ts';
import type { EventLogErrorKind, Result } from '../schema/errors.ts';
import type { EventLog, EventLogReplayOptions } from './types.ts';

/** EventLog 具体实现的增量面（冻结接口 EventLog 之外的文件上下文读取）。 */
export interface EventLogFileContext extends EventLog {
  /** 本文件 run_id（首个 append 盖章；空文件为 null——服务事实须等 run_started 落盘后才可写）。 */
  currentRunId(): RunId | null;
  /** 当前活跃分支（branch() 切换；初始为首条事件的 branch）。 */
  currentBranch(): BranchId;
  /** 当前叶事件 id（下一条 append 的 parent；空文件为 null）。 */
  lastEventId(): EventId | null;
}

/** 打开扫描的结构检查（不做 Zod 全量校验——写入侧已 F12 校验前置，deep-dive 未决问题 3 留恢复路径免校验）。 */
function isEnvelopeish(v: unknown): v is Event {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    /^e\d{7,}$/.test(o.id) &&
    (typeof o.parent_id === 'string' || o.parent_id === null) &&
    typeof o.run_id === 'string' &&
    typeof o.branch === 'string' &&
    typeof o.type === 'string'
  );
}

export function createEventLog(opts: { filePath: string }): EventLogFileContext {
  const { filePath } = opts;
  mkdirSync(dirname(filePath), { recursive: true });

  // ===== 内存索引（单写者，append 同步提交；replay 从内存吐序列，无中途 IO 错误面） =====
  const events: Event[] = [];
  const byId = new Map<EventId, Event>();
  const branchLeaves = new Map<BranchId, EventId>();
  let counter = 0;
  let leafId: EventId | null = null;
  let activeBranch: BranchId = 'main'; // 初始分支约定（event.ts BranchIdSchema）；首条事件落盘后以其为准
  let runId: RunId | null = null;

  /** 盖章并追加（唯一写入点；parentOverride 仅 fork 条目使用——挂到锚点而非当前叶）。 */
  function stamp(
    draft: EventDraft,
    parentOverride?: EventId | null,
  ): Result<Event, EventLogErrorKind> {
    const parsed = EventDraftSchema.safeParse(draft);
    if (!parsed.success) return { ok: false, error: 'EVENT_SCHEMA_INVALID' };
    if (runId !== null && draft.run_id !== runId) return { ok: false, error: 'EVENT_SCHEMA_INVALID' }; // 一文件一局
    if (events.length === 0) activeBranch = draft.branch;
    if (parentOverride === undefined && draft.branch !== activeBranch) {
      return { ok: false, error: 'EVENT_SCHEMA_INVALID' }; // 分支路径 = parent 链的不变量
    }
    const id = `e${String(counter + 1).padStart(7, '0')}` as EventId;
    const event = { id, parent_id: parentOverride !== undefined ? parentOverride : leafId, ...draft } as Event;
    try {
      appendFileSync(filePath, JSON.stringify(event) + '\n', 'utf8');
    } catch {
      return { ok: false, error: 'APPEND_FAILED' }; // 未取号（counter 未推进），id 序无洞
    }
    counter += 1;
    runId ??= draft.run_id;
    events.push(event);
    byId.set(id, event);
    branchLeaves.set(event.branch, id);
    leafId = id;
    return { ok: true, value: event };
  }

  /** runner 级 system 注记（§2.3/F1；仅打开修复路径自用——EventLog 是损坏的唯一知情方）。 */
  function noteSystem(code: string, message: string): void {
    if (runId === null) return; // 空文件无 run 上下文可落
    stamp({
      ts: new Date().toISOString(),
      run_id: runId,
      branch: activeBranch,
      exec: null,
      type: 'system',
      payload: { code, message, severity: 'warning' },
    } as EventDraft);
  }

  // ===== 打开扫描：恢复续号 + 索引 + 损坏修复（§2.3/deep-dive §1.4） =====
  if (existsSync(filePath)) {
    let text = readFileSync(filePath, 'utf8');
    let tailTruncated = false;
    if (text.length > 0 && !text.endsWith('\n')) {
      const cut = text.lastIndexOf('\n');
      text = cut < 0 ? '' : text.slice(0, cut + 1);
      truncateSync(filePath, Buffer.byteLength(text, 'utf8')); // 尾部半行物理丢弃（崩溃截断修复）
      tailTruncated = true;
    }
    let corruptLines = 0;
    for (const line of text.split('\n')) {
      if (line === '') continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        corruptLines += 1;
        continue; // 无法解析的行丢弃（该行从未成为事实）
      }
      if (!isEnvelopeish(obj)) {
        corruptLines += 1;
        continue;
      }
      events.push(obj);
      byId.set(obj.id, obj);
      branchLeaves.set(obj.branch, obj.id);
      leafId = obj.id;
      activeBranch = obj.branch;
      runId ??= obj.run_id;
      counter = Math.max(counter, Number.parseInt(obj.id.slice(1), 10));
    }
    if (tailTruncated) noteSystem('jsonl_tail_truncated', 'JSONL 尾部半行（崩溃截断）已丢弃并物理截断修复（§2.3）');
    if (corruptLines > 0) noteSystem('jsonl_line_corrupt', `JSONL 有 ${corruptLines} 行无法解析，已丢弃（打开扫描）`);
  }

  // ===== 冻结接口实现 =====

  function append(draft: EventDraft): Result<Event, EventLogErrorKind> {
    return stamp(draft);
  }

  function branch(atEventId: EventId, newBranch: BranchId): Result<void, EventLogErrorKind> {
    if (!byId.has(atEventId)) return { ok: false, error: 'BRANCH_NOT_FOUND' };
    if (branchLeaves.has(newBranch)) return { ok: false, error: 'EVENT_SCHEMA_INVALID' }; // 缺 BRANCH_CONFLICT 枚举（见汇报）：新分支标识必须未用
    if (runId === null) return { ok: false, error: 'BRANCH_NOT_FOUND' }; // 不可达（锚点存在则 runId 必有），防御
    // fork 控制条目与分叉原子完成（§2.4-3）；条目属新分支、挂在锚点之下
    const r = stamp(
      {
        ts: new Date().toISOString(),
        run_id: runId,
        branch: newBranch,
        exec: null,
        type: 'fork',
        payload: { at_event_id: atEventId, new_branch: newBranch },
      } as EventDraft,
      atEventId,
    );
    if (!r.ok) return { ok: false, error: r.error };
    activeBranch = newBranch; // leafId 已由 stamp 推进到 fork 条目；旧分支封存
    return { ok: true, value: undefined };
  }

  function snapshot(state: unknown): Result<EventId, EventLogErrorKind> {
    if (runId === null || leafId === null) return { ok: false, error: 'SNAPSHOT_CORRUPT' }; // 无 run 上下文可锚定
    const s = (state ?? {}) as Record<string, unknown>;
    const draft = {
      ts: new Date().toISOString(),
      run_id: runId,
      branch: activeBranch,
      exec: null,
      type: 'snapshot',
      payload: {
        last_event_id: leafId, // 截至本快照已分配的最大序号（续号锚点，deep-dive §1.5-6）
        blackboard: s.blackboard,
        agents: s.agents,
        progress: s.progress,
        ledger: s.ledger,
      },
    } as EventDraft;
    if (!EventDraftSchema.safeParse(draft).success) return { ok: false, error: 'SNAPSHOT_CORRUPT' }; // 快照条目校验失败（D11）
    const r = stamp(draft);
    return r.ok ? { ok: true, value: r.value.id } : { ok: false, error: r.error };
  }

  async function replay(
    options: EventLogReplayOptions = {},
  ): Promise<Result<AsyncIterable<Event>, EventLogErrorKind>> {
    const branchId = options.branch ?? activeBranch;
    const leaf = branchLeaves.get(branchId);
    if (leaf === undefined) return { ok: false, error: 'BRANCH_NOT_FOUND' };
    // 沿 parent_id 回溯分支路径（§2.3）；parent 缺失 = 链完整性破坏
    const path: Event[] = [];
    let cur: Event | undefined = byId.get(leaf);
    while (cur !== undefined) {
      path.push(cur);
      if (cur.parent_id === null) break;
      cur = byId.get(cur.parent_id as EventId);
      if (cur === undefined) return { ok: false, error: 'REPLAY_CORRUPT' };
    }
    path.reverse();
    // 定位快照：指定 fromSnapshot 或路径上最新一个（§4.3 首条可为快照检查点）
    let startIdx = 0;
    if (options.fromSnapshot !== undefined) {
      startIdx = path.findIndex((e) => e.id === options.fromSnapshot);
      if (startIdx < 0 || path[startIdx].type !== 'snapshot') return { ok: false, error: 'REPLAY_CORRUPT' };
    } else {
      for (let i = path.length - 1; i >= 0; i -= 1) {
        if (path[i].type === 'snapshot') {
          startIdx = i;
          break;
        }
      }
    }
    // 快照条目校验（D11：SNAPSHOT_CORRUPT——调用方据此前移 fromSnapshot 回退重试，错误矩阵）
    if (path[startIdx]?.type === 'snapshot' && !KernelEventSchema.safeParse(path[startIdx]).success) {
      return { ok: false, error: 'SNAPSHOT_CORRUPT' };
    }
    let out = path.slice(startIdx);
    // 裁决 3-D-4 重放窗口 = 分支 run_started + 最新快照 + 后续事件：run_started 落在窗口外时
    // 前置补上（恢复侧的版本身份/D33 校验与 reducer 身份字段来源；窗口内唯一「乱序」条目，
    // 调用方按序号过滤不受影响——快照段之后的事件序保持文件物理序）
    if (startIdx > 0) {
      for (let i = startIdx - 1; i >= 0; i -= 1) {
        if (path[i].type === 'run_started') {
          out = [path[i], ...out];
          break;
        }
      }
    }
    if (options.until !== undefined) {
      const ui = out.findIndex((e) => e.id === options.until);
      if (ui < 0) return { ok: false, error: 'REPLAY_CORRUPT' };
      out = out.slice(0, ui + 1); // until 含本体（分叉点状态重建用）
    }
    const frozen = out; // 调用时刻快照：之后的新 append 不进本次序列（确定性）
    async function* gen(): AsyncIterable<Event> {
      for (const e of frozen) yield e;
    }
    return { ok: true, value: gen() };
  }

  return {
    append,
    replay,
    branch,
    snapshot,
    currentRunId: () => runId,
    currentBranch: () => activeBranch,
    lastEventId: () => leafId,
  };
}
