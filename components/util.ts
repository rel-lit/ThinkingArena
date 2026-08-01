// Version: 1.0.0
/** 组件层共享小工具：参数校验、元组件调用解包、事件发射。 */
import { z } from 'zod';
import type { ComponentErrorKind, Result } from '../schema/errors.ts';
import type { ComponentContext } from '../schema/meta-component.ts';

/** 校验节点参数（运行期兜底；加载期拦截是 FlowRunner 的 D20 职责）。 */
export function parseParams<P>(schema: z.ZodType<P>, params: unknown): Result<P, ComponentErrorKind> {
  const r = schema.safeParse(params);
  return r.success ? { ok: true, value: r.data } : { ok: false, error: 'PARAM_SCHEMA_INVALID' };
}

/** 调用元组件；失败归一为组件错误枚举（具体枚举已由 FlowRunner 经节点失败事件归因，D35）。 */
export async function callMeta(
  ctx: ComponentContext,
  name: string,
  args: unknown,
): Promise<Result<unknown, ComponentErrorKind>> {
  const r = await ctx.meta.call(name, args, ctx);
  return r.ok ? { ok: true, value: r.value } : { ok: false, error: 'COMPONENT_FAILED' };
}

/** 发射游戏语义事件（D35 组件显式发射面）；返回盖章事件（供 judgement.dice_event_id 等引用）。 */
export function emit(ctx: ComponentContext, type: string, payload: unknown) {
  return callMeta(ctx, 'emit_event', { type, payload });
}

/** 描述表 parameters 字段的 JSON Schema 导出（ComponentDescriptor 契约形态）。 */
export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema) as Record<string, unknown>;
}
