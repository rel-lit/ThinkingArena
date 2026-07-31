// ThinkingArena 事件流重放耗时实测（调研临时脚本，非项目代码）
// 模拟 D35 事件族的典型混合负载，测量：
//   A) 逐行 JSON.parse + 纯函数 reduce 重放 1万/10万事件的耗时
//   B) 两种读取方式（readFileSync+split vs 流式 readline）
//   C) 全量 reduce 状态快照的体积量级与序列化成本
// 运行：node task/tmp/replay-bench.mjs
import { writeFileSync, readFileSync, statSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { fileURLToPath } from 'node:url';
const TMP = fileURLToPath(new URL('.', import.meta.url));
const RUNS = 5;

// ---- 确定性伪随机（可复现） ----
let seed = 42;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function pick(arr) { return arr[Math.floor(rnd() * arr.length)]; }

const AGENTS = ['alice', 'bob', 'carol', 'dave', 'narrator', 'archivist'];
const NODES = ['opening', 'turn_loop', 'narrate', 'judge', 'dice', 'gate', 'closing'];

function speechText(n) { return '这是一段角色发言，包含若干叙事内容。'.repeat(n); }
function monoText(n) { return 'thinking: 角色内心推理过程，分析局势与他人动机。'.repeat(n); }

// ---- 事件生成：一局典型混合（比例按 D35 事件族估计） ----
let seq = 0;
function makeEvent(i, prevId) {
  seq = i;
  const base = {
    id: `e${String(i).padStart(7, '0')}`,
    parent_id: prevId,
    ts: new Date(1754000000000 + i * 3000).toISOString(),
    node_exec: { node: pick(NODES), iter: Math.floor(i / 40) },
  };
  const r = rnd();
  if (r < 0.10) return { ...base, type: 'node_start' };
  if (r < 0.20) return { ...base, type: 'node_end' };
  if (r < 0.25) return { ...base, type: 'turn_start', agent: pick(AGENTS) };
  if (r < 0.30) return { ...base, type: 'turn_end', agent: pick(AGENTS) };
  if (r < 0.45) return { ...base, type: 'speech', agent: pick(AGENTS), text: speechText(3 + Math.floor(rnd() * 8)) }; // ~150-450B 正文
  if (r < 0.55) return { ...base, type: 'monologue', agent: pick(AGENTS), text: monoText(20 + Math.floor(rnd() * 60)) }; // ~2-8KB thinking
  if (r < 0.70) return { ...base, type: 'cost', agent: pick(AGENTS), model: 'kimi-k2', usage: { input: 12000, output: 800, cached: 6000 }, cost: 0.0042 };
  if (r < 0.80) return { ...base, type: 'prompt_hash', agent: pick(AGENTS), sha256: 'a'.repeat(64) };
  if (r < 0.93) return { ...base, type: 'bb_set', key: `worldbook.fact_${Math.floor(rnd() * 50)}`, value: { desc: speechText(2), updated_by: 'gate' } };
  if (r < 0.96) return { ...base, type: 'director_intervention', kind: 'whisper', target: pick(AGENTS), text: speechText(2), hash: 'b'.repeat(64) };
  if (r < 0.98) return { ...base, type: 'dice', expr: '1d20+3', result: 14 };
  return { ...base, type: 'milestone', name: `act_${Math.floor(i / 2000)}` };
}

function generate(path, n) {
  const lines = [];
  let prev = null;
  for (let i = 0; i < n; i++) {
    const e = makeEvent(i, prev);
    prev = e.id;
    lines.push(JSON.stringify(e));
  }
  writeFileSync(path, lines.join('\n') + '\n');
  return statSync(path).size;
}

// ---- 纯函数 reduce（模拟 D1/D22 事件流内状态：黑板 + Agent 生命周期 + 调度进度 + 成本账本） ----
function reduce(state, e) {
  switch (e.type) {
    case 'bb_set': state.blackboard[e.key] = e.value; break;
    case 'turn_start': state.agents[e.agent] = 'RUNNING'; break;
    case 'turn_end': state.agents[e.agent] = 'IDLE'; break;
    case 'node_start': state.progress[`${e.node_exec.node}#${e.node_exec.iter}`] = 'running'; break;
    case 'node_end': state.progress[`${e.node_exec.node}#${e.node_exec.iter}`] = 'done'; break;
    case 'cost': state.ledger.total += e.cost; state.ledger.count++; break;
    case 'speech': state.lastSpeech[e.agent] = e.text.slice(0, 200); break; // 黑板派生切片
    default: break;
  }
  return state;
}
function newState() { return { blackboard: {}, agents: {}, progress: {}, ledger: { total: 0, count: 0 }, lastSpeech: {} }; }

// ---- 方式 A：readFileSync + split + JSON.parse + reduce ----
function replaySync(path) {
  const t0 = performance.now();
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n');
  const t1 = performance.now();
  let state = newState();
  let n = 0;
  for (const line of lines) {
    if (!line) continue;
    state = reduce(state, JSON.parse(line));
    n++;
  }
  const t2 = performance.now();
  return { readMs: t1 - t0, parseReduceMs: t2 - t1, totalMs: t2 - t0, events: n, state };
}

// ---- 方式 B：流式 readline（真实实现更可能用） ----
async function replayStream(path) {
  const t0 = performance.now();
  let state = newState();
  let n = 0;
  const rl = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    state = reduce(state, JSON.parse(line));
    n++;
  }
  const t1 = performance.now();
  return { totalMs: t1 - t0, events: n, state };
}

