// Version: 1.0.0
/**
 * 内置组件 dice：带种子骰子。mulberry32 PRNG；骰式 "NdM±K"（如 1d20+2）；
 * 骰点落 dice 事件（D31 骰运即素材；D33 种子参与版本身份，同版本 rerun 复现骰点序列）。
 *
 * 组件为工厂形态：rng 流由组件注册表（index.ts）按种子创建并在 dice/judge 间共享——
 * 组件本身无状态，骰流是注册表级资源，线性首局消耗序确定。
 */
import { z } from 'zod';
import type { Component } from '../schema/meta-component.ts';
import { emit, jsonSchemaOf, parseParams } from './util.ts';

/** mulberry32：32 位种子 → [0,1) 均匀序列。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface DiceRoll {
  rolls: number[];
  modifier: number;
  total: number;
}

/** 解析并投掷简单骰式 "NdM±K"；非法骰式返回 null。 */
export function rollExpression(expression: string, rng: () => number): DiceRoll | null {
  const m = /^(\d{1,3})d(\d{1,4})([+-]\d+)?$/.exec(expression.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const sides = Number(m[2]);
  if (n < 1 || sides < 1) return null;
  const rolls = Array.from({ length: n }, () => 1 + Math.floor(rng() * sides));
  const modifier = m[3] ? Number(m[3]) : 0;
  return { rolls, modifier, total: rolls.reduce((a, b) => a + b, 0) + modifier };
}

export const DiceParamsSchema = z
  .strictObject({
    expression: z.string().min(1).describe('骰式（如 "1d20+2"）'),
    purpose: z.string().optional().describe('检定目的（归因：这次骰点判什么）'),
    modifier: z.number().optional().describe('表达式外的附加修正（技能/物资等，并入 dice 事件 modifier）'),
  })
  .describe('dice 节点参数');

export function createDiceComponent(rng: () => number): Component {
  return {
    description: {
      name: 'dice',
      version: '1.0.0',
      description: '骰子：投掷带种子骰式并落 dice 事件（D31/D33）',
      parameters: jsonSchemaOf(DiceParamsSchema),
      inputs: ['in'],
      outputs: ['out'],
      writable_prefixes: [],
    },
    async run(params, ctx) {
      const p = parseParams(DiceParamsSchema, params);
      if (!p.ok) return p;
      const roll = rollExpression(p.value.expression, rng);
      if (!roll) return { ok: false, error: 'COMPONENT_FAILED' }; // 非法骰式 = 配置错误
      const modifier = roll.modifier + (p.value.modifier ?? 0);
      const s = await emit(ctx, 'dice', {
        expression: p.value.expression,
        rolls: roll.rolls,
        modifier,
        total: roll.rolls.reduce((a, b) => a + b, 0) + modifier,
        purpose: p.value.purpose,
      });
      return s.ok ? { ok: true, value: undefined } : s;
    },
  };
}
