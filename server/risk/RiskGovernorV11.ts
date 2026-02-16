import { StrategyRegime } from '../types/strategy';

export interface RiskGovernorInput {
  equity: number;
  price: number;
  vwap: number;
  volatility: number;
  regime: StrategyRegime;
  liquidationDistance?: number | null; // absolute price distance
  stopDistance?: number | null;
}

export interface RiskGovernorOutput {
  qty: number;
  riskR: number;
  stopDistance: number;
  reason: string | null;
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

export class RiskGovernorV11 {
  private readonly riskPctByRegime: Record<StrategyRegime, number> = {
    TR: 0.0035,
    MR: 0.0025,
    EV: 0.001,
  };

  compute(input: RiskGovernorInput): RiskGovernorOutput {
    const equity = Number.isFinite(input.equity) ? Math.max(0, input.equity) : 0;
    const price = Number.isFinite(input.price) ? Math.max(0, input.price) : 0;
    const vwap = Number.isFinite(input.vwap) ? Math.max(0, input.vwap) : 0;
    const volatility = Number.isFinite(input.volatility) ? Math.max(0, input.volatility) : 0;

    const baseRiskPct = this.riskPctByRegime[input.regime] ?? 0.0025;
    let riskR = equity * baseRiskPct;
    if (input.regime === 'EV') {
      riskR = riskR * 0.5;
    }

    let stopDistance = input.stopDistance ?? 0;
    if (!(stopDistance > 0)) {
      if (input.regime === 'TR') {
        stopDistance = Math.max(Math.abs(price - vwap), volatility * 0.5);
      } else if (input.regime === 'MR') {
        stopDistance = Math.max(Math.abs(price - vwap) * 0.7, volatility * 0.35);
      } else {
        stopDistance = Math.max(price * 0.0015, volatility * 0.25);
      }
    }

    stopDistance = Math.max(stopDistance, price * 0.0005);

    let qty = stopDistance > 0 ? riskR / stopDistance : 0;
    let reason: string | null = null;

    const liqDist = input.liquidationDistance ?? null;
    if (liqDist && liqDist > 0 && stopDistance > 0) {
      const ratio = liqDist / stopDistance;
      if (ratio < 2) {
        const factor = clamp(ratio / 2, 0.1, 1);
        qty = qty * factor;
        reason = 'RISK_CLAMP';
      }
    }

    if (!Number.isFinite(qty) || qty < 0) qty = 0;
    return {
      qty: Number(qty.toFixed(6)),
      riskR,
      stopDistance,
      reason,
    };
  }
}
