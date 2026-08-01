// Version: 1.0.0
/** judge.ts 测试：骰子 + 裁判裁决 + 状态更新最小链路；judge_retry（D17）与数值依据（D31）。 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createMetaRegistry } from '../meta/registry.ts';
import {
  makeCtx,
  mockAgentService,
  mockBlackboard,
  mockEnvelopeSource,
  mockEventLog,
  mockMemory,
} from '../meta/testkit.ts';
import { createJudgeComponent } from './judge.ts';
import { mulberry32 } from './dice.ts';

function setup(seed = 42) {
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
  return { agentService, blackboard, eventLog, ctx: makeCtx(meta), component: createJudgeComponent(mulberry32(seed)) };
}

const PARAMS = {
  subject: '跃过断崖',
  referee_agent_id: 'referee',
  grades: ['大成功', '成功', '失败'],
  dice_expression: '1d20+2',
  modifier: 1,
};

const VERDICT_JSON = JSON.stringify({
  grade: '成功',
  rationale: '骰点过阈值 10',
  updates: [{ key: 'protagonist.hp', value: 8, reason: '落地擦伤 -2' }],
});

describe('judge 组件', () => {
  test('最小链路：dice → 裁判 JSON → judgement（档级/修正明细/骰点归因）→ bb_set 数值依据', async () => {
    const { agentService, blackboard, eventLog, ctx, component } = setup();
    agentService.runTurnImpl = async () => ({ ok: true, value: { kind: 'final', text: `裁决如下：${VERDICT_JSON}` } });
    const r = await component.run(PARAMS, ctx);
    assert.equal(r.ok, true);
    const types = eventLog.events.map((e) => e.type);
    assert.deepEqual(types, ['dice', 'judgement', 'bb_set']);
    const judgement = eventLog.events[1].payload as {
      grade: string;
      modifiers: { label: string; value: number }[];
      dice_event_id: string | null;
      rationale?: string;
    };
    assert.equal(judgement.grade, '成功');
    assert.deepEqual(judgement.modifiers, [{ label: '检定修正', value: 1 }]);
    assert.equal(judgement.dice_event_id, eventLog.events[0].id); // 随机性来源归因
    assert.equal(judgement.rationale, '骰点过阈值 10');
    const bb = eventLog.events[2].payload as { key: string; value: number; reason: string };
    assert.deepEqual(bb, { key: 'protagonist.hp', value: 8, reason: '落地擦伤 -2' }); // D31 数值依据
    assert.equal(blackboard.get('protagonist.hp'), 8);
    // 裁判收到的 intent 含行动声明与档级集
    const [, turnCtx] = agentService.calls.find((c) => c.method === 'runTurn')!.args as [string, { intent: string }];
    assert.ok(turnCtx.intent.includes('跃过断崖'));
    assert.ok(turnCtx.intent.includes('大成功'));
  });

  test('裁决输出校验失败：落 judge_retry 后重试成功（D17）', async () => {
    const { agentService, eventLog, ctx, component } = setup();
    let round = 0;
    agentService.runTurnImpl = async () => {
      round++;
      return { ok: true, value: { kind: 'final', text: round === 1 ? '我觉得大概行吧' : VERDICT_JSON } };
    };
    const r = await component.run(PARAMS, ctx);
    assert.equal(r.ok, true);
    assert.equal(round, 2);
    const retry = eventLog.events.find((e) => e.type === 'judge_retry')!.payload as { attempt: number; max_attempts: number; error: string };
    assert.deepEqual(retry, { attempt: 1, max_attempts: 2, error: 'SCHEMA_MISMATCH' });
  });

  test('档级越界同样触发重试；达上限 → COMPONENT_FAILED（升级导演裁决，D17）', async () => {
    const { agentService, eventLog, ctx, component } = setup();
    agentService.runTurnImpl = async () => ({
      ok: true,
      value: { kind: 'final', text: JSON.stringify({ grade: '天降神迹', updates: [] }) }, // 不在档级集内
    });
    const r = await component.run({ ...PARAMS, max_retries: 1 }, ctx);
    assert.deepEqual(r, { ok: false, error: 'COMPONENT_FAILED' });
    assert.equal(eventLog.events.filter((e) => e.type === 'judge_retry').length, 1);
    assert.equal(eventLog.events.some((e) => e.type === 'judgement'), false);
  });

  test('无骰判定：dice_event_id 落 null；TurnOutcome error → COMPONENT_FAILED', async () => {
    const { agentService, eventLog, ctx, component } = setup();
    agentService.runTurnImpl = async () => ({ ok: true, value: { kind: 'final', text: VERDICT_JSON } });
    const { dice_expression: _, ...noDice } = PARAMS;
    const r = await component.run(noDice, ctx);
    assert.equal(r.ok, true);
    const judgement = eventLog.events.find((e) => e.type === 'judgement')!.payload as { dice_event_id: string | null };
    assert.equal(judgement.dice_event_id, null);

    agentService.runTurnImpl = async () => ({ ok: true, value: { kind: 'error', error: 'TURN_FAILED' } });
    const r2 = await component.run(noDice, ctx);
    assert.deepEqual(r2, { ok: false, error: 'COMPONENT_FAILED' });
  });
});
