export interface RiskConfig {
  maxPositionNotionalUsdt: number;
  cooldownMs: number;
  maxSlippagePct: number;
  circuitBreaker?: {
    maxConsecutiveLosses: number;
    maxDailyDrawdownPct: number;
    pauseDurationMs: number;
  };
  onAlert?: (message: string) => void;
}

interface CircuitBreakerState {
  consecutiveLosses: number;
  dailyPnl: number;
  dailyStartBalance: number;
  pausedUntilMs: number;
  dayKey: string;
}

export class RiskManager {
  private config: RiskConfig;
  private lastTradeTs: Map<string, number> = new Map();
  private circuitBreaker: CircuitBreakerState = {
    consecutiveLosses: 0,
    dailyPnl: 0,
    dailyStartBalance: 0,
    pausedUntilMs: 0,
    dayKey: this.currentDayKey(),
  };

  constructor(config: RiskConfig = {
    maxPositionNotionalUsdt: 500,
    cooldownMs: 10_000,
    maxSlippagePct: 0.1,
    circuitBreaker: {
      maxConsecutiveLosses: 3,
      maxDailyDrawdownPct: 0.15,
      pauseDurationMs: 30 * 60 * 1000,
    },
  }) {
    this.config = config;
  }

  public check(
    symbol: string,
    side: 'BUY' | 'SELL',
    price: number,
    quantity: number,
    options?: { maxPositionNotionalUsdt?: number }
  ): { ok: boolean; reason: string | null } {
    const now = Date.now();
    this.rollDayIfNeeded();
    const breaker = this.checkCircuitBreaker();
    if (breaker.triggered) {
      return { ok: false, reason: breaker.reason || 'CIRCUIT_BREAKER_PAUSED' };
    }

    const lastTs = this.lastTradeTs.get(symbol) || 0;
    if (now - lastTs < this.config.cooldownMs) {
      return { ok: false, reason: 'COOLDOWN_ACTIVE' };
    }

    const notional = price * quantity;
    const notionalLimit = Number.isFinite(options?.maxPositionNotionalUsdt as number)
      ? Math.max(0, Number(options?.maxPositionNotionalUsdt))
      : this.config.maxPositionNotionalUsdt;
    if (notional > notionalLimit) {
      return { ok: false, reason: 'EXCEEDS_MAX_NOTIONAL' };
    }

    return { ok: true, reason: null };
  }

  public recordTrade(symbol: string) {
    this.lastTradeTs.set(symbol, Date.now());
  }

  public recordTradeClosed(realizedPnl: number, walletBalance: number) {
    this.rollDayIfNeeded();
    if (this.circuitBreaker.dailyStartBalance <= 0 && walletBalance > 0) {
      this.circuitBreaker.dailyStartBalance = walletBalance;
    }
    this.circuitBreaker.dailyPnl += realizedPnl;
    if (realizedPnl < 0) {
      this.circuitBreaker.consecutiveLosses += 1;
    } else if (realizedPnl > 0) {
      this.circuitBreaker.consecutiveLosses = 0;
    }
    this.checkCircuitBreaker();
  }

  public getCircuitBreakerState() {
    return { ...this.circuitBreaker };
  }

  private checkCircuitBreaker(): { triggered: boolean; reason?: string } {
    const cfg = this.config.circuitBreaker;
    if (!cfg) return { triggered: false };
    const now = Date.now();
    if (now < this.circuitBreaker.pausedUntilMs) {
      return { triggered: true, reason: 'CIRCUIT_BREAKER_PAUSED' };
    }

    if (this.circuitBreaker.consecutiveLosses >= cfg.maxConsecutiveLosses) {
      this.circuitBreaker.pausedUntilMs = now + cfg.pauseDurationMs;
      this.config.onAlert?.(`Circuit breaker - ${this.circuitBreaker.consecutiveLosses} consecutive losses`);
      return { triggered: true, reason: 'CONSECUTIVE_LOSSES' };
    }

    if (this.circuitBreaker.dailyStartBalance > 0) {
      const dailyDrawdown = this.circuitBreaker.dailyPnl / this.circuitBreaker.dailyStartBalance;
      if (dailyDrawdown <= -cfg.maxDailyDrawdownPct) {
        this.circuitBreaker.pausedUntilMs = now + cfg.pauseDurationMs;
        this.config.onAlert?.(`Circuit breaker - ${(dailyDrawdown * 100).toFixed(2)}% drawdown`);
        return { triggered: true, reason: 'DAILY_DRAWDOWN' };
      }
    }

    return { triggered: false };
  }

  private rollDayIfNeeded() {
    const nowKey = this.currentDayKey();
    if (nowKey === this.circuitBreaker.dayKey) {
      return;
    }
    this.circuitBreaker.dayKey = nowKey;
    this.circuitBreaker.dailyPnl = 0;
    this.circuitBreaker.consecutiveLosses = 0;
    this.circuitBreaker.dailyStartBalance = 0;
  }

  private currentDayKey(): string {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }
}
