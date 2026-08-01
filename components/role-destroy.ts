// Version: 1.0.0
/** 内置组件 role_destroy：显式销毁 Agent 实例（§3.1 A10；agent_destroyed 由服务自动落，D35）。 */
import { z } from 'zod';
import { AgentIdSchema } from '../schema/event.ts';
import type { Component } from '../schema/meta-component.ts';
import { callMeta, jsonSchemaOf, parseParams } from './util.ts';

export const RoleDestroyParamsSchema = z
  .strictObject({
    agent_id: AgentIdSchema,
    reason: z.string().optional().describe('销毁说明（人读归因；agent_destroyed 载荷由服务落）'),
  })
  .describe('role_destroy 节点参数');

export const roleDestroyComponent: Component = {
  description: {
    name: 'role_destroy',
    version: '1.0.0',
    description: '角色销毁：显式销毁 Agent 实例（§3.1 A10–A12；不销毁则跨局存续，D22）',
    parameters: jsonSchemaOf(RoleDestroyParamsSchema),
    inputs: ['in'],
    outputs: ['out'],
    writable_prefixes: [],
  },
  async run(params, ctx) {
    const p = parseParams(RoleDestroyParamsSchema, params);
    if (!p.ok) return p;
    const r = await callMeta(ctx, 'destroy_agent', p.value);
    return r.ok ? { ok: true, value: undefined } : r;
  },
};
