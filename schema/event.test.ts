// Version: 1.0.0
/**
 * event.ts 契约测试：38 个内核类型正向用例 + 信封/载荷反向用例 + 开放注册（D32）+ round-trip + JSON Schema 导出。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  CUSTOM_EVENT_TYPE_RE,
  CustomEventSchema,
  EventDraftSchema,
  EventSchema,
  KERNEL_EVENT_TYPES,
  KernelEventSchema,
  createEventSchema,
} from './event.ts';

// ===== 测试基座 =====

const SHA = 'a'.repeat(64);
const RUN_ID = '01890f3e-5c2a-7b3d-8e4f-a1b2c3d4e5f6';
const TS = '2026-07-31T11:15:24.108Z';
const EXEC = { node_id: 'narrate_scene', iteration: 0 };

function fullEvent(type, exec, payload) {
  return { id: 'e0000001', parent_id: null, ts: TS, run_id: RUN_ID, branch: 'main', exec, type, payload };
}

/** 38 个内核类型的正向用例：type → [exec, payload]。 */
const VALID_KERNEL = [
  ['run_started', null, { bundle_hash: SHA, bundle_path: 'bundles/isekai', mode: 'fresh', fork_from_event_id: null }],
  ['run_paused', null, { reason: '导演请求暂停' }],
  ['run_resumed', null, { from_state: 'paused' }],
  ['run_completed', null, { ending: 'cleared', cost: { total: 12.34, currency: 'CNY' } }],
  ['run_error', null, { error: 'NODE_FAILED', node_id: 'settle', detail: 'archivist 组件超时' }],
  ['run_cancelled', null, { reason: '导演放弃整局' }],
  ['node_start', EXEC, { component_type: 'narrator', component_version: '1.0.0', params: { agent_id: 'narrator' } }],
  ['node_end', EXEC, { component_type: 'narrator', component_version: '1.0.0' }],
  ['node_failed', EXEC, { component_type: 'narrator', component_version: '1.0.0', error: 'COMPONENT_FAILED' }],
  ['gate_waiting', EXEC, { targets: ['protagonist'], accepts: ['whisper', 'inject'], timeout: { policy: 'wait_forever' } }],
  ['gate_input_received', EXEC, {
    directive: { kind: 'whisper', text: '你隐约记得这个世界的天空', targets: ['protagonist'], mode: 'steering' },
    directive_hash: SHA,
    source: 'director_inbox',
  }],
  ['gate_timeout', EXEC, { policy: 'use_default', waited_ms: 60000 }],
  ['gate_cancelled', EXEC, { reason: 'run_cancelled' }],
  ['director_intervention', EXEC, {
    directive: { kind: 'inject', text: '一支商队路过地平线', targets: [], mode: null },
    directive_hash: SHA,
    outcome: 'applied',
  }],
  ['director_note', null, { text: '这段节奏不错，留作高光候选', directive_hash: SHA }],
  ['agent_created', EXEC, { agent_id: 'protagonist', card_name: 'Build A · 均衡生存流', card_version: '1.0', model: 'kimi-k3', memory_ref: null }],
  ['agent_destroyed', EXEC, { agent_id: 'protagonist', reason: '局末收尾' }],
  ['agent_paused', EXEC, { agent_id: 'protagonist' }],
  ['agent_resumed', EXEC, { agent_id: 'protagonist' }],
  ['agent_error', EXEC, { agent_id: 'protagonist', error: 'TURN_FAILED', detail: 'fallback 链耗尽' }],
  ['agent_recovered', EXEC, { agent_id: 'protagonist', strategy: 'retry' }],
  ['turn_start', EXEC, { agent_id: 'protagonist', first_turn: true }],
  ['turn_end', EXEC, { agent_id: 'protagonist', outcome: 'final' }],
  ['speech', EXEC, { agent_id: 'protagonist', text: '我先检查岩棚的稳固性。' }],
  ['monologue', EXEC, { agent_id: 'protagonist', text: '（岩层走向西北，可能是背风坡……）' }],
  ['dice', EXEC, { expression: '1d20+2', rolls: [17], modifier: 2, total: 19, purpose: '攀爬检定' }],
  ['judgement', EXEC, {
    subject: '攀爬岩壁', grade: '成功',
    modifiers: [{ label: '野外生存', value: 2 }],
    dice_event_id: 'e0000042', rationale: 'd20=17 + 技能2 = 19 ≥ 15',
  }],
  ['milestone', EXEC, { kind: 'world', label: '世界第一·灰烬荒原', data: { world: 1, day: 1 } }],
  ['agent_to_agent', EXEC, { source_agent_id: 'narrator', target_agent_id: 'protagonist', text: '你听到远处传来引擎声。' }],
  ['bb_set', EXEC, { key: 'state.protagonist.hp', value: 92, reason: '跌落 -8' }],
  ['judge_retry', EXEC, { attempt: 1, max_attempts: 3, error: 'SCHEMA_MISMATCH' }],
  ['branch_decision', EXEC, {
    condition: { op: 'gte', left: { ref: 'state.protagonist.san_delta' }, right: 10 },
    snapshot: { 'state.protagonist.san_delta': 12 },
    result: true, from_port: 'out', target_node: 'sanity_check',
  }],
  ['cost', EXEC, {
    agent_id: 'protagonist', model: 'kimi-k3', requested_model: 'kimi-k3',
    usage: { input: 1200, output: 300, cached_read: 800, cached_write: 0, reasoning: 150 },
    cost: { amount: 0.05, currency: 'CNY' },
    raw_usage: { prompt_tokens: 2000, completion_tokens: 450, cached_tokens: 800 },
  }],
  ['prompt_hash', EXEC, { agent_id: 'protagonist', prefix_sha256: SHA }],
  ['cache_invalidation', EXEC, { agent_id: null, reason: 'edit_world', detail: 'worldbook.ashen_wastes' }],
  ['snapshot', null, {
    last_event_id: 'e0000500',
    blackboard: { 'state.protagonist.hp': 92 },
    agents: { protagonist: { state: 'IDLE', memory_ref: null } },
    progress: { 'narrate_scene#0': { status: 'completed' } },
    ledger: { total: 1.2, currency: 'CNY' },
  }],
  ['fork', null, { at_event_id: 'e0000123', new_branch: 'try2', reason: '换一个干预重来一轮' }],
  ['system', null, { code: 'invalid_director_line', message: 'inbox 第 3 行无法解析，已跳过', severity: 'warning' }],
];

