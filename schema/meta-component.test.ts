// Version: 1.0.0
/**
 * meta-component.ts 契约测试：内置名册六个 parameters 正反向 + TurnOutcome 三态 + 描述形态 + round-trip + JSON Schema 导出。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  AwaitDirectorInputParamsSchema,
  BbGetParamsSchema,
  BbSetParamsSchema,
  BUILTIN_META_COMPONENTS,
  BUILTIN_META_COMPONENT_NAMES,
  CallAgentParamsSchema,
  ComponentDescriptorSchema,
  EmitEventParamsSchema,
  InjectContextParamsSchema,
  MetaComponentDescriptorSchema,
  TurnOutcomeSchema,
} from './meta-component.ts';

describe('内置元组件名册（§4.7）', () => {
  test('名册恰为签名级列举的六个', () => {
    assert.deepEqual(
      [...BUILTIN_META_COMPONENT_NAMES].sort(),
      ['await_director_input', 'bb_get', 'bb_set', 'call_agent', 'emit_event', 'inject_context'],
    );
  });

  test('名册条目：name 一致、version 为 semver、parameters 为 Zod Schema', () => {
    for (const [key, mc] of Object.entries(BUILTIN_META_COMPONENTS)) {
      assert.equal(mc.name, key);
      assert.match(mc.version, /^\d+\.\d+\.\d+$/);
      assert.ok(mc.parameters instanceof z.ZodType, `${key}.parameters 应为 Zod Schema`);
      assert.ok(mc.description.length > 0);
    }
  });
});

describe('call_agent 参数', () => {
  test('正向：首次调用与携带工具结果的循环调用（§2.2）', () => {
    assert.ok(CallAgentParamsSchema.safeParse({ agent_id: 'protagonist', intent: '声明你的行动' }).success);
    const withResults = {
      agent_id: 'protagonist',
      intent: '继续',
      tool_results: [{ call_id: 'c1', content: { ok: true, value: 92 }, is_error: false }],
    };
    assert.ok(CallAgentParamsSchema.safeParse(withResults).success);
  });

  test('反向：缺 agent_id / 空 intent / tool_results 缺 call_id', () => {
    assert.ok(!CallAgentParamsSchema.safeParse({ intent: 'x' }).success);
    assert.ok(!CallAgentParamsSchema.safeParse({ agent_id: 'p', intent: '' }).success);
    assert.ok(!CallAgentParamsSchema.safeParse({ agent_id: 'p', intent: 'x', tool_results: [{ content: 1 }] }).success);
  });
});

describe('其余五个内置元组件参数', () => {
  test('inject_context（D2/F8）', () => {
    assert.ok(InjectContextParamsSchema.safeParse({ target_agent_id: 'protagonist', text: '你听到引擎声', source: 'narrator' }).success);
    assert.ok(!InjectContextParamsSchema.safeParse({ target_agent_id: 'p' }).success);
    assert.ok(!InjectContextParamsSchema.safeParse({ text: 'x' }).success);
  });

  test('bb_get / bb_set（§4.2/D1）', () => {
    assert.ok(BbGetParamsSchema.safeParse({ key: 'state.protagonist.hp' }).success);
    assert.ok(!BbGetParamsSchema.safeParse({}).success);
    assert.ok(BbSetParamsSchema.safeParse({ key: 'state.protagonist.hp', value: 92, reason: '跌落 -8' }).success);
    assert.ok(!BbSetParamsSchema.safeParse({ key: 'k' }).success, 'bb_set 缺 value 拒绝');
  });

  test('emit_event（F12 校验前置）', () => {
    assert.ok(EmitEventParamsSchema.safeParse({ type: 'speech', payload: { agent_id: 'p', text: 't' } }).success);
    assert.ok(EmitEventParamsSchema.safeParse({ type: 'isekai.omen', payload: { omen: '血月' } }).success);
    assert.ok(!EmitEventParamsSchema.safeParse({ payload: {} }).success);
    assert.ok(!EmitEventParamsSchema.safeParse({ type: '' }).success);
  });

  test('await_director_input（D37/D15）', () => {
    const ok = { targets: ['protagonist'], accepts: ['whisper'], timeout: { policy: 'wait_forever' } };
    assert.ok(AwaitDirectorInputParamsSchema.safeParse(ok).success);
    assert.ok(!AwaitDirectorInputParamsSchema.safeParse({ targets: [], accepts: ['whisper'], timeout: { policy: 'auto' } }).success);
    assert.ok(!AwaitDirectorInputParamsSchema.safeParse({ targets: [], accepts: [], timeout: { policy: 'wait_forever' } }).success);
  });
});

describe('TurnOutcome（§4.1/§2.2）', () => {
  test('正向三态：final（含 reasoning）/ tool_calls / error', () => {
    assert.ok(TurnOutcomeSchema.safeParse({ kind: 'final', text: '我检查岩棚。', reasoning: '（岩层走向……）' }).success);
    assert.ok(TurnOutcomeSchema.safeParse({ kind: 'tool_calls', calls: [{ call_id: 'c1', name: 'dice', arguments: { expression: '1d20' } }] }).success);
    assert.ok(TurnOutcomeSchema.safeParse({ kind: 'error', error: 'TURN_ABORTED' }).success);
  });

  test('反向：未知 kind / tool_calls 空列表 / error 位非枚举（收紧为枚举联合，§4.7 备注）', () => {
    assert.ok(!TurnOutcomeSchema.safeParse({ kind: 'stream', text: 'x' }).success);
    assert.ok(!TurnOutcomeSchema.safeParse({ kind: 'tool_calls', calls: [] }).success);
    assert.ok(!TurnOutcomeSchema.safeParse({ kind: 'error', error: 'SOME_RANDOM_STRING' }).success);
  });

  test('round-trip：三态经 JSON 序列化后再校验深度相等', () => {
    for (const v of [
      { kind: 'final', text: '我检查岩棚。', reasoning: '（……）' },
      { kind: 'tool_calls', calls: [{ call_id: 'c1', name: 'dice', arguments: { expression: '1d20' } }] },
      { kind: 'error', error: 'CIRCUIT_OPEN', detail: '熔断中' },
    ]) {
      const parsed = TurnOutcomeSchema.parse(v);
      assert.deepEqual(TurnOutcomeSchema.parse(JSON.parse(JSON.stringify(parsed))), parsed);
    }
  });
});

describe('描述形态（可序列化部分，§4.7）', () => {
  test('MetaComponentDescriptor 正反向', () => {
    const ok = { name: 'call_agent', version: '1.0.0', description: '发起单次 LLM 往返', parameters: { type: 'object' } };
    assert.ok(MetaComponentDescriptorSchema.safeParse(ok).success);
    assert.ok(!MetaComponentDescriptorSchema.safeParse({ ...ok, version: '1.0' }).success, 'version 须 semver 三段');
    assert.ok(!MetaComponentDescriptorSchema.safeParse({ ...ok, beforeCall: 'fn' }).success, 'strict：函数不属于可序列化描述');
  });

  test('ComponentDescriptor：含 D26 可写键前缀声明', () => {
    const ok = {
      name: 'archivist', version: '1.0.0', description: '状态权威',
      parameters: { type: 'object' }, inputs: ['in'], outputs: ['out'],
      writable_prefixes: ['state'],
    };
    assert.ok(ComponentDescriptorSchema.safeParse(ok).success);
    const { writable_prefixes, ...missing } = ok;
    assert.ok(!ComponentDescriptorSchema.safeParse(missing).success, 'D26 声明必填');
  });
});

describe('JSON Schema 导出', () => {
  test('名册六个 parameters + TurnOutcome + 两个描述形态全部可导出', () => {
    for (const mc of Object.values(BUILTIN_META_COMPONENTS)) {
      assert.ok(JSON.stringify(z.toJSONSchema(mc.parameters)).length > 50, mc.name);
    }
    for (const s of [TurnOutcomeSchema, MetaComponentDescriptorSchema, ComponentDescriptorSchema]) {
      assert.ok(JSON.stringify(z.toJSONSchema(s)).length > 50);
    }
  });
});
