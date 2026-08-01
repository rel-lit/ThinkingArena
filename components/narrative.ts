// Version: 1.0.0
/**
 * 内置组件 narrative：单 Agent 叙事回合——call_agent 驱动 0..n 工具循环（§2.2 组件驱动决策循环），
 * final 时经 emit_event 落 speech / monologue（D35：speech 由 TurnOutcome 带回组件后发射；D31 全文 + 角色归属）。
 */
import { z } from 'zod';
import { AgentIdSchema } from '../schema/event.ts';
import type { Component, TurnOutcome } from '../schema/meta-component.ts';
import { callMeta, emit, jsonSchemaOf, parseParams } from './util.ts';

export const NarrativeParamsSchema = z
  .strictObject({
    agent_id: AgentIdSchema,
    intent: z.string().min(1).describe('本回合意图/指令文本（组件对 Agent 的任务描述）'),
    tools: z.array(z.string().min(1)).optional().describe('授予的工具白名单（元组件名；工具授予 = 组件选择调用哪些元组件，§2.2）'),
    max_tool_rounds: z.number().int().positive().optional().describe('工具循环上限（D28 统一迭代上限的组件级取值；缺省 4）'),
    emit_monologue: z.boolean().optional().describe('reasoning 全文是否落 monologue 事件（D31；缺省 true）'),
  })
  .describe('narrative 节点参数');

export const narrativeComponent: Component = {
  description: {
    name: 'narrative',
    version: '1.0.0',
    description: '叙事：单 Agent 回合（含工具循环），产出 speech/monologue 事件（D31/D35）',
    parameters: jsonSchemaOf(NarrativeParamsSchema),
    inputs: ['in'],
    outputs: ['out'],
    writable_prefixes: [],
  },
  async run(params, ctx) {
    const parsed = parseParams(NarrativeParamsSchema, params);
    if (!parsed.ok) return parsed;
    const p = parsed.value;
    const grants = new Set(p.tools ?? []);
    const maxRounds = p.max_tool_rounds ?? 4;
    let toolResults: { call_id: string; content: unknown; is_error?: boolean }[] | undefined;

    for (let round = 0; ; round++) {
      if (ctx.signal.aborted) return { ok: false, error: 'ABORTED' };
      const r = await callMeta(ctx, 'call_agent', { agent_id: p.agent_id, intent: p.intent, tool_results: toolResults });
      if (!r.ok) return r;
      const outcome = r.value as TurnOutcome;
      if (outcome.kind === 'error') return { ok: false, error: 'COMPONENT_FAILED' };
      if (outcome.reasoning && p.emit_monologue !== false) {
        const m = await emit(ctx, 'monologue', { agent_id: p.agent_id, text: outcome.reasoning });
        if (!m.ok) return m;
      }
      if (outcome.kind === 'final') {
        const s = await emit(ctx, 'speech', { agent_id: p.agent_id, text: outcome.text });
        return s.ok ? { ok: true, value: undefined } : s;
      }
      // tool_calls：组件驱动工具循环（§2.2），执行权在组件
      if (round + 1 > maxRounds) return { ok: false, error: 'COMPONENT_FAILED' }; // 超 D28 上限
      toolResults = [];
      for (const call of outcome.calls) {
        if (!grants.has(call.name)) {
          toolResults.push({ call_id: call.call_id, content: { error: 'COMPONENT_FAILED', detail: 'tool_not_granted' }, is_error: true });
          continue;
        }
        const tr = await ctx.meta.call(call.name, call.arguments, ctx);
        toolResults.push({ call_id: call.call_id, content: tr.ok ? tr.value : { error: tr.error }, is_error: !tr.ok });
      }
    }
  },
};
