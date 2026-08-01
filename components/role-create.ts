// Version: 1.0.0
/** 内置组件 role_create：按节点参数逐一创建 Agent 实例（§3.1 A1；agent_created 由服务自动落，D35）。 */
import { z } from 'zod';
import { AgentIdSchema } from '../schema/event.ts';
import { IdentityCardV1Schema } from '../schema/identity-card.ts';
import { ModelBindingSchema } from '../schema/bundle.ts';
import type { Component } from '../schema/meta-component.ts';
import { callMeta, jsonSchemaOf, parseParams } from './util.ts';

export const RoleCreateParamsSchema = z
  .strictObject({
    agents: z
      .array(z.strictObject({ id: AgentIdSchema, identity_card: IdentityCardV1Schema, model: ModelBindingSchema }))
      .min(1)
      .describe('待创建实例清单（身份牌与 LLM 绑定内联，与 game.yaml 名册同源）'),
  })
  .describe('role_create 节点参数');

export const roleCreateComponent: Component = {
  description: {
    name: 'role_create',
    version: '1.0.0',
    description: '角色创建：按参数逐一创建 Agent 实例（§3.1 A1/A2）',
    parameters: jsonSchemaOf(RoleCreateParamsSchema),
    inputs: ['in'],
    outputs: ['out'],
    writable_prefixes: [],
  },
  async run(params, ctx) {
    const p = parseParams(RoleCreateParamsSchema, params);
    if (!p.ok) return p;
    for (const spec of p.value.agents) {
      const r = await callMeta(ctx, 'create_agent', spec);
      if (!r.ok) return r;
    }
    return { ok: true, value: undefined };
  },
};
