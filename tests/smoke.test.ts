// Version: 1.0.0
/**
 * 冒烟：组合根能装配（不跑局）+ 信封纪律 + Bundle 目录加载校验。
 * 不发起任何节点执行；仅验证装配面齐备与 meta registry 的信封门（无信封拒 emit）。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ComponentContext } from '../schema/meta-component.ts';
import type { LLMRequest } from '../services/types.ts';
import { assembleComposition, buildMockPriceTable, loadBundle } from '../cli/run.ts';
import { createMockExecutor } from '../cli/mock-llm.ts';
import { makeLinearBundle, makeTmpDir, writeBundleDir } from './e2e/test-kit.ts';

describe('组合根装配冒烟（不跑局）', () => {
  test('全部部件装配成功且形态齐备', () => {
    const runDir = makeTmpDir('ta-smoke-');
    const bundle = makeLinearBundle();
    const c = assembleComposition({
      runDir,
      rngSeed: bundle.seeds.rng_seed,
      priceTable: buildMockPriceTable(bundle),
      executor: createMockExecutor([]),
    });
    // 服务层
    assert.equal(typeof c.eventLog.append, 'function');
    assert.equal(typeof c.eventLog.currentRunId, 'function');
    assert.equal(typeof c.blackboard.set, 'function');
    assert.equal(typeof c.gateway.route, 'function');
    assert.equal(typeof c.memory.projection, 'function');
    assert.equal(typeof c.agentService.runTurn, 'function');
    // 元组件层：六内置名册 + 四扩展
    assert.equal(typeof c.meta.call, 'function');
    // 组件层：六内置组件
    assert.deepEqual(
      c.components.list().map((x) => x.description.name).sort(),
      ['dice', 'director_gate', 'judge', 'narrative', 'role_create', 'role_destroy'],
    );
    // 编排层
    assert.equal(typeof c.runner.run, 'function');
    assert.equal(typeof c.runner.pause, 'function');
    assert.equal(typeof c.pump.awaitDirective, 'function');
    assert.equal(typeof c.pump.isWaiting, 'function');
    // 信封源：装配态无执行上下文
    assert.equal(c.envelopeSource.current(), null);
    // 价格表：名册模型 + 费率齐备
    assert.equal(typeof c.gateway.priceOf('mock-flagship', { input: 1, output: 1, cached_read: 0, cached_write: 0, reasoning: 0 })?.amount, 'number');
    c.pump.stop();
  });

  test('信封门：无信封 emit_event 拒写；注入信封后可落且信封正确', async () => {
    const runDir = makeTmpDir('ta-smoke-env-');
    const bundle = makeLinearBundle();
    const c = assembleComposition({
      runDir,
      rngSeed: bundle.seeds.rng_seed,
      priceTable: buildMockPriceTable(bundle),
      executor: createMockExecutor([]),
    });
    const ctx = { meta: c.meta, signal: new AbortController().signal } as ComponentContext;
    const denied = await c.meta.call('emit_event', { type: 'speech', payload: { agent_id: 'a', text: 'x' } }, ctx);
    assert.deepEqual(denied, { ok: false, error: 'COMPONENT_FAILED' }, '无信封上下文时 emit 类元组件必须拒写');

    // 模拟 FlowRunner 的逐节点绑定（裁决 3-D-1 通道冒烟；run_started 先行提供 run 上下文）
    const started = c.eventLog.append({
      ts: new Date().toISOString(), run_id: '018e6f3a-0000-7000-8000-000000000000', branch: 'main', exec: null,
      type: 'run_started', payload: { bundle_hash: 'a'.repeat(64), bundle_path: runDir, mode: 'fresh', fork_from_event_id: null },
    });
    assert.ok(started.ok);
    c.envelopeSource.set({ run_id: started.value.run_id, branch: 'main', exec: { node_id: 'smoke_node', iteration: 0 } });
    const emitted = await c.meta.call('emit_event', { type: 'speech', payload: { agent_id: 'a', text: '冒烟' } }, ctx);
    assert.ok(emitted.ok, '注入信封后 emit_event 可落');
    const evt = (emitted as { ok: true; value: { exec: { node_id: string } | null } }).value;
    assert.equal(evt.exec?.node_id, 'smoke_node');
    c.envelopeSource.set(null);
    const deniedAgain = await c.meta.call('emit_event', { type: 'speech', payload: { agent_id: 'a', text: 'x' } }, ctx);
    assert.ok(!deniedAgain.ok, '解绑后恢复拒写（节点间无执行上下文）');
    c.pump.stop();
  });

  test('loadBundle：目录加载一致；名册引用缺失身份牌即拒（D20 交叉校验）', () => {
    const dir = makeTmpDir('ta-smoke-bundle-');
    const bundle = makeLinearBundle();
    writeBundleDir(dir, bundle);
    assert.deepEqual(loadBundle(dir), bundle);

    // 交叉校验：删掉被引用的身份牌文件 → 加载拒绝
    rmSync(join(dir, 'identity_cards', 'referee.yaml'));
    assert.throws(() => loadBundle(dir), /身份牌文件不存在/);
  });

  test('mock 执行器：脚本 FIFO 消费 + 缺省 usage 非零（cost > 0 的 mock 侧保证）', async () => {
    const seen: string[] = [];
    const ex = createMockExecutor([{ text: '第一条' }, { object: { tool_calls: [{ call_id: 'c1', name: 'bb_get', arguments: { key: 'k' } }] } }]);
    const decision = { model: 'm', provider: 'mock', fallbackChain: [] };
    const req: LLMRequest = { prompt: 'p' };
    const r1 = await ex(decision, req, new AbortController().signal);
    const r2 = await ex(decision, req, new AbortController().signal);
    const r3 = await ex(decision, req, new AbortController().signal);
    assert.ok(r1.ok && r1.value.text === '第一条' && r1.value.usage.input > 0);
    assert.ok(r2.ok && typeof r2.value.object === 'object');
    assert.ok(r3.ok && r3.value.text.includes('脚本已耗尽'), '脚本耗尽走兜底回应');
    assert.deepEqual(seen, []);
  });
});
