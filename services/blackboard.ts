// Version: 1.0.0
/**
 * Blackboard 服务（§4.2）：D1 写穿（先落盘为 bb_set 事件、后生效）+ applyEvent 恢复双路径。
 *
 * 实现要点：
 * - 扁平键值表：点路径（protagonist.hp）只是命名约定（D26 前缀/D7 引用），不是嵌套结构。
 * - set() 写穿：先 eventLog.append(bb_set) 成功、后改内存；落盘失败写入不生效并返回
 *   PERSIST_FAILED（D1/错误矩阵：调用方上抛致命 → 终止局）。
 * - 信封来源：bb_set 事件需要 ts/run_id/branch/exec，而冻结的 set() 签名与工厂签名都不携带
 *   run 上下文（契约缺口，见汇报）。裁决：run_id/branch 读自 EventLogFileContext 增量面，
 *   exec 经 bindExec() 由 FlowRunner 在节点边界绑定；上下文缺失时 set() 返回 PERSIST_FAILED
 *   （写入不生效，D1 安全方向）。
 * - D26 命名空间写者校验不在本层（黑板不知调用方身份）：由 bb_set 元组件按可写前缀声明校验。
 * - applyEvent() 恢复路径（§4 恢复纪律：不写穿、不通知、不落盘）：bb_set → 改内存；
 *   snapshot → 黑板段整体采纳（§2.3 快照四段之一）。
 */
import type { BlackboardKey, Event, NodeExec } from '../schema/event.ts';
import type { BlackboardErrorKind, Result } from '../schema/errors.ts';
import type { Blackboard, EventLog } from './types.ts';
import type { EventLogFileContext } from './event-log.ts';

/** Blackboard 具体实现的增量面（冻结接口之外的运行上下文绑定）。 */
export interface BlackboardRunContext extends Blackboard {
  /** 绑定当前节点执行标识（bb_set 信封 exec 的唯一来源；FlowRunner 于节点边界绑定，节点间绑 null）。 */
  bindExec(exec: NodeExec | null): void;
}

export function createBlackboard(deps: { eventLog: EventLog }): BlackboardRunContext {
  const data = new Map<string, unknown>();
  let exec: NodeExec | null = null;

  function get(key: BlackboardKey): unknown {
    return data.get(key); // 键不存在返回 undefined，不是错误（§4.2）
  }

  function set(key: BlackboardKey, value: unknown): Result<void, BlackboardErrorKind> {
    const el = deps.eventLog as EventLogFileContext; // 组合根装配的即本仓 EventLog 实现
    const runId = el.currentRunId?.() ?? null;
    const branch = el.currentBranch?.() ?? 'main';
    if (runId === null || exec === null) return { ok: false, error: 'PERSIST_FAILED' }; // 无信封上下文无法写穿
    const r = deps.eventLog.append({
      ts: new Date().toISOString(),
      run_id: runId,
      branch,
      exec,
      type: 'bb_set',
      payload: { key, value },
    });
    if (!r.ok) return { ok: false, error: 'PERSIST_FAILED' }; // 落盘失败 → 写入不生效（D1）
    data.set(key, value); // 先落盘、后生效
    return { ok: true, value: undefined };
  }

  function applyEvent(event: Event): void {
    if (event.type === 'bb_set') {
      data.set(event.payload.key, event.payload.value);
      return;
    }
    if (event.type === 'snapshot') {
      data.clear();
      for (const [k, v] of Object.entries(event.payload.blackboard)) data.set(k, v);
    }
  }

  function snapshot(): Record<string, unknown> {
    return Object.fromEntries(data); // 纯函数快照副本（D7 分支求值/D9 批前快照）
  }

  return {
    get,
    set,
    applyEvent,
    snapshot,
    bindExec: (e) => {
      exec = e;
    },
  };
}
