// Version: 1.0.0
/**
 * AgentService（§4.1）：实例表 + §3.1 状态机 + steering/follow-up 双队列（D4）+ runTurn 单次 LLM 往返。
 *
 * 实现要点：
 * - runTurn = 单次 LLM 往返（§4.1 粒度裁决）：IDLE→RUNNING 由回合首次调用进入（落 turn_start），
 *   final 退出（落 turn_end）；tool_calls 停留 RUNNING，组件携带工具结果再次调用（§2.2 层纪律）。
 *   busy（单次往返在飞）是 AGENT_BUSY 守卫粒度（pi 状态保护），与生命周期 RUNNING（回合开放）分离。
 * - 上下文组装为纯函数渲染：system = 身份牌渲染段（静态前缀，prompt_hash 的哈希对象，D16）；
 *   prompt 动态段 = 记忆投影（L5）→ 黑板快照 → 导演注入（whisper 近尾部、绝不进静态前缀）→ 意图 → 工具结果。
 * - 双队列消费（D4 的 MVP 裁决）：每次往返开始排空 steering（优先）或 follow-up 注入动态段——
 *   生效粒度 = 下一往返边界（即 pi 的 tool 边界语义）。
 * - abort 经 AbortSignal 内部注册：外部 signal 与 abort() 汇入内部 AbortController 传给网关；
 *   响应已成功仍照落 cost（D36：真实花费不作废），再按 aborted 关账。
 * - fallback（D13）：重试在网关内；提供商侧最终失败由本服务主动走 gateway.fallback 同能力级链；
 *   TRUNCATED/SCHEMA_MISMATCH 不降级（D6 重发后仍截断/D17 判定路径），直接编码进结果。
 *   链耗尽 → A8：agent_error + turn_end(failed) + 转 ERROR，错误编码进 TurnOutcome（保留现场）。
 * - 服务事实（D35）自动落：agent_*、turn_*、prompt_hash、cost。信封 run_id/branch 读自
 *   EventLogFileContext 增量面，exec 经 bindExec() 由 FlowRunner 在节点边界绑定（冻结接口无
 *   run 上下文通道——契约缺口，见汇报）。事实落不了 = 致命，操作返回 TURN_FAILED 由执行器升级。
 * - create() 先过 checkIdentityCardModelFields 守卫再过 IdentityCardV1Schema，违规即抛
 *   （§4：异常仅保留给编程错误——D20 漏检才会到这；身份与 LLM 解耦的机械保证）。
 * - TurnOutcome 映射：LLMResponse 无 tools/reasoning 通道（契约缺口，见汇报）——MVP 走 JSON 约定：
 *   object 含合法 tool_calls 数组 → tool_calls；其余 object → final（JSON 文本化）；取 object.reasoning。
 *
 * 冻结接口之外的增量面（AgentServiceEx，FlowRunner 装配后使用）：
 * bindExec（节点执行标识绑定）、applyEvent（§4 恢复路径：重建生命周期，不发射不沉淀）、
 * pauseAll/resumeAll（A6/A7）、recover（A9 导演决策重试/跳过）、restoreSpec（占位实例按名册回填 spec）。
 */
import { createHash } from 'node:crypto';
import {
  IdentityCardV1Schema,
  checkIdentityCardModelFields,
  type IdentityCardV1,
} from '../schema/identity-card.ts';
import {
  type AgentLifecycleState,
  type CostAmount,
  type DirectorDirective,
  type Event,
  type EventDraft,
  type NodeExec,
  type AgentId,
} from '../schema/event.ts';
import { ToolCallRequestSchema, type ToolCallRequest, type TurnOutcome } from '../schema/meta-component.ts';
import type { AgentServiceErrorKind, ErrorCode, Result } from '../schema/errors.ts';
import type { ModelBinding } from '../schema/bundle.ts';
import type {
  AgentService,
  AgentSpec,
  Blackboard,
  EventLog,
  LLMGateway,
  LLMRequest,
  LLMResponse,
  MemoryService,
  TurnContext,
} from './types.ts';
import type { EventLogFileContext } from './event-log.ts';
import type { LLMGatewayPricing } from './llm-gateway.ts';
import type { MemoryServiceEx } from './memory.ts';

