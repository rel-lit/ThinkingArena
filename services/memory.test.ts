// Version: 1.0.0
/**
 * memory.ts 单元测试：挂载语义（缺失/损坏/幂等）、ingest 沉淀、projection 截断渲染、
 * compact 截断 + 原子落盘、跨实例重挂载恢复。文件落 node:os 临时目录，无网络调用。
 */
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryService } from './memory.ts';

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ta-mem-'));
  tmpDirs.push(dir);
  return dir;
}

describe('MemoryService.mount（D22 显式挂载）', () => {
  test('文件缺失 → MEMORY_NOT_FOUND；损坏 → CHECKPOINT_CORRUPT', async () => {
    const dir = tmpDir();
    const mem = createMemoryService({ dir });
    const missing = await mem.mount('ghost');
    assert.ok(!missing.ok && missing.error === 'MEMORY_NOT_FOUND');
    writeFileSync(join(dir, 'broken.json'), 'not-json', 'utf8');
    const corrupt = await mem.mount('broken');
    assert.ok(!corrupt.ok && corrupt.error === 'CHECKPOINT_CORRUPT');
  });

  test('挂载已持久化的记忆 → projection 可取', async () => {
    const dir = tmpDir();
    const mem1 = createMemoryService({ dir });
    mem1.ingest('hero', { intent: '开场', text: '我醒来了' });
    await mem1.persist('hero');
    const mem2 = createMemoryService({ dir });
    const r = await mem2.mount('hero');
    assert.ok(r.ok);
    const proj = mem2.projection('hero');
    assert.ok(proj.ok);
    assert.match(String(proj.value), /我醒来了/);
  });
});

describe('MemoryService.ingest / projection（F17 沉淀 + L5 投影）', () => {
  test('未挂载实例 projection 为空串（新实例合法态，非错误）', () => {
    const mem = createMemoryService({ dir: tmpDir() });
    const r = mem.projection('fresh');
    assert.ok(r.ok && r.value === '');
  });

  test('projection 只渲染最近 10 个回合（截断模式）', () => {
    const mem = createMemoryService({ dir: tmpDir() });
    for (let i = 1; i <= 15; i += 1) mem.ingest('a', { intent: `i${i}`, text: `t${i}` });
    const proj = mem.projection('a');
    assert.ok(proj.ok);
    const text = String(proj.value);
    assert.match(text, /t15/);
    assert.match(text, /t6/); // 第 6 个起在窗口内
    assert.doesNotMatch(text, /t5[^\d]/); // 窗口外
  });
});

describe('MemoryService.compact / persist（截断 + 原子落盘）', () => {
  test('compact 截断到最近 50 回合并落盘；文件形态自包含', async () => {
    const dir = tmpDir();
    const mem = createMemoryService({ dir });
    for (let i = 1; i <= 60; i += 1) mem.ingest('a', { intent: `i${i}`, text: `t${i}` });
    const r = await mem.compact('a');
    assert.ok(r.ok);
    const file = JSON.parse(readFileSync(join(dir, 'a.json'), 'utf8'));
    assert.equal(file.version, '1.0.0');
    assert.equal(file.agent_id, 'a');
    assert.equal(file.turns.length, 50);
    assert.equal(file.turns[0].text, 't11'); // 前 10 个被截掉
    assert.equal(file.turns[49].text, 't60');
  });

  test('persist/compact 对零记忆实例幂等 ok', async () => {
    const mem = createMemoryService({ dir: tmpDir() });
    assert.ok((await mem.persist('nobody')).ok);
    assert.ok((await mem.compact('nobody')).ok);
  });

  test('ingest 超水位自动截断（内存侧防无界增长）', async () => {
    const mem = createMemoryService({ dir: tmpDir() });
    for (let i = 1; i <= 120; i += 1) mem.ingest('a', { intent: `i${i}`, text: `t${i}` });
    const proj = mem.projection('a');
    assert.ok(proj.ok);
    const text = String(proj.value);
    assert.match(text, /t120/);
    assert.doesNotMatch(text, /t70[^\d]/); // 自动截断后只剩最近 50 个
  });
});
