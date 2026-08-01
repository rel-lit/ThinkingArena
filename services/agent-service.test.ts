// Version: 1.0.0
/**
 * agent-service.ts 单元测试：实例表与 §3.1 状态机、双队列消费、runTurn 单次往返、
 * 服务事实自动落盘（D35）、fallback 链、abort、恢复路径。LlmExecutor 全程 mock，无网络调用。
 * 事件面断言直接读真实 EventLog 的临时 JSONL 文件。
 */
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentService, type AgentServiceEx } from './agent-service.ts';
import { createBlackboard } from './blackboard.ts';
import { createEventLog } from './event-log.ts';
import { createLLMGateway } from './llm-gateway.ts';
import { createMemoryService } from './memory.ts';
import type { LLMGatewayErrorKind, Result } from '../schema/errors.ts';
import type { DirectorDirective, Event, NormalizedUsage } from '../schema/event.ts';
import type { IdentityCardV1 } from '../schema/identity-card.ts';
import type { LLMResponse, LlmExecutor } from './types.ts';

const RUN = '0192c9e4-7a1b-7c3d-8e4f-a5b6c7d8e9f0';
const EXEC = { node_id: 'create_node', iteration: 0 };
const USAGE: NormalizedUsage = { input: 100, output: 50, cached_read: 0, cached_write: 0, reasoning: 0 };
const CARD: IdentityCardV1 = {
  version: '1.0',
  name: '勇者',
  description: '灰烬荒原的幸存者。',
  personality: '谨慎而固执。',
  scenario: '醒于荒废驿站。',
};
const TABLE = {
  m1: { provider: 'p1', tier: 'flagship', fallback: ['m2'], price: { currency: 'CNY', input: 1, output: 2 } },
  m2: { provider: 'p2', tier: 'flagship', price: { currency: 'CNY', input: 1, output: 1 } },
};

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function okText(model: string, text = '你好，荒原。'): Result<LLMResponse, LLMGatewayErrorKind> {
  return { ok: true, value: { text, usage: USAGE, rawUsage: { prompt_tokens: 100 }, model } };
}

interface Harness {
  svc: AgentServiceEx;
  scriptPath: string;
  events: () => Event[];
  memDir: string;
}

/** 装配一局的最小服务集（组合根角色）：真实 EventLog/Blackboard/Memory/Gateway + mock 执行器。 */
function setup(executor: LlmExecutor): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'ta-agentsvc-'));
  tmpDirs.push(dir);
  const scriptPath = join(dir, 'script.jsonl');
  const eventLog = createEventLog({ filePath: scriptPath });
  // run 上下文：FlowRunner 的 run_started 先行（R1）；测试以一条 system 条目盖章 run_id
  eventLog.append({
    ts: new Date().toISOString(),
    run_id: RUN,
    branch: 'main',
    exec: null,
    type: 'system',
    payload: { code: 'boot', message: 'boot', severity: 'info' },
  } as never);
  const blackboard = createBlackboard({ eventLog });
  blackboard.bindExec(EXEC);
  const memory = createMemoryService({ dir: join(dir, 'memory') });
  const gateway = createLLMGateway({ priceTable: TABLE, executor });
  const svc = createAgentService({ gateway, memory, blackboard, eventLog });
  svc.bindExec(EXEC);
  const events = () =>
    readFileSync(scriptPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Event);
  return { svc, scriptPath, events, memDir: join(dir, 'memory') };
}

function createHero(svc: AgentServiceEx, id = 'hero') {
  return svc.create({ id, identityCard: CARD, modelBinding: { model: 'm1' } });
}

