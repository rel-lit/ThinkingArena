// Version: 1.0.0
/** role-create.ts 测试：创建经元组件通道（create_agent），参数校验与失败编码。 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createMetaRegistry } from '../meta/registry.ts';
import { makeCtx, mockAgentService, mockBlackboard, mockEventLog, mockMemory } from '../meta/testkit.ts';
import { roleCreateComponent } from './role-create.ts';

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

const SPEC = {
  id: 'hero',
  identity_card: { version: '1.0', name: '勇者', description: '普通人', personality: '谨慎' },
  model: { model: 'deepseek-chat', tier: 'mid' },
};

describe('role_create 组件', () => {
  test('按参数逐一创建（字段映射 id/identityCard/modelBinding）', async () => {
    const { agentService, ctx } = setup();
    const r = await roleCreateComponent.run({ agents: [SPEC] }, ctx);
    assert.equal(r.ok, true);
    const spec = agentService.calls.find((c) => c.method === 'create')!.args[0] as {
      id: string;
      identityCard: { name: string; personality?: string };
      modelBinding: { model: string; tier?: string };
    };
    assert.equal(spec.id, 'hero');
    assert.equal(spec.identityCard.name, '勇者');
    assert.equal(spec.modelBinding.tier, 'mid');
  });

  test('创建失败（AGENT_ALREADY_EXISTS）→ COMPONENT_FAILED；非法参数 → PARAM_SCHEMA_INVALID', async () => {
    const { agentService, ctx } = setup();
    agentService.create = () => {
      agentService.calls.push({ method: 'create', args: [] });
      return { ok: false, error: 'AGENT_ALREADY_EXISTS' };
    };
    const r = await roleCreateComponent.run({ agents: [SPEC] }, ctx);
    assert.deepEqual(r, { ok: false, error: 'COMPONENT_FAILED' });
    const bad = await roleCreateComponent.run({ agents: [] }, ctx);
    assert.deepEqual(bad, { ok: false, error: 'PARAM_SCHEMA_INVALID' });
  });

  test('两元结构：description 带 version / 端口 / 可写键前缀声明（§4.7/D26）', () => {
    assert.equal(roleCreateComponent.description.name, 'role_create');
    assert.equal(roleCreateComponent.description.version, '1.0.0');
    assert.deepEqual(roleCreateComponent.description.outputs, ['out']);
    assert.deepEqual(roleCreateComponent.description.writable_prefixes, []);
    assert.equal(typeof roleCreateComponent.description.parameters, 'object');
  });
});
