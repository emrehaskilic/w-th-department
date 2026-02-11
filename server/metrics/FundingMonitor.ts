/**
 * Funding rate monitor.
 *
 * Periodically polls Binance for the latest funding rate and computes
 * the time until the next funding event as well as the trend compared
 * to the previous rate.  Similar to the OpenInterestMonitor, unit
 * tests can call `update()` directly with synthetic data.
 */

export interface FundingMetrics {
  symbol: string;
  rate: number;
  timeToFundingMs: number;
  trend: 'up' | 'down' | 'flat';
}

type FundingListener = (metrics: FundingMetrics) => void;

export class FundingMonitor {
  private lastRate: number | null = null;
  private readonly listeners: Set<FundingListener> = new Set();
  private readonly symbol: string;
  private readonly intervalMs: number;
  // Timer handle for periodic polling.  We avoid referring to NodeJS
  // types directly to allow compilation in non‑Node environments.
  private timer: any | null = null;

  constructor(symbol: string, intervalMs: number = 60_000) {
    this.symbol = symbol.toUpperCase();
    this.intervalMs = intervalMs;
  }

  public start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.fetchAndUpdate().catch(() => { }), this.intervalMs);
    this.fetchAndUpdate().catch(() => { });
  }

  public stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public update(rate: number, nextFundingTime: number) {
    let trend: 'up' | 'down' | 'flat' = 'flat';
    if (this.lastRate !== null) {
      if (rate > this.lastRate) trend = 'up';
      else if (rate < this.lastRate) trend = 'down';
    }
    this.lastRate = rate;
    const now = Date.now();
    const timeToFundingMs = Math.max(0, nextFundingTime - now);
    const metrics: FundingMetrics = { symbol: this.symbol, rate, timeToFundingMs, trend };
    this.listeners.forEach(l => l(metrics));
  }

  public onUpdate(listener: FundingListener) {
    this.listeners.add(listener);
  }

  private async fetchAndUpdate(): Promise<void> {
    try {
      // Use premiumIndex which includes nextFundingTime
      const url = `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${this.symbol}`;
      const res = await fetch(url);
      if (!res.ok) return;
      const data: any = await res.json();

      if (data && typeof data.lastFundingRate === 'string' && typeof data.nextFundingTime === 'number') {
        const rate = parseFloat(data.lastFundingRate);
        const nextFundingTime = data.nextFundingTime;
        if (!isNaN(rate) && nextFundingTime > 0) {
          this.update(rate, nextFundingTime);
        }
      }
    } catch (e) {
      // Silently ignore fetch errors
    }
  }
}
