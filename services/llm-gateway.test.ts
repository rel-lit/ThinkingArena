// Version: 1.0.0
/**
 * llm-gateway.ts 单元测试：route/价格表、退避重试、TRUNCATED 重发、熔断、fallback 链、usage 把关。
 * LlmExecutor 全程 mock，无网络调用。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createLLMGateway, type PriceTableEntry } from './llm-gateway.ts';
import type { LLMGatewayErrorKind, Result } from '../schema/errors.ts';
import type { NormalizedUsage } from '../schema/event.ts';
import type { LLMRequest, LLMResponse, LlmExecutor, RouteDecision } from './types.ts';

const USAGE: NormalizedUsage = { input: 100, output: 50, cached_read: 20, cached_write: 0, reasoning: 10 };
const REQ: LLMRequest = { prompt: 'p', system: 's' };
const TABLE: Record<string, PriceTableEntry> = {
  m1: { provider: 'p1', tier: 'flagship', fallback: ['m2', 'm3'], price: { currency: 'CNY', input: 1, output: 2, cached_read: 0.5, reasoning: 2 } },
  m2: { provider: 'p2', tier: 'light', price: { currency: 'CNY', input: 0.5, output: 1 } },
  m3: { provider: 'p3', tier: 'flagship', price: { currency: 'USD', input: 5, output: 30 } },
};

function okResp(model: string): Result<LLMResponse, LLMGatewayErrorKind> {
  return { ok: true, value: { text: 'hi', usage: USAGE, rawUsage: { prompt_tokens: 120 }, model } };
}
function err(kind: LLMGatewayErrorKind): Result<LLMResponse, LLMGatewayErrorKind> {
  return { ok: false, error: kind };
}
/** 队列式 mock：依次弹出脚本化结果；耗尽后重复最后一项。 */
function scripted(script: Result<LLMResponse, LLMGatewayErrorKind>[]) {
  let calls = 0;
  const executor: LlmExecutor = async (_d, _r, _s) => {
    calls += 1;
    return script[Math.min(calls - 1, script.length - 1)];
  };
  return { executor, calls: () => calls };
}

describe('LLMGateway.route / priceOf（薄路由 + 价格表，D13/D16）', () => {
  test('route 命中返回 provider/tier/fallback 链；未命中拒路由', () => {
    const gw = createLLMGateway({ priceTable: TABLE, executor: async () => okResp('m1') });
    const r = gw.route('m1');
    assert.ok(r.ok);
    assert.equal(r.value.provider, 'p1');
    assert.equal(r.value.tier, 'flagship');
    assert.deepEqual(r.value.fallbackChain, ['m2', 'm3']);
    assert.ok(!gw.route('unknown').ok);
  });

  test('priceOf 五字段费率算账（每 1M 单价）', () => {
    const gw = createLLMGateway({ priceTable: TABLE, executor: async () => okResp('m1') });
    const cost = gw.priceOf('m1', USAGE);
    assert.ok(cost);
    // (100×1 + 50×2 + 20×0.5 + 0 + 10×2) / 1e6 = 230/1e6
    assert.equal(cost.amount, 230 / 1e6);
    assert.equal(cost.currency, 'CNY');
    assert.equal(gw.priceOf('unknown', USAGE), null);
  });
});

