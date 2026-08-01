// Version: 1.0.0
/**
 * 测试专用装配件（不进生产路径）：mock 服务 / 泵 / 信封源 / ComponentContext 工厂。
 * mock eventLog 以 EventDraftSchema 真校验——测试同时验证组件发射的事件符合契约（F12）。
 */
import type { Result } from '../schema/errors.ts';
import type { Event, EventDraft, EventId } from '../schema/event.ts';
import { EventDraftSchema } from '../schema/event.ts';
import type { TurnOutcome } from '../schema/meta-component.ts';
import type { ComponentContext, MetaRegistry } from '../schema/meta-component.ts';
import type { AgentService, Blackboard, EventLog, MemoryService } from '../services/types.ts';
import type { AwaitDirectiveOpts, DirectorPump } from '../orchestrator/types.ts';
import type { MetaEnvelope } from './registry.ts';

/** 生成合法 UUID v7 形态（z.uuidv7() 校验用；仅测试）。 */
export function fakeUuid7(): string {
  const hex = () => '0123456789abcdef'[Math.floor(Math.random() * 16)];
  const s = (n: number) => Array.from({ length: n }, hex).join('');
  return `${s(8)}-${s(4)}-7${s(3)}-${'89ab'[Math.floor(Math.random() * 4)]}${s(3)}-${s(12)}`;
}

export interface MockAgentService extends AgentService {
  calls: { method: string; args: unknown[] }[];
  runTurnImpl: (id: string, ctx: { intent: string }) => Promise<Result<TurnOutcome, string>>;
}

export function mockAgentService(): MockAgentService {
  const calls: MockAgentService['calls'] = [];
  const svc: MockAgentService = {
    calls,
    runTurnImpl: async () => ({ ok: true, value: { kind: 'final', text: '（沉默）' } }),
    create(spec) {
      calls.push({ method: 'create', args: [spec] });
      return { ok: true, value: undefined };
    },
    destroy(id) {
      calls.push({ method: 'destroy', args: [id] });
      return { ok: true, value: undefined };
    },
    steer(id, msg) {
      calls.push({ method: 'steer', args: [id, msg] });
      return { ok: true, value: undefined };
    },
    followUp(id, msg) {
      calls.push({ method: 'followUp', args: [id, msg] });
      return { ok: true, value: undefined };
    },
    abort(id) {
      calls.push({ method: 'abort', args: [id] });
      return { ok: true, value: undefined };
    },
    async runTurn(id, ctx) {
      calls.push({ method: 'runTurn', args: [id, ctx] });
      return svc.runTurnImpl(id, ctx) as Promise<Result<TurnOutcome, never>>;
    },
  };
  return svc;
}

export interface MockBlackboard extends Blackboard {
  data: Map<string, unknown>;
}

export function mockBlackboard(): MockBlackboard {
  const data = new Map<string, unknown>();
  return {
    data,
    get: (key) => data.get(key),
    set: (key, value) => {
      data.set(key, value);
      return { ok: true, value: undefined };
    },
    applyEvent(event) {
      if (event.type === 'bb_set') data.set(event.payload.key, event.payload.value);
    },
    snapshot: () => Object.fromEntries(data),
  };
}

export interface MockEventLog extends EventLog {
  events: Event[];
}

export function mockEventLog(): MockEventLog {
  const events: Event[] = [];
  return {
    events,
    append(draft) {
      const parsed = EventDraftSchema.safeParse(draft); // 真校验：拒写非法事件（F12）
      if (!parsed.success) return { ok: false, error: 'EVENT_SCHEMA_INVALID' };
      const id: EventId = `e${String(events.length + 1).padStart(7, '0')}`;
      const parent_id = events.length === 0 ? null : events[events.length - 1].id;
      const ev = { ...parsed.data, id, parent_id } as Event;
      events.push(ev);
      return { ok: true, value: ev };
    },
    async replay() {
      return { ok: true, value: (async function* () { yield* events; })() };
    },
    branch: () => ({ ok: true, value: undefined }),
    snapshot: () => ({ ok: true, value: 'e0000001' as EventId }),
  };
}

export function mockMemory(): MemoryService {
  return {
    mount: async () => ({ ok: true, value: undefined }),
    projection: () => ({ ok: true, value: undefined }),
    compact: async () => ({ ok: true, value: undefined }),
    persist: async () => ({ ok: true, value: undefined }),
  };
}

export interface MockPump extends DirectorPump {
  impl: (opts: AwaitDirectiveOpts) => Promise<Result<import('../schema/event.ts').DirectorDirective, 'RUN_CANCELLED' | 'NODE_FAILED'>>;
}

export function mockPump(): MockPump {
  return {
    impl: async () => ({ ok: false, error: 'RUN_CANCELLED' }),
    awaitDirective(opts) {
      return this.impl(opts);
    },
    cancelAll() {},
  };
}

/** 可变信封源：测试模拟 FlowRunner 的逐节点绑定。 */
export function mockEnvelopeSource(exec?: { node_id: string; iteration: number }) {
  const env: MetaEnvelope = {
    run_id: fakeUuid7(),
    branch: 'main',
    exec: exec ?? { node_id: 'test_node', iteration: 0 },
  };
  return { env, source: { current: () => env as MetaEnvelope | null } };
}

export function makeCtx(meta: MetaRegistry, extra?: Partial<ComponentContext>): ComponentContext {
  return { meta, signal: new AbortController().signal, ...extra };
}
