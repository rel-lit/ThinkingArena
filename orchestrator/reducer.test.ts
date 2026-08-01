// Version: 1.0.0
/**
 * reducer.ts 测试：总 reduce 投影（replay 零副作用）、D36 孤儿规则（cost/gate_input_received 例外）、
 * snapshot 四段还原 + 调度指针标记、泵游标计数（D27）、agent 生命周期投影。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { EventDraft, NodeExec, RunId } from '../schema/event.ts';
import { RunReducer } from './reducer.ts';
import { Ledger } from './ledger.ts';
import { MockBlackboard, MockEventLog } from './test-mocks.ts';

const RUN_ID = '019785e0-0000-7000-8000-000000000000' as RunId;
const HASH = 'a'.repeat(64);

/** 经 MockEventLog 落一条事件（契约校验）并返回。 */
function ev(el: MockEventLog, body: Omit<EventDraft, 'ts' | 'run_id' | 'branch'>) {
  const r = el.append({ ...body, ts: new Date().toISOString(), run_id: RUN_ID, branch: 'main' } as EventDraft);
  assert.ok(r.ok, `append 失败: ${JSON.stringify(body)}`);
  return r.value;
}

function started(el: MockEventLog) {
  return ev(el, { exec: null, type: 'run_started', payload: { bundle_hash: HASH, bundle_path: '/tmp/b', mode: 'fresh', fork_from_event_id: null } });
}

function nodeStart(el: MockEventLog, exec: NodeExec) {
  return ev(el, { exec, type: 'node_start', payload: { component_type: 'noop', component_version: '1.0.0' } });
}

function nodeEnd(el: MockEventLog, exec: NodeExec) {
  return ev(el, { exec, type: 'node_end', payload: { component_type: 'noop', component_version: '1.0.0' } });
}

function replayAll(el: MockEventLog, bb: MockBlackboard, ledger?: Ledger): RunReducer {
  const r = new RunReducer(bb, ledger);
  for (const e of el.events) r.feed(e);
  r.finishReplay();
  return r;
}

describe('RunReducer 线性投影', () => {
  test('run/node 边界/branch_decision/bb_set/milestone/run_completed', () => {
    const el = new MockEventLog();
    const bb = new MockBlackboard();
    started(el);
    nodeStart(el, { node_id: 'a', iteration: 0 });
    ev(el, { exec: { node_id: 'a', iteration: 0 }, type: 'bb_set', payload: { key: 'x', value: 1 } });
    nodeEnd(el, { node_id: 'a', iteration: 0 });
    ev(el, {
      exec: { node_id: 'a', iteration: 0 },
      type: 'branch_decision',
      payload: { condition: { op: 'eq', left: { ref: 'x' }, right: 1 }, snapshot: { x: 1 }, result: true, from_port: 'out', target_node: 'b' },
    });
    nodeStart(el, { node_id: 'b', iteration: 0 });
    nodeEnd(el, { node_id: 'b', iteration: 0 });
    ev(el, { exec: { node_id: 'b', iteration: 0 }, type: 'milestone', payload: { kind: 'run_ending', label: '通关' } });
    ev(el, { exec: null, type: 'run_completed', payload: { ending: '通关', cost: { total: 0, currency: 'CNY' } } });

    const r = replayAll(el, bb);
    assert.equal(r.runId, RUN_ID);
    assert.equal(r.bundleHash, HASH);
    assert.equal(bb.get('x'), 1);
    assert.equal(r.progress.get('a#0')?.status, 'completed');
    assert.equal(r.nextIteration('a'), 1);
    assert.equal(r.finished, 'completed');
    assert.equal(r.lastEnding, '通关');
    assert.equal(r.scheduledNext, null);
    assert.equal(r.pendingNext?.node_id, 'b'); // b 的出边未决
  });

  test('回边迭代计数递增；agent 生命周期投影', () => {
    const el = new MockEventLog();
    started(el);
    for (let i = 0; i < 3; i += 1) {
      nodeStart(el, { node_id: 'loop', iteration: i });
      nodeEnd(el, { node_id: 'loop', iteration: i });
    }
    ev(el, { exec: { node_id: 'loop', iteration: 2 }, type: 'agent_created', payload: { agent_id: 'a1', card_name: 'c', card_version: '1.0', model: 'm', memory_ref: 'mem/a1.json' } });
    ev(el, { exec: { node_id: 'loop', iteration: 2 }, type: 'turn_start', payload: { agent_id: 'a1', first_turn: true } });
    ev(el, { exec: { node_id: 'loop', iteration: 2 }, type: 'turn_end', payload: { agent_id: 'a1', outcome: 'final' } });
    const r = replayAll(el, new MockBlackboard());
    assert.equal(r.nextIteration('loop'), 3);
    assert.deepEqual(r.agents.get('a1'), { state: 'IDLE', memory_ref: 'mem/a1.json' });
  });
});

