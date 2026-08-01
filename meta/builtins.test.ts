// Version: 1.0.0
/** builtins.ts 测试：名册六件 + 扩展四件的服务映射、信封补齐、批缓冲预留、D15 超时三策略。 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { DirectorDirective } from '../schema/event.ts';
import { createMetaRegistry } from './registry.ts';
import type { AwaitOutcome } from './builtins.ts';
import {
  makeCtx,
  mockAgentService,
  mockBlackboard,
  mockEnvelopeSource,
  mockEventLog,
  mockMemory,
  mockPump,
} from './testkit.ts';

function setup(opts?: { withPump?: boolean; withEnvelope?: boolean }) {
  const agentService = mockAgentService();
  const blackboard = mockBlackboard();
  const eventLog = mockEventLog();
  const directorPump = mockPump();
  const { env, source } = mockEnvelopeSource({ node_id: 'gate_node', iteration: 0 });
  const meta = createMetaRegistry({
    agentService,
    memory: mockMemory(),
    blackboard,
    eventLog,
    directorPump: opts?.withPump === false ? undefined : directorPump,
    envelopeSource: opts?.withEnvelope === false ? undefined : source,
  });
  return { agentService, blackboard, eventLog, directorPump, env, meta, ctx: makeCtx(meta) };
}

const WHISPER: DirectorDirective = { kind: 'whisper', text: '你感到不安', targets: ['hero'], mode: 'steering' };
const GATE_PARAMS = {
  targets: ['hero'],
  accepts: ['whisper'],
  timeout: { policy: 'wait_forever' },
};

describe('call_agent（→ agentService.runTurn）', () => {
  test('参数映射与 TurnOutcome 透传', async () => {
    const { agentService, meta, ctx } = setup();
    agentService.runTurnImpl = async () => ({ ok: true, value: { kind: 'final', text: '你好' } });
    const r = await meta.call('call_agent', { agent_id: 'hero', intent: '打个招呼' }, ctx);
    assert.equal(r.ok, true);
    assert.deepEqual((r as { value: unknown }).value, { kind: 'final', text: '你好' });
    const [, turnCtx] = agentService.calls.find((c) => c.method === 'runTurn')!.args as [string, { intent: string }];
    assert.equal(turnCtx.intent, '打个招呼');
  });

  test('tool_results 配对映射（call_id + content；is_error 包装）与服务错误编码透传', async () => {
    const { agentService, meta, ctx } = setup();
    agentService.runTurnImpl = async () => ({ ok: false, error: 'AGENT_BUSY' });
    const r = await meta.call(
      'call_agent',
      { agent_id: 'hero', intent: '继续', tool_results: [{ call_id: 'c1', content: 42 }, { call_id: 'c2', content: 'x', is_error: true }] },
      ctx,
    );
    assert.deepEqual(r, { ok: false, error: 'AGENT_BUSY' });
    const [, turnCtx] = agentService.calls.find((c) => c.method === 'runTurn')!.args as [
      string,
      { toolResults: { call: { call_id: string }; result: unknown }[] },
    ];
    assert.equal(turnCtx.toolResults[0].call.call_id, 'c1');
    assert.equal(turnCtx.toolResults[0].result, 42);
    assert.deepEqual(turnCtx.toolResults[1].result, { is_error: true, content: 'x' });
  });
});

describe('inject_context / bb_get / bb_set', () => {
  test('inject_context → steer（whisper/steering 档，单目标）', async () => {
    const { agentService, meta, ctx } = setup();
    const r = await meta.call('inject_context', { target_agent_id: 'hero', text: '身后有脚步声', source: 'npc' }, ctx);
    assert.equal(r.ok, true);
    const [id, msg] = agentService.calls.find((c) => c.method === 'steer')!.args as [string, DirectorDirective];
    assert.equal(id, 'hero');
    assert.deepEqual(msg, { kind: 'whisper', text: '身后有脚步声', targets: ['hero'], mode: 'steering' });
  });

  test('bb_get：命中与未命中（undefined 非错误）', async () => {
    const { blackboard, meta, ctx } = setup();
    blackboard.data.set('protagonist.hp', 10);
    assert.deepEqual(await meta.call('bb_get', { key: 'protagonist.hp' }, ctx), { ok: true, value: 10 });
    assert.deepEqual(await meta.call('bb_get', { key: 'missing' }, ctx), { ok: true, value: undefined });
  });

  test('bb_set：先落 bb_set 事件（含 reason 与信封）再以 applyEvent 生效', async () => {
    const { blackboard, eventLog, env, meta, ctx } = setup();
    const r = await meta.call('bb_set', { key: 'protagonist.hp', value: 8, reason: '受击 -2' }, ctx);
    assert.deepEqual(r, { ok: true, value: undefined });
    assert.equal(eventLog.events.length, 1);
    const ev = eventLog.events[0];
    assert.equal(ev.type, 'bb_set');
    assert.deepEqual(ev.payload, { key: 'protagonist.hp', value: 8, reason: '受击 -2' });
    assert.deepEqual(ev.exec, env.exec);
    assert.equal(ev.run_id, env.run_id);
    assert.equal(blackboard.get('protagonist.hp'), 8); // 事件在前、生效在后（D1）
  });
});

describe('emit_event（F12/D35）', () => {
  test('补齐信封后 append，返回盖章事件', async () => {
    const { env, eventLog, meta, ctx } = setup();
    const r = await meta.call('emit_event', { type: 'speech', payload: { agent_id: 'hero', text: '冲啊' } }, ctx);
    assert.equal(r.ok, true);
    const ev = (r as { value: { id: string; run_id: string } }).value;
    assert.equal(ev.id, 'e0000001');
    assert.equal(ev.run_id, env.run_id);
    assert.equal(eventLog.events.length, 1);
  });

  test('无信封源 → COMPONENT_FAILED；契约非法事件 → EVENT_SCHEMA_INVALID 编码', async () => {
    const { meta, ctx } = setup({ withEnvelope: false });
    assert.deepEqual(await meta.call('emit_event', { type: 'speech', payload: { agent_id: 'h', text: 'x' } }, ctx), {
      ok: false,
      error: 'COMPONENT_FAILED',
    });
    const s2 = setup();
    const bad = await s2.meta.call('emit_event', { type: 'speech', payload: { wrong: 1 } }, s2.ctx);
    assert.deepEqual(bad, { ok: false, error: 'EVENT_SCHEMA_INVALID' });
    assert.equal(s2.eventLog.events.length, 0); // 拒写
  });

  test('batchView 存在时写入本分支缓冲而非直接 append（D9 批协议预留）', async () => {
    const { eventLog, meta } = setup();
    const buffer: unknown[] = [];
    const ctx = makeCtx(meta, { batchView: { snapshot: {}, branchBuffer: buffer } });
    const r = await meta.call('emit_event', { type: 'speech', payload: { agent_id: 'hero', text: '批内' } }, ctx);
    assert.equal(r.ok, true);
    assert.equal(buffer.length, 1);
    assert.equal(eventLog.events.length, 0); // 批结束才串行提交取号
  });
});

describe('await_director_input（D15 计时归泵侧，架构师裁决）', () => {
  test('透传 timeoutPolicy 与 gateNodeId；泵解析导演指令 → received/director_inbox', async () => {
    const { directorPump, meta, ctx } = setup();
    let seen: { gateNodeId?: string; timeoutPolicy?: unknown } = {};
    directorPump.impl = async (opts) => {
      seen = { gateNodeId: opts.gateNodeId, timeoutPolicy: opts.timeoutPolicy };
      return { ok: true, value: WHISPER };
    };
    const params = { ...GATE_PARAMS, timeout: { policy: 'use_default', after_ms: 5000, default_input: { kind: 'inject', text: '默认', targets: [], mode: null } } };
    const r = await meta.call('await_director_input', params, ctx);
    const a = (r as { value: AwaitOutcome }).value;
    assert.equal(a.outcome, 'received');
    if (a.outcome === 'received') {
      assert.equal(a.source, 'director_inbox'); // 非默认输入本体
      assert.deepEqual(a.directive, WHISPER);
    }
    assert.equal(seen.gateNodeId, 'gate_node');
    assert.deepEqual(seen.timeoutPolicy, params.timeout); // 完整透传，本层不计时
  });

  test('泵解析默认输入本体（use_default 到期语义）→ received/timeout_default', async () => {
    const { directorPump, meta, ctx } = setup();
    directorPump.impl = async (opts) => {
      const tp = opts.timeoutPolicy as { default_input: DirectorDirective };
      return { ok: true, value: tp.default_input }; // 模拟 3-C 泵：到期解析 default_input
    };
    const params = {
      ...GATE_PARAMS,
      timeout: { policy: 'use_default', after_ms: 5000, default_input: { kind: 'inject', text: '起风了', targets: [], mode: null } },
    };
    const a = ((await meta.call('await_director_input', params, ctx)) as { value: AwaitOutcome }).value;
    assert.equal(a.outcome, 'received');
    if (a.outcome === 'received') {
      assert.equal(a.source, 'timeout_default');
      assert.equal(a.directive.text, '起风了');
      assert.ok(a.waited_ms >= 0);
    }
  });

  test('泵 RUN_CANCELLED → cancelled/run_cancelled；泵 NODE_FAILED（wait_forever）→ node_failed', async () => {
    const { directorPump, meta, ctx } = setup();
    directorPump.impl = async () => ({ ok: false, error: 'RUN_CANCELLED' });
    let a = ((await meta.call('await_director_input', GATE_PARAMS, ctx)) as { value: AwaitOutcome }).value;
    assert.deepEqual(a.outcome, 'cancelled');
    directorPump.impl = async () => ({ ok: false, error: 'NODE_FAILED' });
    a = ((await meta.call('await_director_input', GATE_PARAMS, ctx)) as { value: AwaitOutcome }).value;
    assert.equal(a.outcome, 'node_failed');
  });

  test('NODE_FAILED 二义（发起时刻 + after_ms）：cancel_branch 到期 → cancelled/timeout_cancel_branch；即时 → node_failed（第二门）', async () => {
    const { directorPump, meta, ctx } = setup();
    const params = { ...GATE_PARAMS, timeout: { policy: 'cancel_branch', after_ms: 10 } };
    directorPump.impl = async () => {
      await new Promise((r) => setTimeout(r, 30)); // 模拟泵在 after_ms 后到期返回 NODE_FAILED
      return { ok: false, error: 'NODE_FAILED' };
    };
    let a = ((await meta.call('await_director_input', params, ctx)) as { value: AwaitOutcome }).value;
    assert.equal(a.outcome, 'cancelled');
    if (a.outcome === 'cancelled') assert.equal(a.reason, 'timeout_cancel_branch');

    directorPump.impl = async () => ({ ok: false, error: 'NODE_FAILED' }); // 即时：第二门进入（D37）
    a = ((await meta.call('await_director_input', params, ctx)) as { value: AwaitOutcome }).value;
    assert.equal(a.outcome, 'node_failed');
  });

  test('无泵装配 → COMPONENT_FAILED', async () => {
    const { meta, ctx } = setup({ withPump: false });
    assert.deepEqual(await meta.call('await_director_input', GATE_PARAMS, ctx), { ok: false, error: 'COMPONENT_FAILED' });
  });
});

describe('扩展四件（名册非穷举）', () => {
  test('create_agent / destroy_agent / steer_agent / follow_up_agent 映射', async () => {
    const { agentService, meta, ctx } = setup();
    const spec = {
      id: 'hero',
      identity_card: { version: '1.0', name: '勇者', description: '普通人' },
      model: { model: 'deepseek-chat' },
    };
    await meta.call('create_agent', spec, ctx);
    const created = agentService.calls.find((c) => c.method === 'create')!.args[0] as {
      id: string;
      identityCard: { name: string };
      modelBinding: { model: string };
    };
    assert.equal(created.id, 'hero');
    assert.equal(created.identityCard.name, '勇者');
    assert.equal(created.modelBinding.model, 'deepseek-chat');

    await meta.call('steer_agent', { agent_id: 'hero', directive: WHISPER }, ctx);
    await meta.call('follow_up_agent', { agent_id: 'hero', directive: { ...WHISPER, mode: 'follow_up' } }, ctx);
    await meta.call('destroy_agent', { agent_id: 'hero' }, ctx);
    const methods = agentService.calls.map((c) => c.method);
    assert.deepEqual(methods, ['create', 'steer', 'followUp', 'destroy']);
  });
});
