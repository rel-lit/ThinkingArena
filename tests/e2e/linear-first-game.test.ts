// Version: 1.0.0
/**
 * e2e：线性首局（mock LlmExecutor 脚本化响应，无外部 LLM）。
 * 覆盖验收点：Script 落盘 / 内核事件族关键类型齐全 / 叙事（含工具循环）/ 骰子 / 判定 /
 * 条件分支 / 回边循环（2 轮）/ 导演门（inbox 驱动）/ envelopeSource 逐节点绑定（裁决 3-D-1）/
 * worldbook 加载期导入（D34）/ manifest 写出且字段齐全（D24）/ 成本累计 > 0（D16/D28）。
 * 另含 CLI 子进程全路径（parseArgs + 目录加载 + use_default 门超时）。
 */
import { execFile } from 'node:child_process';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { RunManifestSchema } from '../../schema/bundle.ts';
import { KernelEventSchema } from '../../schema/event.ts';
import type { LLMRequest, LlmExecutor } from '../../services/types.ts';
import { assembleComposition, buildMockPriceTable, loadBundle } from '../../cli/run.ts';
import { createMockExecutor } from '../../cli/mock-llm.ts';
import { replayRun } from '../../cli/replay.ts';
import { observeRun } from '../../cli/observe.ts';
import { LINEAR_MOCK_SCRIPT, autoDirect, makeLinearBundle, makeTmpDir, readScript, writeBundleDir } from './test-kit.ts';

const execFileP = promisify(execFile);

/** 装配 + 跑局（自动投喂两条门指令）；返回组合根产物与捕获的 LLM 请求。 */
async function runLinearGame(runDir: string) {
  const bundle = makeLinearBundle();
  const captured: LLMRequest[] = [];
  const base = createMockExecutor(LINEAR_MOCK_SCRIPT);
  const executor: LlmExecutor = (decision, req, signal) => {
    captured.push(req);
    return base(decision, req, signal);
  };
  const c = assembleComposition({
    runDir,
    rngSeed: bundle.seeds.rng_seed,
    priceTable: buildMockPriceTable(bundle),
    executor,
    pollIntervalMs: 20,
  });
  await c.pump.start();
  try {
    const directing = autoDirect(c.pump, runDir, ['北风将至，注意保暖与补给。', '营地附近有水声，夜里派人值守。']);
    const r = await c.runner.run(bundle);
    await directing;
    assert.ok(r.ok, `局应落定，实得 ${r.ok ? 'ok' : r.error}`);
    assert.equal(r.value.status, 'completed');
    return { c, r: r.value, captured };
  } finally {
    c.pump.stop();
  }
}

