// Version: 1.0.0
/**
 * e2e：isekai MVP Bundle（bundles/isekai-mvp，单世界切片）——真实 Bundle 目录 + mock LlmExecutor。
 * 覆盖验收点：loadBundle 过契约（D20）/ 线性主链（创建 → 情境呈现 → 导演门 → 决策 → 判定 → 结算）
 * 跑通 3 回合 / 理智检查条件分支（第 2 回合触发，其余回合跳过）/ 回边循环 / 导演门 whisper 注入 /
 * 状态表键（protagonist.hp/san/skills 等）经裁判组件落黑板 / manifest 与成本（D16/D24）。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunManifestSchema } from '../../schema/bundle.ts';
import { KernelEventSchema } from '../../schema/event.ts';
import type { LLMRequest, LlmExecutor } from '../../services/types.ts';
import { assembleComposition, buildMockPriceTable, loadBundle } from '../../cli/run.ts';
import { createMockExecutor, loadMockScript } from '../../cli/mock-llm.ts';
import { replayRun } from '../../cli/replay.ts';
import { autoDirect, makeTmpDir, readScript } from './test-kit.ts';

const BUNDLE_DIR = fileURLToPath(new URL('../../bundles/isekai-mvp', import.meta.url));

/** 三回合门指令（whisper/steering，每回合一条；第 1 条照场景 §4 的「虚假记忆」示例）。 */
const WHISPERS = [
  '你隐约记得菌林的低语在唤你的名字。',
  '褪色带的方向，好像有人在等你。',
  '出口的光在三天的尽头，撑住。',
] as const;