describe('AgentService.create / destroy（实例表与守卫）', () => {
  test('create 落 agent_created；重复 create → AGENT_ALREADY_EXISTS；身份牌含模型字段 → 抛', () => {
    const { svc, events } = setup(async () => okText('m1'));
    assert.ok(createHero(svc).ok);
    const created = events().filter((e) => e.type === 'agent_created');
    assert.equal(created.length, 1);
    if (created[0].type === 'agent_created') {
      assert.equal(created[0].payload.card_name, '勇者');
      assert.equal(created[0].payload.model, 'm1');
    }
    const dup = createHero(svc);
    assert.ok(!dup.ok && dup.error === 'AGENT_ALREADY_EXISTS');
    assert.throws(() =>
      svc.create({ id: 'evil', identityCard: { ...CARD, model: 'gpt' } as never, modelBinding: { model: 'm1' } }),
    );
  });

  test('destroy 落 agent_destroyed；销毁后操作 → AGENT_DESTROYED；未知 → AGENT_NOT_FOUND', () => {
    const { svc, events } = setup(async () => okText('m1'));
    assert.ok(!svc.destroy('ghost').ok);
    createHero(svc);
    assert.ok(svc.destroy('hero').ok);
    assert.equal(events().filter((e) => e.type === 'agent_destroyed').length, 1);
    const r = svc.steer('hero', { kind: 'whisper', text: 'x', targets: ['hero'], mode: 'steering' });
    assert.ok(!r.ok && r.error === 'AGENT_DESTROYED');
    assert.ok(!svc.destroy('hero').ok);
  });
});

describe('AgentService.runTurn（单次往返 + 服务事实，D35/D16）', () => {
  test('final 结局：turn_start/prompt_hash/cost/turn_end 依序落盘，记忆沉淀（F17）', async () => {
    const { svc, events } = setup(async () => okText('m1'));
    createHero(svc);
    const r = await svc.runTurn('hero', { intent: '生成开场呈现' }, new AbortController().signal);
    assert.ok(r.ok && r.value.kind === 'final');
    if (r.value.kind === 'final') assert.equal(r.value.text, '你好，荒原。');
    const types = events().map((e) => e.type);
    assert.deepEqual(
      types.filter((t) => ['turn_start', 'prompt_hash', 'cost', 'turn_end'].includes(t)),
      ['turn_start', 'prompt_hash', 'cost', 'turn_end'],
    );
    const cost = events().find((e) => e.type === 'cost');
    if (cost?.type === 'cost') {
      assert.equal(cost.payload.model, 'm1');
      assert.equal(cost.payload.requested_model, 'm1');
      assert.equal(cost.payload.cost.currency, 'CNY');
      assert.ok(cost.payload.cost.amount > 0); // 价格表算账非零
      assert.deepEqual(cost.payload.usage, USAGE);
    }
    const te = events().find((e) => e.type === 'turn_end');
    if (te?.type === 'turn_end') assert.equal(te.payload.outcome, 'final');
    const ph = events().find((e) => e.type === 'prompt_hash');
    if (ph?.type === 'prompt_hash') assert.match(ph.payload.prefix_sha256, /^[0-9a-f]{64}$/);
    // 次回合：turn_start 再落且 first_turn=false
    const r2 = await svc.runTurn('hero', { intent: '继续' }, new AbortController().signal);
    assert.ok(r2.ok);
    const starts = events().filter((e) => e.type === 'turn_start');
    assert.equal(starts.length, 2);
    if (starts[1].type === 'turn_start') assert.equal(starts[1].payload.first_turn, false);
  });

  test('tool_calls 停留 RUNNING：同一回合两次往返只落一次 turn_start', async () => {
    const executor: LlmExecutor = async (_d, req) => {
      if (!req.prompt.includes('工具结果')) {
        return {
          ok: true,
          value: {
            text: '',
            object: { tool_calls: [{ call_id: 'c1', name: 'bb_get', arguments: { key: 'protagonist.hp' } }] },
            usage: USAGE,
            model: 'm1',
          },
        };
      }
      return okText('m1', '我的 HP 是 100。');
    };
    const { svc, events } = setup(executor);
    createHero(svc);
    const r1 = await svc.runTurn('hero', { intent: '查状态' }, new AbortController().signal);
    assert.ok(r1.ok && r1.value.kind === 'tool_calls');
    const r2 = await svc.runTurn(
      'hero',
      { intent: '查状态', toolResults: [{ call: { call_id: 'c1', name: 'bb_get', arguments: {} }, result: 100 }] },
      new AbortController().signal,
    );
    assert.ok(r2.ok && r2.value.kind === 'final');
    assert.equal(events().filter((e) => e.type === 'turn_start').length, 1);
    assert.equal(events().filter((e) => e.type === 'turn_end').length, 1);
    assert.equal(events().filter((e) => e.type === 'cost').length, 2); // 每次 LLM 调用各落一条
  });

  test('并发 runTurn → AGENT_BUSY（pi 状态保护）', async () => {
    let release: (v: Result<LLMResponse, LLMGatewayErrorKind>) => void = () => {};
    const executor: LlmExecutor = () => new Promise((res) => { release = res; });
    const { svc } = setup(executor);
    createHero(svc);
    const p1 = svc.runTurn('hero', { intent: 'x' }, new AbortController().signal);
    const r2 = await svc.runTurn('hero', { intent: 'y' }, new AbortController().signal);
    assert.ok(!r2.ok && r2.error === 'AGENT_BUSY');
    release(okText('m1'));
    assert.ok((await p1).ok);
  });

  test('steering 注入下一往返的 prompt（D4 双队列；whisper 绝不进 system 静态前缀）', async () => {
    const seen: string[] = [];
    let capturedSystem = '';
    const executor: LlmExecutor = async (_d, req) => {
      seen.push(req.prompt);
      capturedSystem = req.system ?? '';
      return okText('m1');
    };
    const { svc } = setup(executor);
    createHero(svc);
    const directive: DirectorDirective = { kind: 'whisper', text: '你感到一阵寒意。', targets: ['hero'], mode: 'steering' };
    assert.ok(svc.steer('hero', directive).ok);
    await svc.runTurn('hero', { intent: '继续探索' }, new AbortController().signal);
    assert.match(seen[0], /你感到一阵寒意/);
    assert.doesNotMatch(capturedSystem, /寒意/); // 静态前缀只含身份牌
    assert.match(capturedSystem, /勇者/);
  });
});

