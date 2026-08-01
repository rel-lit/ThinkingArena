// Version: 1.0.0
/**
 * ai-sdk-executor 纯函数单测：usage 归一化与错误映射（不碰网络）。
 * 假数据形态对照 deep-dive-llm-gateway 问题 1/5：DeepSeek（providerMetadata 缓存字段）、
 * Kimi（顶层 cached_tokens 经 SDK 转换进标准字段）；错误覆盖超时/HTTP 状态码/结构化失败。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APICallError, NoObjectGeneratedError } from 'ai';
import { NormalizedUsageSchema } from '../schema/event.ts';
import { mapSdkError, normalizeUsage } from './ai-sdk-executor.ts';

// ===== normalizeUsage =====

test('normalizeUsage：DeepSeek 形态——标准字段齐全（SDK 已转换）', () => {
  // DeepSeek 原始 prompt_tokens=hit+miss；SDK 转换后 noCache=miss、cacheRead=hit
  const usage = {
    inputTokens: 1000,
    inputTokenDetails: { noCacheTokens: 900, cacheReadTokens: 100, cacheWriteTokens: undefined },
    outputTokens: 200,
    outputTokenDetails: { textTokens: 200, reasoningTokens: 0 },
    totalTokens: 1200,
  };
  const n = normalizeUsage(usage, { deepseek: { promptCacheHitTokens: 100, promptCacheMissTokens: 900 } });
  assert.deepEqual(n, { input: 900, output: 200, cached_read: 100, cached_write: 0, reasoning: 0 });
  assert.ok(NormalizedUsageSchema.safeParse(n).success); // 过契约（网关把关同一校验）
});

test('normalizeUsage：DeepSeek 形态——标准缓存字段缺失时兜底 providerMetadata.deepseek', () => {
  // deep-dive 问题 5：DeepSeek 缓存指标在 providerMetadata.deepseek.promptCacheHitTokens
  const usage = {
    inputTokens: 1000,
    inputTokenDetails: { noCacheTokens: 900, cacheReadTokens: undefined, cacheWriteTokens: undefined },
    outputTokens: 200,
    outputTokenDetails: { textTokens: 200, reasoningTokens: 0 },
  };
  const n = normalizeUsage(usage, { deepseek: { promptCacheHitTokens: 100, promptCacheMissTokens: 900 } });
  assert.deepEqual(n, { input: 900, output: 200, cached_read: 100, cached_write: 0, reasoning: 0 });
});

test('normalizeUsage：Kimi 形态——cached_tokens 经 SDK 进 cacheReadTokens，无写费字段', () => {
  // Kimi 自动缓存：usage.cached_tokens（顶层）→ SDK cacheReadTokens；cached_write 恒 0
  const usage = {
    inputTokens: 800,
    inputTokenDetails: { noCacheTokens: 500, cacheReadTokens: 300, cacheWriteTokens: undefined },
    outputTokens: 150,
    outputTokenDetails: { textTokens: 150, reasoningTokens: 0 },
  };
  const n = normalizeUsage(usage, { moonshotai: {} });
  assert.deepEqual(n, { input: 500, output: 150, cached_read: 300, cached_write: 0, reasoning: 0 });
});

test('normalizeUsage：思考模型——reasoning 单列，output 仍为总输出', () => {
  const usage = {
    inputTokens: 100,
    inputTokenDetails: { noCacheTokens: 100, cacheReadTokens: 0, cacheWriteTokens: undefined },
    outputTokens: 500,
    outputTokenDetails: { textTokens: 200, reasoningTokens: 300 },
  };
  const n = normalizeUsage(usage, undefined);
  assert.deepEqual(n, { input: 100, output: 500, cached_read: 0, cached_write: 0, reasoning: 300 });
});

test('normalizeUsage：noCacheTokens 缺失时以 inputTokens − cached_read 兜底', () => {
  const usage = {
    inputTokens: 1000,
    inputTokenDetails: { cacheReadTokens: 400 },
    outputTokens: 100,
    outputTokenDetails: {},
  };
  const n = normalizeUsage(usage, undefined);
  assert.equal(n.input, 600);
});

test('normalizeUsage：空/非法 usage 一律归零且过契约', () => {
  for (const bad of [undefined, null, {}, { inputTokens: 'x' }, { inputTokens: -5 }]) {
    const n = normalizeUsage(bad, undefined);
    assert.deepEqual(n, { input: 0, output: 0, cached_read: 0, cached_write: 0, reasoning: 0 });
    assert.ok(NormalizedUsageSchema.safeParse(n).success);
  }
});

// ===== mapSdkError =====

test('mapSdkError：超时/中止 → TIMEOUT', () => {
  for (const name of ['TimeoutError', 'AbortError', 'ResponseAborted']) {
    const e = new Error('x');
    e.name = name;
    assert.equal(mapSdkError(e), 'TIMEOUT');
  }
});

test('mapSdkError：凭证缺失（AI_LoadAPIKeyError）→ AUTH_FAILED', () => {
  const e = new Error('API key is missing');
  e.name = 'AI_LoadAPIKeyError';
  assert.equal(mapSdkError(e), 'AUTH_FAILED');
});

function apiError(statusCode: number): APICallError {
  return new APICallError({
    message: `status ${statusCode}`,
    url: 'https://example.invalid/v1/chat/completions',
    requestBodyValues: {},
    statusCode,
  });
}

test('mapSdkError：APICallError 按 statusCode 分流', () => {
  assert.equal(mapSdkError(apiError(401)), 'AUTH_FAILED');
  assert.equal(mapSdkError(apiError(403)), 'AUTH_FAILED');
  assert.equal(mapSdkError(apiError(402)), 'QUOTA_EXCEEDED'); // DeepSeek Insufficient Balance
  assert.equal(mapSdkError(apiError(429)), 'RATE_LIMITED');
  assert.equal(mapSdkError(apiError(500)), 'PROVIDER_ERROR');
  assert.equal(mapSdkError(apiError(400)), 'PROVIDER_ERROR'); // 4xx 其余归一类（格式异常）
});

test('mapSdkError：NoObjectGeneratedError → SCHEMA_MISMATCH（D17 重试路径）', () => {
  const e = new NoObjectGeneratedError({ message: 'no object generated' });
  assert.equal(mapSdkError(e), 'SCHEMA_MISMATCH');
});

test('mapSdkError：未知异常 → PROVIDER_ERROR', () => {
  assert.equal(mapSdkError(new Error('boom')), 'PROVIDER_ERROR');
  assert.equal(mapSdkError('string error'), 'PROVIDER_ERROR');
  assert.equal(mapSdkError(undefined), 'PROVIDER_ERROR');
});
