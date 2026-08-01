// Version: 1.0.0
/**
 * 测试共享 mock 设施（非测试文件）：EventLog/Blackboard/Agent 服务/记忆/元组件注册表/组件注册表/导演泵。
 * MockEventLog 用真实 EventSchema 校验 append 入参——runner/pump 组装的草稿若违反契约会在测试中暴露。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventLogErrorKind, Result } from '../schema/errors.ts';
import {
  EventSchema,
  type BranchId,
  type DirectorDirective,
  type Event,
  type EventDraft,
  type EventId,
  type RunId,
} from '../schema/event.ts';
import type { ScenarioBundle } from '../schema/bundle.ts';
import type { Component, ComponentContext, MetaRegistry } from '../schema/meta-component.ts';
import type {
  AgentService,
  Blackboard,
  EventLog,
  EventLogReplayOptions,
  MemoryService,
} from '../services/types.ts';
import type { AwaitDirectiveOpts, ComponentRegistry, DirectorPump } from './types.ts';

export function tmpRunDir(): string {
  return mkdtempSync(join(tmpdir(), 'ta-runner-'));
}

function nextId(seq: number): EventId {
  return `e${String(seq).padStart(7, '0')}`;
}

/** 内存 EventLog：id 取号 + parent 链 + 契约校验 + 快照定位 replay（对齐 §4.3/deep-dive 语义）。 */
export class MockEventLog implements EventLog {
  events: Event[] = [];
  activeBranch: BranchId = 'main';
  failAppend = false;
  private seq = 0;

  /** 测试装配：直接载入既有事件序列（崩溃现场重建）。 */
  load(events: Event[]): void {
    this.events = [...events];
    this.seq = events.length;
    const last = events[events.length - 1];
    if (last) this.activeBranch = last.branch;
  }

  append(draft: EventDraft): Result<Event, EventLogErrorKind> {
    if (this.failAppend) return { ok: false, error: 'APPEND_FAILED' };
    const id = nextId((this.seq += 1));
    const parent_id = this.events.length > 0 ? this.events[this.events.length - 1].id : null;
    const parsed = EventSchema.safeParse({ ...draft, id, parent_id });
    if (!parsed.success) {
      this.seq -= 1;
      return { ok: false, error: 'EVENT_SCHEMA_INVALID' };
    }
    this.events.push(parsed.data);
    this.activeBranch = parsed.data.branch; // append 只发生在活跃 leaf（§2.4-3）
    return { ok: true, value: parsed.data };
  }

