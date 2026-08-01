// Version: 1.0.0
/** util.ts 测试：parseParams / callMeta / emit / jsonSchemaOf。 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { callMeta, emit, jsonSchemaOf, parseParams } from './util.ts';
import { createMetaRegistry } from '../meta/registry.ts';
import { makeCtx, mockAgentService, mockBlackboard, mockEnvelopeSource, mockEventLog, mockMemory } from '../meta/testkit.ts';

describe('util 共享小工具', () => {
  test('parseParams：合法/非法', () => {
    const s = z.strictObject({ x: z.number() });
    assert.deepEqual(parseParams(s, { x: 1 }), { ok: true, value: { x: 1 } });
    assert.deepEqual(parseParams(s, { x: 'a' }), { ok: false, error: 'PARAM_SCHEMA_INVALID' });
  });

  test('callMeta 失败归一 COMPONENT_FAILED；emit 走 emit_event 通道；jsonSchemaOf 导出 object', async () => {
    const { source } = mockEnvelopeSource();
    const meta = createMetaRegistry({
      agentService: mockAgentService(),
      memory: mockMemory(),
      blackboard: mockBlackboard(),
      eventLog: mockEventLog(),
      envelopeSource: source,
    });
    const ctx = makeCtx(meta);
    assert.deepEqual(await callMeta(ctx, 'no_such_meta', {}), { ok: false, error: 'COMPONENT_FAILED' });
    const s = await emit(ctx, 'milestone', { kind: 'act', label: '第一幕' });
    assert.equal(s.ok, true);
    assert.equal(jsonSchemaOf(z.strictObject({ x: z.number() })).type, 'object');
  });
});
