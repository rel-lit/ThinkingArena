// Version: 1.0.0
/**
 * event-log.ts 单元测试：取号/盖章、校验拒写、replay 定位快照、branch/fork 原子、尾部半行修复。
 * 文件全部落在 node:os 临时目录，逐测试隔离清理；无任何网络调用。
 */
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEventLog } from './event-log.ts';
import type { Event, EventDraft } from '../schema/event.ts';

const RUN = '0192c9e4-7a1b-7c3d-8e4f-a5b6c7d8e9f0'; // UUID v7 形态常量
const EXEC = { node_id: 'test_node', iteration: 0 };

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});
function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ta-eventlog-'));
  tmpDirs.push(dir);
  return join(dir, 'script.jsonl');
}

/** 构造 system 草稿（exec 恒 null 的 runner 级条目，最简合法形态）。 */
function sysDraft(code: string): EventDraft {
  return {
    ts: new Date().toISOString(),
    run_id: RUN,
    branch: 'main',
    exec: null,
    type: 'system',
    payload: { code, message: `msg-${code}`, severity: 'info' },
  } as EventDraft;
}
/** 构造 bb_set 草稿（exec 必填族，验证节点执行标识路径）。 */
function bbDraft(key: string, value: unknown, branch = 'main'): EventDraft {
  return {
    ts: new Date().toISOString(),
    run_id: RUN,
    branch,
    exec: EXEC,
    type: 'bb_set',
    payload: { key, value },
  } as EventDraft;
}
const LEDGER = { total: 0, currency: 'CNY' };
const SNAPSHOT_STATE = { blackboard: { 'protagonist.hp': 100 }, agents: {}, progress: {}, ledger: LEDGER };

