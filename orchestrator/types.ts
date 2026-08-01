// Version: 1.0.0
/**
 * 编排层运行时接口类型（跨模块冻结，runtime-architecture.md §4.5/§3.3 的落地）。
 * 与 services/types.ts 同级纪律：只声明不实现，任何 Agent 不得修改。
 */
import type { Result } from '../schema/errors.js';
import type { FlowRunnerErrorKind } from '../schema/errors.js';
import type {
  DirectorDirective,
  EventId,
  GateTimeoutPolicy,
  RunId,
} from '../schema/event.js';
import type { ScenarioBundle, RunManifest } from '../schema/bundle.js';
import type { FlowConfig } from '../schema/flow.js';
import type { Component, MetaRegistry } from '../schema/meta-component.js';
import type {
  AgentService,
  Blackboard,
  EventLog,
  MemoryService,
} from '../services/types.js';

// ===== 导演消费泵（D27/D37，orchestrator 内部模块 director-pump 的对外形态）=====

export interface AwaitDirectiveOpts {
  /** 等待中的门节点 id（消费泵据此路由，D27 单门等待约束）。 */
  gateNodeId: string;
  /** 门超时策略（D15）。 */
  timeoutPolicy?: GateTimeoutPolicy;
  signal: AbortSignal;
}

export interface DirectorPump {
  /**
   * 门经 await_director_input 元组件挂起等待（D37）。
   * 泵常驻读取 director_inbox.jsonl：note 直落盘，门指令解析本 promise（F2）。
   * 错误：RUN_CANCELLED（整局取消）/ NODE_FAILED（超时策略 cancel_branch 或第二门进入）。
   */
  awaitDirective(opts: AwaitDirectiveOpts): Promise<Result<DirectorDirective, 'RUN_CANCELLED' | 'NODE_FAILED'>>;

  /** 整局取消时唤醒所有等待中的门（G4/G6）。 */
  cancelAll(): void;
}

// ===== 组件注册表 =====

export interface ComponentRegistry {
  /** 按 type + version 取组件（version 缺省取已注册最新）。 */
  get(type: string, version?: string): Component | undefined;
  /** 全部已注册（加载期校验图节点 type 用，D20）。 */
  list(): readonly Component[];
}

// ===== FlowRunner（§4.5）=====

export interface FlowRunOptions {
  resume?: boolean;       // 崩溃恢复（§2.3）
  forkFrom?: EventId;     // 同版本内从指定事件分叉重跑（§2.4）
}

export interface RunReport {
  runId: RunId;
  /** 终态：COMPLETED / cancelled（run() 只在这两种落定；ERROR 为挂起态，§3.3 补充语义）。 */
  status: 'completed' | 'cancelled';
  manifest: RunManifest;
}

export interface FlowRunner {
  /**
   * 加载 Bundle → 校验/冒烟（D20）→ replayOrInit（D12）→ 调度循环。
   * 落定时机：只在 COMPLETED 或 cancel 后落定；ERROR 为挂起态，等待 resume/cancel。
   */
  run(bundle: ScenarioBundle, options?: FlowRunOptions): Promise<Result<RunReport, FlowRunnerErrorKind>>;

  /** 请求暂停：所有在飞组件到达安全点后生效（R2；WAITING 门视为已在安全点）。异步。 */
  pause(): Promise<Result<void, FlowRunnerErrorKind>>;

  /** 恢复运行（含 ERROR 后经导演决策的恢复，R3/R7；永远沿原 Bundle 版本继续，D21）。异步。 */
  resume(): Promise<Result<void, FlowRunnerErrorKind>>;

  /** 取消整局：安全点优雅终止，导演门转 CANCELLED（R8/R9/R10）。异步。 */
  cancel(): Promise<Result<void, FlowRunnerErrorKind>>;
}

// ===== 服务集合（组合根传入的依赖包）=====

export interface ServiceSet {
  eventLog: EventLog;
  blackboard: Blackboard;
  agentService: AgentService;
  memory: MemoryService;
}

export interface FlowRunnerDeps {
  services: ServiceSet;
  meta: MetaRegistry;
  components: ComponentRegistry;
  directorPump: DirectorPump;
  /** 作品库 run 目录（Script 在此已打开为 eventLog；manifest 写到同目录，D24）。 */
  runDir: string;
}

export declare function createFlowRunner(deps: FlowRunnerDeps): FlowRunner;

// ===== 图解析与校验（graph 模块，D20）=====

export interface GraphValidationIssue {
  nodeId?: string;
  message: string;
}

export declare function parseFlowConfig(raw: unknown): Result<FlowConfig, 'BUNDLE_INVALID'>;
export declare function validateFlowConfig(
  config: FlowConfig,
  components: ComponentRegistry,
): Result<readonly GraphValidationIssue[], 'BUNDLE_INVALID'>;