describe('内核封闭集（D32）', () => {
  test('用例表覆盖全部 38 个内核类型，无遗漏无多余', () => {
    const covered = VALID_KERNEL.map(([t]) => t).sort();
    assert.deepEqual(covered, [...KERNEL_EVENT_TYPES].sort());
    assert.equal(KERNEL_EVENT_TYPES.length, 38);
  });

  for (const [type, exec, payload] of VALID_KERNEL) {
    test(`正向：${type}`, () => {
      const ev = fullEvent(type, exec, payload);
      const r = EventSchema.safeParse(ev);
      assert.ok(r.success, `${type} 应通过：${JSON.stringify(r.error?.issues?.slice(0, 3))}`);
    });

    test(`round-trip：${type}（Zod 校验值 → JSON 序列化 → 再校验 → 深度相等）`, () => {
      const parsed = EventSchema.parse(fullEvent(type, exec, payload));
      const reparsed = EventSchema.parse(JSON.parse(JSON.stringify(parsed)));
      assert.deepEqual(reparsed, parsed);
    });

    test(`draft：${type}（无 id/parent_id 的 append 入参形态）`, () => {
      const draft = { ts: TS, run_id: RUN_ID, branch: 'main', exec, type, payload };
      assert.ok(EventDraftSchema.safeParse(draft).success, `${type} draft 应通过`);
    });
  }

  test('内核类型名均不含命名空间分隔符（与自定义开放集天然不冲突，D32）', () => {
    for (const t of KERNEL_EVENT_TYPES) assert.ok(!t.includes('.'), `${t} 不应含 '.'`);
  });
});

