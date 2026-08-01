// Version: 1.0.0
/**
 * 内置组件 director_gate：导演门（D37：门 = 普通无状态组件，run 内经 await_director_input 等待，分支级阻塞）。
 * G1–G8（§3.2）：G1 gate_waiting → G2/G3 gate_input_received（超时 use_default 先落 gate_timeout）
 *   → G5 注入 → director_intervention；cancel_branch 落 gate_timeout + gate_cancelled；整局取消落 gate_cancelled + ABORTED。
 * follow-up 档走 followUp（D4）；whisper 目标已销毁降级为 note（F2b）；D15 超时三策略。
 */
import { createHash } from 'node:crypto';
import type { ComponentErrorKind, Result } from '../schema/errors.ts';
import type { DirectorDirective } from '../schema/event.ts';
import { DirectorGateParamsSchema } from '../schema/flow.ts';
import type { Component, ComponentContext } from '../schema/meta-component.ts';
import type { AwaitOutcome } from '../meta/builtins.ts';
import { callMeta, emit, jsonSchemaOf, parseParams } from './util.ts';

const sha256hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export const directorGateComponent: Component = {
  description: {
    name: 'director_gate',
    version: '1.0.0',
    description: '导演门：分支级阻塞等待导演干预并按类型注入（D15/D18/D27/D37；G1–G8）',
    parameters: jsonSchemaOf(DirectorGateParamsSchema),
    inputs: ['in'],
    outputs: ['out'],
    writable_prefixes: ['environment', 'worldbook'], // D26/D34：inject 环境数据与 worldbook 命名空间的唯一组件写者
  },
  async run(params, ctx) {
    const parsed = parseParams(DirectorGateParamsSchema, params);
    if (!parsed.ok) return parsed;
    const p = parsed.value;
    const fail = (error: ComponentErrorKind): Result<void, ComponentErrorKind> => ({ ok: false, error });

    // G1：分支到达，登记等待（D27 单门约束由加载期校验 + 泵侧运行期兜底）
    const w = await emit(ctx, 'gate_waiting', { targets: p.targets, accepts: p.accepts, timeout: p.timeout });
    if (!w.ok) return w;

    const awaited = await callMeta(ctx, 'await_director_input', { targets: p.targets, accepts: p.accepts, timeout: p.timeout });
    if (!awaited.ok) return awaited;
    const a = awaited.value as AwaitOutcome;

    if (a.outcome === 'cancelled') {
      // G4：超时 cancel_branch 先落 gate_timeout，再落 gate_cancelled；整局取消直接落 gate_cancelled
      if (a.reason === 'timeout_cancel_branch') {
        const t = await emit(ctx, 'gate_timeout', { policy: 'cancel_branch', waited_ms: a.waited_ms });
        if (!t.ok) return t;
      }
      const c = await emit(ctx, 'gate_cancelled', { reason: a.reason });
      if (!c.ok) return c;
      return fail(a.reason === 'run_cancelled' ? 'ABORTED' : 'COMPONENT_FAILED');
    }
    if (a.outcome === 'node_failed') return fail('COMPONENT_FAILED'); // 第二门进入 WAITING（D37 兜底）

    // G2/G3：读到有效干预（超时默认输入先落 gate_timeout）
    const d: DirectorDirective = a.directive;
    const hash = sha256hex(d.text);
    if (a.source === 'timeout_default') {
      const t = await emit(ctx, 'gate_timeout', { policy: 'use_default', waited_ms: a.waited_ms });
      if (!t.ok) return t;
    }
    const g = await emit(ctx, 'gate_input_received', { directive: d, directive_hash: hash, source: a.source });
    if (!g.ok) return g;
    if (ctx.signal.aborted) {
      // G6：安全点到达前整局取消，丢弃未注入输入（已落盘可溯）
      const c = await emit(ctx, 'gate_cancelled', { reason: 'run_cancelled' });
      return c.ok ? fail('ABORTED') : c;
    }

    // G5：按类型注入（D3 安全点纪律由服务侧 steer/followUp 队列保证）
    const outcome = await inject(d, ctx);
    if (!outcome.ok) return outcome;
    const i = await emit(ctx, 'director_intervention', { directive: d, directive_hash: hash, outcome: outcome.value });
    return i.ok ? { ok: true, value: undefined } : i;
  },
};

/** G5 注入：返回 director_intervention 的 outcome（applied / degraded_to_note）。 */
async function inject(
  d: DirectorDirective,
  ctx: ComponentContext,
): Promise<Result<'applied' | 'degraded_to_note', ComponentErrorKind>> {
  /** whisper 类：steering 档走 steer，follow-up 档走 followUp（D4）；目标已销毁降级 note（F2b）。 */
  async function toAgents(metaName: 'steer_agent' | 'follow_up_agent'): Promise<Result<'applied' | 'degraded_to_note', ComponentErrorKind>> {
    let degraded = false;
    for (const t of d.targets) {
      const r = await ctx.meta.call(metaName, { agent_id: t, directive: d }, ctx);
      if (!r.ok && (r.error === 'AGENT_DESTROYED' || r.error === 'AGENT_NOT_FOUND')) degraded = true;
      else if (!r.ok) return { ok: false, error: 'COMPONENT_FAILED' };
    }
    return { ok: true, value: degraded ? 'degraded_to_note' : 'applied' };
  }

  /** 黑板读改写：inject 公开环境事件 / edit_world 世界书（D34），数组追加形态。 */
  async function appendToBlackboard(key: string, reason: string): Promise<Result<'applied', ComponentErrorKind>> {
    const cur = await callMeta(ctx, 'bb_get', { key });
    if (!cur.ok) return cur;
    const list = Array.isArray(cur.value) ? [...(cur.value as unknown[])] : [];
    list.push({ text: d.text });
    const s = await callMeta(ctx, 'bb_set', { key, value: list, reason });
    return s.ok ? { ok: true, value: 'applied' } : s;
  }

  switch (d.kind) {
    case 'whisper':
      return toAgents(d.mode === 'follow_up' ? 'follow_up_agent' : 'steer_agent');
    case 'agent_broadcast':
      return toAgents('steer_agent');
    case 'inject':
      return appendToBlackboard('environment.injections', 'director inject');
    case 'edit_world':
      return appendToBlackboard('worldbook.director_edits', 'director edit_world');
    case 'note':
      return { ok: true, value: 'degraded_to_note' }; // D18：note 不经门；防御分支
  }
}
