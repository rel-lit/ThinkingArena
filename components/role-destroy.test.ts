// Version: 1.0.0
/** role-destroy.ts 测试：显式销毁经元组件通道（destroy_agent），失败编码。 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createMetaRegistry } from '../meta/registry.ts';
import { makeCtx, mockAgentService, mockBlackboard, mockEventLog, mockMemory } from '../meta/testkit.ts';
import { roleDestroyComponent } from './role-destroy.ts';

function setup() {
  const agentService = mockAgentService();
  const meta = createMetaRegistry({
    agentService,
    memory: mockMemory(),
    blackboard: mockBlackboard(),
    eventLog: mockEventLog(),
  });
  return { agentService, ctx: makeCtx(meta) };
}

describe('role_destroy 组件', () => {
  test('显式销毁（A10）', async () => {
    const { agentService, ctx } = setup();
    const r = await roleDestroyComponent.run({ agent_id: 'hero', reason: '谢幕' }, ctx);
    assert.equal(r.ok, true);
    assert.equal(agentService.calls.find((c) => c.method === 'destroy')!.args[0], 'hero');
  });

  test('目标不存在（AGENT_NOT_FOUND）→ COMPONENT_FAILED；非法参数 → PARAM_SCHEMA_INVALID', async () => {
    const { agentService, ctx } = setup();
    agentService.destroy = (id) => {
      agentService.calls.push({ method: 'destroy', args: [id] });
      return { ok: false, error: 'AGENT_NOT_FOUND' };
    };
    const r = await roleDestroyComponent.run({ agent_id: 'ghost' }, ctx);
    assert.deepEqual(r, { ok: false, error: 'COMPONENT_FAILED' });
    const bad = await roleDestroyComponent.run({}, ctx);
    assert.deepEqual(bad, { ok: false, error: 'PARAM_SCHEMA_INVALID' });
  });
});
