// Version: 1.0.0
/** dice.ts 测试：mulberry32 确定性、骰式解析、组件落 dice 事件（D31/D33）。 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createMetaRegistry } from '../meta/registry.ts';
import { makeCtx, mockAgentService, mockBlackboard, mockEnvelopeSource, mockEventLog, mockMemory } from '../meta/testkit.ts';
import { createDiceComponent, mulberry32, rollExpression } from './dice.ts';

function setup(seed = 42) {
  const eventLog = mockEventLog();
  const { source } = mockEnvelopeSource();
  const meta = createMetaRegistry({
    agentService: mockAgentService(),
    memory: mockMemory(),
    blackboard: mockBlackboard(),
    eventLog,
    envelopeSource: source,
  });
  return { eventLog, ctx: makeCtx(meta), component: createDiceComponent(mulberry32(seed)) };
}

describe('mulberry32 与骰式解析', () => {
  test('同种子同序列（D33 复现前提）；异种子异序列', () => {
    const a = mulberry32(7);
    const sa = [a(), a(), a()];
    const b = mulberry32(7);
    assert.deepEqual(sa, [b(), b(), b()]);
    const c = mulberry32(8);
    assert.notDeepEqual(sa, [c(), c(), c()]);
  });

  test('rollExpression：1d20+2 / 2d6 / 非法骰式', () => {
    const r1 = rollExpression('1d20+2', mulberry32(1))!;
    assert.equal(r1.rolls.length, 1);
    assert.ok(r1.rolls[0] >= 1 && r1.rolls[0] <= 20);
    assert.equal(r1.modifier, 2);
    assert.equal(r1.total, r1.rolls[0] + 2);
    const r2 = rollExpression('2d6-1', mulberry32(1))!;
    assert.equal(r2.rolls.length, 2);
    assert.equal(r2.modifier, -1);
    assert.equal(rollExpression('不是骰式', mulberry32(1)), null);
    assert.equal(rollExpression('1d20+2+3', mulberry32(1)), null);
  });
});

describe('dice 组件', () => {
  test('落 dice 事件：逐骰结果 + 修正 + 总点 + 目的（D31）', async () => {
    const { eventLog, ctx, component } = setup(42);
    const r = await component.run({ expression: '1d20+2', purpose: '先攻检定', modifier: 1 }, ctx);
    assert.equal(r.ok, true);
    const p = eventLog.events[0].payload as { expression: string; rolls: number[]; modifier: number; total: number; purpose: string };
    assert.equal(eventLog.events[0].type, 'dice');
    assert.equal(p.expression, '1d20+2');
    assert.equal(p.modifier, 3); // 表达式 +2 与参数 +1 合并
    assert.equal(p.total, p.rolls[0] + 3);
    assert.equal(p.purpose, '先攻检定');
  });

  test('同种子两组件流 → 同骰点序列（D33 同版本 rerun 复现）', async () => {
    const s1 = setup(99);
    const s2 = setup(99);
    for (let i = 0; i < 3; i++) {
      await s1.component.run({ expression: '2d6' }, s1.ctx);
      await s2.component.run({ expression: '2d6' }, s2.ctx);
    }
    assert.deepEqual(
      s1.eventLog.events.map((e) => (e.payload as { total: number }).total),
      s2.eventLog.events.map((e) => (e.payload as { total: number }).total),
    );
  });

  test('非法骰式 → COMPONENT_FAILED；非法参数 → PARAM_SCHEMA_INVALID', async () => {
    const { ctx, component } = setup();
    assert.deepEqual(await component.run({ expression: 'x' }, ctx), { ok: false, error: 'COMPONENT_FAILED' });
    assert.deepEqual(await component.run({}, ctx), { ok: false, error: 'PARAM_SCHEMA_INVALID' });
  });
});
