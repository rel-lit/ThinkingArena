// Version: 1.0.0
/**
 * errors.ts 契约测试：七组枚举正反向 + 汇总并集 + D13 可重试判定表 + JSON Schema 导出。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  AGENT_SERVICE_ERROR_KINDS,
  AgentServiceErrorKindSchema,
  BLACKBOARD_ERROR_KINDS,
  BlackboardErrorKindSchema,
  COMPONENT_ERROR_KINDS,
  ComponentErrorKindSchema,
  EVENT_LOG_ERROR_KINDS,
  ErrorCodeSchema,
  EventLogErrorKindSchema,
  FLOW_RUNNER_ERROR_KINDS,
  FlowRunnerErrorKindSchema,
  LLM_GATEWAY_ERROR_KINDS,
  LLM_GATEWAY_RETRYABLE,
  LLMGatewayErrorKindSchema,
  MEMORY_ERROR_KINDS,
  MemoryErrorKindSchema,
} from './errors.ts';

const GROUPS = [
  ['AgentService', AGENT_SERVICE_ERROR_KINDS, AgentServiceErrorKindSchema],
  ['Blackboard', BLACKBOARD_ERROR_KINDS, BlackboardErrorKindSchema],
  ['EventLog', EVENT_LOG_ERROR_KINDS, EventLogErrorKindSchema],
  ['LLMGateway', LLM_GATEWAY_ERROR_KINDS, LLMGatewayErrorKindSchema],
  ['FlowRunner', FLOW_RUNNER_ERROR_KINDS, FlowRunnerErrorKindSchema],
  ['Memory', MEMORY_ERROR_KINDS, MemoryErrorKindSchema],
  ['Component', COMPONENT_ERROR_KINDS, ComponentErrorKindSchema],
];

describe('七组错误枚举（§4/§4.6/§4.7）', () => {
  for (const [name, kinds, schema] of GROUPS) {
    test(`${name}：组内全部取值通过（${kinds.length} 个）`, () => {
      for (const k of kinds) assert.ok(schema.safeParse(k).success, `${k} 应通过`);
    });
    test(`${name}：集合外取值拒绝`, () => {
      assert.ok(!schema.safeParse('NOT_A_REAL_ERROR').success);
      assert.ok(!schema.safeParse('').success);
      assert.ok(!schema.safeParse(42).success);
    });
  }

  test('跨组共享值仅 PERSIST_FAILED 一处（§4.2 黑板与 §4.6 记忆同名，架构原文如此；ErrorCode 并集自然去重，事件经 type/exec 归因模块）', () => {
    const all = GROUPS.flatMap(([, kinds]) => kinds);
    const seen = new Set();
    const shared = all.filter((k) => (seen.has(k) ? true : (seen.add(k), false)));
    assert.deepEqual([...new Set(shared)], ['PERSIST_FAILED']);
  });

  test('与架构文档对齐的枚举基数（§4 六组 + §4.7 一组）', () => {
    assert.equal(AGENT_SERVICE_ERROR_KINDS.length, 6);
    assert.equal(BLACKBOARD_ERROR_KINDS.length, 2);
    assert.equal(EVENT_LOG_ERROR_KINDS.length, 5);
    assert.equal(LLM_GATEWAY_ERROR_KINDS.length, 9);
    assert.equal(FLOW_RUNNER_ERROR_KINDS.length, 6);
    assert.equal(MEMORY_ERROR_KINDS.length, 3);
    assert.equal(COMPONENT_ERROR_KINDS.length, 3);
  });
});

describe('ErrorCode 汇总并集', () => {
  test('并集接受全部 34 个枚举值', () => {
    const all = GROUPS.flatMap(([, kinds]) => kinds);
    assert.equal(all.length, 34);
    for (const k of all) assert.ok(ErrorCodeSchema.safeParse(k).success, `${k} 应被并集接受`);
  });

  test('并集拒绝未知值', () => {
    assert.ok(!ErrorCodeSchema.safeParse('UNKNOWN_FAILURE').success);
  });
});

describe('D13 可重试类型判定表', () => {
  test('判定表键集与 LLMGateway 枚举一一对应', () => {
    assert.deepEqual(Object.keys(LLM_GATEWAY_RETRYABLE).sort(), [...LLM_GATEWAY_ERROR_KINDS].sort());
  });

  test('重试语义与错误矩阵一致：超时/限流/5xx 可重试，其余不重试', () => {
    assert.equal(LLM_GATEWAY_RETRYABLE.TIMEOUT, true);
    assert.equal(LLM_GATEWAY_RETRYABLE.RATE_LIMITED, true);
    assert.equal(LLM_GATEWAY_RETRYABLE.PROVIDER_ERROR, true);
    assert.equal(LLM_GATEWAY_RETRYABLE.AUTH_FAILED, false);
    assert.equal(LLM_GATEWAY_RETRYABLE.QUOTA_EXCEEDED, false);
    assert.equal(LLM_GATEWAY_RETRYABLE.TRUNCATED, false);
    assert.equal(LLM_GATEWAY_RETRYABLE.SCHEMA_MISMATCH, false);
    assert.equal(LLM_GATEWAY_RETRYABLE.CIRCUIT_OPEN, false);
    assert.equal(LLM_GATEWAY_RETRYABLE.NO_FALLBACK_AVAILABLE, false);
  });
});

describe('JSON Schema 导出与 round-trip', () => {
  test('全部枚举 Schema 可导出', () => {
    for (const [, , schema] of GROUPS) assert.ok(JSON.stringify(z.toJSONSchema(schema)).length > 10);
    assert.ok(JSON.stringify(z.toJSONSchema(ErrorCodeSchema)).length > 10);
  });

  test('round-trip：枚举值经 JSON 序列化后再校验相等', () => {
    const parsed = ErrorCodeSchema.parse('JOIN_TIMEOUT');
    assert.deepEqual(ErrorCodeSchema.parse(JSON.parse(JSON.stringify(parsed))), parsed);
  });
});
