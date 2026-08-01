// Version: 1.0.0
/**
 * 成本账本（D28）：cost 事件经 reduce 累计的派生切片——无独立台账，恢复随事件流/快照重建。
 * apply 逐条累计（total + by_model；异币种跳过并上报记 system）；restore 从 snapshot 还原
 * （成本闸恢复后不清零，deep-dive §2.4-1）；超阈触发一次回调（FlowRunner 转 pause），resume 后 rearm。
 */
import type { CostSummary, Event } from '../schema/event.ts';

/** 成本闸配置（D28：机制必须在场，阈值可设极大值）。 */
export interface CostBudgetBinding {
  maxTotal: number;
  currency: string;
  /** 超阈回调（FlowRunner 注册：触发 pause + run_paused.reason）。 */
  onExceed: (summary: CostSummary) => void;
}

export class Ledger {
  private total = 0;
  private currency: string | null = null;
  private byModel = new Map<string, number>();
  private budget: CostBudgetBinding | null = null;
  private fired = false;

  setBudget(binding: CostBudgetBinding): void {
    this.budget = binding;
  }

  /** resume 后重新武装（导演决策继续超阈运行时，下一条 cost 仍会再触发闸）。 */
  rearm(): void {
    this.fired = false;
  }

  /** 累计一条 cost 事件；false = 币种不一致被跳过（调用方记 system 告警，成本失真须导演知情）。 */
  apply(event: Extract<Event, { type: 'cost' }>): boolean {
    const { cost, model } = event.payload;
    if (this.currency === null) this.currency = cost.currency;
    if (cost.currency !== this.currency) return false;
    this.total += cost.amount;
    this.byModel.set(model, (this.byModel.get(model) ?? 0) + cost.amount);
    if (this.budget && !this.fired && this.total > this.budget.maxTotal && this.currency === this.budget.currency) {
      this.fired = true;
      this.budget.onExceed(this.summary());
    }
    return true;
  }

  /** 恢复路径：从 snapshot 的 ledger 段整体还原（D28 成本闸在恢复后不清零）。 */
  restore(summary: CostSummary): void {
    this.total = summary.total;
    this.currency = summary.currency;
    this.byModel = new Map(Object.entries(summary.by_model ?? {}));
  }

  /** 派生切片输出（run_completed / snapshot / manifest 共用形态）。 */
  summary(): CostSummary {
    return {
      total: this.total,
      currency: this.currency ?? this.budget?.currency ?? 'CNY',
      by_model: Object.fromEntries(this.byModel),
    };
  }

  /** 当前是否已超阈（恢复后调度前的静态检查用）。 */
  isExceeded(): boolean {
    return this.budget !== null && this.total > this.budget.maxTotal && this.currency === this.budget.currency;
  }
}