  async replay(options?: EventLogReplayOptions): Promise<Result<AsyncIterable<Event>, EventLogErrorKind>> {
    let list = this.events;
    if (options?.until) {
      const idx = list.findIndex((e) => e.id === options.until);
      list = idx >= 0 ? list.slice(0, idx + 1) : [];
    }
    const branch = options?.branch ?? this.activeBranch;
    const firstDiverge = list.findIndex((e) => e.branch !== 'main');
    const onPath = (e: Event, idx: number): boolean =>
      e.branch === branch || firstDiverge === -1 || idx < firstDiverge;
    let snapIdx = -1;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i].type === 'snapshot') {
        snapIdx = i;
        break;
      }
    }
    let out: Event[];
    if (snapIdx >= 0) {
      // 版本身份随快照一并吐出：D33 恢复校验需要 run_started（bundle_hash），否则快照后恢复无法验证版本
      const root =
        list.find((e) => e.type === 'run_started' && e.branch === branch) ??
        list.find((e) => e.type === 'run_started');
      out = [
        ...(root ? [root] : []),
        list[snapIdx],
        ...list.slice(snapIdx + 1).filter((e, i) => onPath(e, snapIdx + 1 + i)),
      ];
    } else {
      out = list.filter((e, i) => onPath(e, i));
    }
    return {
      ok: true,
      value: (async function* () {
        for (const e of out) yield e;
      })(),
    };
  }

  branch(atEventId: EventId, newBranch: BranchId): Result<void, EventLogErrorKind> {
    const last = this.events[this.events.length - 1];
    if (!last || !this.events.some((e) => e.id === atEventId)) return { ok: false, error: 'BRANCH_NOT_FOUND' };
    const r = this.append({
      ts: new Date().toISOString(),
      run_id: last.run_id,
      branch: this.activeBranch,
      exec: null,
      type: 'fork',
      payload: { at_event_id: atEventId, new_branch: newBranch },
    });
    if (!r.ok) return r;
    this.activeBranch = newBranch;
    return { ok: true, value: undefined };
  }

  snapshot(state: unknown): Result<EventId, EventLogErrorKind> {
    const last = this.events[this.events.length - 1];
    const r = this.append({
      ts: new Date().toISOString(),
      run_id: last?.run_id ?? ('019785e0-0000-7000-8000-000000000000' as RunId),
      branch: this.activeBranch,
      exec: null,
      type: 'snapshot',
      payload: state,
    });
    return r.ok ? { ok: true, value: r.value.id } : { ok: false, error: r.error };
  }

  /** 测试便利：按类型过滤事件。 */
  ofType<T extends Event['type']>(type: T): Extract<Event, { type: T }>[] {
    return this.events.filter((e) => e.type === type) as Extract<Event, { type: T }>[];
  }
}

/** 内存黑板（mock 不做写穿——写穿是 3-A 职责；恢复路径 applyEvent 语义保留）。 */
export class MockBlackboard implements Blackboard {
  private data = new Map<string, unknown>();

  get(key: string): unknown {
    return this.data.get(key);
  }

  set(key: string, value: unknown): Result<void, never> {
    this.data.set(key, value);
    return { ok: true, value: undefined };
  }

  applyEvent(event: Event): void {
    if (event.type === 'bb_set') this.data.set(event.payload.key, event.payload.value);
    if (event.type === 'snapshot') this.data = new Map(Object.entries(event.payload.blackboard));
  }

  snapshot(): Record<string, unknown> {
    return Object.fromEntries(this.data);
  }
}

export function mockAgentService(): AgentService {
  const ok = { ok: true as const, value: undefined };
  return {
    create: () => ok,
    destroy: () => ok,
    steer: () => ok,
    followUp: () => ok,
    abort: () => ok,
    runTurn: async () => ({ ok: true, value: { kind: 'final', text: 'mock' } }),
  };
}

export function mockMemory(): MemoryService {
  const ok = { ok: true as const, value: undefined };
  return {
    mount: async () => ok,
    projection: () => ({ ok: true, value: null }),
    compact: async () => ok,
    persist: async () => ok,
  };
}

/** 元组件注册表 mock：bb_get/bb_set 接到 MockBlackboard；emit_cost 用于成本闸测试（落 cost 事件）。 */
export function mockMeta(bb: MockBlackboard, el?: MockEventLog, execOf?: () => { node_id: string; iteration: number }): MetaRegistry {
  return {
    call: async (name: string, args: unknown) => {
      const a = args as { key?: string; value?: unknown; amount?: number };
      if (name === 'bb_get') return { ok: true, value: bb.get(a.key!) };
      if (name === 'bb_set') {
        bb.set(a.key!, a.value);
        return { ok: true, value: undefined };
      }
      if (name === 'emit_cost' && el) {
        const exec = execOf?.() ?? { node_id: 'unknown', iteration: 0 };
        const r = el.append({
          ts: new Date().toISOString(),
          run_id: el.events[0]?.run_id ?? ('019785e0-0000-7000-8000-000000000000' as RunId),
          branch: el.activeBranch,
          exec,
          type: 'cost',
          payload: {
            agent_id: null,
            model: 'mock-model',
            usage: { input: 1, output: 1, cached_read: 0, cached_write: 0, reasoning: 0 },
            cost: { amount: a.amount ?? 0, currency: 'CNY' },
            raw_usage: {},
          },
        });
        return r.ok ? { ok: true, value: undefined } : { ok: false, error: r.error };
      }
      return { ok: true, value: undefined };
    },
  };
}

