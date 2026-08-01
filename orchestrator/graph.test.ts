// Version: 1.0.0
/**
 * graph.ts 测试：parseFlowConfig（schema 结构校验）+ validateFlowConfig（D20 跨引用校验）。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFlowConfig, validateFlowConfig } from './graph.ts';
import { makeComponent, MockComponentRegistry, OK_COMPONENT } from './test-mocks.ts';

function linearFlow() {
  return {
    name: 't',
    version: '1.0.0',
    entry: 'a',
    nodes: [
      { id: 'a', type: 'noop', version: '1.0.0', on_error: 'stop' },
      { id: 'b', type: 'noop', version: '1.0.0', on_error: 'continue' },
    ],
    edges: [{ from: 'a', from_port: 'out', to: 'b', to_port: 'in' }],
  };
}

function registry(): MockComponentRegistry {
  return new MockComponentRegistry().add(makeComponent('noop', OK_COMPONENT));
}

describe('parseFlowConfig', () => {
  test('正向：合法线性图', () => {
    const r = parseFlowConfig(linearFlow());
    assert.ok(r.ok);
  });

  test('反向：结构非法（坏节点 id / 笔误字段 / 缺 on_error）', () => {
    assert.equal(parseFlowConfig(null).ok, false);
    const bad1 = linearFlow();
    bad1.nodes[0].id = 'Bad-Id';
    assert.equal(parseFlowConfig(bad1).ok, false);
    const bad2 = linearFlow() as Record<string, unknown>;
    bad2.unknown_key = 1;
    assert.equal(parseFlowConfig(bad2).ok, false);
    const bad3 = linearFlow();
    delete (bad3.nodes[0] as Record<string, unknown>).on_error;
    assert.equal(parseFlowConfig(bad3).ok, false);
  });
});

describe('validateFlowConfig（D20）', () => {
  test('正向：合法图返回空问题清单', () => {
    const parsed = parseFlowConfig(linearFlow());
    assert.ok(parsed.ok);
    const r = validateFlowConfig(parsed.value, registry());
    assert.ok(r.ok);
    assert.deepEqual(r.value, []);
  });

  test('入口不存在 / 节点 id 重复 / 不可达节点', () => {
    const f = linearFlow();
    f.entry = 'ghost';
    const parsed = parseFlowConfig(f);
    assert.ok(parsed.ok);
    let issues = validateFlowConfig(parsed.value, registry());
    assert.ok(issues.ok && issues.value.some((i) => i.message.includes('入口节点不存在')));

    const dup = linearFlow();
    dup.nodes.push({ ...dup.nodes[0] });
    const p2 = parseFlowConfig(dup);
    assert.ok(p2.ok);
    issues = validateFlowConfig(p2.value, registry());
    assert.ok(issues.ok && issues.value.some((i) => i.message.includes('节点 id 重复')));

    const iso = linearFlow();
    iso.nodes.push({ id: 'island', type: 'noop', version: '1.0.0', on_error: 'stop' });
    const p3 = parseFlowConfig(iso);
    assert.ok(p3.ok);
    issues = validateFlowConfig(p3.value, registry());
    assert.ok(issues.ok && issues.value.some((i) => i.message.includes('入口不可达')));
  });

  test('边端点不存在 / 端口未声明 / 组件未注册', () => {
    const f = linearFlow();
    f.edges.push({ from: 'a', from_port: 'out', to: 'ghost', to_port: 'in' });
    const parsed = parseFlowConfig(f);
    assert.ok(parsed.ok);
    let issues = validateFlowConfig(parsed.value, registry());
    assert.ok(issues.ok && issues.value.some((i) => i.message.includes('目标节点不存在')));

    const f2 = linearFlow();
    f2.edges[0].from_port = 'nope';
    const p2 = parseFlowConfig(f2);
    assert.ok(p2.ok);
    issues = validateFlowConfig(p2.value, registry());
    assert.ok(issues.ok && issues.value.some((i) => i.message.includes('输出端口未在组件')));

    const f3 = linearFlow();
    f3.nodes[1].type = 'unregistered';
    const p3 = parseFlowConfig(f3);
    assert.ok(p3.ok);
    issues = validateFlowConfig(p3.value, registry());
    assert.ok(issues.ok && issues.value.some((i) => i.message.includes('组件未注册')));
  });

  test('join 声明 → Phase 2 报错（首局不实现）', () => {
    const f = linearFlow();
    (f.nodes[1] as Record<string, unknown>).join = { inputs: ['in'] };
    const parsed = parseFlowConfig(f);
    assert.ok(parsed.ok);
    const issues = validateFlowConfig(parsed.value, registry());
    assert.ok(issues.ok && issues.value.some((i) => i.message.includes('Phase 2')));
  });

  test('导演门节点参数非法 → issue', () => {
    const f = linearFlow();
    f.nodes.push({
      id: 'gate',
      type: 'director_gate',
      version: '1.0.0',
      params: { targets: ['a1'] }, // 缺 accepts/timeout
      on_error: 'stop',
    });
    f.edges.push({ from: 'b', from_port: 'out', to: 'gate', to_port: 'in' });
    const parsed = parseFlowConfig(f);
    assert.ok(parsed.ok);
    const reg = registry().add(makeComponent('director_gate', OK_COMPONENT));
    const issues = validateFlowConfig(parsed.value, reg);
    assert.ok(issues.ok && issues.value.some((i) => i.message.includes('导演门节点参数')));
  });
});
