// Version: 1.0.0
/**
 * scheduler.ts 测试：条件 DSL 求值（D7 封闭算子集）+ 排他出边决策（order 短路）+ 进度键。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FlowEdge } from '../schema/flow.ts';
import { collectRefs, decideOutEdge, evalCondition, progressKey } from './scheduler.ts';

const bb = (m: Record<string, unknown>) => (k: string) => m[k];

describe('evalCondition（D7）', () => {
  test('比较算子：eq/neq/gt/gte/lt/lte', () => {
    assert.deepEqual(evalCondition({ op: 'eq', left: { ref: 'a' }, right: 1 }, bb({ a: 1 })), { ok: true, value: true });
    assert.deepEqual(evalCondition({ op: 'neq', left: { ref: 'a' }, right: 'x' }, bb({ a: 'y' })), { ok: true, value: true });
    assert.deepEqual(evalCondition({ op: 'gt', left: { ref: 'a' }, right: 3 }, bb({ a: 4 })), { ok: true, value: true });
    assert.deepEqual(evalCondition({ op: 'gte', left: 3, right: { ref: 'a' } }, bb({ a: 3 })), { ok: true, value: true });
    assert.deepEqual(evalCondition({ op: 'lt', left: { ref: 'a' }, right: 3 }, bb({ a: 4 })), { ok: true, value: false });
    assert.deepEqual(evalCondition({ op: 'lte', left: { ref: 'a' }, right: 3 }, bb({ a: 3 })), { ok: true, value: true });
  });

  test('布尔组合：and/or/not 与嵌套、短路', () => {
    const expr = {
      op: 'and' as const,
      args: [
        { op: 'eq' as const, left: { ref: 'a' }, right: 1 },
        { op: 'or' as const, args: [{ op: 'eq' as const, left: { ref: 'b' }, right: true }, { op: 'not' as const, arg: { op: 'eq' as const, left: { ref: 'c' }, right: true } }] },
      ],
    };
    assert.deepEqual(evalCondition(expr, bb({ a: 1, b: false, c: false })), { ok: true, value: true });
    assert.deepEqual(evalCondition(expr, bb({ a: 1, b: false, c: true })), { ok: true, value: false });
    assert.deepEqual(evalCondition(expr, bb({ a: 0, b: true })), { ok: true, value: false });
  });

  test('配置错误：引用不存在的键 / 非数字比较（F14）', () => {
    const r1 = evalCondition({ op: 'eq', left: { ref: 'ghost' }, right: 1 }, bb({}));
    assert.ok(!r1.ok && r1.error.includes('ghost'));
    const r2 = evalCondition({ op: 'gt', left: { ref: 'a' }, right: 1 }, bb({ a: 'str' }));
    assert.ok(!r2.ok && r2.error.includes('数字'));
  });

  test('collectRefs 收集引用键（branch_decision 快照子集）', () => {
    const refs = collectRefs({
      op: 'or',
      args: [
        { op: 'gte', left: { ref: 'x.y' }, right: 10 },
        { op: 'eq', left: { ref: 'z' }, right: true },
      ],
    });
    assert.deepEqual([...refs].sort(), ['x.y', 'z']);
  });
});

describe('decideOutEdge（排他分支，首局语义）', () => {
  const edges: FlowEdge[] = [
    { id: 'e1', from: 's', from_port: 'out', to: 't1', to_port: 'in', condition: { op: 'gte', left: { ref: 'hp' }, right: 10 }, order: 0 },
    { id: 'e2', from: 's', from_port: 'out', to: 't2', to_port: 'in', order: 1 },
    { id: 'e3', from: 'other', from_port: 'out', to: 't3', to_port: 'in' },
  ];

  test('条件成立 → 采用条件边，落 branch_decision 载荷（含引用键子集快照）', () => {
    const r = decideOutEdge('s', edges, bb({ hp: 20, other: 1 }));
    assert.ok(r.ok);
    assert.equal(r.value.next, 't1');
    assert.equal(r.value.decisions.length, 1);
    assert.deepEqual(r.value.decisions[0].snapshot, { hp: 20 });
    assert.equal(r.value.decisions[0].result, true);
    assert.equal(r.value.decisions[0].from_port, 'out');
  });

  test('条件不成立 → 短路到无条件边（恒真，不落 branch_decision）', () => {
    const r = decideOutEdge('s', edges, bb({ hp: 5 }));
    assert.ok(r.ok);
    assert.equal(r.value.next, 't2');
    assert.equal(r.value.decisions.length, 1); // 只有被求值的条件边落盘
    assert.equal(r.value.decisions[0].result, false);
  });

  test('全部条件不成立且无兜底 → next=null（图走完）', () => {
    const onlyCond: FlowEdge[] = [
      { from: 's', from_port: 'out', to: 't1', to_port: 'in', condition: { op: 'eq', left: { ref: 'hp' }, right: 1 } },
    ];
    const r = decideOutEdge('s', onlyCond, bb({ hp: 2 }));
    assert.ok(r.ok);
    assert.equal(r.value.next, null);
  });

  test('无出边 → next=null；求值失败 → 配置错误上报', () => {
    const r1 = decideOutEdge('lonely', edges, bb({}));
    assert.ok(r1.ok && r1.value.next === null && r1.value.decisions.length === 0);
    const r2 = decideOutEdge('s', edges, bb({}));
    assert.ok(!r2.ok && r2.error.includes('hp'));
  });

  test('order 缺省按声明序稳定排序', () => {
    const noOrder: FlowEdge[] = [
      { from: 's', from_port: 'out', to: 'first', to_port: 'in' },
      { from: 's', from_port: 'out', to: 'second', to_port: 'in' },
    ];
    const r = decideOutEdge('s', noOrder, bb({}));
    assert.ok(r.ok && r.value.next === 'first');
  });

  test('progressKey 形态：节点id#迭代计数（§3.3 调度进度键）', () => {
    assert.equal(progressKey('narrate_scene', 3), 'narrate_scene#3');
  });
});
