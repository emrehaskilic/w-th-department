export interface FundingRateInfo {
  symbol: string;
  fundingRate: number;
  fundingTime: number;
  nextFundingTime: number;
}

export class FundingRateMonitor {
  private readonly fundingRates = new Map<string, FundingRateInfo>();

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly shortBlockThreshold: number = 0.0001
  ) { }

  async updateFundingRate(symbol: string): Promise<void> {
    const normalized = symbol.toUpperCase();
    const response = await this.fetchImpl(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${normalized}&limit=1`);
    if (!response.ok) {
      return;
    }
    const data: any = await response.json();
    if (!Array.isArray(data) || data.length === 0) {
      return;
    }
    const row = data[0];
    const fundingRate = Number(row?.fundingRate || 0);
    const fundingTime = Number(row?.fundingTime || 0);
    if (!Number.isFinite(fundingRate) || !Number.isFinite(fundingTime) || fundingTime <= 0) {
      return;
    }
    this.fundingRates.set(normalized, {
      symbol: normalized,
      fundingRate,
      fundingTime,
      nextFundingTime: fundingTime + (8 * 60 * 60 * 1000),
    });
  }

  get(symbol: string): FundingRateInfo | null {
    return this.fundingRates.get(symbol.toUpperCase()) || null;
  }

  isShortBlocked(symbol: string): boolean {
    const info = this.fundingRates.get(symbol.toUpperCase());
    if (!info) return false;
    return info.fundingRate > this.shortBlockThreshold;
  }
}
