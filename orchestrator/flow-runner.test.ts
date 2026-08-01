// Version: 1.0.0
/**
 * flow-runner.ts 测试：状态机 §3.3 全路径——线性落定 / 回边条件退出 / on_error 三策略 /
 * pause（WAITING 门=安全点）/ resume（含 R7 重试）/ cancel（G4/G6）/ 崩溃恢复（D12/D36）/
 * 版本不匹配拒绝（D33）/ 成本闸（D28）/ fork（§2.4）/ 快照调度指针恢复（D30/D11）。
 * 全部依赖 mock（组件注册表/服务/泵），无真实网络调用。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RunManifestSchema } from '../schema/bundle.ts';
import type { Event, NodeExec } from '../schema/event.ts';
import { createFlowRunner } from './flow-runner.ts';
import type { FlowRunnerDeps } from './types.ts';
import {
  makeBundle,
  makeComponent,
  mockAgentService,
  mockMemory,
  mockMeta,
  mockPump,
  MockBlackboard,
  MockComponentRegistry,
  MockEventLog,
  OK_COMPONENT,
  tmpRunDir,
  waitFor,
} from './test-mocks.ts';

type Pump = ReturnType<typeof mockPump>;

function noopRegistry(): MockComponentRegistry {
  return new MockComponentRegistry().add(makeComponent('noop', OK_COMPONENT));
}

function makeDeps(
  registry: MockComponentRegistry,
  pump: Pump,
  el = new MockEventLog(),
  runDir = tmpRunDir(),
): { deps: FlowRunnerDeps; el: MockEventLog; bb: MockBlackboard } {
  const bb = new MockBlackboard();
  return {
    deps: {
      services: { eventLog: el, blackboard: bb, agentService: mockAgentService(), memory: mockMemory() },
      meta: mockMeta(bb, el),
      components: registry,
      directorPump: pump,
      runDir,
    },
    el,
    bb,
  };
}

function linearFlow() {
  return {
    name: 'linear',
    version: '1.0.0',
    entry: 'a',
    nodes: [
      { id: 'a', type: 'noop', version: '1.0.0', on_error: 'stop' },
      { id: 'b', type: 'noop', version: '1.0.0', on_error: 'stop' },
      { id: 'c', type: 'noop', version: '1.0.0', on_error: 'stop' },
    ],
    edges: [
      { from: 'a', from_port: 'out', to: 'b', to_port: 'in' },
      { from: 'b', from_port: 'out', to: 'c', to_port: 'in' },
    ],
  };
}

function readManifest(runDir: string) {
  const m = JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8')) as unknown;
  const parsed = RunManifestSchema.safeParse(m);
  assert.ok(parsed.success, 'manifest 必须过契约校验');
  return parsed.data;
}

describe('FlowRunner 线性局（R1/R4/D24）', () => {
  test('三节点线性 → COMPLETED + run_completed + 局末快照 + manifest 契约', async () => {
    const { deps, el } = makeDeps(noopRegistry(), mockPump());
    const r = await createFlowRunner(deps).run(makeBundle(linearFlow()));
    assert.ok(r.ok);
    assert.equal(r.value.status, 'completed');
    const types = el.events.map((e) => e.type);
    assert.equal(types[0], 'run_started');
    assert.deepEqual(
      types.filter((t) => t.startsWith('node_')),
      ['node_start', 'node_end', 'node_start', 'node_end', 'node_start', 'node_end'],
    );
    assert.ok(types.includes('run_completed'));
    assert.ok(types.includes('snapshot'), '局末必落快照（D30）');
    const m = readManifest(deps.runDir);
    assert.equal(m.status, 'completed');
    assert.equal(m.ending, 'finished'); // 无 run_ending milestone 时的缺省
    assert.equal(m.run_id, r.value.manifest.run_id);
    assert.equal(m.ending, el.ofType('run_completed')[0].payload.ending);
    assert.match(m.bundle_hash, /^[0-9a-f]{64}$/);
  });

  test('Bundle 校验失败（组件未注册）→ BUNDLE_INVALID，局不开始（D20）', async () => {
    const { deps, el } = makeDeps(new MockComponentRegistry(), mockPump());
    const r = await createFlowRunner(deps).run(makeBundle(linearFlow()));
    assert.deepEqual(r, { ok: false, error: 'BUNDLE_INVALID' });
    assert.equal(el.events.length, 0, '局未开始不落任何事件');
  });
});

describe('FlowRunner 回边与条件分支（D7）', () => {
  test('回边迭代计数递增 + branch_decision 落盘 + 条件退出', async () => {
    const counter = makeComponent('counter', async (_p, ctx) => {
      const got = (await ctx.meta.call('bb_get', { key: 'n' }, ctx)) as { ok: true; value: unknown };
      const n = typeof got.value === 'number' ? got.value : 0;
      await ctx.meta.call('bb_set', { key: 'n', value: n + 1 }, ctx);
      return { ok: true, value: undefined };
    });
    const registry = new MockComponentRegistry().add(counter).add(makeComponent('noop', OK_COMPONENT));
    const flow = {
      name: 'loop',
      version: '1.0.0',
      entry: 'count',
      nodes: [
        { id: 'count', type: 'counter', version: '1.0.0', on_error: 'stop' },
        { id: 'check', type: 'noop', version: '1.0.0', on_error: 'stop' },
        { id: 'done', type: 'noop', version: '1.0.0', on_error: 'stop' },
      ],
      edges: [
        { from: 'count', from_port: 'out', to: 'check', to_port: 'in' },
        { id: 'exit', from: 'check', from_port: 'out', to: 'done', to_port: 'in', condition: { op: 'gte', left: { ref: 'n' }, right: 3 }, order: 0 },
        { from: 'check', from_port: 'out', to: 'count', to_port: 'in', order: 1 },
      ],
    };
    const { deps, el, bb } = makeDeps(registry, mockPump());
    const r = await createFlowRunner(deps).run(makeBundle(flow));
    assert.ok(r.ok);
    assert.equal(bb.get('n'), 3);
    const countStarts = el.events.filter((e) => e.type === 'node_start' && e.exec?.node_id === 'count');
    assert.deepEqual(countStarts.map((e) => (e.exec as NodeExec).iteration), [0, 1, 2]);
    const decisions = el.ofType('branch_decision');
    assert.deepEqual(decisions.map((d) => d.payload.result), [false, false, true]);
    assert.equal(decisions[2].payload.target_node, 'done');
    assert.deepEqual(decisions[0].payload.snapshot, { n: 1 }, '被引用键子集快照（D7）');
  });
});

describe('FlowRunner on_error 策略（错误矩阵）', () => {
  const badFlow = (onError: 'stop' | 'retry' | 'continue', maxRetries?: number) => ({
    name: 'bad',
    version: '1.0.0',
    entry: 'bad',
    nodes: [
      { id: 'bad', type: 'bad', version: '1.0.0', on_error: onError, ...(maxRetries ? { max_retries: maxRetries } : {}) },
      { id: 'next', type: 'noop', version: '1.0.0', on_error: 'stop' },
    ],
    edges: [{ from: 'bad', from_port: 'out', to: 'next', to_port: 'in' }],
  });

  function badRegistry(behavior: () => boolean): MockComponentRegistry {
    // behavior() 返回 true 表示本次应失败
    const bad = makeComponent('bad', async () =>
      behavior() ? { ok: false as const, error: 'COMPONENT_FAILED' as const } : { ok: true as const, value: undefined },
    );
    return new MockComponentRegistry().add(bad).add(makeComponent('noop', OK_COMPONENT));
  }

  test('stop：节点失败 → run_error + ERROR 挂起（R5）→ resume 重试（R7）→ COMPLETED', async () => {
    let shouldFail = true;
    const { deps, el } = makeDeps(badRegistry(() => shouldFail), mockPump());
    const runner = createFlowRunner(deps);
    const runP = runner.run(makeBundle(badFlow('stop')));
    await waitFor(() => el.ofType('run_error').length === 1);
    assert.equal(el.ofType('run_error')[0].payload.error, 'NODE_FAILED');
    assert.equal(el.ofType('node_failed').length, 1);
    assert.equal(readManifest(deps.runDir).status, 'error', 'ERROR 挂起也写 manifest（D24）');
    shouldFail = false;
    const rr = await runner.resume();
    assert.ok(rr.ok);
    assert.equal(el.ofType('run_resumed')[0].payload.from_state, 'error');
    const report = await runP;
    assert.ok(report.ok && report.value.status === 'completed');
    const badStarts = el.events.filter((e) => e.type === 'node_start' && e.exec?.node_id === 'bad');
    assert.equal(badStarts.length, 2, 'R7 重跑失败节点（同 exec 迭代）');
    assert.deepEqual((badStarts[0].exec as NodeExec).iteration, (badStarts[1].exec as NodeExec).iteration);
    assert.equal(readManifest(deps.runDir).status, 'completed', '恢复后幂等重写 manifest');
  });

  test('continue：失败后跳过继续下一节点', async () => {
    const { deps, el } = makeDeps(badRegistry(() => true), mockPump());
    const r = await createFlowRunner(deps).run(makeBundle(badFlow('continue')));
    assert.ok(r.ok && r.value.status === 'completed');
    assert.equal(el.ofType('node_failed').length, 1);
    assert.ok(el.events.some((e) => e.type === 'node_start' && e.exec?.node_id === 'next'));
  });

  test('retry：有界重试（同 exec 标识重跑）→ 成功', async () => {
    let calls = 0;
    const { deps, el } = makeDeps(badRegistry(() => (calls += 1) === 1), mockPump());
    const r = await createFlowRunner(deps).run(makeBundle(badFlow('retry', 2)));
    assert.ok(r.ok && r.value.status === 'completed');
    assert.equal(calls, 2);
    const badStarts = el.events.filter((e) => e.type === 'node_start' && e.exec?.node_id === 'bad');
    assert.equal(badStarts.length, 2);
    assert.equal(el.ofType('node_failed').length, 1);
  });

  test('retry 耗尽 → 转 stop（ERROR 挂起）', async () => {
    const { deps, el } = makeDeps(badRegistry(() => true), mockPump());
    const runner = createFlowRunner(deps);
    const runP = runner.run(makeBundle(badFlow('retry', 1)));
    await waitFor(() => el.ofType('run_error').length === 1);
    const badStarts = el.events.filter((e) => e.type === 'node_start' && e.exec?.node_id === 'bad');
    assert.equal(badStarts.length, 2, '初跑 + 一次重试');
    await runner.cancel();
    await runP;
  });
});

describe('FlowRunner 导演门交互（pause/cancel，§3.3 补充语义）', () => {
  function gateFlow() {
    return {
      name: 'gate',
      version: '1.0.0',
      entry: 'a',
      nodes: [
        { id: 'a', type: 'noop', version: '1.0.0', on_error: 'stop' },
        { id: 'gate', type: 'gate', version: '1.0.0', on_error: 'stop' },
        { id: 'c', type: 'noop', version: '1.0.0', on_error: 'stop' },
      ],
      edges: [
        { from: 'a', from_port: 'out', to: 'gate', to_port: 'in' },
        { from: 'gate', from_port: 'out', to: 'c', to_port: 'in' },
      ],
    };
  }

  function gateRegistry(pump: Pump): MockComponentRegistry {
    const gate = makeComponent('gate', async (_p, ctx) => {
      const r = await pump.awaitDirective({ gateNodeId: 'gate', signal: ctx.signal });
      return r.ok ? { ok: true as const, value: undefined } : { ok: false as const, error: 'ABORTED' as const };
    });
    return new MockComponentRegistry().add(gate).add(makeComponent('noop', OK_COMPONENT));
  }

  test('WAITING 门视为安全点：pause 立即生效、不解除等待；resume 后继续（R2/R3）', async () => {
    const pump = mockPump();
    const { deps, el } = makeDeps(gateRegistry(pump), pump);
    const runner = createFlowRunner(deps);
    const runP = runner.run(makeBundle(gateFlow()));
    await waitFor(() => pump.isWaiting());
    await runner.pause();
    assert.equal(el.ofType('run_paused').length, 1);
    pump.resolveNext({ kind: 'inject', text: '继续', targets: [], mode: null });
    await waitFor(() => el.ofType('node_end').length === 2);
    assert.equal(el.ofType('node_start').length, 2, 'PAUSED 期间不调度后续节点');
    const rr = await runner.resume();
    assert.ok(rr.ok);
    const report = await runP;
    assert.ok(report.ok && report.value.status === 'completed');
    assert.equal(el.ofType('node_start').length, 3);
    assert.equal(el.ofType('run_resumed')[0].payload.from_state, 'paused');
  });

  test('门等待中 cancel：cancelAll 唤醒（G4/G6）→ run_cancelled + manifest cancelled（R8）', async () => {
    const pump = mockPump();
    const { deps, el } = makeDeps(gateRegistry(pump), pump);
    const runner = createFlowRunner(deps);
    const runP = runner.run(makeBundle(gateFlow()));
    await waitFor(() => pump.isWaiting());
    const cancelP = runner.cancel();
    await cancelP;
    assert.equal(pump.cancelCount, 1);
    const report = await runP;
    assert.ok(report.ok && report.value.status === 'cancelled');
    assert.equal(el.ofType('run_cancelled').length, 1);
    assert.equal(el.ofType('node_failed').length, 1, '在飞门节点边界闭合（ABORTED）');
    const m = readManifest(deps.runDir);
    assert.equal(m.status, 'cancelled');
    assert.equal(m.ending, null);
  });
});

describe('FlowRunner 崩溃恢复与版本域（D12/D36/D33）', () => {
  /** 探针：真实跑一局拿 bundle_hash 与 run_id（hash 计算属实现内部，测试经探针取得）。 */
  async function probe(bundle: ReturnType<typeof makeBundle>) {
    const { deps, el } = makeDeps(noopRegistry(), mockPump());
    const r = await createFlowRunner(deps).run(bundle);
    assert.ok(r.ok);
    return { hash: el.ofType('run_started')[0].payload.bundle_hash, runId: el.ofType('run_started')[0].run_id };
  }

  function craftCrashLog(hash: string, runId: Event['run_id']): MockEventLog {
    const el = new MockEventLog();
    const ts = () => new Date().toISOString();
    const a0 = { node_id: 'a', iteration: 0 };
    const b0 = { node_id: 'b', iteration: 0 };
    el.append({ ts: ts(), run_id: runId, branch: 'main', exec: null, type: 'run_started', payload: { bundle_hash: hash, bundle_path: '/tmp/b', mode: 'fresh', fork_from_event_id: null } });
    el.append({ ts: ts(), run_id: runId, branch: 'main', exec: a0, type: 'node_start', payload: { component_type: 'noop', component_version: '1.0.0' } });
    el.append({ ts: ts(), run_id: runId, branch: 'main', exec: a0, type: 'node_end', payload: { component_type: 'noop', component_version: '1.0.0' } });
    el.append({ ts: ts(), run_id: runId, branch: 'main', exec: b0, type: 'node_start', payload: { component_type: 'noop', component_version: '1.0.0' } });
    // 崩溃：b 在飞已落的 bb_set 为孤儿（跳过），cost 真实花费保留（D36）
    el.append({ ts: ts(), run_id: runId, branch: 'main', exec: b0, type: 'bb_set', payload: { key: 'orphan', value: true } });
    el.append({
      ts: ts(), run_id: runId, branch: 'main', exec: b0, type: 'cost',
      payload: { agent_id: null, model: 'm1', usage: { input: 1, output: 1, cached_read: 0, cached_write: 0, reasoning: 0 }, cost: { amount: 5, currency: 'CNY' }, raw_usage: {} },
    });
    return el;
  }

  test('resume：孤儿事件跳过（cost 除外）+ 未完成节点重跑 + manifest 成本累计', async () => {
    const bundle = makeBundle(linearFlow());
    const { hash, runId } = await probe(bundle);
    const crashEl = craftCrashLog(hash, runId);
    const runDir = tmpRunDir();
    const { deps, bb } = makeDeps(noopRegistry(), mockPump(), crashEl, runDir);
    const r = await createFlowRunner(deps).run(bundle, { resume: true });
    assert.ok(r.ok && r.value.status === 'completed');
    assert.equal(bb.get('orphan'), undefined, '孤儿 bb_set 被跳过（D36）');
    const bStarts = crashEl.events.filter((e) => e.type === 'node_start' && e.exec?.node_id === 'b');
    assert.equal(bStarts.length, 2, '未完成节点执行按 D12 重跑（同 exec 标识）');
    assert.equal(crashEl.ofType('run_started')[1].payload.mode, 'resume');
    assert.equal(readManifest(runDir).cost.total, 5, '孤儿 cost 不作废，计入账本');
  });

  test('resume：版本不匹配（改 Bundle）→ 拒绝恢复（D21/D33）；已落定局 → RUN_STATE_CORRUPT', async () => {
    const bundle = makeBundle(linearFlow());
    const { hash, runId } = await probe(bundle);
    const crashEl = craftCrashLog(hash, runId);
    const altered = makeBundle(linearFlow());
    altered.seeds = { ...altered.seeds, rng_seed: 43 };
    const r1 = await createFlowRunner(makeDeps(noopRegistry(), mockPump(), crashEl).deps).run(altered, { resume: true });
    assert.deepEqual(r1, { ok: false, error: 'RUN_STATE_CORRUPT' });

    const { deps, el } = makeDeps(noopRegistry(), mockPump());
    await createFlowRunner(deps).run(bundle); // 跑完落定
    const r2 = await createFlowRunner({ ...deps }).run(bundle, { resume: true });
    assert.deepEqual(r2, { ok: false, error: 'RUN_STATE_CORRUPT' });
    assert.ok(el.ofType('run_completed').length === 1);
  });

  test('快照调度指针恢复：崩溃于边界快照后，resume 精确定位出边未决（D30/D11）', async () => {
    const bundle = makeBundle(linearFlow(), { snapshot: { every_node_boundaries: 1, min_events: 1 } });
    const { deps, el } = makeDeps(noopRegistry(), mockPump());
    const r0 = await createFlowRunner(deps).run(bundle);
    assert.ok(r0.ok);
    const snapIdx = el.events.findIndex((e) => e.type === 'snapshot');
    assert.ok(snapIdx > 0);
    const crashed = new MockEventLog();
    crashed.load(el.events.slice(0, snapIdx + 1) as Event[]); // 截断 = 边界快照后崩溃
    const runDir = tmpRunDir();
    const { deps: deps2 } = makeDeps(noopRegistry(), mockPump(), crashed, runDir);
    const r = await createFlowRunner(deps2).run(bundle, { resume: true });
    assert.ok(r.ok && r.value.status === 'completed');
    const bStarts = crashed.events.filter((e) => e.type === 'node_start' && e.exec?.node_id === 'b');
    assert.equal(bStarts.length, 1, '从快照标记的 pendingNext 继续，不重跑 a');
  });

  test('fork：同版本内分叉重跑（§2.4-3）', async () => {
    const bundle = makeBundle({
      name: 'forkt',
      version: '1.0.0',
      entry: 'a',
      nodes: [
        { id: 'a', type: 'noop', version: '1.0.0', on_error: 'stop' },
        { id: 'b', type: 'noop', version: '1.0.0', on_error: 'stop' },
      ],
      edges: [{ from: 'a', from_port: 'out', to: 'b', to_port: 'in' }],
    });
    const { deps, el } = makeDeps(noopRegistry(), mockPump());
    await createFlowRunner(deps).run(bundle);
    const anchor = el.ofType('node_end')[0].id;
    const { deps: deps2 } = makeDeps(noopRegistry(), mockPump(), el, tmpRunDir());
    const r = await createFlowRunner(deps2).run(bundle, { forkFrom: anchor });
    assert.ok(r.ok && r.value.status === 'completed');
    assert.equal(el.ofType('fork').length, 1);
    const forkStarted = el.ofType('run_started').filter((e) => e.payload.mode === 'fork');
    assert.equal(forkStarted.length, 1);
    assert.equal(forkStarted[0].payload.fork_from_event_id, anchor);
    const bStarts = el.events.filter((e) => e.type === 'node_start' && e.exec?.node_id === 'b');
    assert.equal(bStarts.length, 2, '分叉点之后的节点在新分支真实重跑');
    assert.notEqual(bStarts[0].branch, bStarts[1].branch, '新旧分支标识不同');
  });
});