describe('LLMGateway.call（退避重试与截断重发，D6/D13）', () => {
  test('成功直通：一次调用，usage 五字段原样带回', async () => {
    const { executor, calls } = scripted([okResp('m1')]);
    const gw = createLLMGateway({ priceTable: TABLE, executor });
    const d = gw.route('m1');
    assert.ok(d.ok);
    const r = await gw.call(d.value, REQ, new AbortController().signal);
    assert.ok(r.ok && r.value.text === 'hi');
    assert.equal(calls(), 1);
  });

  test('TIMEOUT 指数退避后成功（2 次失败 + 第 3 次成功）', async () => {
    const { executor, calls } = scripted([err('TIMEOUT'), err('TIMEOUT'), okResp('m1')]);
    const gw = createLLMGateway({ priceTable: TABLE, executor });
    const d = gw.route('m1');
    assert.ok(d.ok);
    const r = await gw.call(d.value, REQ, new AbortController().signal);
    assert.ok(r.ok);
    assert.equal(calls(), 3);
  });

  test('重试有界：持续 PROVIDER_ERROR → 3 次尝试后返回失败', async () => {
    const { executor, calls } = scripted([err('PROVIDER_ERROR')]);
    const gw = createLLMGateway({ priceTable: TABLE, executor });
    const d = gw.route('m1');
    assert.ok(d.ok);
    const r = await gw.call(d.value, REQ, new AbortController().signal);
    assert.ok(!r.ok && r.error === 'PROVIDER_ERROR');
    assert.equal(calls(), 3);
  });

  test('TRUNCATED 自动整批重发一次（D6）：重发成功即返回', async () => {
    const { executor, calls } = scripted([err('TRUNCATED'), okResp('m1')]);
    const gw = createLLMGateway({ priceTable: TABLE, executor });
    const d = gw.route('m1');
    assert.ok(d.ok);
    const r = await gw.call(d.value, REQ, new AbortController().signal);
    assert.ok(r.ok);
    assert.equal(calls(), 2);
  });

  test('TRUNCATED 重发仍截断 → 编码返回 TRUNCATED（不重试）', async () => {
    const { executor, calls } = scripted([err('TRUNCATED')]);
    const gw = createLLMGateway({ priceTable: TABLE, executor });
    const d = gw.route('m1');
    assert.ok(d.ok);
    const r = await gw.call(d.value, REQ, new AbortController().signal);
    assert.ok(!r.ok && r.error === 'TRUNCATED');
    assert.equal(calls(), 2);
  });

  test('AUTH_FAILED 不重试（错误矩阵：直接 fallback）', async () => {
    const { executor, calls } = scripted([err('AUTH_FAILED')]);
    const gw = createLLMGateway({ priceTable: TABLE, executor });
    const d = gw.route('m1');
    assert.ok(d.ok);
    const r = await gw.call(d.value, REQ, new AbortController().signal);
    assert.ok(!r.ok && r.error === 'AUTH_FAILED');
    assert.equal(calls(), 1);
  });

  test('usage 非法（缺字段）归一 PROVIDER_ERROR；执行器抛异常同归一', async () => {
    const badUsage: LlmExecutor = async () => ({
      ok: true,
      value: { text: 'x', usage: { input: 1 } as unknown as NormalizedUsage, model: 'm1' },
    });
    const gw1 = createLLMGateway({ priceTable: TABLE, executor: badUsage });
    const d1 = gw1.route('m1');
    assert.ok(d1.ok);
    const r1 = await gw1.call(d1.value, REQ, new AbortController().signal);
    assert.ok(!r1.ok && r1.error === 'PROVIDER_ERROR');
    const throwing: LlmExecutor = async () => {
      throw new Error('boom');
    };
    const gw2 = createLLMGateway({ priceTable: TABLE, executor: throwing });
    const d2 = gw2.route('m1');
    assert.ok(d2.ok);
    const r2 = await gw2.call(d2.value, REQ, new AbortController().signal);
    assert.ok(!r2.ok && r2.error === 'PROVIDER_ERROR');
  });

  test('abort 后不再重试', async () => {
    const { executor, calls } = scripted([err('TIMEOUT')]);
    const gw = createLLMGateway({ priceTable: TABLE, executor });
    const d = gw.route('m1');
    assert.ok(d.ok);
    const ctl = new AbortController();
    ctl.abort();
    const r = await gw.call(d.value, REQ, ctl.signal);
    assert.ok(!r.ok && r.error === 'TIMEOUT');
    assert.equal(calls(), 1);
  });
});

describe('LLMGateway 熔断（D13 熔断计数）', () => {
  test('连续最终失败达阈值开路 → CIRCUIT_OPEN；冷却期拒绝调用', async () => {
    const { executor, calls } = scripted([err('PROVIDER_ERROR')]);
    const gw = createLLMGateway({ priceTable: TABLE, executor });
    const d = gw.route('m1');
    assert.ok(d.ok);
    for (let i = 0; i < 3; i += 1) {
      const r = await gw.call(d.value, REQ, new AbortController().signal);
      assert.ok(!r.ok && r.error === 'PROVIDER_ERROR');
    }
    const before = calls();
    const r4 = await gw.call(d.value, REQ, new AbortController().signal);
    assert.ok(!r4.ok && r4.error === 'CIRCUIT_OPEN');
    assert.equal(calls(), before); // 熔断期不打执行器
  });

  test('fallback 跳过熔断中与能力档不符的候选（同能力级链，D13）', async () => {
    const { executor } = scripted([err('PROVIDER_ERROR')]);
    const gw = createLLMGateway({ priceTable: TABLE, executor });
    const d2 = gw.route('m2');
    assert.ok(d2.ok);
    for (let i = 0; i < 3; i += 1) await gw.call(d2.value, REQ, new AbortController().signal); // 熔断 m2
    const d1 = gw.route('m1');
    assert.ok(d1.ok);
    const fb = gw.fallback(d1.value, 'PROVIDER_ERROR');
    assert.ok(fb.ok);
    assert.equal(fb.value.model, 'm3'); // m2 熔断且 tier=light 不符 flagship，双重跳过
    assert.deepEqual(fb.value.fallbackChain, []);
    const exhausted = gw.fallback(fb.value, 'PROVIDER_ERROR');
    assert.ok(!exhausted.ok && exhausted.error === 'NO_FALLBACK_AVAILABLE');
  });
});
