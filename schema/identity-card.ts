// Version: 1.0.0
/**
 * 身份牌契约（identity_card_v1，MVP 简化版）：只定义「角色是谁」，与 LLM 配置零耦合。
 *
 * 字段集裁决（任务书阶段 2 v2）：以 used-reference/design/overview.md §7.5 为基础精简——
 * 保留 version/name/description/personality/scenario（isekai Build 卡需要 scenario 场景设定）；
 * 不实现 firstMes/mesExample/creatorNotes/Tavern v2 导入/World Info/L0–L9 渲染器（留后续版本）。
 *
 * 身份与 LLM 解耦是机械保证（AGENTS.md 安全边界、overview §7.5）：
 * 卡内禁止出现模型字段。本契约以两道互备的机制落地——
 * 1. 运行时守卫 checkIdentityCardModelFields()：在解析前对原始数据递归扫描，给出精确的违规字段路径
 *    （主机制；不用 refine，保证 JSON Schema 导出无损）；
 * 2. strictObject：解析期拒绝一切未声明字段（兜底网）。
 * LLM 绑定在 Bundle 的 game.yaml 中定义「用什么模型扮演这个角色」（bundle.ts ModelBinding）。
 */
import { z } from 'zod';

/** identity_card_v1 Schema。 */
export const IdentityCardV1Schema = z
  .strictObject({
    version: z.literal('1.0').describe('身份牌契约版本（identity_card_v1；四份契约各自独立版本化，overview §7.6）'),
    name: z.string().min(1).describe('角色名（agent_created 事件 card_name 的来源；L2 静态前缀的身份锚点，附录 A）'),
    description: z.string().min(1).describe('角色核心描述（L2 身份牌核心之 Description，overview §7.5；isekai Build 卡的本/硕/博院校专业+课题写在这里）'),
    personality: z.string().min(1).optional().describe('性格特征（L2 之 Personality，可选，overview §7.5）'),
    scenario: z.string().min(1).optional().describe('场景设定（L2 之 Scenario，可选；v2 裁决保留——isekai Build 卡需要初始处境设定）'),
  })
  .describe(
    'identity_card_v1（MVP 字段集，任务书阶段 2 v2 裁决）；卡内禁止出现模型字段——' +
      '加载期须先经 checkIdentityCardModelFields 守卫，再经本 Schema 解析',
  );
export type IdentityCardV1 = z.infer<typeof IdentityCardV1Schema>;

/**
 * 模型字段禁词表（归一化后精确匹配：小写、去除 _ 与 -）。
 * 覆盖 model/apiKey/baseUrl 及其常见变体；身份与 LLM 解耦的机械保证（AGENTS.md 安全边界）。
 */
export const FORBIDDEN_MODEL_FIELDS: readonly string[] = [
  'model',
  'models',
  'apikey',
  'baseurl',
  'provider',
  'llm',
  'endpoint',
  'temperature',
  'maxtokens',
  'topp',
] as const;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '');
}

/**
 * 运行时守卫：递归扫描原始数据（解析前的 YAML/JSON 对象），返回违规模型字段的路径列表。
 * 空数组 = 通过。这是「校验器拒绝卡内出现模型字段」的主机制（独立函数，非 refine）。
 */
export function findForbiddenModelFields(raw: unknown, path = ''): string[] {
  if (Array.isArray(raw)) {
    return raw.flatMap((item, i) => findForbiddenModelFields(item, `${path}[${i}]`));
  }
  if (raw !== null && typeof raw === 'object') {
    const hits: string[] = [];
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const fieldPath = path ? `${path}.${key}` : key;
      if (FORBIDDEN_MODEL_FIELDS.includes(normalizeKey(key))) {
        hits.push(fieldPath);
      }
      hits.push(...findForbiddenModelFields(value, fieldPath));
    }
    return hits;
  }
  return [];
}

/**
 * 守卫断言形态（D5 风格 Result）：加载身份牌时先过本守卫，违规即拒绝加载（BUNDLE_INVALID，D20）。
 */
export function checkIdentityCardModelFields(raw: unknown): { ok: true } | { ok: false; fields: string[] } {
  const fields = findForbiddenModelFields(raw);
  return fields.length === 0 ? { ok: true } : { ok: false, fields };
}