function median(arr) { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }

// ---- 快照体积：全量 reduce 状态（黑板 + Agent 生命周期 + 调度进度 + 账本） ----
function snapshotSizeBench(state) {
  const t0 = performance.now();
  const json = JSON.stringify(state);
  const t1 = performance.now();
  return { bytes: Buffer.byteLength(json), stringifyMs: t1 - t0 };
}

const f10k = join(TMP, 'bench-10k.jsonl');
const f100k = join(TMP, 'bench-100k.jsonl');
const size10k = generate(f10k, 10_000);
const size100k = generate(f100k, 100_000);
console.log(`文件体积: 10k事件=${(size10k / 1024 / 1024).toFixed(2)}MB (${(size10k / 10000).toFixed(0)}B/事件), 100k事件=${(size100k / 1024 / 1024).toFixed(2)}MB (${(size100k / 100000).toFixed(0)}B/事件)`);

for (const [label, f] of [['10k', f10k], ['100k', f100k]]) {
  const syncRuns = [];
  for (let i = 0; i < RUNS; i++) syncRuns.push(replaySync(f));
  const streamRuns = [];
  for (let i = 0; i < RUNS; i++) streamRuns.push(await replayStream(f));

  const mSyncRead = median(syncRuns.map(r => r.readMs));
  const mSyncPR = median(syncRuns.map(r => r.parseReduceMs));
  const mSyncTotal = median(syncRuns.map(r => r.totalMs));
  const mStream = median(streamRuns.map(r => r.totalMs));
  const n = syncRuns[0].events;
  console.log(`\n== ${label} 事件 (${RUNS} 次取中位) ==`);
  console.log(`方式A readFileSync+split: 读取 ${mSyncRead.toFixed(1)}ms + parse+reduce ${mSyncPR.toFixed(1)}ms = ${mSyncTotal.toFixed(1)}ms (${(n / mSyncTotal * 1000).toFixed(0)} 事件/s)`);
  console.log(`方式B 流式readline:      ${mStream.toFixed(1)}ms (${(n / mStream * 1000).toFixed(0)} 事件/s)`);
  console.log(`快照体积: ${JSON.stringify(snapshotSizeBench(syncRuns[0].state))}`);
}
