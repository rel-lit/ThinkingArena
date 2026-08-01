// Version: 1.0.0
/**
 * 内置组件 judge（判定最小版）：骰子 → Referee 经 call_agent 叙事裁决 → Archivist 状态更新经 bb_set。
 * 裁决输出为 JSON（档级封闭集内）；校验失败重试并落 judge_retry（D17），达上限节点失败升级导演裁决。
 * 状态变更数值依据走 bb_set 的 reason（D31）。Archivist 最小实现 = 本组件顺序应用 updates
 *（附录 A「顺序执行、同回合内完成」；独立 Archivist Agent 留后续版本）。
 */
import { z } from 'zod';
import { AgentIdSchema } from '../schema/event.ts';
import type { Component, TurnOutcome } from '../schema/meta-component.ts';
import { rollExpression } from './dice.ts';
import { callMeta, emit, jsonSchemaOf, parseParams } from './util.ts';

export const JudgeParamsSchema = z
  .strictObject({
    subject: z.string().min(1).describe('被判定的行动声明'),
    referee_agent_id: AgentIdSchema.describe('Referee（裁判）Agent：叙事裁决'),
    grades: z.array(z.string().min(1)).min(1).describe('档级封闭集（场景规则定义，如 大成功/成功/失败）'),
    dice_expression: z.string().optional().describe('检定骰式（缺省 = 无骰判定，dice_event_id 落 null）'),
    modifier: z.number().optional().describe('检定修正（技能/物资等）'),
    max_retries: z.number().int().positive().optional().describe('裁决输出校验失败的重试上限（D17；缺省 2）'),
  })
  .describe('judge 节点参数');

/** 裁判输出契约（从 final 文本中提取 JSON 后校验；grade 须在档级封闭集内）。 */
const VerdictSchema = z.strictObject({
  grade: z.string(),
  rationale: z.string().optional(),
  updates: z
    .array(z.strictObject({ key: z.string().min(1), value: z.unknown(), reason: z.string().optional() }))
    .optional(),
});
type Verdict = z.infer<typeof VerdictSchema>;

/** 从裁判文本提取并校验裁决 JSON；失败返回 null（触发 judge_retry）。 */
function parseVerdict(text: string, grades: readonly string[]): Verdict | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const v = VerdictSchema.safeParse(raw);
  return v.success && grades.includes(v.data.grade) ? v.data : null;
}

export function createJudgeComponent(rng: () => number): Component {
  return {
    description: {
      name: 'judge',
      version: '1.0.0',
      description: '判定：骰子 + Referee 叙事裁决 + 状态更新（D17/D31；judgement 事件含档级与修正明细）',
      parameters: jsonSchemaOf(JudgeParamsSchema),
      inputs: ['in'],
      outputs: ['out'],
      writable_prefixes: ['state', 'protagonist'], // D26：状态表键仅裁判组件可写
    },
    async run(params, ctx) {
      const parsed = parseParams(JudgeParamsSchema, params);
      if (!parsed.ok) return parsed;
      const p = parsed.value;

      // 1) 骰子（可选）：先落 dice 事件，judgement 以其 id 归因随机性来源
      let diceEventId: string | null = null;
      let diceTotal: number | null = null;
      if (p.dice_expression) {
        const roll = rollExpression(p.dice_expression, rng);
        if (!roll) return { ok: false, error: 'COMPONENT_FAILED' }; // 非法骰式 = 配置错误
        const modifier = roll.modifier + (p.modifier ?? 0);
        diceTotal = roll.rolls.reduce((a, b) => a + b, 0) + modifier;
        const d = await emit(ctx, 'dice', {
          expression: p.dice_expression,
          rolls: roll.rolls,
          modifier,
          total: diceTotal,
          purpose: p.subject,
        });
        if (!d.ok) return d;
        diceEventId = (d.value as { id: string }).id;
      }

      // 2) Referee 叙事裁决（D17：校验失败重试并落 judge_retry，达上限升级导演）
      const maxRetries = p.max_retries ?? 2;
      const ask =
        `你是裁判。裁决以下行动并只回复 JSON。\n行动：${p.subject}\n` +
        (diceTotal === null ? '本次判定无骰。\n' : `检定骰点：${diceTotal}。\n`) +
        `档级集合：${p.grades.join(' / ')}\n` +
        '回复格式：{"grade":"<档级之一>","rationale":"<数值依据>","updates":[{"key":"<黑板键>","value":<新值>,"reason":"<数值依据>"}]}\n' +
        '无状态变更时 updates 为空数组；状态变动必须给出数值依据。';
      let verdict: Verdict | null = null;
      for (let attempt = 0; attempt <= maxRetries && !verdict; attempt++) {
        if (ctx.signal.aborted) return { ok: false, error: 'ABORTED' };
        if (attempt > 0) {
          const jr = await emit(ctx, 'judge_retry', { attempt, max_attempts: maxRetries, error: 'SCHEMA_MISMATCH' });
          if (!jr.ok) return jr;
        }
        const intent = attempt === 0 ? ask : `${ask}\n（上次输出未通过校验：只回复规定 JSON，grade 必须属于档级集合）`;
        const r = await callMeta(ctx, 'call_agent', { agent_id: p.referee_agent_id, intent });
        if (!r.ok) return r;
        const outcome = r.value as TurnOutcome;
        if (outcome.kind === 'error') return { ok: false, error: 'COMPONENT_FAILED' };
        if (outcome.kind === 'final') verdict = parseVerdict(outcome.text, p.grades);
      }
      if (!verdict) return { ok: false, error: 'COMPONENT_FAILED' }; // 达上限：节点失败 → onError → 导演裁决（D17）

      // 3) judgement 事件（D31：档级 + 修正明细 + 数值依据）
      const modifiers = p.modifier ? [{ label: '检定修正', value: p.modifier }] : [];
      const j = await emit(ctx, 'judgement', {
        subject: p.subject,
        grade: verdict.grade,
        modifiers,
        dice_event_id: diceEventId,
        rationale: verdict.rationale,
      });
      if (!j.ok) return j;

      // 4) Archivist 状态更新（最小版：本组件顺序应用；数值依据 D31）
      for (const u of verdict.updates ?? []) {
        const s = await callMeta(ctx, 'bb_set', { key: u.key, value: u.value, reason: u.reason ?? verdict.rationale });
        if (!s.ok) return s;
      }
      return { ok: true, value: undefined };
    },
  };
}