describe('AgentService fallback 与失败关账（D13/A8）', () => {
  test('AUTH_FAILED 直接降级 m2：cost 按实际出账模型归因', async () => {
    const executor: LlmExecutor = async (d) => (d.model === 'm1' ? { ok: false, error: 'AUTH_FAILED' } : okText('m2', '备用模型的回答'));
    const { svc, events } = setup(executor);
    createHero(svc);
    const r = await svc.runTurn('hero', { intent: 'x' }, new AbortController().signal);
    assert.ok(r.ok && r.value.kind === 'final');
    if (r.value.kind === 'final') assert.equal(r.value.text, '备用模型的回答');
    const cost = events().find((e) => e.type === 'cost');
    if (cost?.type === 'cost') {
      assert.equal(cost.payload.model, 'm2');
      assert.equal(cost.payload.requested_model, 'm1');
    }
  });

  test('链耗尽 → TurnOutcome error + agent_error + 转 ERROR；recover 回 IDLE', async () => {
    const executor: LlmExecutor = async () => ({ ok: false, error: 'AUTH_FAILED' });
    const { svc, events } = setup(executor);
    createHero(svc);
    const r = await svc.runTurn('hero', { intent: 'x' }, new AbortController().signal);
    assert.ok(r.ok && r.value.kind === 'error');
    if (r.value.kind === 'error') assert.equal(r.value.error, 'NO_FALLBACK_AVAILABLE');
    assert.equal(events().filter((e) => e.type === 'agent_error').length, 1);
    const te = events().find((e) => e.type === 'turn_end');
    if (te?.type === 'turn_end') assert.equal(te.payload.outcome, 'failed');
    // ERROR 中拒绝新往返；recover 后恢复
    const busy = await svc.runTurn('hero', { intent: 'y' }, new AbortController().signal);
    assert.ok(!busy.ok && busy.error === 'AGENT_BUSY');
    assert.ok(svc.recover('hero', 'retry').ok);
    assert.equal(events().filter((e) => e.type === 'agent_recovered').length, 1);
  });

  test('TRUNCATED 不降级（D6 语义归内容侧），编码进 TurnOutcome', async () => {
    const executor: LlmExecutor = async () => ({ ok: false, error: 'TRUNCATED' });
    const { svc } = setup(executor);
    createHero(svc);
    const r = await svc.runTurn('hero', { intent: 'x' }, new AbortController().signal);
    assert.ok(r.ok && r.value.kind === 'error');
    if (r.value.kind === 'error') assert.equal(r.value.error, 'TRUNCATED');
  });
});

