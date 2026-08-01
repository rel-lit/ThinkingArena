// Version: 1.0.0
/**
 * 元组件注册表实现（§4.7 MetaRegistry）：服务层的唯一调用面。
 * call() 管线 = 参数 schema 校验前置 → beforeCall → run → afterCall；错误编码进 Result 不抛异常（D5）。
 *
 * 实现级裁决（信封来源）：emit_event / bb_set / await_director_input 需要 run_id / branch /
 * 节点执行标识（D36）补齐事件信封与门路由，而冻结的 ComponentContext 无此通道——故本工厂
 * 接受可选 envelopeSource，由组合根/FlowRunner 在每次节点执行前更新其 current()。
 */
import type { ErrorCode, Result } from '../schema/errors.ts';
import { ErrorCodeSchema } from '../schema/errors.ts';
import type { BranchId, NodeExec, RunId } from '../schema/event.ts';
import type { BlockReason, ComponentContext, MetaComponent, MetaRegistry } from '../schema/meta-component.ts';
import type { AgentService, Blackboard, EventLog, MemoryService } from '../services/types.ts';
import type { DirectorPump } from '../orchestrator/types.ts';
import { createBuiltinMetaComponents } from './builtins.ts';

/** 运行信封：emit 类元组件补齐事件信封 / 门路由所需的执行上下文（D36）。 */
export interface MetaEnvelope {
  run_id: RunId;
  branch: BranchId;
  exec: NodeExec;
}

/** 信封源：组合根（或 FlowRunner）持有，节点执行前更新 current()；非节点执行上下文返回 null。 */
export interface EnvelopeSource {
  current(): MetaEnvelope | null;
}

export interface MetaRegistryDeps {
  agentService: AgentService;
  memory: MemoryService;
  blackboard: Blackboard;
  eventLog: EventLog;
  directorPump?: DirectorPump;
  envelopeSource?: EnvelopeSource;
  /** 额外注册的元组件（名册「签名级列举，非穷举」，§4.7）；同名覆盖内置。 */
  extra?: readonly MetaComponent[];
}

export function createMetaRegistry(deps: MetaRegistryDeps): MetaRegistry {
  const table = new Map<string, MetaComponent>();
  for (const m of createBuiltinMetaComponents(deps)) table.set(m.name, m);
  for (const m of deps.extra ?? []) table.set(m.name, m);

  /** BlockReason.code 是合法错误枚举则透传，否则归一（错误矩阵：钩子拦截由组件决定走向）。 */
  function blockedError(b: BlockReason): ErrorCode {
    const p = ErrorCodeSchema.safeParse(b.code);
    return p.success ? p.data : 'COMPONENT_FAILED';
  }

  return {
    async call(name: string, args: unknown, ctx: ComponentContext): Promise<Result<unknown, ErrorCode>> {
      const meta = table.get(name);
      if (!meta) return { ok: false, error: 'COMPONENT_FAILED' }; // 未注册名：配置错误
      try {
        const parsed = meta.parameters.safeParse(args);
        if (!parsed.success) return { ok: false, error: 'PARAM_SCHEMA_INVALID' }; // 校验前置（F4）
        if (meta.beforeCall) {
          const block = await meta.beforeCall(parsed.data, ctx);
          if (block) return { ok: false, error: blockedError(block) };
        }
        const result = await meta.run(parsed.data, ctx);
        if (!result.ok) return result;
        if (meta.afterCall) return await meta.afterCall(parsed.data, result.value, ctx);
        return result;
      } catch {
        // D5：异常只应来自编程错误；跨模块一律编码，不裸抛
        return { ok: false, error: 'COMPONENT_FAILED' };
      }
    },
  };
}
