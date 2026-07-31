// Version: 1.0.0
/**
 * identity-card.ts 契约测试：MVP 字段集正反向 + 拒模型字段运行时守卫 + fixtures Build 卡 + round-trip + JSON Schema 导出。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  FORBIDDEN_MODEL_FIELDS,
  IdentityCardV1Schema,
  checkIdentityCardModelFields,
  findForbiddenModelFields,
} from './identity-card.ts';

const FIXTURE_CARD = new URL('./fixtures/isekai/identity_cards/build-a.yaml', import.meta.url);

function minimalCard() {
  return { version: '1.0', name: 'Build A · 均衡生存流', description: '本/硕/博院校专业与课题……' };
}

describe('identity_card_v1 字段集（任务书 v2 裁决）', () => {
  test('正向：最小集与全集', () => {
    assert.ok(IdentityCardV1Schema.safeParse(minimalCard()).success);
    const full = { ...minimalCard(), personality: '冷静、复盘癖', scenario: '醒来时位于灰烬荒原边缘的岩棚' };
    assert.ok(IdentityCardV1Schema.safeParse(full).success);
  });

  test('反向：version 必须字面量 "1.0"；name/description 必填非空', () => {
    assert.ok(!IdentityCardV1Schema.safeParse({ ...minimalCard(), version: '2.0' }).success);
    assert.ok(!IdentityCardV1Schema.safeParse({ ...minimalCard(), version: 1 }).success);
    const { name, ...noName } = minimalCard();
    assert.ok(!IdentityCardV1Schema.safeParse(noName).success);
    assert.ok(!IdentityCardV1Schema.safeParse({ ...minimalCard(), description: '' }).success);
  });

  test('反向：strictObject 拒绝一切未声明字段（含模型字段的解析期兜底网）', () => {
    assert.ok(!IdentityCardV1Schema.safeParse({ ...minimalCard(), model: 'kimi-k3' }).success);
    assert.ok(!IdentityCardV1Schema.safeParse({ ...minimalCard(), firstMes: '你好' }).success, 'MVP 不含 firstMes（任务书 v2 裁剪）');
  });
});

describe('拒模型字段运行时守卫（AGENTS.md 安全边界；身份与 LLM 解耦的机械保证）', () => {
  test('干净卡通过（ok: true）', () => {
    assert.deepEqual(checkIdentityCardModelFields(minimalCard()), { ok: true });
  });

  test('顶层模型字段逐个命中并给出路径', () => {
    for (const field of ['model', 'apiKey', 'api_key', 'baseUrl', 'base_url', 'provider', 'llm', 'endpoint', 'temperature', 'max_tokens', 'top_p']) {
      const r = checkIdentityCardModelFields({ ...minimalCard(), [field]: 'x' });
      assert.equal(r.ok, false, `${field} 应被拒绝`);
      assert.deepEqual(r.fields, [field]);
    }
  });

  test('嵌套对象与数组内的模型字段同样命中（递归扫描）', () => {
    const dirty = {
      ...minimalCard(),
      extra: { nested: [{ model: 'kimi-k3' }] },
      profile: { llm_config: { baseURL: 'https://api.example.com' } },
    };
    const fields = findForbiddenModelFields(dirty);
    assert.ok(fields.includes('extra.nested[0].model'), JSON.stringify(fields));
    assert.ok(fields.some((f) => f.startsWith('profile')), '嵌套 llm_config 应命中');
  });

  test('禁词表归一化：大小写与连字符变体等价', () => {
    assert.deepEqual(findForbiddenModelFields({ ...minimalCard(), APIKEY: 'x' }), ['APIKEY']);
    assert.deepEqual(findForbiddenModelFields({ ...minimalCard(), 'base-url': 'x' }), ['base-url']);
    assert.ok(FORBIDDEN_MODEL_FIELDS.length >= 8);
  });

  test('守卫作用于解析前的原始数据（strip/strict 都无法洗白）', () => {
    const raw = { ...minimalCard(), model: 'kimi-k3' };
    assert.equal(checkIdentityCardModelFields(raw).ok, false, '先守卫：拒绝');
  });
});

describe('fixtures Build 卡与 round-trip', () => {
  test('fixtures/isekai/identity_cards/build-a.yaml：守卫 + 解析双通过', () => {
    const raw = JSON.parse(readFileSync(FIXTURE_CARD, 'utf8'));
    assert.deepEqual(checkIdentityCardModelFields(raw), { ok: true });
    const r = IdentityCardV1Schema.safeParse(raw);
    assert.ok(r.success, JSON.stringify(r.error?.issues));
    assert.equal(r.data.version, '1.0');
    assert.ok(r.data.scenario, 'isekai Build 卡需要 scenario（v2 裁决保留）');
  });

  test('round-trip：fixture 卡经 JSON 序列化后再校验深度相等', () => {
    const parsed = IdentityCardV1Schema.parse(JSON.parse(readFileSync(FIXTURE_CARD, 'utf8')));
    assert.deepEqual(IdentityCardV1Schema.parse(JSON.parse(JSON.stringify(parsed))), parsed);
  });

  test('JSON Schema 导出可用', () => {
    assert.ok(JSON.stringify(z.toJSONSchema(IdentityCardV1Schema)).length > 100);
  });
});
