// Version: 1.0.0
/**
 * 内置元组件实现：§4.7 名册六件（契约冻结）+ 注册表扩展四件
 *（名册「签名级列举，非穷举」；角色生命周期与导演双档无名册通道，组件又不许持有服务句柄）：
 * create_agent / destroy_agent / steer_agent / follow_up_agent。
 *
 * 实现级裁决：
 * - bb_set = 先经 emit 同一通道落 bb_set 事件（D31 reason 入载荷）、再以 applyEvent 生效。
 *   写穿语义不变（事件在前、生效在后）；冻结的 Blackboard.set 无 reason/exec 通道（见汇报）。
 * - inject_context 经 agentService.steer（whisper/steering 档）注入私有上下文（L8）——
 *   冻结的 AgentService 无独立 inject 通道；agent_to_agent 事件由组件显式发射（D35），不在此落。
 * - await_director_input 透传 timeoutPolicy，D15 超时计时归泵侧（架构师裁决：泵持有游标与指令流）；
 *   返回结构化 AwaitOutcome，gate_* 事件全部由门组件落（D35）。
 */
import { z } from 'zod';
import type { ErrorCode, Result } from '../schema/errors.ts';
import type { Event, EventDraft } from '../schema/event.ts';
import { AgentIdSchema, DirectorDirectiveSchema } from '../schema/event.ts';
import { ModelBindingSchema } from '../schema/bundle.ts';
import { IdentityCardV1Schema } from '../schema/identity-card.ts';
import type {
  AwaitDirectorInputParams,
  BbGetParams,
  BbSetParams,
  CallAgentParams,
  ComponentContext,
  EmitEventParams,
  InjectContextParams,
  MetaComponent,
} from '../schema/meta-component.ts';
import { BUILTIN_META_COMPONENTS } from '../schema/meta-component.ts';
import type { DirectorPump } from '../orchestrator/types.ts';
import type { AgentService, Blackboard, EventLog, MemoryService } from '../services/types.ts';
import type { EnvelopeSource, MetaEnvelope } from './registry.ts';

export interface BuiltinDeps {
  agentService: AgentService;
  memory: MemoryService;
  blackboard: Blackboard;
  eventLog: EventLog;
  directorPump?: DirectorPump;
  envelopeSource?: EnvelopeSource;
}

/** await_director_input 的结构化返回（门组件据此落 G1–G8 事件）。 */
export type AwaitOutcome =
  | { outcome: 'received'; directive: z.infer<typeof DirectorDirectiveSchema>; source: 'director_inbox' | 'timeout_default'; waited_ms: number }
  | { outcome: 'cancelled'; reason: 'run_cancelled' | 'timeout_cancel_branch'; waited_ms: number }
  | { outcome: 'node_failed' }; // 泵侧 NODE_FAILED（D37 运行期兜底：第二门进入 WAITING）

const ok = <T>(value: T): Result<T, ErrorCode> => ({ ok: true, value });
const fail = (error: ErrorCode): Result<never, ErrorCode> => ({ ok: false, error });

