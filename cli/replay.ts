// Version: 1.0.0
/**
 * cli/replay：只读重放已落 Script（§2.4-6 回放 ≠ 重跑：纯 reduce、确定性、零副作用）→
 * 输出重建状态摘要（黑板键、Agent 生命周期、调度进度、成本切片）。
 *
 * 重放窗口 = 分支路径上最新快照 + 其后事件（裁决 3-D-4；快照四段整体还原，续放段逐条 reduce）。
 * 用法：node cli/replay.ts --run-dir <dir>
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { CostSummary, EventId, RunId } from '../schema/event.ts';
import { createEventLog } from '../services/event-log.ts';
import { createBlackboard } from '../services/blackboard.ts';
import { RunReducer, type AgentProjection, type ProgressEntry } from '../orchestrator/reducer.ts';

/** 重放重建的状态摘要（replay CLI 输出形态，亦为 e2e 一致性比对的数据面）。 */
export interface ReplaySummary {
  runId: RunId | null;
  branch: string;
  /** 落定态（未落定为 null——崩溃现场）。 */
  finished: 'completed' | 'cancelled' | null;
  ending: string | null;
  cost: CostSummary;
  blackboard: Record<string, unknown>;
  agents: Record<string, AgentProjection>;
  progress: Record<string, ProgressEntry>;
  /** 本窗口 reduce 的事件数（含快照条目）。 */
  eventCount: number;
  lastEventId: EventId | null;
}

/** 重放 run 目录的 Script 并重建状态（只读语义；EventLog 打开扫描的损坏修复是已知例外，见 event-log.ts）。 */
export async function replayRun(runDir: string): Promise<ReplaySummary> {
  const eventLog = createEventLog({ filePath: join(runDir, 'script.jsonl') });
  const blackboard = createBlackboard({ eventLog });
  const reducer = new RunReducer(blackboard);
  const rr = await eventLog.replay();
  if (!rr.ok) throw new Error(`重放失败: ${rr.error}`);
  let eventCount = 0;
  for await (const e of rr.value) {
    reducer.feed(e);
    eventCount += 1;
  }
  reducer.finishReplay(); // D36：丢弃重放末尾的孤儿事件
  return {
    runId: reducer.runId,
    branch: reducer.branch,
    finished: reducer.finished,
    ending: reducer.lastEnding,
    cost: reducer.ledger.summary(),
    blackboard: blackboard.snapshot(),
    agents: Object.fromEntries(reducer.agents),
    progress: Object.fromEntries(reducer.progress),
    eventCount,
    lastEventId: reducer.lastEventId,
  };
}

/** 人读摘要渲染（F16 复盘视图的最小形态之一）。 */
export function renderSummary(s: ReplaySummary): string {
  const lines: string[] = [];
  lines.push(`run_id: ${s.runId ?? '(未知)'}  branch: ${s.branch}  状态: ${s.finished ?? '未落定'}  结局: ${s.ending ?? '(无)'}`);
  lines.push(`成本: ${s.cost.total} ${s.cost.currency}  窗口事件数: ${s.eventCount}  末事件: ${s.lastEventId ?? '(无)'}`);
  lines.push('--- 黑板键 ---');
  for (const k of Object.keys(s.blackboard).sort()) lines.push(`  ${k} = ${JSON.stringify(s.blackboard[k])?.slice(0, 100)}`);
  lines.push('--- Agent 生命周期 ---');
  for (const [id, a] of Object.entries(s.agents)) lines.push(`  ${id}: ${a.state}（memory_ref: ${a.memory_ref ?? 'null'}）`);
  lines.push('--- 调度进度（节点#迭代） ---');
  for (const [key, p] of Object.entries(s.progress)) lines.push(`  ${key}: ${p.status}`);
  return lines.join('\n');
}

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { 'run-dir': { type: 'string' } } });
  if (values['run-dir'] === undefined) {
    console.error('用法: node cli/replay.ts --run-dir <dir>');
    return 2;
  }
  console.log(renderSummary(await replayRun(values['run-dir'])));
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
