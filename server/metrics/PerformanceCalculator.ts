export interface TradePerformanceInput {
  realizedPnl: number;
  equity: number;
}

export interface PerformanceMetrics {
  totalPnL: number;
  winCount: number;
  lossCount: number;
  totalTrades: number;
  winRate: number;
  maxDrawdown: number;
  sharpeRatio: number;
  pnlCurve: Array<{ timestamp: number; pnl: number }>;
}

export class PerformanceCalculator {
  private totalPnL = 0;
  private winCount = 0;
  private lossCount = 0;
  private maxDrawdown = 0;
  private peakPnL = 0;
  private pnlCurve: Array<{ timestamp: number; pnl: number }> = [];
  private readonly maxCurvePoints = Number(process.env.DRY_RUN_PNL_CURVE_LIMIT || 2000);

  constructor(private readonly initialBalance: number = 0) {
    this.pnlCurve.push({ timestamp: Date.now(), pnl: 0 });
  }

  recordTrade(input: TradePerformanceInput): PerformanceMetrics {
    if (input.realizedPnl > 0) this.winCount += 1;
    if (input.realizedPnl < 0) this.lossCount += 1;
    return this.recordEquity(input.equity);
  }

  recordEquity(equity: number): PerformanceMetrics {
    this.totalPnL = equity - this.initialBalance;
    const now = Date.now();
    this.pnlCurve.push({ timestamp: now, pnl: this.totalPnL });
    if (this.pnlCurve.length > this.maxCurvePoints) {
      this.pnlCurve = this.pnlCurve.slice(this.pnlCurve.length - this.maxCurvePoints);
    }
    this.peakPnL = Math.max(this.peakPnL, this.totalPnL);
    this.maxDrawdown = Math.max(this.maxDrawdown, this.peakPnL - this.totalPnL);

    return this.getMetrics();
  }

  getMetrics(): PerformanceMetrics {
    const totalTrades = this.winCount + this.lossCount;
    const winRate = totalTrades > 0 ? (this.winCount / totalTrades) * 100 : 0;
    const sharpeRatio = this.calculateSharpe();

    return {
      totalPnL: this.totalPnL,
      winCount: this.winCount,
      lossCount: this.lossCount,
      totalTrades,
      winRate,
      maxDrawdown: this.maxDrawdown,
      sharpeRatio,
      pnlCurve: [...this.pnlCurve],
    };
  }

  restore(metrics: PerformanceMetrics): void {
    this.totalPnL = metrics.totalPnL;
    this.winCount = metrics.winCount;
    this.lossCount = metrics.lossCount;
    this.maxDrawdown = metrics.maxDrawdown;
    this.peakPnL = metrics.totalPnL + metrics.maxDrawdown;
    this.pnlCurve = [...metrics.pnlCurve];
  }

  private calculateSharpe(): number {
    if (this.pnlCurve.length < 3) {
      return 0;
    }
    const returns: number[] = [];
    for (let i = 1; i < this.pnlCurve.length; i += 1) {
      const prev = this.pnlCurve[i - 1].pnl;
      const current = this.pnlCurve[i].pnl;
      const base = this.initialBalance + prev;
      if (base <= 0) continue;
      returns.push((current - prev) / base);
    }

    if (returns.length < 2) {
      return 0;
    }
    const avg = returns.reduce((acc, v) => acc + v, 0) / returns.length;
    const variance = returns.reduce((acc, v) => acc + Math.pow(v - avg, 2), 0) / returns.length;
    const std = Math.sqrt(variance);
    if (std === 0) return 0;
    return (avg / std) * Math.sqrt(252);
  }
}