/** AgentService 具体实现的增量面（运行上下文绑定 + 恢复路径 + 暂停/恢复联动）。 */
export interface AgentServiceEx extends AgentService {
  /** 绑定当前节点执行标识（服务事实信封 exec 的唯一来源；FlowRunner 于节点边界绑定，节点间绑 null）。 */
  bindExec(exec: NodeExec | null): void;
  /** 恢复路径（§4 恢复纪律）：replay 重建生命周期表；只改状态，不发射、不沉淀。 */
  applyEvent(event: Event): void;
  /** A6：所有 RUNNING 实例转 PAUSED（执行器暂停且到达安全点）。 */
  pauseAll(): Result<void, AgentServiceErrorKind>;
  /** A7：所有 PAUSED 实例回 RUNNING（执行器恢复）。 */
  resumeAll(): Result<void, AgentServiceErrorKind>;
  /** A9：ERROR 实例经导演/系统决策重试或跳过，回 IDLE。 */
  recover(id: AgentId, strategy: 'retry' | 'skip'): Result<void, AgentServiceErrorKind>;
  /**
   * 恢复配套（§2.3）：replay 重建的占位实例按 Bundle 名册回填 spec（身份牌 + 模型绑定）。
   * 恢复纪律：不发射、不沉淀、不做状态迁移；实例不存在（名册是声明面，节点尚未创建）/已有 spec/已销毁均幂等跳过。
   */
  restoreSpec(spec: AgentSpec): Result<void, AgentServiceErrorKind>;
}

interface AgentInstance {
  id: AgentId;
  spec: AgentSpec | null; // null = replay 重建的占位实例（恢复后须由 create 按 Bundle 填实）
  state: AgentLifecycleState;
  steering: DirectorDirective[];
  followUp: DirectorDirective[];
  busy: boolean; // 单次 LLM 往返在飞（AGENT_BUSY 守卫）
  abortRequested: boolean;
  innerAbort: AbortController | null;
  turnsCompleted: number;
}