async function drain(iter: AsyncIterable<Event>): Promise<Event[]> {
  const out: Event[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

describe('EventLog.append（取号与盖章，deep-dive §1.4/§1.5）', () => {
  test('id 零填充单调、parent_id 链、返回盖章事件', () => {
    const log = createEventLog({ filePath: tmpFile() });
    const e1 = log.append(sysDraft('a'));
    const e2 = log.append(bbDraft('k', 1));
    const e3 = log.append(sysDraft('b'));
    assert.ok(e1.ok && e2.ok && e3.ok);
    assert.equal(e1.value.id, 'e0000001');
    assert.equal(e1.value.parent_id, null);
    assert.equal(e2.value.id, 'e0000002');
    assert.equal(e2.value.parent_id, 'e0000001');
    assert.equal(e3.value.parent_id, 'e0000002');
    assert.equal(log.currentRunId(), RUN);
    assert.equal(log.lastEventId(), 'e0000003');
  });

  test('写者自带 id/parent_id 机械拒写（EVENT_SCHEMA_INVALID）', () => {
    const log = createEventLog({ filePath: tmpFile() });
    const bad = { ...sysDraft('x'), id: 'e0000099' } as EventDraft;
    const r = log.append(bad);
    assert.ok(!r.ok && r.error === 'EVENT_SCHEMA_INVALID');
  });

  test('非法载荷拒写；跨 run_id 拒写；跨活跃分支拒写', () => {
    const log = createEventLog({ filePath: tmpFile() });
    assert.ok(log.append(sysDraft('a')).ok);
    const badPayload = { ...sysDraft('bad'), payload: { wrong: 1 } } as unknown as EventDraft;
    assert.ok(!log.append(badPayload).ok);
    const otherRun = { ...sysDraft('b'), run_id: '0192c9e4-0000-7000-8000-000000000000' } as EventDraft;
    assert.ok(!log.append(otherRun).ok);
    const otherBranch = { ...sysDraft('c'), branch: 'other' } as EventDraft;
    assert.ok(!log.append(otherBranch).ok);
    assert.equal(log.lastEventId(), 'e0000001'); // 拒写不取号
  });
});

describe('EventLog.replay（只吐序列，首条可为快照，§4.3）', () => {
  test('无快照从头吐；有快照从最新快照起吐', async () => {
    const file = tmpFile();
    const log = createEventLog({ filePath: file });
    log.append(sysDraft('a'));
    log.append(bbDraft('k', 1));
    const snap = log.snapshot(SNAPSHOT_STATE);
    assert.ok(snap.ok);
    log.append(bbDraft('k', 2));
    log.append(sysDraft('z'));
    const r = await log.replay();
    assert.ok(r.ok);
    const evts = await drain(r.value);
    assert.deepEqual(
      evts.map((e) => e.id),
      ['e0000003', 'e0000004', 'e0000005'],
    );
    assert.equal(evts[0].type, 'snapshot');
  });

  test('until 含本体；未知分支 BRANCH_NOT_FOUND', async () => {
    const log = createEventLog({ filePath: tmpFile() });
    log.append(sysDraft('a'));
    log.append(sysDraft('b'));
    log.append(sysDraft('c'));
    const r = await log.replay({ until: 'e0000002' });
    assert.ok(r.ok);
    assert.deepEqual((await drain(r.value)).map((e) => e.id), ['e0000001', 'e0000002']);
    const bad = await log.replay({ branch: 'nope' });
    assert.ok(!bad.ok && bad.error === 'BRANCH_NOT_FOUND');
  });

  test('fromSnapshot 指定非快照条目 → REPLAY_CORRUPT', async () => {
    const log = createEventLog({ filePath: tmpFile() });
    log.append(sysDraft('a'));
    const r = await log.replay({ fromSnapshot: 'e0000001' });
    assert.ok(!r.ok && r.error === 'REPLAY_CORRUPT');
  });
});

describe('EventLog.branch（fork 控制条目原子落盘，§2.4-3）', () => {
  test('fork 条目挂锚点下，新分支共享前缀，旧分支封存', async () => {
    const log = createEventLog({ filePath: tmpFile() });
    log.append(sysDraft('a'));
    log.append(sysDraft('b'));
    log.append(sysDraft('c'));
    const r = log.branch('e0000002', 'b2');
    assert.ok(r.ok);
    assert.equal(log.currentBranch(), 'b2');
    log.append(bbDraft('k', 9, 'b2'));
    // 新分支路径：e1,e2 → fork(e4) → e5
    const b2 = await log.replay({ branch: 'b2' });
    assert.ok(b2.ok);
    const b2evts = await drain(b2.value);
    assert.deepEqual(
      b2evts.map((e) => e.id),
      ['e0000001', 'e0000002', 'e0000004', 'e0000005'],
    );
    assert.equal(b2evts[2].type, 'fork');
    assert.equal(b2evts[2].parent_id, 'e0000002');
    // 旧分支 main 仍是 e1,e2,e3（封存不增长）
    const main = await log.replay({ branch: 'main' });
    assert.ok(main.ok);
    assert.deepEqual((await drain(main.value)).map((e) => e.id), ['e0000001', 'e0000002', 'e0000003']);
  });

  test('锚点不存在 BRANCH_NOT_FOUND；分支名复用拒写', () => {
    const log = createEventLog({ filePath: tmpFile() });
    log.append(sysDraft('a'));
    assert.ok(!log.branch('e0000099', 'b2').ok);
    assert.ok(!log.branch('e0000001', 'main').ok);
  });
});

describe('EventLog 打开扫描（崩溃恢复，§2.3）', () => {
  test('续号 + 尾部半行丢弃并记 system 事件', async () => {
    const file = tmpFile();
    const log1 = createEventLog({ filePath: file });
    log1.append(sysDraft('a'));
    log1.append(sysDraft('b'));
    appendFileSync(file, '{"id":"e000000', 'utf8'); // 崩溃半行
    const log2 = createEventLog({ filePath: file });
    assert.equal(log2.lastEventId(), 'e0000003'); // e3 = 修复注记 system 事件
    const r = await log2.replay();
    assert.ok(r.ok);
    const evts = await drain(r.value);
    assert.equal(evts.length, 3);
    assert.equal(evts[2].type, 'system');
    if (evts[2].type === 'system') assert.equal(evts[2].payload.code, 'jsonl_tail_truncated');
    const e4 = log2.append(sysDraft('d'));
    assert.ok(e4.ok && e4.value.id === 'e0000004'); // 续号无洞
  });

  test('无法解析的完整行丢弃并注记；纯半行文件降级为空文件', async () => {
    const file = tmpFile();
    const log1 = createEventLog({ filePath: file });
    log1.append(sysDraft('a'));
    appendFileSync(file, 'not-json-at-all\n', 'utf8');
    const log2 = createEventLog({ filePath: file });
    const r = await log2.replay();
    assert.ok(r.ok);
    const evts = await drain(r.value);
    assert.equal(evts.length, 2); // e1 + 损坏注记
    assert.equal(evts[1].type, 'system');
    // 只有半行的空文件：无 run 上下文，静默修复不注记
    const file2 = tmpFile();
    writeFileSync(file2, '{"id":"e0', 'utf8');
    const log3 = createEventLog({ filePath: file2 });
    assert.equal(log3.lastEventId(), null);
    assert.equal(log3.currentRunId(), null);
  });
});

describe('EventLog.snapshot（D11 内联条目）', () => {
  test('last_event_id 由服务注入；载荷缺段 → SNAPSHOT_CORRUPT；空文件拒写', () => {
    const log = createEventLog({ filePath: tmpFile() });
    assert.ok(!log.snapshot(SNAPSHOT_STATE).ok); // 无 run 上下文
    log.append(sysDraft('a'));
    const ok = log.snapshot(SNAPSHOT_STATE);
    assert.ok(ok.ok && ok.value === 'e0000002');
    const bad = log.snapshot({ blackboard: {} }); // 缺 agents/progress/ledger
    assert.ok(!bad.ok && bad.error === 'SNAPSHOT_CORRUPT');
  });

  test('快照条目载荷四段齐全且 last_event_id 正确', () => {
    const file = tmpFile();
    const log = createEventLog({ filePath: file });
    log.append(sysDraft('a'));
    log.snapshot(SNAPSHOT_STATE);
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    const snap = JSON.parse(lines[1]);
    assert.equal(snap.type, 'snapshot');
    assert.equal(snap.payload.last_event_id, 'e0000001');
    assert.equal(snap.payload.blackboard['protagonist.hp'], 100);
    assert.equal(snap.payload.ledger.currency, 'CNY');
  });
});
