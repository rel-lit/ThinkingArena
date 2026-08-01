// Version: 1.0.0
/**
 * e2e：崩溃恢复（§2.3 / D12 / D36 / 裁决 3-D-4）。
 * 剧本：跑到导演门 WAITING 时模拟崩溃（直接弃 runner 不清理、停泵）→ 同 run 目录新组合根
 * resume → 投喂门指令 → 落定。对照组：同 Bundle 不中断直跑。
 * 断言：已完成节点不重复落事件（D36 孤儿规则：仅崩溃在飞的 gate#0 重跑）/ cost 事件保留不重复 /
 * 快照窗口恢复（加密快照策略覆盖 D30 窗口）/ 终态与对照组一致。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RunManifestSchema } from '../../schema/bundle.ts';
import type { Event } from '../../schema/event.ts';
import { assembleComposition, buildMockPriceTable } from '../../cli/run.ts';
import { createMockExecutor } from '../../cli/mock-llm.ts';
import { replayRun, type ReplaySummary } from '../../cli/replay.ts';
import { LINEAR_MOCK_SCRIPT, autoDirect, makeLinearBundle, makeTmpDir, readScript, waitFor } from './test-kit.ts';

const nodeStartCount = (events: Event[], nodeId: string, iteration: number): number =>
  events.filter((e) => e.type === 'node_start' && e.exec?.node_id === nodeId && e.exec.iteration === iteration).length;

/** 终态比对面（run_id / 墙钟等局间差异字段除外）。 */
function semanticView(s: ReplaySummary) {
  return {
    finished: s.finished,
    ending: s.ending,
    cost: s.cost,
    blackboard: s.blackboard,
    agents: s.agents,
    progress: s.progress,
  };
}

describe('e2e 崩溃恢复（resume）', () => {
  test('门等待期崩溃 → resume：已完成节点不重复、cost 保留、终态与对照一致', async () => {
    // 加密快照策略（每 2 节点边界 / 5 事件即落）：强制崩溃前存在快照，覆盖快照窗口恢复路径（D30/裁决 3-D-4）
    const bundle = makeLinearBundle({ snapshot: { every_node_boundaries: 2, min_events: 5 } });
    const runDir = makeTmpDir('ta-e2e-resume-');

    // ===== 阶段 1：跑到导演门 WAITING，模拟崩溃（弃 runner 不清理）=====
    const c1 = assembleComposition({
      runDir,
      rngSeed: bundle.seeds.rng_seed,
      priceTable: buildMockPriceTable(bundle),
      executor: createMockExecutor(LINEAR_MOCK_SCRIPT),
      pollIntervalMs: 20,
    });
    await c1.pump.start();
    const crashed = c1.runner.run(bundle); // 永不落定（门 wait_forever 无人投喂）——崩溃语义 = 直接弃置
    void crashed.catch(() => {}); // 弃置 promise 的 rejection 防御（正常路径永不 reject）
    await waitFor(() => c1.pump.isWaiting(), '阶段 1 门进入等待');
    c1.pump.stop(); // 崩溃：无 cancel、无 finalize、无局末快照

    const before = readScript(runDir);
    assert.ok(before.some((e) => e.type === 'snapshot'), '崩溃前应已有周期快照（加密策略）');
    assert.equal(before.filter((e) => e.type === 'gate_waiting').length, 1);
    const costBefore = before.filter((e) => e.type === 'cost');
    assert.equal(costBefore.length, 3, '第 1 轮 3 次 LLM 调用（叙事 2 + 判定 1）已落 cost');

    // ===== 阶段 2：同 run 目录新组合根 resume =====
    const c2 = assembleComposition({
      runDir,
      rngSeed: bundle.seeds.rng_seed,
      priceTable: buildMockPriceTable(bundle),
      executor: createMockExecutor(LINEAR_MOCK_SCRIPT.slice(3)), // 阶段 1 已消耗 3 条，续跑只调 2 次
      pollIntervalMs: 20,
    });
    await c2.pump.start();
    try {
      const directing = autoDirect(c2.pump, runDir, ['北风将至，注意保暖与补给。', '营地附近有水声，夜里派人值守。']);
      const r = await c2.runner.run(bundle, { resume: true });
      await directing;
      assert.ok(r.ok, `resume 局应落定，实得 ${r.ok ? 'ok' : r.error}`);
      assert.equal(r.value.status, 'completed');
    } finally {
      c2.pump.stop();
    }

    const events = readScript(runDir);

    // ===== D36：已完成节点不重复落事件；仅崩溃在飞的 gate#0 重跑（其首轮事件为孤儿）=====
    for (const [nodeId, iteration] of [
      ['create_roles', 0], ['narrate', 0], ['dice_check', 0], ['judge_action', 0],
      ['narrate', 1], ['dice_check', 1], ['judge_action', 1], ['gate', 1],
      ['destroy_protagonist', 0], ['destroy_referee', 0],
    ] as const) {
      assert.equal(nodeStartCount(events, nodeId, iteration), 1, `已完成执行 ${nodeId}#${iteration} 的 node_start 不得重复`);
    }
    assert.equal(nodeStartCount(events, 'gate', 0), 2, '崩溃在飞的 gate#0 按 D12 重跑（旧执行为孤儿）');
    // 孤儿规则 reduce 语义：重放后调度进度每个 exec 恰好一条、无重复推进
    const summary = await replayRun(runDir);
    assert.equal(Object.keys(summary.progress).length, 11, '11 个节点执行各一条进度记录（1 创建 + 2×4 轮内 + 2 销毁）');
    assert.ok(Object.values(summary.progress).every((p) => p.status === 'completed'));

    // ===== cost 事件保留不重复（D36 例外：真实花费不作废）=====
    const costs = events.filter((e) => e.type === 'cost');
    assert.equal(costs.length, 5, '崩溃前 3 条保留 + 续跑 2 条，无重复');
    assert.ok(costs.every((e, i) => costs.findIndex((x) => x.id === e.id) === i), 'cost 事件 id 唯一');

    // ===== resume 语义：第二条 run_started mode=resume（裁决 3-D-4）=====
    const starts = events.filter((e) => e.type === 'run_started');
    assert.equal(starts.length, 2);
    assert.equal(starts[0].payload.mode, 'fresh');
    assert.equal(starts[1].payload.mode, 'resume');
    assert.equal(starts[1].run_id, starts[0].run_id, 'resume 沿原 run 继续（同 run_id）');

    // ===== 落定 + manifest =====
    const manifest = RunManifestSchema.parse(JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8')));
    assert.equal(manifest.status, 'completed');
    assert.ok(manifest.cost.total > 0);

    // ===== 对照组：同 Bundle 不中断直跑，终态须一致 =====
    const controlDir = makeTmpDir('ta-e2e-control-');
    const cc = assembleComposition({
      runDir: controlDir,
      rngSeed: bundle.seeds.rng_seed,
      priceTable: buildMockPriceTable(bundle),
      executor: createMockExecutor(LINEAR_MOCK_SCRIPT),
      pollIntervalMs: 20,
    });
    await cc.pump.start();
    try {
      const directing = autoDirect(cc.pump, controlDir, ['北风将至，注意保暖与补给。', '营地附近有水声，夜里派人值守。']);
      const rc = await cc.runner.run(bundle);
      await directing;
      assert.ok(rc.ok && rc.value.status === 'completed');
    } finally {
      cc.pump.stop();
    }
    const control = await replayRun(controlDir);
    assert.deepEqual(semanticView(summary), semanticView(control), 'resume 终态与不中断对照组一致（黑板/进度/生命周期/成本）');
  });
});