export function createBuiltinMetaComponents(deps: BuiltinDeps): MetaComponent[] {
  const envelope = (): MetaEnvelope | null => deps.envelopeSource?.current() ?? null;

  /** emit 共用通道：补信封 → 批缓冲（D9 预留）或直接 append；返回盖章事件（供 dice_event_id 等引用）。 */
  async function emitDraft(type: string, payload: unknown, ctx: ComponentContext): Promise<Result<Event, ErrorCode>> {
    const env = envelope();
    if (!env) return fail('COMPONENT_FAILED'); // 无信封：非节点执行上下文
    const draft = {
      ts: new Date().toISOString(),
      run_id: env.run_id,
      branch: env.branch,
      exec: env.exec,
      type,
      payload,
    } as EventDraft;
    const buffer = ctx.batchView?.branchBuffer as { push?: (d: EventDraft) => void } | undefined;
    if (buffer !== undefined) {
      // D9 批协议预留：批内写入本分支缓冲，批结束按声明分支序串行提交时才取号（deep-dive §1.5-4）
      if (typeof buffer.push !== 'function') return fail('COMPONENT_FAILED'); // TCAS 本期不实现，缓冲形态未知
      buffer.push(draft);
      return ok(draft as Event); // 批内尚无盖章 id
    }
    return deps.eventLog.append(draft);
  }

  const callAgent: MetaComponent = {
    ...BUILTIN_META_COMPONENTS.call_agent,
    async run(args: CallAgentParams, ctx) {
      // 冻结 TurnContext 需完整 ToolCallRequest，而组件侧只回传 call_id+content（契约错位，见汇报）
      const toolResults = args.tool_results?.map((tr) => ({
        call: { call_id: tr.call_id, name: '', arguments: {} },
        result: tr.is_error ? { is_error: true, content: tr.content } : tr.content,
      }));
      return deps.agentService.runTurn(args.agent_id, { intent: args.intent, toolResults }, ctx.signal);
    },
  };

  const injectContext: MetaComponent = {
    ...BUILTIN_META_COMPONENTS.inject_context,
    async run(args: InjectContextParams) {
      return deps.agentService.steer(args.target_agent_id, {
        kind: 'whisper',
        text: args.text,
        targets: [args.target_agent_id],
        mode: 'steering',
      });
    },
  };

  const bbGet: MetaComponent = {
    ...BUILTIN_META_COMPONENTS.bb_get,
    async run(args: BbGetParams) {
      return ok(deps.blackboard.get(args.key)); // 键不存在返回 undefined，非错误（§4.2）
    },
  };

  const bbSet: MetaComponent = {
    ...BUILTIN_META_COMPONENTS.bb_set,
    async run(args: BbSetParams, ctx) {
      const emitted = await emitDraft('bb_set', { key: args.key, value: args.value, reason: args.reason }, ctx);
      if (!emitted.ok) return emitted;
      deps.blackboard.applyEvent(emitted.value); // 恢复路径同构：事件在前、生效在后（D1）
      return ok(undefined);
    },
  };

  const emitEvent: MetaComponent = {
    ...BUILTIN_META_COMPONENTS.emit_event,
    async run(args: EmitEventParams, ctx) {
      return emitDraft(args.type, args.payload, ctx);
    },
  };

  const awaitDirectorInput: MetaComponent = {
    ...BUILTIN_META_COMPONENTS.await_director_input,
    async run(args: AwaitDirectorInputParams, ctx): Promise<Result<AwaitOutcome, ErrorCode>> {
      if (!deps.directorPump) return fail('COMPONENT_FAILED'); // 组合根未装配泵
      const env = envelope();
      if (!env) return fail('COMPONENT_FAILED');
      const started = Date.now();
      const policy = args.timeout;
      // D15 超时计时归泵侧（架构师裁决：泵持有游标与指令流）：完整透传 timeoutPolicy，本层不持有计时器
      const r = await deps.directorPump.awaitDirective({ gateNodeId: env.exec.node_id, timeoutPolicy: policy, signal: ctx.signal });
      const waited_ms = Date.now() - started;
      if (r.ok) {
        // 冻结返回为裸指令、泵不标注 source：use_default 超时的解析值即 default_input 本体（引用优先、深等兜底）
        const isDefault =
          policy.policy === 'use_default' &&
          (r.value === policy.default_input || JSON.stringify(r.value) === JSON.stringify(policy.default_input));
        return ok({ outcome: 'received', directive: r.value, source: isDefault ? 'timeout_default' : 'director_inbox', waited_ms });
      }
      if (r.error === 'RUN_CANCELLED') return ok({ outcome: 'cancelled', reason: 'run_cancelled', waited_ms });
      // NODE_FAILED 二义（「发起时刻 + after_ms」判定）：cancel_branch 超时到期 vs 第二门进入（D37，即时返回）
      if (policy.policy === 'cancel_branch' && waited_ms >= policy.after_ms) {
        return ok({ outcome: 'cancelled', reason: 'timeout_cancel_branch', waited_ms });
      }
      return ok({ outcome: 'node_failed' });
    },
  };

  // ===== 注册表扩展件（非名册）=====

  const createAgent: MetaComponent = {
    name: 'create_agent',
    version: '1.0.0',
    description: '创建 Agent 实例（§3.1 A1；名册扩展：角色创建组件的服务通道）',
    parameters: z.strictObject({ id: AgentIdSchema, identity_card: IdentityCardV1Schema, model: ModelBindingSchema }),
    async run(args: { id: string; identity_card: z.infer<typeof IdentityCardV1Schema>; model: z.infer<typeof ModelBindingSchema> }) {
      return deps.agentService.create({ id: args.id, identityCard: args.identity_card, modelBinding: args.model });
    },
  };

  const destroyAgent: MetaComponent = {
    name: 'destroy_agent',
    version: '1.0.0',
    description: '显式销毁 Agent 实例（§3.1 A10；不销毁则跨局存续，D22）',
    parameters: z.strictObject({ agent_id: AgentIdSchema, reason: z.string().optional() }),
    async run(args: { agent_id: string }) {
      return deps.agentService.destroy(args.agent_id);
    },
  };

  const steerAgent: MetaComponent = {
    name: 'steer_agent',
    version: '1.0.0',
    description: 'steering 档干预入队（D4；下一安全点生效）',
    parameters: z.strictObject({ agent_id: AgentIdSchema, directive: DirectorDirectiveSchema }),
    async run(args: { agent_id: string; directive: z.infer<typeof DirectorDirectiveSchema> }) {
      return deps.agentService.steer(args.agent_id, args.directive);
    },
  };

  const followUpAgent: MetaComponent = {
    name: 'follow_up_agent',
    version: '1.0.0',
    description: 'follow-up 档干预入队（D4；turn_end 时 steering 为空则消费）',
    parameters: z.strictObject({ agent_id: AgentIdSchema, directive: DirectorDirectiveSchema }),
    async run(args: { agent_id: string; directive: z.infer<typeof DirectorDirectiveSchema> }) {
      return deps.agentService.followUp(args.agent_id, args.directive);
    },
  };

  return [callAgent, injectContext, bbGet, bbSet, emitEvent, awaitDirectorInput, createAgent, destroyAgent, steerAgent, followUpAgent];
}
