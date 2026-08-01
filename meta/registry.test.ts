// Version: 1.0.0
/** registry.ts 测试：call() 管线（校验前置 → beforeCall → run → afterCall）与错误编码纪律（D5）。 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { MetaComponent } from '../schema/meta-component.ts';
import { createMetaRegistry } from './registry.ts';
import { makeCtx, mockAgentService, mockBlackboard, mockEventLog, mockMemory } from './testkit.ts';

function setup(extra?: MetaComponent[]) {
  const meta = createMetaRegistry({
    agentService: mockAgentService(),
    memory: mockMemory(),
    blackboard: mockBlackboard(),
    eventLog: mockEventLog(),
    extra,
  });
  return { meta, ctx: makeCtx(meta) };
}

describe('MetaRegistry.call 管线', () => {
  test('未注册名 → COMPONENT_FAILED（配置错误，不抛异常）', async () => {
    const { meta, ctx } = setup();
    const r = await meta.call('no_such_meta', {}, ctx);
    assert.deepEqual(r, { ok: false, error: 'COMPONENT_FAILED' });
  });

  test('参数校验前置：非法参数不执行 run → PARAM_SCHEMA_INVALID', async () => {
    let ran = false;
    const probe: MetaComponent = {
      name: 'probe', version: '1.0.0', description: '探针', parameters: z.strictObject({ x: z.number() }),
      async run() { ran = true; return { ok: true, value: 1 }; },
    };
    const { meta, ctx } = setup([probe]);
    const r = await meta.call('probe', { x: 'NaN' }, ctx);
    assert.deepEqual(r, { ok: false, error: 'PARAM_SCHEMA_INVALID' });
    assert.equal(ran, false);
  });

  test('管线顺序：校验 → beforeCall → run → afterCall；afterCall 可包装结果', async () => {
    const order: string[] = [];
    const probe: MetaComponent = {
      name: 'probe', version: '1.0.0', description: '探针', parameters: z.strictObject({ x: z.number() }),
      async beforeCall() { order.push('before'); },
      async run() { order.push('run'); return { ok: true, value: 1 }; },
      async afterCall(_a, result) { order.push('after'); return { ok: true, value: (result as number) + 1 }; },
    };
    const { meta, ctx } = setup([probe]);
    const r = await meta.call('probe', { x: 1 }, ctx);
    assert.deepEqual(order, ['before', 'run', 'after']);
    assert.deepEqual(r, { ok: true, value: 2 });
  });

  test('beforeCall 拦截：code 为合法枚举透传，缺省归一 COMPONENT_FAILED；run 不执行', async () => {
    let ran = false;
    const mk = (code?: string): MetaComponent => ({
      name: `probe_${code ?? 'none'}`, version: '1.0.0', description: '探针', parameters: z.strictObject({}),
      async beforeCall() { return { reason: '拦截', code }; },
      async run() { ran = true; return { ok: true, value: 1 }; },
    });
    const { meta, ctx } = setup([mk('AGENT_BUSY'), mk()]);
    assert.deepEqual(await meta.call('probe_AGENT_BUSY', {}, ctx), { ok: false, error: 'AGENT_BUSY' });
    assert.deepEqual(await meta.call('probe_none', {}, ctx), { ok: false, error: 'COMPONENT_FAILED' });
    assert.equal(ran, false);
  });

  test('run 失败编码直接返回（不触发 afterCall）；run 抛异常归一 COMPONENT_FAILED（D5 不裸抛）', async () => {
    let after = false;
    const failing: MetaComponent = {
      name: 'failing', version: '1.0.0', description: '探针', parameters: z.strictObject({}),
      async run() { return { ok: false, error: 'AGENT_NOT_FOUND' }; },
      async afterCall(_a, r) { after = true; return { ok: true, value: r }; },
    };
    const throwing: MetaComponent = {
      name: 'throwing', version: '1.0.0', description: '探针', parameters: z.strictObject({}),
      async run() { throw new Error('编程错误'); },
    };
    const { meta, ctx } = setup([failing, throwing]);
    assert.deepEqual(await meta.call('failing', {}, ctx), { ok: false, error: 'AGENT_NOT_FOUND' });
    assert.equal(after, false);
    assert.deepEqual(await meta.call('throwing', {}, ctx), { ok: false, error: 'COMPONENT_FAILED' });
  });
});
