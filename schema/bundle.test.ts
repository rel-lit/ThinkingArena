// Version: 1.0.0
/**
 * bundle.ts 契约测试：game/worldbook/seeds 正反向 + D33 hash 输入集 + run manifest（D24）
 * + fixtures/isekai 示例 Bundle 装配解析证明 + round-trip + JSON Schema 导出。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  AgentBindingSchema,
  BUNDLE_HASH_INPUTS,
  BUNDLE_LAYOUT,
  BundleHashSchema,
  CostBudgetSchema,
  GameConfigSchema,
  ModelBindingSchema,
  RunManifestSchema,
  ScenarioBundleSchema,
  SeedsSchema,
  SnapshotPolicySchema,
  WorldBookSchema,
} from './bundle.ts';
import { FlowConfigSchema } from './flow.ts';
import { IdentityCardV1Schema, checkIdentityCardModelFields } from './identity-card.ts';

const DIR = new URL('./fixtures/isekai/', import.meta.url);
const readYaml = (rel) => JSON.parse(readFileSync(new URL(rel, DIR), 'utf8'));

const SHA = 'b'.repeat(64);
const RUN_ID = '01890f3e-5c2a-7b3d-8e4f-a1b2c3d4e5f6';

describe('game.yaml 契约', () => {
  test('正向：fixture game.yaml 解析通过', () => {
    const r = GameConfigSchema.safeParse(readYaml('game.yaml'));
    assert.ok(r.success, JSON.stringify(r.error?.issues?.slice(0, 5)));
    assert.equal(r.data.agents.length, 3);
    assert.equal(r.data.snapshot.every_node_boundaries, 10, 'deep-dive §2.3 建议值');
    assert.equal(r.data.snapshot.min_events, 500);
  });

  test('反向：agents 空名册 / 绑定缺 model / memory_ref 缺省（必填，可为 null，D22）', () => {
    assert.ok(!GameConfigSchema.safeParse({ version: '1.0', rules: {}, agents: [] }).success);
    assert.ok(!AgentBindingSchema.safeParse({ id: 'a', identity_card: 'a.yaml', model: {}, memory_ref: null }).success);
    assert.ok(!AgentBindingSchema.safeParse({ id: 'a', identity_card: 'a.yaml', model: { model: 'kimi-k3' } }).success);
  });

  test('ModelBinding：tier 与 fallback 链（D13/deep-dive-llm 问题 4）', () => {
    const ok = { model: 'kimi-k3', tier: 'flagship', fallback: ['claude-opus-4-8', 'gpt-5.6-sol'], params: { temperature: 0.8 } };
    assert.ok(ModelBindingSchema.safeParse(ok).success);
    assert.ok(ModelBindingSchema.safeParse({ model: 'kimi-k3' }).success, '最小绑定只有 model');
    assert.ok(!ModelBindingSchema.safeParse({ model: '' }).success);
  });

  test('成本闸（D28）与快照策略（D30）正反向', () => {
    assert.ok(CostBudgetSchema.safeParse({ max_total: 50, currency: 'CNY' }).success);
    assert.ok(!CostBudgetSchema.safeParse({ max_total: -1, currency: 'CNY' }).success);
    assert.ok(SnapshotPolicySchema.safeParse({ every_node_boundaries: 10, min_events: 500 }).success);
    assert.ok(!SnapshotPolicySchema.safeParse({ every_node_boundaries: 0, min_events: 500 }).success);
  });
});

describe('worldbook.yaml / seeds.yaml 契约', () => {
  test('正向：fixture 解析通过；条目键符合黑板键形态（D34 worldbook.<key>）', () => {
    const wb = WorldBookSchema.parse(readYaml('worldbook.yaml'));
    assert.equal(wb.entries.length, 3);
    for (const e of wb.entries) assert.match(e.key, /^[a-z][a-z0-9_]*$/);
  });

  test('反向：世界书条目键非法 / 内容为空', () => {
    assert.ok(!WorldBookSchema.safeParse({ version: '1.0', entries: [{ key: 'Bad Key', content: 'x' }] }).success);
    assert.ok(!WorldBookSchema.safeParse({ version: '1.0', entries: [{ key: 'ok', content: '' }] }).success);
  });

  test('seeds：rng_seed 必填整数；llm_seed 可 null（D33 种子参与版本身份）', () => {
    const s = SeedsSchema.parse(readYaml('seeds.yaml'));
    assert.equal(s.rng_seed, 20260731);
    assert.equal(s.llm_seed, null);
    assert.ok(!SeedsSchema.safeParse({ version: '1.0', rng_seed: 1.5, llm_seed: null }).success);
    assert.ok(!SeedsSchema.safeParse({ version: '1.0', rng_seed: 42 }).success, 'llm_seed 必填（可为 null）');
  });
});

describe('Scenario Bundle 装配态（验收 2：解析 isekai 示例 Bundle）', () => {
  function loadFixtureBundle() {
    return {
      flow: FlowConfigSchema.parse(readYaml('flow.yaml')),
      game: GameConfigSchema.parse(readYaml('game.yaml')),
      identity_cards: {
        'build-a.yaml': IdentityCardV1Schema.parse(readYaml('identity_cards/build-a.yaml')),
      },
      worldbook: WorldBookSchema.parse(readYaml('worldbook.yaml')),
      seeds: SeedsSchema.parse(readYaml('seeds.yaml')),
    };
  }

  test('fixture 目录五个部分各自解析成功，装配态 ScenarioBundleSchema 通过', () => {
    const bundle = loadFixtureBundle();
    const r = ScenarioBundleSchema.safeParse(bundle);
    assert.ok(r.success, JSON.stringify(r.error?.issues?.slice(0, 5)));
    assert.equal(r.data.flow.entry, 'narrate_scene');
    assert.equal(r.data.identity_cards['build-a.yaml'].name, 'Build A · 均衡生存流');
  });

  test('fixture 身份卡过模型字段守卫（身份与 LLM 解耦）', () => {
    assert.deepEqual(checkIdentityCardModelFields(readYaml('identity_cards/build-a.yaml')), { ok: true });
  });

  test('BUNDLE_LAYOUT 约定的五个落点在 fixture 目录中齐全', () => {
    for (const rel of [BUNDLE_LAYOUT.flow, BUNDLE_LAYOUT.game, BUNDLE_LAYOUT.worldbook, BUNDLE_LAYOUT.seeds, `${BUNDLE_LAYOUT.identityCardsDir}/build-a.yaml`]) {
      assert.ok(readYaml(rel), `${rel} 应存在且可解析`);
    }
  });

  test('round-trip：装配态经 JSON 序列化后再校验深度相等', () => {
    const parsed = ScenarioBundleSchema.parse(loadFixtureBundle());
    assert.deepEqual(ScenarioBundleSchema.parse(JSON.parse(JSON.stringify(parsed))), parsed);
  });
});

describe('D33 版本 hash 输入集', () => {
  test('输入集与决策原文一致：图、组件版本、身份牌、LLM 绑定、世界书、种子', () => {
    assert.deepEqual([...BUNDLE_HASH_INPUTS], ['graph', 'component_versions', 'identity_cards', 'llm_bindings', 'worldbook', 'seeds']);
  });

  test('hash 格式：小写 64 hex（大写/短串拒绝）', () => {
    assert.ok(BundleHashSchema.safeParse(SHA).success);
    assert.ok(!BundleHashSchema.safeParse(SHA.toUpperCase()).success);
    assert.ok(!BundleHashSchema.safeParse('abc123').success);
  });
});

describe('run manifest（D24）', () => {
  function validManifest() {
    return {
      run_id: RUN_ID,
      scenario: 'isekai-survival',
      bundle_hash: SHA,
      bundle_path: 'schema/fixtures/isekai',
      started_at: '2026-07-31T10:00:00.000Z',
      ended_at: '2026-07-31T11:00:00.000Z',
      status: 'completed',
      ending: 'cleared',
      cost: { total: 12.34, currency: 'CNY', by_model: { 'kimi-k3': 10.0, 'kimi-k2.7-code': 2.34 } },
      genealogy: { source_run_id: RUN_ID, source_event_id: 'e0000123' },
      schema_version: '1.0.0',
    };
  }

  test('正向：completed（含族谱指针）/ cancelled / error（无结局，带 error 元信息）', () => {
    assert.ok(RunManifestSchema.safeParse(validManifest()).success);
    const cancelled = { ...validManifest(), status: 'cancelled', ending: null, ended_at: '2026-07-31T10:30:00.000Z', genealogy: null };
    assert.ok(RunManifestSchema.safeParse(cancelled).success);
    const errored = { ...validManifest(), status: 'error', ending: null, ended_at: null, error: { code: 'NODE_FAILED', detail: 'settle 节点 onError=stop' } };
    assert.ok(RunManifestSchema.safeParse(errored).success);
  });

  test('反向：run_id 非 v7 / bundle_hash 非法 / status 非三态 / 缺成本汇总', () => {
    assert.ok(!RunManifestSchema.safeParse({ ...validManifest(), run_id: 'not-uuid' }).success);
    assert.ok(!RunManifestSchema.safeParse({ ...validManifest(), bundle_hash: 'xyz' }).success);
    assert.ok(!RunManifestSchema.safeParse({ ...validManifest(), status: 'running' }).success, 'D24 写入时机不含 running');
    const { cost, ...noCost } = validManifest();
    assert.ok(!RunManifestSchema.safeParse(noCost).success);
  });

  test('族谱指针：跨局引用必须 run id + 事件 id 二元组（deep-dive §1.5-7）', () => {
    const badGenealogy = { ...validManifest(), genealogy: { source_run_id: RUN_ID } };
    assert.ok(!RunManifestSchema.safeParse(badGenealogy).success);
    assert.ok(RunManifestSchema.safeParse({ ...validManifest(), genealogy: null }).success, '初代版本为 null');
  });

  test('round-trip：manifest 经 JSON 序列化后再校验深度相等', () => {
    const parsed = RunManifestSchema.parse(validManifest());
    assert.deepEqual(RunManifestSchema.parse(JSON.parse(JSON.stringify(parsed))), parsed);
  });
});

describe('JSON Schema 导出', () => {
  test('bundle.ts 全部导出 Schema 可导出且可序列化', () => {
    for (const s of [ModelBindingSchema, AgentBindingSchema, CostBudgetSchema, SnapshotPolicySchema, GameConfigSchema, WorldBookSchema, SeedsSchema, ScenarioBundleSchema, BundleHashSchema, RunManifestSchema]) {
      assert.ok(JSON.stringify(z.toJSONSchema(s)).length > 50);
    }
  });
});