/** 组件工厂（description + run 两元，§4.7）。 */
export function makeComponent(
  type: string,
  run: (params: unknown, ctx: ComponentContext) => Promise<Result<void, 'COMPONENT_FAILED' | 'ABORTED' | 'PARAM_SCHEMA_INVALID'>>,
  opts?: { version?: string; inputs?: string[]; outputs?: string[] },
): Component {
  return {
    description: {
      name: type,
      version: opts?.version ?? '1.0.0',
      description: `mock ${type}`,
      parameters: {},
      inputs: opts?.inputs ?? ['in'],
      outputs: opts?.outputs ?? ['out'],
      writable_prefixes: [],
    },
    run,
  };
}

export class MockComponentRegistry implements ComponentRegistry {
  private comps = new Map<string, Component>();

  add(c: Component): this {
    this.comps.set(`${c.description.name}@${c.description.version}`, c);
    return this;
  }

  get(type: string, version?: string): Component | undefined {
    if (version) return this.comps.get(`${type}@${version}`);
    const hits = [...this.comps.values()].filter((c) => c.description.name === type);
    return hits[hits.length - 1];
  }

  list(): readonly Component[] {
    return [...this.comps.values()];
  }
}

/** 导演泵 mock（flow-runner 测试用；真实泵见 director-pump.test.ts）。 */
export function mockPump(): DirectorPump & {
  calls: AwaitDirectiveOpts[];
  cancelCount: number;
  isWaiting(): boolean;
  bindRunContext(): void;
  resolveNext(d: DirectorDirective): void;
} {
  let pending: ((r: Result<DirectorDirective, 'RUN_CANCELLED' | 'NODE_FAILED'>) => void) | null = null;
  const pump = {
    calls: [] as AwaitDirectiveOpts[],
    cancelCount: 0,
    isWaiting: () => pending !== null,
    bindRunContext: () => undefined,
    resolveNext(d: DirectorDirective) {
      const p = pending;
      pending = null;
      p?.({ ok: true, value: d });
    },
    awaitDirective(opts: AwaitDirectiveOpts) {
      pump.calls.push(opts);
      return new Promise<Result<DirectorDirective, 'RUN_CANCELLED' | 'NODE_FAILED'>>((resolve) => {
        pending = resolve;
        opts.signal.addEventListener('abort', () => {
          const p = pending;
          pending = null;
          p?.({ ok: false, error: 'RUN_CANCELLED' });
        }, { once: true });
      });
    },
    cancelAll() {
      pump.cancelCount += 1;
      const p = pending;
      pending = null;
      p?.({ ok: false, error: 'RUN_CANCELLED' });
    },
  };
  return pump;
}

/** 最小合法 Bundle（flow 由测试给定）。 */
export function makeBundle(flow: unknown, gameExtra: Record<string, unknown> = {}): ScenarioBundle {
  return {
    flow: flow as ScenarioBundle['flow'],
    game: {
      version: '1.0',
      rules: {},
      agents: [{ id: 'a1', identity_card: 'a1.yaml', model: { model: 'mock-model' }, memory_ref: null }],
      ...gameExtra,
    } as ScenarioBundle['game'],
    identity_cards: { 'a1.yaml': { version: '1.0', name: 'A1', description: 'mock card' } },
    worldbook: { version: '1.0', entries: [] },
    seeds: { version: '1.0', rng_seed: 42, llm_seed: null },
  };
}

export const OK_COMPONENT = async (): Promise<Result<void, never>> => ({ ok: true, value: undefined });

/** 轮询等待条件成立（异步时序测试用）。 */
export async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 5));
  }
}
