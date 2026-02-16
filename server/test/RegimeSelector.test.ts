// Minimal assertion helper
function assert(condition: any, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

import { NormalizationStore } from '../strategy/Normalization';
import { RegimeSelector } from '../strategy/RegimeSelector';

export function runTests() {
  const norm = new NormalizationStore(60_000, 32);
  const selector = new RegimeSelector(norm, 3, 2);
  let regime = selector.update({
    nowMs: 1,
    price: 100,
    vwap: 100,
    dfsPercentile: 0.6,
    deltaZ: 0.1,
    printsPerSecond: 1,
    burstCount: 1,
    volatility: 0.5,
  }).regime;
  assert(regime === 'TR', 'initial regime should default to TR');

  // Feed MR candidate ticks below lock threshold
  for (let i = 0; i < 2; i += 1) {
    regime = selector.update({
      nowMs: 100 + i,
      price: 105,
      vwap: 100,
      dfsPercentile: 0.52,
      deltaZ: 0.2,
      printsPerSecond: 0.5,
      burstCount: 1,
      volatility: 0.4,
    }).regime;
  }
  assert(regime === 'TR', 'TR->MR should respect lock ticks');

  // Third MR tick should switch
  regime = selector.update({
    nowMs: 105,
    price: 106,
    vwap: 100,
    dfsPercentile: 0.51,
    deltaZ: 0.2,
    printsPerSecond: 0.5,
    burstCount: 1,
    volatility: 0.4,
  }).regime;
  assert(regime === 'MR', 'TR->MR should switch after lock ticks');

  // EV override after 2 ticks with extreme event score
  regime = selector.update({
    nowMs: 200,
    price: 120,
    vwap: 100,
    dfsPercentile: 0.9,
    deltaZ: 3,
    printsPerSecond: 10,
    burstCount: 20,
    volatility: 5,
  }).regime;
  regime = selector.update({
    nowMs: 201,
    price: 121,
    vwap: 100,
    dfsPercentile: 0.9,
    deltaZ: 3,
    printsPerSecond: 10,
    burstCount: 20,
    volatility: 5,
  }).regime;
  assert(regime === 'EV', 'EV override should engage after lock ticks');
}
