export interface SizingRampConfig {
  startingMarginUsdt: number;
  minMarginUsdt: number;
  rampStepPct: number;
  rampDecayPct: number;
  rampMaxMult: number;
  useAsymmetricCompound?: boolean;
}

export interface SizingRampState {
  currentMarginBudgetUsdt: number;
  rampMult: number;
  successCount: number;
  failCount: number;
  consecutiveWins: number;
  consecutiveLosses: number;
  currentMultiplier: number;
}

const COMPOUND_CONFIG = {
  winMultiplier: 1.2,
  lossMultiplier: 0.8,
  streakBonus: 1.5,
  maxMultiplier: 3.0,
  minMultiplier: 0.5,
};

export function computeRampBounds(config: SizingRampConfig): { min: number; max: number } {
  const min = Math.max(0, config.minMarginUsdt);
  const max = Math.max(min, config.startingMarginUsdt * Math.max(1, config.rampMaxMult));
  return { min, max };
}

export class SizingRamp {
  private state: SizingRampState;

  constructor(private config: SizingRampConfig) {
    this.state = {
      currentMarginBudgetUsdt: Math.max(0, config.startingMarginUsdt),
      rampMult: 1,
      successCount: 0,
      failCount: 0,
      consecutiveWins: 0,
      consecutiveLosses: 0,
      currentMultiplier: 1,
    };
  }

  getState(): SizingRampState {
    return { ...this.state };
  }

  updateConfig(next: Partial<SizingRampConfig>) {
    this.config = {
      ...this.config,
      ...next,
    };
    this.state.currentMarginBudgetUsdt = this.clamp(this.state.currentMarginBudgetUsdt);
    this.state.rampMult = this.config.startingMarginUsdt > 0
      ? this.state.currentMarginBudgetUsdt / this.config.startingMarginUsdt
      : 0;
    this.state.currentMultiplier = this.state.rampMult;
  }

  getCurrentMarginBudgetUsdt(): number {
    return this.state.currentMarginBudgetUsdt;
  }

  onTradeClosed(realizedPnl: number): SizingRampState {
    const useAsymmetric = this.config.useAsymmetricCompound ?? true;
    if (useAsymmetric) {
      const nextMultiplier = this.updateCompound(realizedPnl > 0);
      const nextBudget = this.config.startingMarginUsdt * nextMultiplier;
      this.state.currentMarginBudgetUsdt = this.clamp(nextBudget);
      this.state.currentMultiplier = this.config.startingMarginUsdt > 0
        ? this.state.currentMarginBudgetUsdt / this.config.startingMarginUsdt
        : 0;
    } else {
      if (realizedPnl > 0) {
        this.state.successCount += 1;
        this.state.currentMarginBudgetUsdt = this.clamp(
          this.state.currentMarginBudgetUsdt * (1 + this.config.rampStepPct / 100)
        );
      } else {
        this.state.failCount += 1;
        this.state.currentMarginBudgetUsdt = this.clamp(
          this.state.currentMarginBudgetUsdt * (1 - this.config.rampDecayPct / 100)
        );
      }
    }

    this.state.rampMult = this.config.startingMarginUsdt > 0
      ? this.state.currentMarginBudgetUsdt / this.config.startingMarginUsdt
      : 0;

    return this.getState();
  }

  forceBudget(amount: number) {
    this.state.currentMarginBudgetUsdt = this.clamp(amount);
    // Recalculate rampMult based on new budget
    this.state.rampMult = this.config.startingMarginUsdt > 0
      ? this.state.currentMarginBudgetUsdt / this.config.startingMarginUsdt
      : 0;
    this.state.currentMultiplier = this.state.rampMult;
  }

  private updateCompound(isWin: boolean): number {
    if (isWin) {
      this.state.successCount += 1;
      this.state.consecutiveWins += 1;
      this.state.consecutiveLosses = 0;
      const multiplier = this.state.consecutiveWins >= 3
        ? COMPOUND_CONFIG.streakBonus
        : COMPOUND_CONFIG.winMultiplier;
      this.state.currentMultiplier = Math.min(
        this.state.currentMultiplier * multiplier,
        COMPOUND_CONFIG.maxMultiplier
      );
    } else {
      this.state.failCount += 1;
      this.state.consecutiveLosses += 1;
      this.state.consecutiveWins = 0;
      this.state.currentMultiplier = Math.max(
        this.state.currentMultiplier * COMPOUND_CONFIG.lossMultiplier,
        COMPOUND_CONFIG.minMultiplier
      );
    }
    return this.state.currentMultiplier;
  }

  private clamp(value: number): number {
    const { min, max } = computeRampBounds(this.config);
    return Math.max(min, Math.min(max, value));
  }
}