describe('FlowRunner 成本闸（D28）', () => {
  test('累计超阈 → 自动 pause 并通知导演（reason 落盘）；resume 后继续', async () => {
    const spender = makeComponent('spender', async (_p, ctx) => {
      await ctx.meta.call('emit_cost', { amount: 100 }, ctx);
      return { ok: true as const, value: undefined };
    });
    const registry = new MockComponentRegistry().add(spender).add(makeComponent('noop', OK_COMPONENT));
    const flow = {
      name: 'cost',
      version: '1.0.0',
      entry: 'spend',
      nodes: [
        { id: 'spend', type: 'spender', version: '1.0.0', on_error: 'stop' },
        { id: 'end', type: 'noop', version: '1.0.0', on_error: 'stop' },
      ],
      edges: [{ from: 'spend', from_port: 'out', to: 'end', to_port: 'in' }],
    };
    const bundle = makeBundle(flow, { cost_budget: { max_total: 50, currency: 'CNY' } });
    const { deps, el } = makeDeps(registry, mockPump());
    const runner = createFlowRunner(deps);
    const runP = runner.run(bundle);
    await waitFor(() => el.ofType('run_paused').length === 1);
    assert.match(el.ofType('run_paused')[0].payload.reason ?? '', /cost_budget_exceeded/);
    assert.equal(el.events.some((e) => e.type === 'node_start' && e.exec?.node_id === 'end'), false, '闸停后不继续调度');
    await runner.resume();
    const report = await runP;
    assert.ok(report.ok && report.value.status === 'completed');
    assert.equal(readManifest(deps.runDir).cost.total, 100);
  });
});
