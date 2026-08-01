// Version: 1.0.0
/**
 * 图解析与加载期校验（D20：配置类错误消灭在运转之前，失败则局不开始）。
 * parseFlowConfig：结构校验；validateFlowConfig：跨引用校验（入口/节点 id/边端点/组件注册/
 * 端口声明/门参数/可达性）；join 声明直接报 issue（并行分支/join/TCAS 属 Phase 2，§0.2）。
 * 单门等待（D27）静态说明：首局串行排他调度下两門不可能同时 WAITING，约束天然成立；
 * 运行期兜底（第二门进入 → NODE_FAILED）由 director-pump 实现（D37）。
 */
import { DirectorGateParamsSchema, FlowConfigSchema, type FlowConfig } from '../schema/flow.ts';
import type { Result } from '../schema/errors.ts';
import type { ComponentRegistry, GraphValidationIssue } from './types.ts';

/** 结构校验：raw → FlowConfig。失败即 BUNDLE_INVALID（局不开始）。 */
export function parseFlowConfig(raw: unknown): Result<FlowConfig, 'BUNDLE_INVALID'> {
  const r = FlowConfigSchema.safeParse(raw);
  return r.success ? { ok: true, value: r.data } : { ok: false, error: 'BUNDLE_INVALID' };
}

/** 跨引用校验：返回问题清单（空 = 通过）；清单非空时 FlowRunner 以 BUNDLE_INVALID 拒绝开局。 */
export function validateFlowConfig(
  config: FlowConfig,
  components: ComponentRegistry,
): Result<readonly GraphValidationIssue[], 'BUNDLE_INVALID'> {
  const issues: GraphValidationIssue[] = [];
  const nodes = new Map(config.nodes.map((n) => [n.id, n] as const));

  for (const n of config.nodes) {
    if (config.nodes.filter((x) => x.id === n.id).length > 1) {
      issues.push({ nodeId: n.id, message: `节点 id 重复: ${n.id}` });
    }
    if (n.join) {
      issues.push({ nodeId: n.id, message: 'join 声明属 Phase 2（并行分支/join/TCAS 首局不实现，§0.2）' });
    }
    if (!components.get(n.type, n.version)) {
      issues.push({ nodeId: n.id, message: `组件未注册: ${n.type}@${n.version}` });
    }
    if (n.type === 'director_gate' && !DirectorGateParamsSchema.safeParse(n.params ?? {}).success) {
      issues.push({ nodeId: n.id, message: '导演门节点参数不符合 DirectorGateParamsSchema（D15/D37）' });
    }
  }
  if (!nodes.has(config.entry)) {
    issues.push({ message: `入口节点不存在: ${config.entry}` });
  }

  for (const e of config.edges) {
    const label = e.id ?? `${e.from}->${e.to}`;
    if (!nodes.has(e.from)) issues.push({ message: `边 ${label} 源节点不存在: ${e.from}` });
    if (!nodes.has(e.to)) issues.push({ message: `边 ${label} 目标节点不存在: ${e.to}` });
    const fromComp = nodes.has(e.from) ? components.get(nodes.get(e.from)!.type, nodes.get(e.from)!.version) : undefined;
    const toComp = nodes.has(e.to) ? components.get(nodes.get(e.to)!.type, nodes.get(e.to)!.version) : undefined;
    if (fromComp && !fromComp.description.outputs.includes(e.from_port)) {
      issues.push({ nodeId: e.from, message: `边 ${label} 输出端口未在组件 description.outputs 声明: ${e.from_port}` });
    }
    if (toComp && !toComp.description.inputs.includes(e.to_port)) {
      issues.push({ nodeId: e.to, message: `边 ${label} 输入端口未在组件 description.inputs 声明: ${e.to_port}` });
    }
  }

  // 可达性：入口沿边 DFS，不可达节点属配置错误（D20：消灭在运转之前）。
  const reachable = new Set<string>();
  const stack = [config.entry];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (reachable.has(id) || !nodes.has(id)) continue;
    reachable.add(id);
    for (const e of config.edges) if (e.from === id) stack.push(e.to);
  }
  for (const n of config.nodes) {
    if (!reachable.has(n.id)) issues.push({ nodeId: n.id, message: `入口不可达节点: ${n.id}` });
  }

  return { ok: true, value: issues };
}
