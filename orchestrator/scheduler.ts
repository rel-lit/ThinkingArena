// Version: 1.0.0
/**
 * 调度器（首局范围：线性推进 + 回边迭代计数 + 条件分支，§0.2）。
 * 调度进度 = （节点 id, 迭代计数）元组（§3.3）；回边重入 = 无状态新执行、计数递增。
 * 出边排他（首局无并行）：按 order 升序（缺省按声明序）逐条求值，第一条成立（或无条件）的边胜出；
 * 被求值的条件边落 branch_decision（含被引用键子集快照，D7）；全部不成立 = 图走完。
 * 引用不存在的键 / 类型不可比 = 配置错误（F14），经返回值上报走节点 on_error。
 */
import type { ConditionExpr, ConditionOperand, FlowEdge } from '../schema/flow.ts';
import type { Result } from '../schema/errors.ts';

/** 调度进度键（snapshot progress 段与 reducer 共用）："节点id#迭代计数"（§3.3）。 */
export function progressKey(nodeId: string, iteration: number): string {
  return `${nodeId}#${iteration}`;
}

/** 条件引用的黑板键全集（branch_decision 快照子集裁剪用，D7）。 */
export function collectRefs(expr: ConditionExpr, out: Set<string> = new Set()): Set<string> {
  if (expr.op === 'and' || expr.op === 'or') {
    for (const a of expr.args) collectRefs(a, out);
  } else if (expr.op === 'not') {
    collectRefs(expr.arg, out);
  } else {
    for (const o of [expr.left, expr.right]) if (isRef(o)) out.add(o.ref);
  }
  return out;
}

function isRef(o: ConditionOperand): o is { ref: string } {
  return typeof o === 'object' && o !== null && 'ref' in o;
}

/** 缺键哨兵：ref 引用不存在时的操作数占位（运行时态键缺失 ≠ 配置错误，架构师裁决 2026-08-01）。 */
const MISSING = Symbol('missing-ref');

/** 操作数求值：字面量直返；ref 经 get 读取，键不存在（undefined）→ MISSING 哨兵（比较整体求值为 false，不再判配置错误）。 */
function evalOperand(o: ConditionOperand, get: (key: string) => unknown): Result<unknown, string> {
  if (!isRef(o)) return { ok: true, value: o };
  const v = get(o.ref);
  return v === undefined ? { ok: true, value: MISSING } : { ok: true, value: v };
}

/** 缺键时的引用名（用于 system 事件归因）。 */
function missingRefOf(o: ConditionOperand): string | null {
  return isRef(o) ? o.ref : null;
}

/** 深比较规范化：对象按排序键 JSON，标量直返（条件字面量集不含数组/对象，ref 值可能为任意 JSON）。 */
function canonical(v: unknown): unknown {
  if (typeof v !== 'object' || v === null) return v;
  return JSON.stringify(v, Object.keys(v as object).sort());
}

/** 条件表达式求值（D7 封闭算子集，纯函数）。错误为配置错误说明（detail 文本）。
 *  运行时缺键：比较整体求值为 false 并经 onMissingRef 上报（裁决：LLM 产出的运行时态键缺席是常态，
 *  不应判节点失败；算子非法/类型不可比仍是配置错误）。 */
export function evalCondition(
  expr: ConditionExpr,
  get: (key: string) => unknown,
  onMissingRef?: (ref: string) => void,
): Result<boolean, string> {
  switch (expr.op) {
    case 'and':
    case 'or': {
      for (const a of expr.args) {
        const r = evalCondition(a, get, onMissingRef);
        if (!r.ok) return r;
        if (expr.op === 'and' && !r.value) return { ok: true, value: false };
        if (expr.op === 'or' && r.value) return { ok: true, value: true };
      }
      return { ok: true, value: expr.op === 'and' };
    }
    case 'not': {
      const r = evalCondition(expr.arg, get, onMissingRef);
      return r.ok ? { ok: true, value: !r.value } : r;
    }
    default: {
      const l = evalOperand(expr.left, get);
      if (!l.ok) return l;
      const r = evalOperand(expr.right, get);
      if (!r.ok) return r;
      if (l.value === MISSING || r.value === MISSING) {
        onMissingRef?.(l.value === MISSING ? missingRefOf(expr.left)! : missingRefOf(expr.right)!);
        return { ok: true, value: false };
      }
      if (expr.op === 'eq') return { ok: true, value: canonical(l.value) === canonical(r.value) };
      if (expr.op === 'neq') return { ok: true, value: canonical(l.value) !== canonical(r.value) };
      if (typeof l.value !== 'number' || typeof r.value !== 'number') {
        return { ok: false, error: `比较算子 ${expr.op} 要求数字操作数，实得 ${typeof l.value}/${typeof r.value}` };
      }
      const [a, b] = [l.value, r.value];
      return {
        ok: true,
        value: expr.op === 'gt' ? a > b : expr.op === 'gte' ? a >= b : expr.op === 'lt' ? a < b : a <= b,
      };
    }
  }
}

/** branch_decision 事件载荷（不含信封；D7：条件 JSON 快照 + 被引用键子集 + 结果 + 端口与目标）。 */
export interface BranchDecisionPayload {
  condition: unknown;
  snapshot: Record<string, unknown>;
  result: boolean;
  from_port: string;
  target_node: string;
}

export interface OutEdgeDecision {
  /** 已求值条件边的 branch_decision 载荷（求值失败时已成功部分照常返回落盘，错误矩阵）。 */
  decisions: BranchDecisionPayload[];
  /** 被采用的下一节点 id；null = 无出边成立（图走完）。 */
  next: string | null;
}

/**
 * 出边决策（排他语义）：按 order 排序逐条求值，第一条成立（或无条件）的边胜出。
 * 失败 = 配置错误（detail 文本），FlowRunner 按节点 on_error 处理。
 */
export function decideOutEdge(
  nodeId: string,
  edges: readonly FlowEdge[],
  get: (key: string) => unknown,
  onMissingRef?: (ref: string) => void,
): Result<OutEdgeDecision, string> {
  const outs = edges
    .map((e, i) => ({ e, i }))
    .filter((x) => x.e.from === nodeId)
    .sort((a, b) => (a.e.order ?? a.i) - (b.e.order ?? b.i));
  const decisions: BranchDecisionPayload[] = [];
  for (const { e } of outs) {
    if (!e.condition) return { ok: true, value: { decisions, next: e.to } };
    const r = evalCondition(e.condition, get, onMissingRef);
    if (!r.ok) return { ok: false, error: r.error };
    const snapshot: Record<string, unknown> = {};
    for (const key of collectRefs(e.condition)) snapshot[key] = get(key) ?? null;
    decisions.push({ condition: e.condition, snapshot, result: r.value, from_port: e.from_port, target_node: e.to });
    if (r.value) return { ok: true, value: { decisions, next: e.to } };
  }
  return { ok: true, value: { decisions, next: null } };
}
