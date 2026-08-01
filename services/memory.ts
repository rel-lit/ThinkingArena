// Version: 1.0.0
/**
 * MemoryService（§4.6）：MVP 截断模式——每 Agent 一个 JSON 文件（D22 独立持久化，事件流之外）。
 *
 * 实现要点：
 * - 文件形态 `${dir}/${agentId}.json`：{ version, agent_id, updated_at, turns[] }；memory_ref
 *   （Bundle 声明）按约定即该文件名（跨局显式挂载的键，D22）。
 * - mount() 显式挂载：文件缺失 → MEMORY_NOT_FOUND；损坏 → CHECKPOINT_CORRUPT（D29 回退上一代
 *   在 MVP 无上一代可退，挂载拒绝、记忆不载入）。
 * - ingest() 是 F17 回合沉淀的唯一写入面（D22 无外部写入面；冻结接口无沉淀方法——契约缺口，
 *   见汇报——增量面由 Agent 服务于 turn_end 调用）；仅 final 关账回合沉淀。
 * - projection() = L5 投影：最近 PROJECTION_TURNS 回合渲染为文本段；空记忆返回空串（新实例合法态）。
 * - compact() = 截断到最近 COMPACT_KEEP 回合 + persist；ingest 内存侧达 AUTO_COMPACT_AT 自动截断。
 * - persist() 临时文件 + rename 原子写（D29）；gateway 依赖（F18）截断模式缺省不用。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MemoryErrorKind, Result } from '../schema/errors.ts';
import type { AgentId } from '../schema/event.ts';
import type { LLMGateway, MemoryService } from './types.ts';

/** 记忆服务具体实现的增量面（F17 沉淀通道）。 */
export interface MemoryServiceEx extends MemoryService {
  /** 回合沉淀（F17/D22 唯一写入面）：追加一个回合的意图与产出文本。同步（内存侧，落盘走 persist）。 */
  ingest(agentId: AgentId, entry: { intent: string; text: string }): void;
}

interface MemoryTurn {
  ts: string;
  intent: string;
  text: string;
}
interface MemoryFile {
  version: '1.0.0';
  agent_id: string;
  updated_at: string;
  turns: MemoryTurn[];
}

const COMPACT_KEEP = 50; // compact 保留的最近回合数（截断模式）
const PROJECTION_TURNS = 10; // L5 投影渲染的最近回合数
const AUTO_COMPACT_AT = 100; // 内存侧自动截断水位

export function createMemoryService(deps: {
  dir: string;
  gateway?: LLMGateway; // F18 压缩调用；MVP 截断模式缺省不用
}): MemoryServiceEx {
  void deps.gateway;
  const memories = new Map<AgentId, MemoryTurn[]>();
  mkdirSync(deps.dir, { recursive: true });

  function fileOf(agentId: AgentId): string {
    return join(deps.dir, `${agentId}.json`);
  }

  async function mount(agentId: AgentId): Promise<Result<void, MemoryErrorKind>> {
    if (memories.has(agentId)) return { ok: true, value: undefined }; // 幂等（同进程重复挂载）
    const path = fileOf(agentId);
    if (!existsSync(path)) return { ok: false, error: 'MEMORY_NOT_FOUND' };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return { ok: false, error: 'CHECKPOINT_CORRUPT' };
    }
    const f = parsed as MemoryFile;
    if (f === null || typeof f !== 'object' || !Array.isArray(f.turns)) {
      return { ok: false, error: 'CHECKPOINT_CORRUPT' };
    }
    memories.set(agentId, f.turns);
    return { ok: true, value: undefined };
  }

  function projection(agentId: AgentId): Result<unknown, MemoryErrorKind> {
    const turns = memories.get(agentId) ?? [];
    const text = turns
      .slice(-PROJECTION_TURNS)
      .map((t) => `[${t.ts}] 意图：${t.intent}\n${t.text}`)
      .join('\n\n');
    return { ok: true, value: text };
  }

  async function persist(agentId: AgentId): Promise<Result<void, MemoryErrorKind>> {
    const turns = memories.get(agentId);
    if (turns === undefined) return { ok: true, value: undefined }; // 无记忆可落（零回合实例），幂等
    const file: MemoryFile = {
      version: '1.0.0',
      agent_id: agentId,
      updated_at: new Date().toISOString(),
      turns,
    };
    const path = fileOf(agentId);
    const tmp = `${path}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', 'utf8');
      renameSync(tmp, path); // 临时文件 + rename 原子写（D29）
    } catch {
      return { ok: false, error: 'PERSIST_FAILED' };
    }
    return { ok: true, value: undefined };
  }

  async function compact(agentId: AgentId): Promise<Result<void, MemoryErrorKind>> {
    const turns = memories.get(agentId);
    if (turns === undefined) return { ok: true, value: undefined }; // 无记忆，幂等
    if (turns.length > COMPACT_KEEP) turns.splice(0, turns.length - COMPACT_KEEP); // 截断 = MVP 压缩
    return persist(agentId);
  }

  function ingest(agentId: AgentId, entry: { intent: string; text: string }): void {
    let turns = memories.get(agentId);
    if (turns === undefined) {
      turns = [];
      memories.set(agentId, turns);
    }
    turns.push({ ts: new Date().toISOString(), intent: entry.intent, text: entry.text });
    if (turns.length > AUTO_COMPACT_AT) turns.splice(0, turns.length - COMPACT_KEEP);
  }

  return { mount, projection, compact, persist, ingest };
}
