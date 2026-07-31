// Version: 1.0.0
/**
 * flow.ts 契约测试：节点/边/条件 DSL/门参数 正反向 + fixtures flow.yaml 解析 + round-trip + JSON Schema 导出。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  ConditionExprSchema,
  DirectorGateParamsSchema,
  FlowConfigSchema,
  FlowEdgeSchema,
  FlowNodeSchema,
  JoinDeclSchema,
} from './flow.ts';

const FIXTURE_URL = new URL('./fixtures/isekai/flow.yaml', import.meta.url);

function minimalNode() {
  return { id: 'start', type: 'narrator', version: '1.0.0', on_error: 'stop' };
}

describe('FlowNode / FlowEdge 形态', () => {
  test('正向：最小节点与完整节点', () => {
    assert.ok(FlowNodeSchema.safeParse(minimalNode()).success);
    const full = {
      id: 'settle', type: 'archivist', version: '1.0.0',
      params: { agent_id: 'archivist' },
      on_error: 'retry', max_retries: 2,
      join: { inputs: ['in_a', 'in_b'], timeout_ms: 30000 },
    };
    assert.ok(FlowNodeSchema.safeParse(full).success);
  });

  test('反向：节点 id 必须 snake_case；on_error 必填（显式优于自动）', () => {
    assert.ok(!FlowNodeSchema.safeParse({ ...minimalNode(), id: 'Node1' }).success);
    assert.ok(!FlowNodeSchema.safeParse({ ...minimalNode(), id: '1abc' }).success);
    const { on_error, ...noOnError } = minimalNode();
    assert.ok(!FlowNodeSchema.safeParse(noOnError).success);
    assert.ok(!FlowNodeSchema.safeParse({ ...minimalNode(), on_error: 'ignore' }).success);
    assert.ok(!FlowNodeSchema.safeParse({ ...minimalNode(), unknown_key: 1 }).success, 'strict 拒绝笔误字段');
  });

  test('正向：边（含条件边与声明分支序 order）', () => {
    const edge = {
      from: 'settle', from_port: 'out', to: 'sanity_check', to_port: 'in',
      condition: { op: 'gte', left: { ref: 'state.protagonist.san_delta' }, right: 10 },
      order: 0,
    };
    assert.ok(FlowEdgeSchema.safeParse(edge).success);
  });

  test('反向：端口名禁止魔法下标/数字开头（端口用名字）', () => {
    const base = { from: 'a', from_port: 'out', to: 'b', to_port: 'in' };
    assert.ok(!FlowEdgeSchema.safeParse({ ...base, from_port: '0' }).success);
    assert.ok(!FlowEdgeSchema.safeParse({ ...base, to_port: '2' }).success);
  });

  test('join 声明：显式等待输入口（D8），空列表拒绝', () => {
    assert.ok(JoinDeclSchema.safeParse({ inputs: ['in_a'], timeout_ms: 1000 }).success);
    assert.ok(JoinDeclSchema.safeParse({ inputs: ['in_a'] }).success, '超时可选（缺省=永不超时）');
    assert.ok(!JoinDeclSchema.safeParse({ inputs: [] }).success);
  });
});

describe('条件 DSL（D7 封闭算子集）', () => {
  test('正向：比较 / and / or / not 及嵌套', () => {
    assert.ok(ConditionExprSchema.safeParse({ op: 'eq', left: { ref: 'a.b' }, right: 1 }).success);
    assert.ok(ConditionExprSchema.safeParse({ op: 'lte', left: 3, right: { ref: 'x' } }).success);
    const nested = {
      op: 'and',
      args: [
        { op: 'gte', left: { ref: 'state.protagonist.san' }, right: 30 },
        { op: 'or', args: [{ op: 'eq', left: { ref: 'state.world.id' }, right: 'ashen_wastes' }, { op: 'not', arg: { op: 'eq', left: { ref: 'state.world.safe' }, right: true } }] },
      ],
    };
    assert.ok(ConditionExprSchema.safeParse(nested).success);
  });

  test('反向：算子封闭集外拒绝（无 eval 式表达式）', () => {
    assert.ok(!ConditionExprSchema.safeParse({ op: 'contains', left: { ref: 'a' }, right: 'x' }).success);
    assert.ok(!ConditionExprSchema.safeParse({ op: 'eq', left: { ref: 'a' } }).success);
    assert.ok(!ConditionExprSchema.safeParse('state.protagonist.hp < 30').success, '字符串表达式不是 DSL');
  });

  test('反向：黑板键路径格式（拒绝非点路径）', () => {
    assert.ok(!ConditionExprSchema.safeParse({ op: 'eq', left: { ref: '1bad.key' }, right: 1 }).success);
    assert.ok(!ConditionExprSchema.safeParse({ op: 'eq', left: { ref: 'a..b' }, right: 1 }).success);
  });

  test('round-trip：嵌套条件经 JSON 序列化后再校验深度相等', () => {
    const cond = { op: 'not', arg: { op: 'and', args: [{ op: 'eq', left: { ref: 'a' }, right: null }, { op: 'gt', left: { ref: 'b.c' }, right: -1.5 }] } };
    const parsed = ConditionExprSchema.parse(cond);
    assert.deepEqual(ConditionExprSchema.parse(JSON.parse(JSON.stringify(parsed))), parsed);
  });
});

describe('导演门节点参数（D15/D37）', () => {
  const base = { targets: ['protagonist'], accepts: ['whisper', 'inject', 'edit_world', 'agent_broadcast'] };

  test('正向：三档超时策略', () => {
    assert.ok(DirectorGateParamsSchema.safeParse({ ...base, timeout: { policy: 'wait_forever' } }).success);
    assert.ok(DirectorGateParamsSchema.safeParse({
      ...base,
      timeout: { policy: 'use_default', after_ms: 60000, default_input: { kind: 'inject', text: '天象异变', targets: [], mode: null } },
    }).success);
    assert.ok(DirectorGateParamsSchema.safeParse({ ...base, timeout: { policy: 'cancel_branch', after_ms: 60000 } }).success);
  });

  test('反向：use_default 缺默认输入 / 未知策略 / 非封闭干预类型', () => {
    assert.ok(!DirectorGateParamsSchema.safeParse({ ...base, timeout: { policy: 'use_default', after_ms: 1000 } }).success);
    assert.ok(!DirectorGateParamsSchema.safeParse({ ...base, timeout: { policy: 'auto_resolve' } }).success);
    assert.ok(!DirectorGateParamsSchema.safeParse({ ...base, accepts: ['mind_control'], timeout: { policy: 'wait_forever' } }).success);
    assert.ok(!DirectorGateParamsSchema.safeParse({ ...base, accepts: [], timeout: { policy: 'wait_forever' } }).success);
    // 注：accepts: ['note'] 在 Schema 层合法（note 属 D18 封闭集）；「note 不经门」是 D27 加载期语义校验，不在本契约层。
  });
});

describe('FlowConfig 与 fixtures', () => {
  test('正向：最小图（单节点零边）', () => {
    const flow = { name: 'minimal', version: '1.0.0', entry: 'start', nodes: [minimalNode()], edges: [] };
    assert.ok(FlowConfigSchema.safeParse(flow).success);
  });

  test('反向：空节点列表拒绝', () => {
    assert.ok(!FlowConfigSchema.safeParse({ name: 'x', version: '1.0.0', entry: 'start', nodes: [], edges: [] }).success);
  });

  test('fixtures/isekai/flow.yaml 解析通过（六步回合 + 条件边 + 回边 + 导演门）', () => {
    const raw = JSON.parse(readFileSync(FIXTURE_URL, 'utf8'));
    const r = FlowConfigSchema.safeParse(raw);
    assert.ok(r.success, JSON.stringify(r.error?.issues?.slice(0, 5)));
    // 导演门节点的 params 必须过门参数契约
    const gate = r.data.nodes.find((n) => n.type === 'director_gate');
    assert.ok(gate, 'fixture 应含导演门节点');
    assert.ok(DirectorGateParamsSchema.safeParse(gate.params).success);
    // 条件边必须过条件 DSL
    const condEdges = r.data.edges.filter((e) => e.condition);
    assert.ok(condEdges.length >= 2, 'fixture 应含至少两条条件边（理智检查触发 + 循环退出）');
    for (const e of condEdges) assert.ok(ConditionExprSchema.safeParse(e.condition).success);
    // 回边存在（回边即循环）
    assert.ok(r.data.edges.some((e) => e.to === 'narrate_scene' && e.from === 'world_switch'));
  });

  test('round-trip：fixture flow 经 JSON 序列化后再校验深度相等', () => {
    const parsed = FlowConfigSchema.parse(JSON.parse(readFileSync(FIXTURE_URL, 'utf8')));
    assert.deepEqual(FlowConfigSchema.parse(JSON.parse(JSON.stringify(parsed))), parsed);
  });
});

describe('JSON Schema 导出（含递归条件 DSL）', () => {
  test('全部导出 Schema 可导出且可序列化', () => {
    for (const s of [FlowConfigSchema, FlowNodeSchema, FlowEdgeSchema, ConditionExprSchema, DirectorGateParamsSchema, JoinDeclSchema]) {
      assert.ok(JSON.stringify(z.toJSONSchema(s)).length > 50);
    }
  });
});