describe('信封（D31/D36/deep-dive §1.4）', () => {
  const base = fullEvent('speech', EXEC, { agent_id: 'p', text: 't' });

  test('id 格式：必须 e + ≥7 位零填充数字', () => {
    assert.ok(!EventSchema.safeParse({ ...base, id: 'e1' }).success);
    assert.ok(!EventSchema.safeParse({ ...base, id: '0000001' }).success);
    assert.ok(!EventSchema.safeParse({ ...base, id: 'f0000001' }).success);
    assert.ok(EventSchema.safeParse({ ...base, id: 'e0000001' }).success);
    assert.ok(EventSchema.safeParse({ ...base, id: 'e12345678' }).success);
  });

  test('parent_id：同格式或 null', () => {
    assert.ok(EventSchema.safeParse({ ...base, parent_id: 'e0000000' }).success);
    assert.ok(!EventSchema.safeParse({ ...base, parent_id: 'x' }).success);
  });

  test('ts：必须 ISO 8601 墙钟（D31）', () => {
    assert.ok(!EventSchema.safeParse({ ...base, ts: 'not-a-time' }).success);
    assert.ok(!EventSchema.safeParse({ ...base, ts: 1756624524108 }).success);
  });

  test('run_id：必须 UUID v7（v4 拒绝）', () => {
    assert.ok(!EventSchema.safeParse({ ...base, run_id: '01890f3e-5c2a-4b3d-8e4f-a1b2c3d4e5f6' }).success);
    assert.ok(!EventSchema.safeParse({ ...base, run_id: 'not-uuid' }).success);
  });

  test('exec 空值纪律：节点事件必带，runner 级事件恒 null（D36）', () => {
    assert.ok(!EventSchema.safeParse({ ...base, exec: null }).success, 'speech 缺 exec 应拒绝');
    const rs = fullEvent('run_started', null, VALID_KERNEL.find(([t]) => t === 'run_started')[2]);
    assert.ok(!EventSchema.safeParse({ ...rs, exec: EXEC }).success, 'run_started 带 exec 应拒绝');
    // cost 例外：exec nullable（加载期冒烟等局外调用）
    const costEv = fullEvent('cost', null, VALID_KERNEL.find(([t]) => t === 'cost')[2]);
    assert.ok(EventSchema.safeParse(costEv).success, 'cost exec=null 应通过');
  });

  test('信封 strict：多余字段拒绝', () => {
    assert.ok(!EventSchema.safeParse({ ...base, extra_field: 1 }).success);
  });

  test('draft strict：append 入参自带 id 拒绝（取号权在 EventLog，deep-dive §1.5-3）', () => {
    const draft = { id: 'e0000001', ts: TS, run_id: RUN_ID, branch: 'main', exec: EXEC, type: 'speech', payload: { agent_id: 'p', text: 't' } };
    assert.ok(!EventDraftSchema.safeParse(draft).success);
  });
});

