import { Fp, fromFp, toFp } from './DryRunMath';
import { DryRunBookLevel, DryRunOrderBook, DryRunOrderType, DryRunSide, DryRunTimeInForce } from './types';

export interface MarketImpactConfig {
  impactFactorBps: number;
  maxSlippageBps: number;
  queuePenaltyBps: number;
  topDepthLevels: number;
}

export interface MarketImpactAdjustmentInput {
  side: DryRunSide;
  type: DryRunOrderType;
  tif: DryRunTimeInForce;
  requestedQty: Fp;
  filledQty: Fp;
  avgFillPrice: Fp;
  book: DryRunOrderBook;
}

export interface MarketImpactAdjustment {
  adjustedAvgFillPrice: Fp;
  slippageBps: number;
  marketImpactBps: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function sumDepth(levels: DryRunBookLevel[], depth: number): number {
  let total = 0;
  for (let i = 0; i < Math.min(levels.length, depth); i += 1) {
    const qty = levels[i]?.qty ?? 0;
    if (Number.isFinite(qty) && qty > 0) {
      total += qty;
    }
  }
  return total;
}

export class MarketImpactSimulator {
  private readonly config: MarketImpactConfig;

  constructor(config?: Partial<MarketImpactConfig>) {
    this.config = {
      impactFactorBps: config?.impactFactorBps ?? 18,
      maxSlippageBps: config?.maxSlippageBps ?? 120,
      queuePenaltyBps: config?.queuePenaltyBps ?? 5,
      topDepthLevels: config?.topDepthLevels ?? 10,
    };
  }

  adjustFill(input: MarketImpactAdjustmentInput): MarketImpactAdjustment {
    if (input.filledQty <= 0n || input.avgFillPrice <= 0n) {
      return {
        adjustedAvgFillPrice: input.avgFillPrice,
        slippageBps: 0,
        marketImpactBps: 0,
      };
    }

    const bestOpposite = this.getBestOpposite(input.side, input.book);
    if (bestOpposite <= 0) {
      return {
        adjustedAvgFillPrice: input.avgFillPrice,
        slippageBps: 0,
        marketImpactBps: 0,
      };
    }

    const avgFill = fromFp(input.avgFillPrice);
    const qty = fromFp(input.filledQty);
    const requestedQty = fromFp(input.requestedQty);
    const baseSlippageBps = this.computeBaseSlippageBps(input.side, avgFill, bestOpposite);

    const sideLevels = input.side === 'BUY' ? input.book.asks : input.book.bids;
    const topDepthQty = sumDepth(sideLevels, this.config.topDepthLevels);
    const participation = clamp(topDepthQty > 0 ? qty / topDepthQty : 1, 0, 5);
    let marketImpactBps = this.config.impactFactorBps * Math.sqrt(participation);

    // Non-crossing GTC limits are effectively queueing for future fills.
    // Penalize these lightly to model queue position uncertainty.
    if (input.type === 'LIMIT' && input.tif === 'GTC' && requestedQty > qty) {
      marketImpactBps += this.config.queuePenaltyBps;
    }

    marketImpactBps = clamp(marketImpactBps, 0, this.config.maxSlippageBps);
    const totalSlippageBps = clamp(baseSlippageBps + marketImpactBps, 0, this.config.maxSlippageBps);

    const adjustmentFactor = input.side === 'BUY'
      ? 1 + (totalSlippageBps / 10000)
      : 1 - (totalSlippageBps / 10000);
    const adjustedAvgFillPrice = toFp(avgFill * adjustmentFactor);

    return {
      adjustedAvgFillPrice,
      slippageBps: totalSlippageBps,
      marketImpactBps,
    };
  }

  private getBestOpposite(side: DryRunSide, book: DryRunOrderBook): number {
    if (side === 'BUY') {
      return Number(book.asks[0]?.price ?? 0);
    }
    return Number(book.bids[0]?.price ?? 0);
  }

  private computeBaseSlippageBps(side: DryRunSide, fillPrice: number, bestOpposite: number): number {
    if (!Number.isFinite(fillPrice) || !Number.isFinite(bestOpposite) || bestOpposite <= 0) {
      return 0;
    }
    const raw = side === 'BUY'
      ? ((fillPrice - bestOpposite) / bestOpposite) * 10000
      : ((bestOpposite - fillPrice) / bestOpposite) * 10000;
    return Math.max(0, raw);
  }
}
