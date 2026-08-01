// Version: 1.0.0
/**
 * blackboard.ts 单元测试：写穿顺序（先事件后生效）、落盘失败不生效、applyEvent 恢复、快照副本。
 * 正常路径用真实 EventLog（临时文件）；失败路径用 mock EventLog。无网络调用。
 */
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBlackboard } from './blackboard.ts';
import { createEventLog } from './event-log.ts';
import type { Event, EventDraft } from '../schema/event.ts';
import type { EventLog } from './types.ts';

const RUN = '0192c9e4-7a1b-7c3d-8e4f-a5b6c7d8e9f0';
const EXEC = { node_id: 'test_node', iteration: 0 };

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'ta-bb-'));
  tmpDirs.push(dir);
  const eventLog = createEventLog({ filePath: join(dir, 'script.jsonl') });
  // run 上下文：FlowRunner 的 run_started 先行（R1）；测试以一条 system 条目盖章 run_id
  eventLog.append({
    ts: new Date().toISOString(),
    run_id: RUN,
    branch: 'main',
    exec: null,
    type: 'system',
    payload: { code: 'boot', message: 'boot', severity: 'info' },
  } as EventDraft);
  const bb = createBlackboard({ eventLog });
  bb.bindExec(EXEC);
  return { eventLog, bb, dir };
}

function bbSetEvent(key: string, value: unknown): Event {
  return {
    id: 'e0000099',
    parent_id: null,
    ts: new Date().toISOString(),
    run_id: RUN,
    branch: 'main',
    exec: EXEC,
    type: 'bb_set',
    payload: { key, value },
  } as Event;
}

describe('Blackboard.set（D1 写穿：先落盘、后生效）', () => {
  test('写穿成功：bb_set 事件落盘，键值随后可读', () => {
    const { bb, dir } = setup();
    const r = bb.set('protagonist.hp', 100);
    assert.ok(r.ok);
    assert.equal(bb.get('protagonist.hp'), 100);
    const lines = readFileSync(join(dir, 'script.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    const evt = JSON.parse(lines[1]);
    assert.equal(evt.type, 'bb_set');
    assert.deepEqual(evt.exec, EXEC);
    assert.equal(evt.payload.key, 'protagonist.hp');
  });

  test('落盘失败写入不生效（PERSIST_FAILED，D1 安全方向）', () => {
    const failing = {
      currentRunId: () => RUN,
      currentBranch: () => 'main',
      append: () => ({ ok: false as const, error: 'APPEND_FAILED' as const }),
      replay: async () => ({ ok: false as const, error: 'REPLAY_CORRUPT' as const }),
      branch: () => ({ ok: false as const, error: 'BRANCH_NOT_FOUND' as const }),
      snapshot: () => ({ ok: false as const, error: 'SNAPSHOT_CORRUPT' as const }),
    } satisfies EventLog;
    const bb = createBlackboard({ eventLog: failing });
    bb.bindExec(EXEC);
    const r = bb.set('k', 1);
    assert.ok(!r.ok && r.error === 'PERSIST_FAILED');
    assert.equal(bb.get('k'), undefined);
  });

  test('exec/run 上下文缺失时拒写（信封无法盖章）', () => {
    const { bb } = setup();
    bb.bindExec(null);
    assert.ok(!bb.set('k', 1).ok);
    assert.equal(bb.get('k'), undefined);
  });
});

describe('Blackboard.applyEvent（恢复路径：不写穿不通知，§4 恢复纪律）', () => {
  test('bb_set 事件重建键值，不产生新事件', () => {
    const { bb, dir } = setup();
    const before = readFileSync(join(dir, 'script.jsonl'), 'utf8').trim().split('\n').length;
    bb.applyEvent(bbSetEvent('worldbook.ashen_wastes', { title: '灰烬荒原' }));
    assert.deepEqual(bb.get('worldbook.ashen_wastes'), { title: '灰烬荒原' });
    const after = readFileSync(join(dir, 'script.jsonl'), 'utf8').trim().split('\n').length;
    assert.equal(before, after); // 恢复路径零副作用
  });

  test('snapshot 事件的黑板段整体采纳（§2.3 快照四段之一）', () => {
    const { bb } = setup();
    bb.set('old.key', 1);
    bb.applyEvent({
      id: 'e0000050',
      parent_id: null,
      ts: new Date().toISOString(),
      run_id: RUN,
      branch: 'main',
      exec: null,
      type: 'snapshot',
      payload: {
        last_event_id: 'e0000049',
        blackboard: { 'protagonist.hp': 42 },
        agents: {},
        progress: {},
        ledger: { total: 0, currency: 'CNY' },
      },
    } as Event);
    assert.equal(bb.get('protagonist.hp'), 42);
    assert.equal(bb.get('old.key'), undefined); // 快照即全量检查点
  });

  test('无关事件类型忽略', () => {
    const { bb } = setup();
    bb.applyEvent({
      id: 'e0000060',
      parent_id: null,
      ts: new Date().toISOString(),
      run_id: RUN,
      branch: 'main',
      exec: null,
      type: 'system',
      payload: { code: 'x', message: 'x', severity: 'info' },
    } as Event);
    assert.deepEqual(bb.snapshot(), {});
  });
});

describe('Blackboard.snapshot / get', () => {
  test('快照为副本：改返回值不影响内部状态；缺失键返回 undefined', () => {
    const { bb } = setup();
    bb.set('a.b', 1);
    const snap = bb.snapshot();
    snap['a.b'] = 999;
    assert.equal(bb.get('a.b'), 1);
    assert.equal(bb.get('not.exists'), undefined);
  });
});