describe('RunReducer 孤儿规则（D36）', () => {
  test('未完成执行的已落事件被跳过；cost 与 gate_input_received 除外', () => {
    const el = new MockEventLog();
    const bb = new MockBlackboard();
    const ledger = new Ledger();
    started(el);
    nodeStart(el, { node_id: 'a', iteration: 0 });
    nodeEnd(el, { node_id: 'a', iteration: 0 });
    nodeStart(el, { node_id: 'b', iteration: 0 }); // 崩溃：b 未闭合
    ev(el, { exec: { node_id: 'b', iteration: 0 }, type: 'bb_set', payload: { key: 'orphan', value: true } });
    ev(el, { exec: { node_id: 'b', iteration: 0 }, type: 'speech', payload: { agent_id: 'a1', text: '孤儿发言' } });
    ev(el, {
      exec: { node_id: 'b', iteration: 0 },
      type: 'cost',
      payload: { agent_id: null, model: 'm1', usage: { input: 1, output: 1, cached_read: 0, cached_write: 0, reasoning: 0 }, cost: { amount: 3, currency: 'CNY' }, raw_usage: {} },
    });
    ev(el, {
      exec: { node_id: 'b', iteration: 0 },
      type: 'gate_input_received',
      payload: { directive: { kind: 'inject', text: '干预', targets: [], mode: null }, directive_hash: 'b'.repeat(64), source: 'director_inbox' },
    });

    const r = replayAll(el, bb, ledger);
    assert.equal(bb.get('orphan'), undefined, '孤儿 bb_set 应被跳过');
    assert.equal(ledger.summary().total, 3, 'cost 真实花费不作废');
    assert.ok(r.gateReceived.has('b#0'), 'gate_input_received 保留供门重入查询');
    assert.equal(r.consumedInboxLines, 1);
    assert.deepEqual(r.openExec, { node_id: 'b', iteration: 0 }, '未完成执行标识供 D12 重跑');
    assert.equal(r.lastEventId, el.events[el.events.length - 1].id, '孤儿事件同样续号');
  });

  test('节点执行正常闭合：缓冲事件按序冲刷生效', () => {
    const el = new MockEventLog();
    const bb = new MockBlackboard();
    started(el);
    nodeStart(el, { node_id: 'a', iteration: 0 });
    ev(el, { exec: { node_id: 'a', iteration: 0 }, type: 'bb_set', payload: { key: 'k', value: 'v' } });
    nodeEnd(el, { node_id: 'a', iteration: 0 });
    replayAll(el, bb);
    assert.equal(bb.get('k'), 'v');
  });
});

describe('RunReducer snapshot 还原', () => {
  test('四段还原 + 在飞执行（running → openExec）+ 调度指针推导（最后 completed → pendingNext）', () => {
    const el = new MockEventLog();
    const bb = new MockBlackboard();
    started(el);
    nodeStart(el, { node_id: 'gate', iteration: 1 });
    const lastId = el.events[el.events.length - 1].id;
    // pause 于门等待期的快照：gate#1 在飞
    ev(el, {
      exec: null,
      type: 'snapshot',
      payload: {
        last_event_id: lastId,
        blackboard: { 'worldbook.w': { title: 't', content: 'c' }, hp: 80 },
        agents: { a1: { state: 'PAUSED', memory_ref: null } },
        progress: {
          'a#0': { status: 'completed' },
          'gate#0': { status: 'completed' },
          'gate#1': { status: 'running' },
          'b#2': { status: 'completed' },
        },
        ledger: { total: 7, currency: 'CNY', by_model: { m1: 7 } },
      },
    });
    const ledger = new Ledger();
    const r = replayAll(el, bb, ledger);
    assert.equal(bb.get('hp'), 80);
    assert.deepEqual(bb.get('worldbook.w'), { title: 't', content: 'c' });
    assert.deepEqual(r.agents.get('a1'), { state: 'PAUSED', memory_ref: null });
    assert.deepEqual(r.openExec, { node_id: 'gate', iteration: 1 }, '快照切割的在飞执行恢复后重跑');
    assert.deepEqual(r.pendingNext, { node_id: 'b', iteration: 2 }, '最后 completed 出边未决（确定性重算）');
    assert.equal(r.scheduledNext, null);
    assert.equal(ledger.summary().total, 7);
    assert.equal(r.nextIteration('gate'), 2);
  });
});

describe('RunReducer 泵游标计数（D27）', () => {
  test('note/门指令(director_inbox)/无效行/无门拒绝 计入；timeout_default 不计', () => {
    const el = new MockEventLog();
    started(el);
    ev(el, { exec: null, type: 'director_note', payload: { text: 'n1', directive_hash: 'c'.repeat(64) } });
    ev(el, { exec: { node_id: 'g', iteration: 0 }, type: 'gate_input_received', payload: { directive: { kind: 'inject', text: 'i', targets: [], mode: null }, directive_hash: 'd'.repeat(64), source: 'director_inbox' } });
    ev(el, { exec: { node_id: 'g', iteration: 0 }, type: 'gate_input_received', payload: { directive: { kind: 'inject', text: 't', targets: [], mode: null }, directive_hash: 'e'.repeat(64), source: 'timeout_default' } });
    ev(el, { exec: null, type: 'system', payload: { code: 'invalid_director_line', message: 'x', severity: 'warning' } });
    ev(el, { exec: null, type: 'system', payload: { code: 'no_waiting_gate', message: 'x', severity: 'warning' } });
    ev(el, { exec: null, type: 'system', payload: { code: 'other_code', message: 'x', severity: 'info' } });
    const r = replayAll(el, new MockBlackboard());
    assert.equal(r.consumedInboxLines, 4);
  });

  test('fork 事件切换分支投影；run_cancelled 标记落定', () => {
    const el = new MockEventLog();
    started(el);
    ev(el, { exec: null, type: 'fork', payload: { at_event_id: el.events[0].id, new_branch: 'fork-x' } });
    const r = replayAll(el, new MockBlackboard());
    assert.equal(r.branch, 'fork-x');
    ev(el, { exec: null, type: 'run_cancelled', payload: {} });
    const r2 = replayAll(el, new MockBlackboard());
    assert.equal(r2.finished, 'cancelled');
  });
});
