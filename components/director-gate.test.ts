// Version: 1.0.0
/** director-gate.ts 测试：G1–G8 事件序列、D4 双档注入、F2b 降级、D15 超时三策略。 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { DirectorDirective } from '../schema/event.ts';
import { createMetaRegistry } from '../meta/registry.ts';
import {
  makeCtx,
  mockAgentService,
  mockBlackboard,
  mockEnvelopeSource,
  mockEventLog,
  mockMemory,
  mockPump,
} from '../meta/testkit.ts';
import { directorGateComponent } from './director-gate.ts';

function setup() {
  const agentService = mockAgentService();
  const blackboard = mockBlackboard();
  const eventLog = mockEventLog();
  const directorPump = mockPump();
  const { source } = mockEnvelopeSource({ node_id: 'gate', iteration: 0 });
  const meta = createMetaRegistry({
    agentService,
    memory: mockMemory(),
    blackboard,
    eventLog,
    directorPump,
    envelopeSource: source,
  });
  return { agentService, blackboard, eventLog, directorPump, ctx: makeCtx(meta) };
}

const PARAMS = { targets: ['hero'], accepts: ['whisper', 'inject', 'edit_world', 'agent_broadcast'], timeout: { policy: 'wait_forever' } };
const WHISPER: DirectorDirective = { kind: 'whisper', text: '你听到低语', targets: ['hero'], mode: 'steering' };

const types = (events: { type: string }[]) => events.map((e) => e.type);

describe('director_gate 组件（G1–G8）', () => {
  test('whisper/steering：gate_waiting → gate_input_received → steer → director_intervention(applied)', async () => {
    const { agentService, eventLog, directorPump, ctx } = setup();
    directorPump.impl = async () => ({ ok: true, value: WHISPER });
    const r = await directorGateComponent.run(PARAMS, ctx);
    assert.equal(r.ok, true);
    assert.deepEqual(types(eventLog.events), ['gate_waiting', 'gate_input_received', 'director_intervention']);
    const received = eventLog.events[1].payload as { directive: DirectorDirective; directive_hash: string; source: string };
    assert.deepEqual(received.directive, WHISPER);
    assert.match(received.directive_hash, /^[0-9a-f]{64}$/);
    assert.equal(received.source, 'director_inbox');
    const [, msg] = agentService.calls.find((c) => c.method === 'steer')!.args as [string, DirectorDirective];
    assert.deepEqual(msg, WHISPER);
    const intervention = eventLog.events[2].payload as { outcome: string };
    assert.equal(intervention.outcome, 'applied');
  });

  test('whisper/follow_up 档走 followUp（D4）；agent_broadcast 多目标逐个 steer', async () => {
    const { agentService, directorPump, ctx } = setup();
    directorPump.impl = async () => ({ ok: true, value: { ...WHISPER, mode: 'follow_up' } });
    await directorGateComponent.run(PARAMS, ctx);
    assert.equal(agentService.calls.some((c) => c.method === 'followUp'), true);
    assert.equal(agentService.calls.some((c) => c.method === 'steer'), false);

    const s2 = setup();
    const broadcast: DirectorDirective = { kind: 'agent_broadcast', text: '全体注意', targets: ['a', 'b'], mode: null };
    s2.directorPump.impl = async () => ({ ok: true, value: broadcast });
    await directorGateComponent.run(PARAMS, s2.ctx);
    const steered = s2.agentService.calls.filter((c) => c.method === 'steer').map((c) => c.args[0]);
    assert.deepEqual(steered, ['a', 'b']);
  });

  test('inject → 黑板 environment.injections；edit_world → worldbook.director_edits（D34）', async () => {
    const { blackboard, directorPump, ctx } = setup();
    directorPump.impl = async () => ({ ok: true, value: { kind: 'inject', text: '天降酸雨', targets: [], mode: null } });
    await directorGateComponent.run(PARAMS, ctx);
    assert.deepEqual(blackboard.get('environment.injections'), [{ text: '天降酸雨' }]);

    const s2 = setup();
    s2.directorPump.impl = async () => ({ ok: true, value: { kind: 'edit_world', text: '荒原夜晚极寒', targets: [], mode: null } });
    await directorGateComponent.run(PARAMS, s2.ctx);
    assert.deepEqual(s2.blackboard.get('worldbook.director_edits'), [{ text: '荒原夜晚极寒' }]);
  });

  test('whisper 目标已销毁：干预降级为 note（F2b），outcome=degraded_to_note', async () => {
    const { agentService, eventLog, directorPump, ctx } = setup();
    agentService.steer = (id, msg) => {
      agentService.calls.push({ method: 'steer', args: [id, msg] });
      return { ok: false, error: 'AGENT_DESTROYED' };
    };
    directorPump.impl = async () => ({ ok: true, value: WHISPER });
    const r = await directorGateComponent.run(PARAMS, ctx);
    assert.equal(r.ok, true);
    const intervention = eventLog.events.at(-1)!.payload as { outcome: string };
    assert.equal(intervention.outcome, 'degraded_to_note');
  });

  test('超时 use_default（G3）：gate_timeout → gate_input_received(timeout_default) → 注入', async () => {
    const { eventLog, directorPump, ctx } = setup();
    // 模拟 3-C 泵：到期解析门参数中的默认输入本体（D15 计时归泵侧）
    directorPump.impl = async (opts) => {
      const tp = opts.timeoutPolicy as { default_input: DirectorDirective };
      return { ok: true, value: tp.default_input };
    };
    const params = {
      ...PARAMS,
      timeout: { policy: 'use_default', after_ms: 20, default_input: { kind: 'inject', text: '默认风声', targets: [], mode: null } },
    };
    const r = await directorGateComponent.run(params, ctx);
    assert.equal(r.ok, true);
    // inject 默认输入经 bb_set 写穿落盘（G5），故序列含 bb_set
    assert.deepEqual(types(eventLog.events), ['gate_waiting', 'gate_timeout', 'gate_input_received', 'bb_set', 'director_intervention']);
    const received = eventLog.events[2].payload as { source: string };
    assert.equal(received.source, 'timeout_default');
  });

  test('超时 cancel_branch（G4）：gate_timeout + gate_cancelled，节点失败', async () => {
    const { eventLog, directorPump, ctx } = setup();
    // 模拟 3-C 泵：cancel_branch 到期返回 NODE_FAILED（发起时刻 + after_ms 判定）
    directorPump.impl = async () => {
      await new Promise((r) => setTimeout(r, 30));
      return { ok: false, error: 'NODE_FAILED' };
    };
    const params = { ...PARAMS, timeout: { policy: 'cancel_branch', after_ms: 10 } };
    const r = await directorGateComponent.run(params, ctx);
    assert.deepEqual(r, { ok: false, error: 'COMPONENT_FAILED' });
    assert.deepEqual(types(eventLog.events), ['gate_waiting', 'gate_timeout', 'gate_cancelled']);
    assert.equal((eventLog.events[2].payload as { reason: string }).reason, 'timeout_cancel_branch');
  });

  test('整局取消（G4/G6）：泵 RUN_CANCELLED → gate_cancelled(run_cancelled)，组件 ABORTED', async () => {
    const { eventLog, directorPump, ctx } = setup();
    directorPump.impl = async () => ({ ok: false, error: 'RUN_CANCELLED' });
    const r = await directorGateComponent.run(PARAMS, ctx);
    assert.deepEqual(r, { ok: false, error: 'ABORTED' });
    assert.deepEqual(types(eventLog.events), ['gate_waiting', 'gate_cancelled']);
    assert.equal((eventLog.events[1].payload as { reason: string }).reason, 'run_cancelled');
  });

  test('第二门进入（D37 运行期兜底）：泵 NODE_FAILED → 节点失败，无 gate_cancelled', async () => {
    const { eventLog, directorPump, ctx } = setup();
    directorPump.impl = async () => ({ ok: false, error: 'NODE_FAILED' });
    const r = await directorGateComponent.run(PARAMS, ctx);
    assert.deepEqual(r, { ok: false, error: 'COMPONENT_FAILED' });
    assert.deepEqual(types(eventLog.events), ['gate_waiting']);
  });

  test('非法参数 → PARAM_SCHEMA_INVALID', async () => {
    const { ctx } = setup();
    assert.deepEqual(await directorGateComponent.run({ targets: [] }, ctx), { ok: false, error: 'PARAM_SCHEMA_INVALID' });
  });
});
