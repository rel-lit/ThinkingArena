// Version: 1.0.0
/** narrative.ts 测试：final 落 speech/monologue（D31/D35）、组件驱动工具循环（§2.2）、D28 上限。 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { TurnOutcome } from '../schema/meta-component.ts';
import { createMetaRegistry } from '../meta/registry.ts';
import {
  makeCtx,
  mockAgentService,
  mockBlackboard,
  mockEnvelopeSource,
  mockEventLog,
  mockMemory,
} from '../meta/testkit.ts';
import { narrativeComponent } from './narrative.ts';

function setup() {
  const agentService = mockAgentService();
  const blackboard = mockBlackboard();
  const eventLog = mockEventLog();
  const { source } = mockEnvelopeSource();
  const meta = createMetaRegistry({
    agentService,
    memory: mockMemory(),
    blackboard,
    eventLog,
    envelopeSource: source,
  });
  return { agentService, blackboard, eventLog, meta, ctx: makeCtx(meta) };
}

const PARAMS = { agent_id: 'hero', intent: '描述眼前景象' };

describe('narrative 组件', () => {
  test('final：落 speech + monologue（reasoning 全文，D31）', async () => {
    const { agentService, eventLog, ctx } = setup();
    agentService.runTurnImpl = async () => ({ ok: true, value: { kind: 'final', text: '荒原尽头有火光。', reasoning: '先观察再行动…' } });
    const r = await narrativeComponent.run(PARAMS, ctx);
    assert.equal(r.ok, true);
    assert.deepEqual(
      eventLog.events.map((e) => [e.type, (e.payload as { text: string }).text]),
      [
        ['monologue', '先观察再行动…'],
        ['speech', '荒原尽头有火光。'],
      ],
    );
  });

  test('emit_monologue=false 时只落 speech；无 reasoning 不落 monologue', async () => {
    const { agentService, eventLog, ctx } = setup();
    agentService.runTurnImpl = async () => ({ ok: true, value: { kind: 'final', text: '嗯。', reasoning: '想' } });
    await narrativeComponent.run({ ...PARAMS, emit_monologue: false }, ctx);
    assert.deepEqual(eventLog.events.map((e) => e.type), ['speech']);
  });

  test('工具循环：授权工具经元组件执行，结果回灌下一轮（§2.2）', async () => {
    const { agentService, blackboard, eventLog, ctx } = setup();
    blackboard.data.set('world.day', 3);
    let round = 0;
    agentService.runTurnImpl = async (): Promise<{ ok: true; value: TurnOutcome }> => {
      round++;
      if (round === 1) {
        return { ok: true, value: { kind: 'tool_calls', calls: [{ call_id: 'c1', name: 'bb_get', arguments: { key: 'world.day' } }] } };
      }
      return { ok: true, value: { kind: 'final', text: '第三天了。' } };
    };
    const r = await narrativeComponent.run({ ...PARAMS, tools: ['bb_get'] }, ctx);
    assert.equal(r.ok, true);
    assert.equal(round, 2);
    // 第二次 call_agent 携带工具结果（call_id 配对）
    const calls = agentService.calls.filter((c) => c.method === 'runTurn');
    const second = calls[1].args[1] as { toolResults: { call: { call_id: string }; result: unknown }[] };
    assert.equal(second.toolResults[0].call.call_id, 'c1');
    assert.equal(second.toolResults[0].result, 3);
    assert.equal(eventLog.events.at(-1)!.type, 'speech');
  });

  test('未授权工具：结果以 is_error 回灌，不执行元组件', async () => {
    const { agentService, ctx } = setup();
    let round = 0;
    agentService.runTurnImpl = async (): Promise<{ ok: true; value: TurnOutcome }> => {
      round++;
      if (round === 1) {
        return { ok: true, value: { kind: 'tool_calls', calls: [{ call_id: 'c9', name: 'bb_set', arguments: { key: 'x', value: 1 } }] } };
      }
      return { ok: true, value: { kind: 'final', text: '好吧。' } };
    };
    const r = await narrativeComponent.run({ ...PARAMS, tools: [] }, ctx);
    assert.equal(r.ok, true);
    const calls = agentService.calls.filter((c) => c.method === 'runTurn');
    const second = calls[1].args[1] as { toolResults: { result: { is_error: boolean } }[] };
    assert.equal(second.toolResults[0].result.is_error, true);
  });

  test('TurnOutcome error → COMPONENT_FAILED；工具循环超 D28 上限 → COMPONENT_FAILED', async () => {
    const { agentService, ctx } = setup();
    agentService.runTurnImpl = async () => ({ ok: true, value: { kind: 'error', error: 'TURN_FAILED' } });
    const r = await narrativeComponent.run(PARAMS, ctx);
    assert.deepEqual(r, { ok: false, error: 'COMPONENT_FAILED' });

    agentService.runTurnImpl = async () => ({
      ok: true,
      value: { kind: 'tool_calls', calls: [{ call_id: 'c', name: 'bb_get', arguments: { key: 'x' } }] },
    });
    const r2 = await narrativeComponent.run({ ...PARAMS, tools: ['bb_get'], max_tool_rounds: 2 }, ctx);
    assert.deepEqual(r2, { ok: false, error: 'COMPONENT_FAILED' });
  });

  test('非法参数 → PARAM_SCHEMA_INVALID', async () => {
    const { ctx } = setup();
    assert.deepEqual(await narrativeComponent.run({}, ctx), { ok: false, error: 'PARAM_SCHEMA_INVALID' });
  });
});
