// Version: 1.0.0
/**
 * ledger.ts 测试：cost 累计切片（D28）——累计/by_model/币种约束/快照还原/成本闸触发与重新武装。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Event } from '../schema/event.ts';
import { Ledger } from './ledger.ts';

function costEvent(amount: number, currency = 'CNY', model = 'm1'): Extract<Event, { type: 'cost' }> {
  return {
    id: 'e0000001',
    parent_id: null,
    ts: new Date().toISOString(),
    run_id: '019785e0-0000-7000-8000-000000000000',
    branch: 'main',
    exec: { node_id: 'n', iteration: 0 },
    type: 'cost',
    payload: {
      agent_id: null,
      model,
      usage: { input: 1, output: 1, cached_read: 0, cached_write: 0, reasoning: 0 },
      cost: { amount, currency },
      raw_usage: {},
    },
  };
}

describe('Ledger 成本累计（D28）', () => {
  test('累计 total + by_model + summary', () => {
    const l = new Ledger();
    assert.equal(l.apply(costEvent(1.5, 'CNY', 'm1')), true);
    assert.equal(l.apply(costEvent(2.5, 'CNY', 'm2')), true);
    const s = l.summary();
    assert.equal(s.total, 4);
    assert.equal(s.currency, 'CNY');
    assert.deepEqual(s.by_model, { m1: 1.5, m2: 2.5 });
  });

  test('币种不一致：跳过并返回 false（调用方记 system 告警）', () => {
    const l = new Ledger();
    assert.equal(l.apply(costEvent(1, 'CNY')), true);
    assert.equal(l.apply(costEvent(1, 'USD')), false);
    assert.equal(l.summary().total, 1);
  });

  test('restore 从快照还原（恢复后成本闸不清零，deep-dive §2.4-1）', () => {
    const l = new Ledger();
    l.restore({ total: 9, currency: 'CNY', by_model: { m1: 9 } });
    assert.equal(l.summary().total, 9);
    l.apply(costEvent(1));
    assert.equal(l.summary().total, 10);
  });

  test('成本闸：超阈触发一次回调；rearm 后再次触发', () => {
    const l = new Ledger();
    const hits: number[] = [];
    l.setBudget({ maxTotal: 10, currency: 'CNY', onExceed: (s) => hits.push(s.total) });
    l.apply(costEvent(5));
    assert.equal(hits.length, 0);
    assert.equal(l.isExceeded(), false);
    l.apply(costEvent(6));
    assert.deepEqual(hits, [11]);
    assert.equal(l.isExceeded(), true);
    l.apply(costEvent(1)); // 已触发不重复
    assert.equal(hits.length, 1);
    l.rearm();
    l.apply(costEvent(1));
    assert.equal(hits.length, 2);
  });

  test('预算币种与账本币种不一致不触发', () => {
    const l = new Ledger();
    let fired = 0;
    l.setBudget({ maxTotal: 1, currency: 'USD', onExceed: () => (fired += 1) });
    l.apply(costEvent(100, 'CNY'));
    assert.equal(fired, 0);
    assert.equal(l.isExceeded(), false);
  });
});