/** 身份牌渲染（静态前缀本体；渲染器纯函数——同输入逐字稳定，D16 的机械前提）。 */
function renderCard(card: IdentityCardV1): string {
  const parts = [`你是 ${card.name}。`, card.description];
  if (card.personality !== undefined) parts.push(`性格：${card.personality}`);
  if (card.scenario !== undefined) parts.push(`场景：${card.scenario}`);
  return parts.join('\n');
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** TurnOutcome 映射（JSON 约定通道，见文件头）。 */
function toOutcome(resp: LLMResponse): TurnOutcome {
  const obj = resp.object;
  if (obj !== null && typeof obj === 'object' && !Array.isArray(obj)) {
    const o = obj as Record<string, unknown>;
    const reasoning = typeof o.reasoning === 'string' ? o.reasoning : undefined;
    if (Array.isArray(o.tool_calls) && o.tool_calls.length > 0) {
      const calls = o.tool_calls.map((c) => ToolCallRequestSchema.safeParse(c));
      if (calls.every((c) => c.success)) {
        return { kind: 'tool_calls', calls: calls.map((c) => (c as { success: true; data: ToolCallRequest }).data), reasoning };
      }
    }
    return { kind: 'final', text: JSON.stringify(obj), reasoning };
  }
  return { kind: 'final', text: resp.text };
}

export function createAgentService(deps: {
  gateway: LLMGateway;
  memory: MemoryService;
  blackboard: Blackboard;
  eventLog: EventLog;
}): AgentServiceEx {
  const instances = new Map<AgentId, AgentInstance>();
  let currentExec: NodeExec | null = null;

  /** 服务事实落盘（D35）：信封盖章 + 追加；上下文未绑定或落盘失败 = 致命（TURN_FAILED 上抛）。 */
  function emitFact(build: (runId: string, branch: string, exec: NodeExec) => EventDraft): Result<Event, 'TURN_FAILED'> {
    const el = deps.eventLog as EventLogFileContext;
    const runId = el.currentRunId?.() ?? null;
    const branch = el.currentBranch?.() ?? 'main';
    if (runId === null || currentExec === null) return { ok: false, error: 'TURN_FAILED' };
    const r = deps.eventLog.append(build(runId, branch, currentExec));
    return r.ok ? { ok: true, value: r.value } : { ok: false, error: 'TURN_FAILED' };
  }

  function draftOf(type: EventDraft['type'], inst: AgentInstance, extra: Record<string, unknown>) {
    return (run_id: string, branch: string, exec: NodeExec): EventDraft =>
      ({ ts: new Date().toISOString(), run_id, branch, exec, type, payload: { agent_id: inst.id, ...extra } }) as EventDraft;
  }

  function emitLifecycle(
    inst: AgentInstance,
    type: 'agent_created' | 'agent_destroyed' | 'agent_paused' | 'agent_resumed' | 'agent_error' | 'agent_recovered',
    extra: Record<string, unknown>,
  ): Result<Event, 'TURN_FAILED'> {
    return emitFact(draftOf(type, inst, extra));
  }

  function emitTurnEnd(inst: AgentInstance, outcome: 'final' | 'aborted' | 'failed'): Result<Event, 'TURN_FAILED'> {
    return emitFact(draftOf('turn_end', inst, { outcome }));
  }

  function guard(id: AgentId): Result<AgentInstance, AgentServiceErrorKind> {
    const inst = instances.get(id);
    if (inst === undefined || inst.spec === null) return { ok: false, error: 'AGENT_NOT_FOUND' };
    if (inst.state === 'DESTROYED') return { ok: false, error: 'AGENT_DESTROYED' };
    return { ok: true, value: inst };
  }

  /** A8 关账：错误编码进 TurnOutcome、保留现场（双队列不清空）。 */
  function failTurn(inst: AgentInstance, error: ErrorCode): Result<TurnOutcome, AgentServiceErrorKind> {
    if (inst.state === 'RUNNING') {
      emitLifecycle(inst, 'agent_error', { error }); // 事实落不了不掩盖原失败（致命将由后续操作再撞）
      emitTurnEnd(inst, 'failed');
    }
    inst.state = 'ERROR';
    return { ok: true, value: { kind: 'error', error } };
  }

  /** abort 关账：turn_end(aborted) → IDLE（R8 安全点优雅终止后的实例侧落定）。 */
  function closeAborted(inst: AgentInstance): Result<TurnOutcome, AgentServiceErrorKind> {
    if (inst.state === 'RUNNING') emitTurnEnd(inst, 'aborted');
    inst.state = 'IDLE';
    inst.abortRequested = false;
    return { ok: false, error: 'TURN_ABORTED' };
  }

  function create(spec: AgentSpec): Result<void, AgentServiceErrorKind> {
    const existing = instances.get(spec.id);
    if (existing !== undefined && existing.spec !== null) return { ok: false, error: 'AGENT_ALREADY_EXISTS' };
    if (existing !== undefined && existing.state === 'DESTROYED') return { ok: false, error: 'AGENT_DESTROYED' };
    // 身份与 LLM 解耦的机械保证：守卫 + schema 双检；能到这的违规 = 上游 D20 漏检的编程错误（§4 异常纪律）
    const guardResult = checkIdentityCardModelFields(spec.identityCard);
    if (!guardResult.ok) throw new Error(`身份牌含禁规模型字段（身份与 LLM 解耦违例）: ${guardResult.fields.join(', ')}`);
    IdentityCardV1Schema.parse(spec.identityCard);
    const inst: AgentInstance = existing ?? {
      id: spec.id, spec: null, state: 'CREATED', steering: [], followUp: [],
      busy: false, abortRequested: false, innerAbort: null, turnsCompleted: 0,
    };
    inst.spec = spec;
    // A1+A2（并入 agent_created）：CREATED→IDLE；memory_ref 不在 AgentSpec 内（契约缺口），记 null
    const r = emitLifecycle(inst, 'agent_created', {
      card_name: spec.identityCard.name,
      card_version: spec.identityCard.version,
      model: spec.modelBinding.model,
      memory_ref: null,
    });
    if (!r.ok) return { ok: false, error: r.error };
    inst.state = 'IDLE';
    instances.set(spec.id, inst);
    return { ok: true, value: undefined };
  }

  function destroy(id: AgentId): Result<void, AgentServiceErrorKind> {
    const g = guard(id);
    if (!g.ok) return g;
    const inst = g.value;
    if (inst.state === 'RUNNING') return { ok: false, error: 'AGENT_BUSY' }; // 不变式：须先 abort 走 A8（§3.1）
    // A10：持久化记忆（destroy 同步语义，persist 异步触发不等待——实现裁决，见汇报）、释放实例
    void (deps.memory as MemoryServiceEx).persist(id).catch(() => {});
    const r = emitLifecycle(inst, 'agent_destroyed', { reason: 'explicit_destroy' });
    if (!r.ok) return { ok: false, error: r.error }; // 落盘失败不生效（D1 同构）
    inst.state = 'DESTROYED';
    return { ok: true, value: undefined };
  }

  function steer(id: AgentId, msg: DirectorDirective): Result<void, AgentServiceErrorKind> {
    const g = guard(id);
    if (!g.ok) return g;
    g.value.steering.push(msg); // 入队，下一安全点（下一往返边界）生效（D3/D4）
    return { ok: true, value: undefined };
  }

  function followUp(id: AgentId, msg: DirectorDirective): Result<void, AgentServiceErrorKind> {
    const g = guard(id);
    if (!g.ok) return g;
    g.value.followUp.push(msg); // turn_end 时 steering 为空则消费（A5）
    return { ok: true, value: undefined };
  }

  function abort(id: AgentId): Result<void, AgentServiceErrorKind> {
    const g = guard(id);
    if (!g.ok) return g;
    const inst = g.value;
    if (inst.state === 'RUNNING') {
      inst.abortRequested = true;
      inst.innerAbort?.abort(); // AbortSignal 内部注册：打断在飞往返
    }
    return { ok: true, value: undefined }; // 非 RUNNING = 已在安全点，幂等
  }

  async function runTurn(id: AgentId, ctx: TurnContext, signal: AbortSignal): Promise<Result<TurnOutcome, AgentServiceErrorKind>> {
    const g = guard(id);
    if (!g.ok) return g;
    const inst = g.value;
    if (inst.busy) return { ok: false, error: 'AGENT_BUSY' }; // 单次往返在飞（pi 状态保护）
    if (inst.state === 'PAUSED' || inst.state === 'ERROR') return { ok: false, error: 'AGENT_BUSY' }; // 须 resume/recover（A7/A9）
    if (inst.abortRequested) return closeAborted(inst); // 回合开放期收到 abort：关账
    if (signal.aborted) return { ok: false, error: 'TURN_ABORTED' };

    // 取消链（§4.7 逐环传递）：外部 signal 与 abort() 汇入内部 AbortController
    const inner = new AbortController();
    const onExternal = () => inner.abort();
    signal.addEventListener('abort', onExternal, { once: true });
    inst.innerAbort = inner;
    inst.busy = true;
    try {
      return await runTurnInner(inst, ctx, inner.signal);
    } finally {
      signal.removeEventListener('abort', onExternal);
      inst.innerAbort = null;
      inst.busy = false;
    }
  }

  async function runTurnInner(inst: AgentInstance, ctx: TurnContext, signal: AbortSignal): Promise<Result<TurnOutcome, AgentServiceErrorKind>> {
    const spec = inst.spec as AgentSpec;
    const firstOfTurn = inst.state !== 'RUNNING';
    if (firstOfTurn) {
      // A4 IDLE→RUNNING：turn_start 先落（服务事实落不了则回合不开局）
      const ts = emitFact(draftOf('turn_start', inst, { first_turn: inst.turnsCompleted === 0 }));
      if (!ts.ok) return { ok: false, error: ts.error };
      inst.state = 'RUNNING';
      // D16：每回合静态前缀 SHA256（身份牌渲染段；hash 变化 = 预期缓存命中率归零）
      const ph = emitFact(draftOf('prompt_hash', inst, { prefix_sha256: sha256Hex(renderCard(spec.identityCard)) }));
      if (!ph.ok) return { ok: false, error: ph.error };
    }

    // 双队列消费（D4 的 MVP 裁决：下一往返边界生效；steering 优先，空则 follow-up）
    const injected = inst.steering.splice(0);
    if (injected.length === 0) injected.push(...inst.followUp.splice(0));

    // 上下文组装（纯函数渲染，无 LLM 调用）：身份牌进 system（静态前缀，prompt_hash 的哈希对象），
    // 记忆投影 + 黑板快照 + 注入 + 意图 + 工具结果进 prompt 动态段（置尾）
    const proj = deps.memory.projection(inst.id);
    const memoryText = proj.ok ? String(proj.value) : ''; // 未挂载/空记忆 = 空投影（新实例合法态）
    const prompt = renderTurnPrompt({
      memoryText,
      blackboard: deps.blackboard.snapshot(),
      injected,
      ctx,
    });
    const req: LLMRequest = { prompt, system: renderCard(spec.identityCard), ...samplingParams(spec.modelBinding) };

    // LLM 调用 + 同能力级 fallback 链（D13：重试在网关内，链式降级由本服务主动触发）
    const gw = deps.gateway as LLMGatewayPricing;
    const routed = deps.gateway.route(spec.modelBinding.model);
    if (!routed.ok) return failTurn(inst, routed.error);
    let decision = routed.value;
    let result = await deps.gateway.call(decision, req, signal);
    while (!result.ok && isProviderSide(result.error) && !signal.aborted) {
      const fb = deps.gateway.fallback(decision, result.error);
      if (!fb.ok) {
        result = { ok: false, error: fb.error };
        break;
      }
      decision = fb.value;
      result = await deps.gateway.call(decision, req, signal);
    }

    // abort 生效：响应已成功则真实花费照落（D36 cost 不作废），随后按 aborted 关账
    if (inst.abortRequested || signal.aborted) {
      if (result.ok) appendCost(inst, spec, result.value, decision.model, gw);
      return closeAborted(inst);
    }
    if (!result.ok) return failTurn(inst, result.error); // A8

    // cost（D16 双轨：价格表计算值 + 原始 usage；按实际出账模型归因，fallback 可溯）
    const c = appendCost(inst, spec, result.value, decision.model, gw);
    if (!c.ok) return { ok: false, error: c.error };

    const outcome = toOutcome(result.value);
    if (outcome.kind === 'final') {
      // A5 RUNNING→IDLE：F17 回合沉淀（记忆唯一写入面）+ turn_end 关账
      (deps.memory as MemoryServiceEx).ingest(inst.id, { intent: ctx.intent, text: outcome.text });
      const te = emitTurnEnd(inst, 'final');
      if (!te.ok) return { ok: false, error: te.error };
      inst.state = 'IDLE';
      inst.turnsCompleted += 1;
    }
    return { ok: true, value: outcome }; // tool_calls：停留 RUNNING，组件驱动工具循环（§2.2）
  }

  /** cost 事件（D16）：价格表缺失降级 {0, UNKNOWN} 不阻断回合（账单失真优于回合丢失，见汇报）。 */
  function appendCost(
    inst: AgentInstance,
    spec: AgentSpec,
    resp: LLMResponse,
    decidedModel: string,
    gw: LLMGatewayPricing,
  ): Result<Event, 'TURN_FAILED'> {
    const cost: CostAmount =
      gw.priceOf?.(resp.model, resp.usage) ?? gw.priceOf?.(decidedModel, resp.usage) ?? { amount: 0, currency: 'UNKNOWN' };
    return emitFact(
      draftOf('cost', inst, {
        model: resp.model,
        requested_model: spec.modelBinding.model,
        usage: resp.usage,
        cost,
        raw_usage: resp.rawUsage ?? null,
      }),
    );
  }

  function pauseAll(): Result<void, AgentServiceErrorKind> {
    for (const inst of instances.values()) {
      if (inst.state !== 'RUNNING') continue; // 仅 RUNNING→PAUSED（§3.1 无 IDLE→PAUSED 边）
      const r = emitLifecycle(inst, 'agent_paused', {});
      if (!r.ok) return { ok: false, error: r.error };
      inst.state = 'PAUSED';
    }
    return { ok: true, value: undefined };
  }

  function resumeAll(): Result<void, AgentServiceErrorKind> {
    for (const inst of instances.values()) {
      if (inst.state !== 'PAUSED') continue;
      const r = emitLifecycle(inst, 'agent_resumed', {});
      if (!r.ok) return { ok: false, error: r.error };
      inst.state = 'RUNNING';
    }
    return { ok: true, value: undefined };
  }

  function recover(id: AgentId, strategy: 'retry' | 'skip'): Result<void, AgentServiceErrorKind> {
    const g = guard(id);
    if (!g.ok) return g;
    const inst = g.value;
    if (inst.state !== 'ERROR') return { ok: false, error: 'AGENT_BUSY' }; // A9 只从 ERROR 出
    const r = emitLifecycle(inst, 'agent_recovered', { strategy });
    if (!r.ok) return { ok: false, error: r.error };
    inst.state = 'IDLE';
    return { ok: true, value: undefined };
  }

  function applyEvent(event: Event): void {
    const payload = event.payload as Record<string, unknown>;
    const agentId = typeof payload.agent_id === 'string' ? payload.agent_id : null;
    if (event.type === 'snapshot') {
      // 快照 Agent 生命周期表整体采纳（§2.3 快照四段之二）
      for (const [id, a] of Object.entries((event.payload as { agents: Record<string, { state: AgentLifecycleState }> }).agents)) {
        const inst = instances.get(id) ?? placeholder(id);
        inst.state = a.state;
        instances.set(id, inst);
      }
      return;
    }
    if (agentId === null) return;
    const inst = instances.get(agentId) ?? placeholder(agentId);
    instances.set(agentId, inst);
    switch (event.type) {
      case 'agent_created': if (inst.state !== 'DESTROYED') inst.state = 'IDLE'; break;
      case 'agent_destroyed': inst.state = 'DESTROYED'; break;
      case 'turn_start': if (inst.state !== 'DESTROYED') inst.state = 'RUNNING'; break;
      case 'turn_end': if (inst.state !== 'DESTROYED') inst.state = 'IDLE'; break;
      case 'agent_paused': inst.state = 'PAUSED'; break;
      case 'agent_resumed': inst.state = 'RUNNING'; break;
      case 'agent_error': inst.state = 'ERROR'; break;
      case 'agent_recovered': inst.state = 'IDLE'; break;
      default: break; // 非生命周期事件与本服务无关
    }
  }

  function placeholder(id: AgentId): AgentInstance {
    return {
      id, spec: null, state: 'IDLE', steering: [], followUp: [],
      busy: false, abortRequested: false, innerAbort: null, turnsCompleted: 0,
    };
  }

  /** 恢复配套（§2.3）：占位实例按名册回填 spec；身份牌机械守卫与 create 同构（不发射、不迁移状态）。 */
  function restoreSpec(spec: AgentSpec): Result<void, AgentServiceErrorKind> {
    const inst = instances.get(spec.id);
    if (inst === undefined || inst.spec !== null || inst.state === 'DESTROYED') return { ok: true, value: undefined }; // 幂等跳过
    const guardResult = checkIdentityCardModelFields(spec.identityCard);
    if (!guardResult.ok) throw new Error(`身份牌含禁规模型字段（身份与 LLM 解耦违例）: ${guardResult.fields.join(', ')}`);
    IdentityCardV1Schema.parse(spec.identityCard);
    inst.spec = spec;
    return { ok: true, value: undefined };
  }

  return {
    create, destroy, steer, followUp, abort, runTurn,
    bindExec: (e) => { currentExec = e; },
    applyEvent, pauseAll, resumeAll, recover, restoreSpec,
  };
}

/** 提供商侧失败（可降级）判定：TRUNCATED（D6 重发后仍截断）与 SCHEMA_MISMATCH（D17 判定路径）不降级。 */
function isProviderSide(kind: ErrorCode): boolean {
  return kind !== 'TRUNCATED' && kind !== 'SCHEMA_MISMATCH' && kind !== 'NO_FALLBACK_AVAILABLE';
}

/** 采样参数透传（L0：ModelBinding.params 的 temperature/max_tokens 映射到 LLMRequest）。 */
function samplingParams(binding: ModelBinding): Pick<LLMRequest, 'temperature' | 'maxTokens'> {
  const p = binding.params ?? {};
  return {
    temperature: typeof p.temperature === 'number' ? p.temperature : undefined,
    maxTokens: typeof p.max_tokens === 'number' ? p.max_tokens : undefined,
  };
}

/** 回合 prompt 动态段组装（四区结构，附录 A：静态身份区在 system；动态段置尾，whisper 近尾部）。 */
function renderTurnPrompt(args: {
  memoryText: string;
  blackboard: Record<string, unknown>;
  injected: readonly DirectorDirective[];
  ctx: TurnContext;
}): string {
  const sections: string[] = [];
  if (args.memoryText !== '') sections.push(`# 记忆摘要\n${args.memoryText}`);
  const bbKeys = Object.keys(args.blackboard);
  if (bbKeys.length > 0) sections.push(`# 公共状态\n${JSON.stringify(args.blackboard, null, 2)}`);
  for (const d of args.injected) sections.push(`# 导演干预（${d.kind}）\n${d.text}`); // L8 注入区：绝不进静态前缀
  sections.push(`# 本回合意图\n${args.ctx.intent}`);
  for (const tr of args.ctx.toolResults ?? []) {
    // 容忍补丁（裁决 3-D-2）：CallAgentParams.tool_results 契约形态为 {call_id, content}，
    // 工具名在契约边界丢失（3-B 映射层填空串）——渲染时以 call_id 为锚，空名不输出括号
    const label = tr.call.name !== '' ? `${tr.call.name}(${tr.call.call_id})` : tr.call.call_id;
    sections.push(`# 工具结果 ${label}\n${JSON.stringify(tr.result)}`);
  }
  return sections.join('\n\n');
}