describe('AgentService.abort（AbortSignal 内部注册，R8 安全点）', () => {
  test('在飞往返被 abort → TURN_ABORTED + turn_end(aborted)；次回合可再开', async () => {
    let calls = 0;
    const executor: LlmExecutor = async (_d, _r, signal) => {
      calls += 1;
      if (calls > 1) return okText('m1', '重新开始的回答'); // 次回合立即成功
      return new Promise((res) => {
        if (signal.aborted) res({ ok: false, error: 'TIMEOUT' });
        signal.addEventListener('abort', () => res({ ok: false, error: 'TIMEOUT' }), { once: true });
      });
    };
    const { svc, events } = setup(executor);
    createHero(svc);
    const p = svc.runTurn('hero', { intent: 'x' }, new AbortController().signal);
    await new Promise((r) => setImmediate(r)); // 让在飞调用先注册 abort 监听
    assert.ok(svc.abort('hero').ok);
    const r = await p;
    assert.ok(!r.ok && r.error === 'TURN_ABORTED');
    const te = events().find((e) => e.type === 'turn_end');
    if (te?.type === 'turn_end') assert.equal(te.payload.outcome, 'aborted');
    const again = await svc.runTurn('hero', { intent: 'z' }, new AbortController().signal);
    assert.ok(again.ok && again.value.kind === 'final'); // abort 后实例回 IDLE，可再开回合
  });

  test('abort 已完成响应仍落 cost（D36 真实花费不作废）', async () => {
    const executor: LlmExecutor = async () => okText('m1');
    const { svc, events } = setup(executor);
    createHero(svc);
    const p = svc.runTurn('hero', { intent: 'x' }, new AbortController().signal);
    assert.ok(svc.abort('hero').ok); // 响应即刻成功，但 abort 标志已置
    const r = await p;
    assert.ok(!r.ok && r.error === 'TURN_ABORTED');
    assert.equal(events().filter((e) => e.type === 'cost').length, 1);
  });
});

describe('AgentService.applyEvent（恢复路径，§4 恢复纪律）', () => {
  test('按事件重建生命周期：已填实实例随事件转移状态；占位实例拒绝 runTurn', async () => {
    const { svc } = setup(async () => okText('m1'));
    createHero(svc);
    const base = { id: 'e0000010', parent_id: null, ts: new Date().toISOString(), run_id: RUN, branch: 'main', exec: EXEC };
    // agent_paused → PAUSED：runTurn 被拒（AGENT_BUSY 语义：须 resume）
    svc.applyEvent({ ...base, type: 'agent_paused', payload: { agent_id: 'hero' } } as Event);
    const paused = await svc.runTurn('hero', { intent: 'x' }, new AbortController().signal);
    assert.ok(!paused.ok && paused.error === 'AGENT_BUSY');
    // agent_resumed → RUNNING：可继续回合
    svc.applyEvent({ ...base, type: 'agent_resumed', payload: { agent_id: 'hero' } } as Event);
    const resumed = await svc.runTurn('hero', { intent: 'x' }, new AbortController().signal);
    assert.ok(resumed.ok);
    // agent_destroyed → DESTROYED：操作拒绝
    svc.applyEvent({ ...base, type: 'agent_destroyed', payload: { agent_id: 'hero' } } as Event);
    const g = svc.steer('hero', { kind: 'whisper', text: 'x', targets: ['hero'], mode: 'steering' });
    assert.ok(!g.ok && g.error === 'AGENT_DESTROYED');
    // 占位实例（replay 重建、spec 未填实）：拒绝 runTurn
    svc.applyEvent({ ...base, type: 'agent_created', payload: { agent_id: 'ghost', card_name: 'x', card_version: '1.0', model: 'm1', memory_ref: null } } as Event);
    const r = await svc.runTurn('ghost', { intent: 'x' }, new AbortController().signal);
    assert.ok(!r.ok && r.error === 'AGENT_NOT_FOUND');
  });
});
