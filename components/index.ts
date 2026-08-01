// Version: 1.0.0
/** 内置组件注册表（orchestrator/types.ts ComponentRegistry 的实现）；骰流按种子创建并在 dice/judge 间共享。 */
import type { ComponentRegistry } from '../orchestrator/types.ts';
import type { Component } from '../schema/meta-component.ts';
import { roleCreateComponent } from './role-create.ts';
import { roleDestroyComponent } from './role-destroy.ts';
import { narrativeComponent } from './narrative.ts';
import { createDiceComponent, mulberry32 } from './dice.ts';
import { createJudgeComponent } from './judge.ts';
import { directorGateComponent } from './director-gate.ts';

/**
 * 创建内置组件注册表。rngSeed 来自 Bundle seeds.yaml（D33：种子参与版本身份，同版本 rerun 复现骰点序列）；
 * 缺省 0（测试/冒烟便利）。
 */
export function createBuiltinComponentRegistry(opts?: { rngSeed?: number }): ComponentRegistry {
  const rng = mulberry32(opts?.rngSeed ?? 0);
  const all: readonly Component[] = [
    roleCreateComponent,
    roleDestroyComponent,
    narrativeComponent,
    createDiceComponent(rng),
    createJudgeComponent(rng),
    directorGateComponent,
  ];
  return {
    get: (type, version) =>
      all.find((c) => c.description.name === type && (version === undefined || c.description.version === version)),
    list: () => all,
  };
}
