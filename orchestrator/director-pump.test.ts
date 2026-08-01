// Version: 1.0.0
/**
 * director-pump.ts 测试（D27/D37）：note 直落盘 / 门指令路由 / 无门拒绝 / 无效行 /
 * 单门约束 / 超时策略（D15）/ cancelAll（G4/G6）/ 消费游标与 hash 幂等降级恢复。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { DirectorDirective, RunId } from '../schema/event.ts';
import { createDirectorPump, type DirectorPumpControl } from './director-pump.ts';
import type { DirectorPump } from './types.ts';
import { MockEventLog, tmpRunDir } from './test-mocks.ts';

const RUN_ID = '019785e0-0000-7000-8000-000000000000' as RunId;

function directive(kind: DirectorDirective['kind'], text: string): string {
  return JSON.stringify({ kind, text, targets: kind === 'note' ? [] : ['a1'], mode: kind === 'whisper' ? 'steering' : null });
}

function setup() {
  const dir = tmpRunDir();
  const inboxPath = join(dir, 'director_inbox.jsonl');
  const el = new MockEventLog();
  const pump = createDirectorPump({ inboxPath, eventLog: el });
  pump.bindRunContext({ runId: RUN_ID, branch: 'main' });
  return { dir, inboxPath, el, pump };
}

async function startPump(pump: DirectorPump & DirectorPumpControl) {
  const r = await pump.start();
  assert.ok(r.ok);
}

describe('director-pump 行消费（D27）', () => {
  test('note → 直接落 director_note（全文 + hash，不需门等待）', async () => {
    const { inboxPath, el, pump } = await setup();
    await startPump(pump);
    appendFileSync(inboxPath, directive('note', '导演批注') + '\n');
    pump.pollOnce();
    const notes = el.ofType('director_note');
    assert.equal(notes.length, 1);
    assert.equal(notes[0].payload.text, '导演批注');
    assert.equal(notes[0].payload.directive_hash, createHash('sha256').update('导演批注', 'utf8').digest('hex'));
    assert.equal(notes[0].exec, null);
    pump.stop();
  });

  test('门指令：有门等待 → 解析等待中的 promise；无门等待 → 拒绝并记 system', async () => {
    const { inboxPath, el, pump } = await setup();
    await startPump(pump);
    // 无门等待：拒绝（F2 MVP 不缓冲）
    appendFileSync(inboxPath, directive('inject', '无门指令') + '\n');
    pump.pollOnce();
    const rejected = el.ofType('system').filter((e) => e.payload.code === 'no_waiting_gate');
    assert.equal(rejected.length, 1);

    // 有门等待：路由解析
    const ac = new AbortController();
    const p = pump.awaitDirective({ gateNodeId: 'gate', signal: ac.signal });
    assert.equal(pump.isWaiting(), true);
    appendFileSync(inboxPath, directive('inject', '开门') + '\n');
    pump.pollOnce();
    const r = await p;
    assert.ok(r.ok && r.value.text === '开门' && r.value.kind === 'inject');
    assert.equal(pump.isWaiting(), false);
    pump.stop();
  });

  test('无效行（坏 JSON / 不符契约）→ 跳过并记 system(invalid_director_line)，不阻断后续行', async () => {
    const { inboxPath, el, pump } = await setup();
    await startPump(pump);
    appendFileSync(inboxPath, 'not-json\n' + JSON.stringify({ kind: 'nope' }) + '\n' + directive('note', 'ok') + '\n');
    pump.pollOnce();
    const invalid = el.ofType('system').filter((e) => e.payload.code === 'invalid_director_line');
    assert.equal(invalid.length, 2);
    assert.equal(el.ofType('director_note').length, 1, '后续有效行照常消费');
    pump.stop();
  });

  test('尾部半行暂不消费，补全后消费', async () => {
    const { inboxPath, el, pump } = await setup();
    await startPump(pump);
    appendFileSync(inboxPath, directive('note', '半行'));
    pump.pollOnce();
    assert.equal(el.ofType('director_note').length, 0);
    appendFileSync(inboxPath, '\n');
    pump.pollOnce();
    assert.equal(el.ofType('director_note').length, 1);
    pump.stop();
  });
});

describe('director-pump 单门约束与取消（D37/G4/G6/D15）', () => {
  test('单门等待：第二门进入立即 NODE_FAILED', async () => {
    const { pump } = await setup();
    const ac1 = new AbortController();
    const ac2 = new AbortController();
    const p1 = pump.awaitDirective({ gateNodeId: 'g1', signal: ac1.signal });
    const r2 = await pump.awaitDirective({ gateNodeId: 'g2', signal: ac2.signal });
    assert.deepEqual(r2, { ok: false, error: 'NODE_FAILED' });
    pump.cancelAll();
    await p1;
  });

  test('cancelAll 唤醒等待中的门（RUN_CANCELLED）；signal abort 同效', async () => {
    const { pump } = await setup();
    const ac = new AbortController();
    const p1 = pump.awaitDirective({ gateNodeId: 'g1', signal: ac.signal });
    pump.cancelAll();
    assert.deepEqual(await p1, { ok: false, error: 'RUN_CANCELLED' });

    const ac2 = new AbortController();
    const p2 = pump.awaitDirective({ gateNodeId: 'g2', signal: ac2.signal });
    ac2.abort();
    assert.deepEqual(await p2, { ok: false, error: 'RUN_CANCELLED' });
  });

  test('超时策略：use_default 到期解析默认输入；cancel_branch 到期 NODE_FAILED', async () => {
    const { pump } = await setup();
    const ac1 = new AbortController();
    const p1 = pump.awaitDirective({
      gateNodeId: 'g1',
      signal: ac1.signal,
      timeoutPolicy: {
        policy: 'use_default',
        after_ms: 20,
        default_input: { kind: 'inject', text: '默认输入', targets: [], mode: null },
      },
    });
    const r1 = await p1;
    assert.ok(r1.ok && r1.value.text === '默认输入');

    const ac2 = new AbortController();
    const p2 = pump.awaitDirective({
      gateNodeId: 'g2',
      signal: ac2.signal,
      timeoutPolicy: { policy: 'cancel_branch', after_ms: 20 },
    });
    assert.deepEqual(await p2, { ok: false, error: 'NODE_FAILED' });
  });
});

describe('director-pump 消费游标（崩溃恢复不重读）', () => {
  test('游标文件：恢复后跳过已消费行', async () => {
    const dir = tmpRunDir();
    const inboxPath = join(dir, 'director_inbox.jsonl');
    const el = new MockEventLog();
    writeFileSync(inboxPath, directive('note', '旧') + '\n');
    writeFileSync(`${inboxPath}.cursor.json`, JSON.stringify({ consumed_lines: 1 }));
    appendFileSync(inboxPath, directive('note', '新') + '\n');

    const pump = createDirectorPump({ inboxPath, eventLog: el });
    pump.bindRunContext({ runId: RUN_ID, branch: 'main' });
    await startPump(pump);
    const notes = el.ofType('director_note');
    assert.equal(notes.length, 1);
    assert.equal(notes[0].payload.text, '新');
    pump.stop();
  });

  test('游标缺失降级：按 directive_hash 对已落盘指令幂等去重', async () => {
    const dir = tmpRunDir();
    const inboxPath = join(dir, 'director_inbox.jsonl');
    const el = new MockEventLog();
    // 事件流中已有「旧」note（恢复前已消费落盘）
    const r = el.append({
      ts: new Date().toISOString(),
      run_id: RUN_ID,
      branch: 'main',
      exec: null,
      type: 'director_note',
      payload: { text: '旧', directive_hash: createHash('sha256').update('旧', 'utf8').digest('hex') },
    });
    assert.ok(r.ok);
    writeFileSync(inboxPath, directive('note', '旧') + '\n' + directive('note', '新') + '\n');

    const pump = createDirectorPump({ inboxPath, eventLog: el });
    pump.bindRunContext({ runId: RUN_ID, branch: 'main' });
    await startPump(pump);
    const notes = el.ofType('director_note');
    assert.equal(notes.length, 2, '旧 note 不重复落盘，只补新行');
    assert.equal(notes[1].payload.text, '新');
    pump.stop();
  });

  test('消费后游标文件随行进', async () => {
    const { inboxPath, el, pump } = await setup();
    await startPump(pump);
    appendFileSync(inboxPath, directive('note', '一') + '\n' + directive('note', '二') + '\n');
    pump.pollOnce();
    const cursor = JSON.parse(readFileSync(`${inboxPath}.cursor.json`, 'utf8')) as { consumed_lines: number };
    assert.equal(cursor.consumed_lines, 2);
    assert.equal(el.ofType('director_note').length, 2);
    pump.stop();
  });
});
