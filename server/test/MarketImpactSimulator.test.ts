import assert from 'node:assert/strict';

import { toFp } from '../dryrun/DryRunMath';
import { MarketImpactSimulator } from '../dryrun/MarketImpactSimulator';

export function runTests() {
  const simulator = new MarketImpactSimulator({
    impactFactorBps: 20,
    maxSlippageBps: 150,
    queuePenaltyBps: 4,
    topDepthLevels: 5,
  });

  const book = {
    bids: [
      { price: 99.9, qty: 2 },
      { price: 99.8, qty: 3 },
    ],
    asks: [
      { price: 100.0, qty: 2 },
      { price: 100.1, qty: 3 },
      { price: 100.2, qty: 5 },
    ],
  };

  const small = simulator.adjustFill({
    side: 'BUY',
    type: 'MARKET',
    tif: 'IOC',
    requestedQty: toFp(1),
    filledQty: toFp(1),
    avgFillPrice: toFp(100.0),
    book,
  });
  assert(small.adjustedAvgFillPrice > toFp(100.0), 'buy side should get adverse impact');
  assert(small.marketImpactBps > 0, 'impact bps must be positive');

  const large = simulator.adjustFill({
    side: 'BUY',
    type: 'MARKET',
    tif: 'IOC',
    requestedQty: toFp(8),
    filledQty: toFp(8),
    avgFillPrice: toFp(100.15),
    book,
  });
  assert(large.marketImpactBps > small.marketImpactBps, 'larger participation must increase impact');
}