describe('e2e isekai-mvp Bundle（单世界切片，mock LLM）', () => {
  test('目录加载 + 3 回合跑通：条件理智检查 / 回边 / 导演门 / 状态表', async () => {
    // ===== 真实 Bundle 目录过契约加载（D20；含名册↔身份牌交叉校验）=====
    const bundle = loadBundle(BUNDLE_DIR);
    assert.equal(bundle.flow.name, 'isekai-mvp-fungal-forest');
    assert.ok('build-a.yaml' in bundle.identity_cards && 'build-b.yaml' in bundle.identity_cards, '两张 Build 卡须在册');

    const runDir = makeTmpDir('ta-e2e-isekai-');
    const script = loadMockScript(join(BUNDLE_DIR, 'mock-llm.script.json'));
    const captured: LLMRequest[] = [];
    const base = createMockExecutor(script);
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
      const directing = autoDirect(c.pump, runDir, WHISPERS);
      const r = await c.runner.run(bundle);
      await directing;
      assert.ok(r.ok, `局应落定，实得 ${r.ok ? 'ok' : r.error}`);
      assert.equal(r.value.status, 'completed');
    } finally {
      c.pump.stop();
    }

    // ===== Script 落盘 + 全事件过契约 =====
    assert.ok(existsSync(join(runDir, 'script.jsonl')), 'Script 必须落盘');
    const events = readScript(runDir);
    assert.ok(events.length > 50, `事件量异常（${events.length}）`);
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

    // ===== 回合结构：主链 5 节点 ×3 回合；理智检查仅第 2 回合（认知冲击）触发 =====
    const nodeStarts = events.filter((e) => e.type === 'node_start');
    const countOf = (nodeId: string) => nodeStarts.filter((e) => e.exec?.node_id === nodeId).length;
    assert.equal(countOf('create_roles'), 1);
    assert.equal(countOf('present_scene'), 3, '情境呈现每回合一次');
    assert.equal(countOf('director_gate'), 3, '导演门每回合一次');
    assert.equal(countOf('protagonist_decide'), 3);
    assert.equal(countOf('judge_action'), 3);
    assert.equal(countOf('settle_consequences'), 3);
    assert.equal(countOf('sanity_check'), 1, '理智检查只在第 2 回合（san_delta=12 / cognitive_shock）触发');
    assert.equal(countOf('destroy_protagonist'), 1);
    assert.equal(countOf('destroy_referee'), 1);

    // ===== 条件分支全轨迹（排他求值，按序）：R1 全否回边 → R2 触发理智检查后回边 → R3 切片完成退出 =====
    const branches = events.filter((e) => e.type === 'branch_decision');
    assert.deepEqual(
      branches.map((e) => [e.payload.target_node, e.payload.result]),
      [
        ['sanity_check', false], // R1：san_delta=5，未达阈值
        ['destroy_protagonist', false], // R1：rounds=1
        ['sanity_check', true], // R2：san_delta=12 且 cognitive_shock=true
        ['destroy_protagonist', false], // R2：rounds=2，理智检查后回边
        ['sanity_check', false], // R3：san_delta=3
        ['destroy_protagonist', true], // R3：rounds=3，切片完成退出循环
      ],
      '条件边求值轨迹须与回合脚本一致',
    );
    assert.deepEqual(branches[0].payload.snapshot, { 'state.san_delta': 5, 'state.cognitive_shock': false }, 'branch_decision 含被引用键子集快照（D7）');

    // ===== 导演门：3 条 whisper 全被接收并注入（L8 私有上下文）=====
    const received = events.filter((e) => e.type === 'gate_input_received');
    assert.equal(received.length, 3);
    assert.ok(received.every((e) => e.payload.source === 'director_inbox'));
    const interventions = events.filter((e) => e.type === 'director_intervention');
    assert.equal(interventions.length, 3);
    assert.ok(interventions.every((e) => e.payload.outcome === 'applied'));
    for (const text of WHISPERS) {
      assert.ok(captured.some((q) => q.prompt.includes(text)), `whisper 应注入主角回合上下文: ${text}`);
    }

    // ===== 判定与骰点：3 次行动判定 + 1 次理智检查 =====
    assert.equal(events.filter((e) => e.type === 'judgement').length, 4);
    assert.equal(events.filter((e) => e.type === 'dice').length, 4, 'judge 内建骰（行动 1d20 ×3 + 理智检查 ×1）');
    const grades = events.filter((e) => e.type === 'judgement').map((e) => e.payload.grade);
    assert.deepEqual(grades, ['成功', '部分成功', '守住', '成功']);

    // ===== 状态表键在黑板上有写入（裁判组件唯一写者，D26）=====
    const bbKeys = new Set(events.filter((e) => e.type === 'bb_set').map((e) => String(e.payload.key)));
    for (const k of ['protagonist.hp', 'protagonist.san', 'protagonist.skills', 'state.rounds']) {
      assert.ok(bbKeys.has(k), `状态表键须有 bb_set 事件: ${k}`);
    }
    const skillsSet = events.find((e) => e.type === 'bb_set' && e.payload.key === 'protagonist.skills');
    assert.equal(skillsSet?.exec?.node_id, 'judge_action', '技能标签初始化归因裁判节点');
    assert.equal(c.blackboard.get('protagonist.hp'), 90, '终态 HP = 100 -4 -4 -2');
    assert.equal(c.blackboard.get('protagonist.san'), 84, '终态 SAN = 100 -5 -12 +1（锚点支撑）');
    assert.equal((c.blackboard.get('protagonist.skills') as unknown[]).length, 5, 'Build A 派生 5 个技能标签');
    assert.equal((c.blackboard.get('protagonist.mental_anchors') as unknown[]).length, 1, '第 2 回合建立首个精神锚点');
    assert.equal(c.blackboard.get('state.rounds'), 3);
    assert.notEqual(c.blackboard.get('worldbook.fungal_forest'), undefined, '世界书加载期导入（D34）');

    // ===== 叙事产出：9 段 speech（呈现/决策/结算 ×3）；决策工具循环首轮 reasoning 落 monologue =====
    const speechByNode = (nodeId: string) => events.filter((e) => e.type === 'speech' && e.exec?.node_id === nodeId).length;
    assert.equal(speechByNode('present_scene'), 3);
    assert.equal(speechByNode('protagonist_decide'), 3);
    assert.equal(speechByNode('settle_consequences'), 3);
    assert.ok(
      events.some((e) => e.type === 'monologue' && String(e.payload.text).includes('先查状态表')),
      '第 1 回合决策的 bb_get 工具循环 reasoning 应落 monologue',
    );

    // ===== 成本（D16）：14 次 LLM 调用 = 14 条 cost；manifest 成本 = 累计 =====
    const costs = events.filter((e) => e.type === 'cost');
    assert.equal(costs.length, 14, '呈现 3 + 决策 4（R1 含工具轮）+ 判定 3 + 结算 3 + 理智检查 1');
    const costSum = costs.reduce((a, e) => a + e.payload.cost.amount, 0);
    assert.ok(costSum > 0, '成本累计必须 > 0');

    // ===== manifest（D24）与落定 =====
    const manifest = RunManifestSchema.parse(JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8')));
    assert.equal(manifest.status, 'completed');
    assert.equal(manifest.scenario, 'isekai-mvp-fungal-forest');
    assert.equal(manifest.ending, 'finished'); // 无 milestone 组件，结局落默认（已上报缺口）
    assert.match(manifest.bundle_hash, /^[0-9a-f]{64}$/);
    assert.ok(Math.abs(manifest.cost.total - costSum) < 1e-9);

    // ===== 重放一致性（replay 只读重建 = run 终态）=====
    const summary = await replayRun(runDir);
    assert.equal(summary.finished, 'completed');
    assert.equal(summary.blackboard['protagonist.hp'], 90);
    assert.equal(summary.blackboard['protagonist.san'], 84);
    assert.equal(summary.blackboard['state.rounds'], 3);
    assert.equal(summary.agents['protagonist'].state, 'DESTROYED');
    assert.equal(summary.agents['referee'].state, 'DESTROYED');
    assert.ok(Math.abs(summary.cost.total - costSum) < 1e-9);
  });
});
