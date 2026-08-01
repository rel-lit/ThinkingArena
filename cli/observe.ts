// Version: 1.0.0
/**
 * cli/observe：tail Script 渲染事件视图（F16 最小版：逐行 type + 摘要）。
 * 只读解析 script.jsonl，逐事件输出一行 `[事件id] type  摘要`。
 * 用法：node cli/observe.ts --run-dir <dir> [--tail <n>]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { Event } from '../schema/event.ts';

const cut = (s: string, n = 60): string => (s.length > n ? `${s.slice(0, n)}…` : s);
const execOf = (e: Event): string => (e.exec === null ? '-' : `${e.exec.node_id}#${e.exec.iteration}`);

/** 逐类型一行摘要（未知/自定义类型回退载荷截断 JSON）。 */
export function renderEvent(e: Event): string {
  const p = e.payload as Record<string, unknown>;
  let summary: string;
  switch (e.type) {
    case 'run_started':
      summary = `mode=${p.mode} hash=${String(p.bundle_hash).slice(0, 12)}`;
      break;
    case 'run_paused':
      summary = `reason=${p.reason ?? '(无)'}`;
      break;
    case 'run_resumed':
      summary = `from=${p.from_state}`;
      break;
    case 'run_completed':
      summary = `ending=${p.ending} cost=${JSON.stringify(p.cost)}`;
      break;
    case 'run_error':
      summary = `${p.error} node=${p.node_id ?? '-'} ${p.detail ?? ''}`;
      break;
    case 'run_cancelled':
      summary = '';
      break;
    case 'node_start':
    case 'node_end':
      summary = `${p.component_type}@${p.component_version}`;
      break;
    case 'node_failed':
      summary = `${p.component_type} error=${p.error} ${p.detail ?? ''}`;
      break;
    case 'speech':
    case 'monologue':
      summary = `${p.agent_id}: ${cut(String(p.text))}`;
      break;
    case 'dice':
      summary = `${p.expression} [${(p.rolls as number[]).join(',')}]${Number(p.modifier) >= 0 ? '+' : ''}${p.modifier} → ${p.total}（${p.purpose ?? '无目的'}）`;
      break;
    case 'judgement':
      summary = `${p.subject} → ${p.grade}（${cut(String(p.rationale ?? ''), 40)}）`;
      break;
    case 'judge_retry':
      summary = `attempt=${p.attempt}/${p.max_attempts} ${p.error}`;
      break;
    case 'branch_decision':
      summary = `→ ${p.target_node} result=${p.result}`;
      break;
    case 'bb_set':
      summary = `${p.key} = ${cut(JSON.stringify(p.value) ?? '', 50)}`;
      break;
    case 'cost':
      summary = `${p.model} ${(p.cost as { amount: number }).amount} ${(p.cost as { currency: string }).currency}`;
      break;
    case 'prompt_hash':
      summary = `${p.agent_id} prefix=${String(p.prefix_sha256).slice(0, 12)}`;
      break;
    case 'turn_start':
      summary = `${p.agent_id} first=${p.first_turn}`;
      break;
    case 'turn_end':
      summary = `${p.agent_id} outcome=${p.outcome}`;
      break;
    case 'agent_created':
      summary = `${p.agent_id} card=${p.card_name} model=${p.model}`;
      break;
    case 'agent_destroyed':
      summary = `${p.agent_id} reason=${p.reason}`;
      break;
    case 'agent_error':
      summary = `${p.agent_id} error=${p.error}`;
      break;
    case 'gate_waiting':
      summary = `targets=${JSON.stringify(p.targets)} accepts=${JSON.stringify(p.accepts)}`;
      break;
    case 'gate_input_received':
      summary = `${(p.directive as { kind: string }).kind} source=${p.source} ${cut(String((p.directive as { text: string }).text), 40)}`;
      break;
    case 'gate_timeout':
      summary = `policy=${p.policy} waited=${p.waited_ms}ms`;
      break;
    case 'gate_cancelled':
      summary = `reason=${p.reason}`;
      break;
    case 'director_intervention':
      summary = `${(p.directive as { kind: string }).kind} outcome=${p.outcome} ${cut(String((p.directive as { text: string }).text), 40)}`;
      break;
    case 'director_note':
      summary = cut(String(p.text));
      break;
    case 'milestone':
      summary = `kind=${p.kind} label=${p.label ?? '-'}`;
      break;
    case 'snapshot':
      summary = `截至 ${p.last_event_id}`;
      break;
    case 'fork':
      summary = `at=${p.at_event_id} → ${p.new_branch}`;
      break;
    case 'system':
      summary = `[${p.severity}] ${p.code}: ${cut(String(p.message), 50)}`;
      break;
    default:
      summary = cut(JSON.stringify(p) ?? '', 80);
  }
  return `[${e.id}] ${e.type}  exec=${execOf(e)}  ${summary}`;
}

/** 读取 Script 并渲染事件视图（--tail 取末尾 n 行）。 */
export function observeRun(runDir: string, tail?: number): string {
  const text = readFileSync(join(runDir, 'script.jsonl'), 'utf8');
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  const events = lines.map((l) => JSON.parse(l) as Event);
  const view = tail !== undefined ? events.slice(-tail) : events;
  return view.map(renderEvent).join('\n');
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { 'run-dir': { type: 'string' }, tail: { type: 'string' } },
    allowPositionals: true, // 允许位置参数作 run-dir（node cli/observe.ts runs/xxx）
  });
  const runDir = values['run-dir'] ?? positionals[0];
  if (runDir === undefined) {
    console.error('用法: node cli/observe.ts [--run-dir] <dir> [--tail <n>]');
    return 2;
  }
  console.log(observeRun(runDir, values.tail !== undefined ? Number(values.tail) : undefined));
  return 0;
}

const invokedAsMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsMain) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    },
  );
}