describe('e2e 线性首局（mock LLM）', () => {
  test('完整跑通：事件族 / 回边 2 轮 / 门干预 / manifest / 成本 > 0', async () => {
    const runDir = makeTmpDir('ta-e2e-linear-');
    const { c, r, captured } = await runLinearGame(runDir);

    // ===== Script 落盘 + 全事件过契约 =====
    const scriptPath = join(runDir, 'script.jsonl');
    assert.ok(existsSync(scriptPath), 'Script 必须落盘');
    const events = readScript(runDir);
    assert.ok(events.length > 30, `事件量异常（${events.length}）`);
    for (const e of events) assert.ok(KernelEventSchema.safeParse(e).success, `事件须过内核契约: ${e.id} ${e.type}`);

    // ===== 内核事件族关键类型齐全 =====
    const types = new Set(events.map((e) => e.type));
    for (const t of [
      'run_started', 'node_start', 'node_end', 'speech', 'monologue', 'dice', 'judgement',
      'branch_decision', 'gate_waiting', 'gate_input_received', 'director_intervention',
      'agent_created', 'agent_destroyed', 'turn_start', 'turn_end', 'prompt_hash',
      'cost', 'bb_set', 'snapshot', 'run_completed',
    ]) {
      assert.ok(types.has(t), `缺关键事件类型: ${t}`);
    }

    // ===== 回边循环 ≥2 轮 =====
    const nodeStarts = events.filter((e) => e.type === 'node_start');
    const countOf = (nodeId: string) => nodeStarts.filter((e) => e.exec?.node_id === nodeId).length;
    assert.equal(countOf('narrate'), 2, '回边循环：narrate 应执行 2 轮');
    assert.equal(countOf('gate'), 2);
    assert.equal(countOf('judge_action'), 2);

    // ===== 条件分支：第 1 轮条件不成立（false，落回无条件边回边）→ 第 2 轮成立（true，退出循环）=====
    const branches = events.filter((e) => e.type === 'branch_decision');
    assert.equal(branches.length, 2, '条件边每轮求值一次（无条件边不落 branch_decision，D7）');
    assert.ok(branches.every((e) => e.payload.target_node === 'destroy_protagonist'));
    assert.equal(branches[0].payload.result, false, '第 1 轮条件不成立应回边');
    assert.equal(branches[1].payload.result, true, '第 2 轮条件成立应退出循环');
    assert.deepEqual(branches[0].payload.snapshot, { 'state.rounds': 1 }, 'branch_decision 含被引用键子集快照（D7）');

    // ===== 导演门：inbox 驱动、注入生效 =====
    const received = events.filter((e) => e.type === 'gate_input_received');
    assert.equal(received.length, 2);
    assert.ok(received.every((e) => e.payload.source === 'director_inbox'));
    const interventions = events.filter((e) => e.type === 'director_intervention');
    assert.equal(interventions.length, 2);
    assert.ok(interventions.every((e) => e.payload.outcome === 'applied'));
    // steering 注入 Agent 私有上下文（L8）：第 2 轮 narrate 的 LLM 请求 prompt 含导演 whisper
    assert.ok(captured.some((q) => q.prompt.includes('北风将至')), 'whisper 应注入第 2 轮回合上下文');

    // ===== envelopeSource 逐节点绑定（裁决 3-D-1）=====
    for (const e of events) {
      if (e.type === 'speech' || e.type === 'monologue') assert.equal(e.exec?.node_id, 'narrate', 'speech/monologue 信封 exec 须绑定叙事节点');
      if (e.type === 'cost' || e.type === 'turn_start' || e.type === 'turn_end') assert.notEqual(e.exec, null, '服务事实信封 exec 须非空（bindExec 接线）');
      if (e.type === 'bb_set' && e.payload.key === 'state.rounds') assert.equal(e.exec?.node_id, 'judge_action', '判定状态更新归因 judge 节点');
    }
    // 工具循环往返（§2.2）：bb_get 工具结果回灌后 final——call_agent 的 tool_results 形态贯通（裁决 3-D-2）
    const narrateSpeeches = events.filter((e) => e.type === 'speech');
    assert.equal(narrateSpeeches.length, 2);
    assert.ok(events.some((e) => e.type === 'monologue' && String(e.payload.text).includes('先查看当前回合数')), '工具循环首轮 reasoning 应落 monologue');

    // ===== worldbook 加载期导入（D34/裁决 3-D-5：applyEvent 确定性初始化，不落 bb_set 事件）=====
    assert.ok(events.every((e) => !(e.type === 'bb_set' && String(e.payload.key).startsWith('worldbook.'))), 'worldbook 导入不落 bb_set 事件（契约 exec 必填）');
    assert.notEqual(c.blackboard.get('worldbook.wasteland'), undefined, 'worldbook 已经 applyEvent 进活黑板');

    // ===== manifest（D24）：写出且字段齐全 =====
    const manifest = RunManifestSchema.parse(JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8')));
    assert.equal(manifest.status, 'completed');
    assert.equal(manifest.run_id, r.runId);
    assert.match(manifest.bundle_hash, /^[0-9a-f]{64}$/);
    assert.equal(manifest.scenario, 'e2e-linear');
    assert.equal(manifest.schema_version, '1.0.0');
    assert.equal(manifest.genealogy, null);
    assert.notEqual(manifest.ended_at, null);

    // ===== 成本累计 > 0（D16；5 次 LLM 调用 = 5 条 cost）=====
    const costs = events.filter((e) => e.type === 'cost');
    assert.equal(costs.length, 5, '工具循环 2 + 叙事 1 + 判定 2 = 5 次调用');
    const costSum = costs.reduce((a, e) => a + e.payload.cost.amount, 0);
    assert.ok(costSum > 0, '成本累计必须 > 0');
    assert.ok(Math.abs(manifest.cost.total - costSum) < 1e-9, 'manifest 成本 = cost 事件累计（账本为 reduce 派生切片）');
    assert.equal(manifest.cost.currency, 'CNY');
    const completed = events.find((e) => e.type === 'run_completed');
    assert.ok(completed !== undefined && Math.abs(completed.payload.cost.total - costSum) < 1e-9);

    // ===== 重放一致性（replay 只读重建 = run 终态）=====
    const summary = await replayRun(runDir);
    assert.equal(summary.finished, 'completed');
    assert.equal(summary.blackboard['state.rounds'], 2);
    assert.equal(summary.blackboard['worldbook.wasteland'] !== undefined, true);
    assert.equal(summary.agents['protagonist'].state, 'DESTROYED');
    assert.equal(summary.agents['referee'].state, 'DESTROYED');
    assert.ok(Math.abs(summary.cost.total - costSum) < 1e-9);

    // ===== observe 事件视图可用（F16 最小版）=====
    const view = observeRun(runDir, 5);
    assert.ok(view.includes('run_completed') || view.includes('snapshot'), 'observe tail 应覆盖局末事件');
  });

  test('CLI 子进程全路径：--bundle 目录 + --mock-llm 脚本 + use_default 门超时', async () => {
    const bundleDir = makeTmpDir('ta-e2e-bundle-');
    const runDir = makeTmpDir('ta-e2e-cli-run-');
    const bundle = makeLinearBundle({
      gateTimeout: {
        policy: 'use_default',
        after_ms: 300,
        default_input: { kind: 'whisper', text: '默认输入：保持前进。', targets: ['protagonist'], mode: 'steering' },
      },
    });
    writeBundleDir(bundleDir, bundle);
    // loadBundle 单测面：目录加载 + 名册交叉校验
    const loaded = loadBundle(bundleDir);
    assert.deepEqual(loaded, bundle, 'loadBundle 往返应一致');
    const mockPath = join(bundleDir, 'mock-llm.json');
    writeFileSync(mockPath, JSON.stringify(LINEAR_MOCK_SCRIPT), 'utf8');

    const cliPath = fileURLToPath(new URL('../../cli/run.ts', import.meta.url));
    const { stdout } = await execFileP(
      process.execPath,
      [cliPath, '--bundle', bundleDir, '--run-dir', runDir, '--mock-llm', mockPath, '--poll-interval-ms', '20'],
      { timeout: 60_000 },
    );
    const report = JSON.parse(stdout) as { status: string; run_id: string };
    assert.equal(report.status, 'completed');

    const events = readScript(runDir);
    const received = events.filter((e) => e.type === 'gate_input_received');
    assert.equal(received.length, 2);
    assert.ok(received.every((e) => e.payload.source === 'timeout_default'), '无人值守局应走 use_default 超时默认输入（D15/G3）');
    assert.equal(events.filter((e) => e.type === 'gate_timeout').length, 2);
    const manifest = RunManifestSchema.parse(JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8')));
    assert.equal(manifest.status, 'completed');
    assert.ok(manifest.cost.total > 0);
  });
});
