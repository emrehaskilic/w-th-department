// Minimal assertion helper to avoid relying on Node's built‑in assert
function assert(condition: any, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}
import { CvdCalculator } from '../metrics/CvdCalculator';

/**
 * Unit tests for the CvdCalculator.  These tests feed synthetic trades
 * and verify the cumulative volume delta calculations for multiple
 * timeframes.
 */

export function runTests() {
  const cvd = new CvdCalculator({ '1s': 1_000, '5s': 5_000 });
  const t0 = Date.now();

  // Add a buy trade and check positive delta
  cvd.addTrade({ price: 100, quantity: 1, side: 'buy', timestamp: t0 });
  let metrics = cvd.computeMetrics();
  const m1s = metrics.find(m => m.timeframe === '1s');
  assert(m1s, '1s timeframe should exist');
  assert(m1s!.cvd === 1, 'CVD should be 1 after one buy');

  // Add a sell trade of equal size; delta should return to zero
  cvd.addTrade({ price: 100, quantity: 1, side: 'sell', timestamp: t0 + 100 });
  metrics = cvd.computeMetrics();
  const m1s2 = metrics.find(m => m.timeframe === '1s');
  assert(m1s2!.cvd === 0, 'CVD should be 0 after buy and sell of equal size');

  // Add a sequence of buys to confirm positive CVD on longer timeframe
  cvd.addTrade({ price: 100, quantity: 2, side: 'buy', timestamp: t0 + 200 });
  cvd.addTrade({ price: 99.5, quantity: 2, side: 'buy', timestamp: t0 + 300 });
  metrics = cvd.computeMetrics();
  const m5s = metrics.find(m => m.timeframe === '5s');
  assert(m5s, '5s timeframe should exist');
  assert(m5s!.cvd > 0, 'CVD should be positive after buys');

}