describe('载荷关键约束', () => {
  test('cost：usage 五字段必须非负整数（deep-dive-llm 问题 1）', () => {
    const payload = { ...VALID_KERNEL.find(([t]) => t === 'cost')[2] };
    const bad = { ...payload, usage: { input: -1, output: 0, cached_read: 0, cached_write: 0, reasoning: 0 } };
    assert.ok(!EventSchema.safeParse(fullEvent('cost', EXEC, bad)).success);
    const missing = { ...payload, usage: { input: 1, output: 0, cached_read: 0, cached_write: 0 } };
    assert.ok(!EventSchema.safeParse(fullEvent('cost', EXEC, missing)).success, '缺 reasoning 字段应拒绝');
  });

  test('干预类型封闭集（D18）：集合外类型拒绝', () => {
    const payload = {
      directive: { kind: 'mind_control', text: 'x', targets: [], mode: null },
      directive_hash: SHA,
      outcome: 'applied',
    };
    assert.ok(!EventSchema.safeParse(fullEvent('director_intervention', EXEC, payload)).success);
  });

  test('干预事件必须携带指令全文 + hash（D18/D31）', () => {
    const noText = { directive: { kind: 'inject', targets: [], mode: null }, directive_hash: SHA, outcome: 'applied' };
    assert.ok(!EventSchema.safeParse(fullEvent('director_intervention', EXEC, noText)).success);
    const noHash = { directive: { kind: 'inject', text: 'x', targets: [], mode: null }, outcome: 'applied' };
    assert.ok(!EventSchema.safeParse(fullEvent('director_intervention', EXEC, noHash)).success);
  });

  test('sha256 必须小写 hex', () => {
    const payload = { agent_id: 'p', prefix_sha256: 'A'.repeat(64) };
    assert.ok(!EventSchema.safeParse(fullEvent('prompt_hash', EXEC, payload)).success);
  });

  test('门超时策略（D15）：wait_forever 携带 after_ms 拒绝（strict）', () => {
    const payload = { targets: [], accepts: ['whisper'], timeout: { policy: 'wait_forever', after_ms: 1000 } };
    assert.ok(!EventSchema.safeParse(fullEvent('gate_waiting', EXEC, payload)).success);
  });

  test('快照四段齐全（D11/deep-dive §2.4-1）', () => {
    const payload = { last_event_id: 'e0000001', blackboard: {}, agents: {}, progress: {} };
    assert.ok(!EventSchema.safeParse(fullEvent('snapshot', null, payload)).success, '缺 ledger 段应拒绝');
  });
});

describe('开放注册集（D32）', () => {
  const customBase = fullEvent('isekai.omen_triggered', EXEC, { omen: '血月' });

  test('命名空间前缀约定：含点的小写段接受，其余拒绝', () => {
    assert.ok(CUSTOM_EVENT_TYPE_RE.test('isekai.omen_triggered'));
    assert.ok(CUSTOM_EVENT_TYPE_RE.test('a.b'));
    assert.ok(!CUSTOM_EVENT_TYPE_RE.test('nodot'));
    assert.ok(!CUSTOM_EVENT_TYPE_RE.test('Upper.case'));
    assert.ok(!CUSTOM_EVENT_TYPE_RE.test('.leading'));
  });

  test('自定义事件经全量契约通过（内核 + 开放并集）', () => {
    assert.ok(EventSchema.safeParse(customBase).success);
    assert.ok(CustomEventSchema.safeParse(customBase).success);
    assert.ok(!KernelEventSchema.safeParse(customBase).success, '不属内核封闭集');
  });

  test('注册表校验器：仅接受显式注册的自定义类型，内核类型恒通过', () => {
    const registry = createEventSchema(['isekai.omen_triggered']);
    assert.ok(registry.safeParse(customBase).success);
    assert.ok(!registry.safeParse(fullEvent('other.component_event', EXEC, {})).success);
    assert.ok(registry.safeParse(fullEvent('speech', EXEC, { agent_id: 'p', text: 't' })).success);
  });

  test('注册表构建期拒绝非法类型名', () => {
    assert.throws(() => createEventSchema(['nodot']));
    assert.throws(() => createEventSchema(['speech']), '内核形态名不应允许注册为自定义');
  });
});

describe('JSON Schema 导出（硬约束 2）', () => {
  test('EventSchema / EventDraftSchema / KernelEventSchema / 注册表 全部可导出且可序列化', () => {
    for (const [name, schema] of Object.entries({
      EventSchema,
      EventDraftSchema,
      KernelEventSchema,
      CustomEventSchema,
      registry: createEventSchema(['isekai.omen_triggered']),
    })) {
      const js = z.toJSONSchema(schema);
      assert.ok(JSON.stringify(js).length > 100, `${name} 导出异常`);
    }
  });

  test('导出含 describe 描述（可追溯性）', () => {
    const js = JSON.stringify(z.toJSONSchema(EventSchema));
    assert.ok(js.includes('D36'), '信封 describe 应含决策追溯');
    assert.ok(js.includes('D31'));
  });
});
