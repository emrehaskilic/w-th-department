import assert from 'node:assert/strict';

import { SignalBooster } from '../strategy/SignalBooster';

export function runTests() {
  const booster = new SignalBooster();

  const positive = booster.boost({
    obi: 0.4,
    deltaZ: 1.2,
    cvdSlope: 0.05,
    atr: 120,
    avgAtr: 90,
    price: 101,
    recentHigh: 105,
    recentLow: 95,
  }, {
    obi: 1.2,
    deltaZ: 1.1,
    cvdSlope: 1.05,
    breakoutBias: 1.0,
  });

  assert(positive.score > 60, 'positive metrics should produce a strong score');
  assert(positive.confidence !== 'LOW', 'positive metrics should not be low confidence');

  const negative = booster.boost({
    obi: -0.5,
    deltaZ: -1.5,
    cvdSlope: -0.08,
    atr: 80,
    avgAtr: 120,
    price: 94,
    recentHigh: 105,
    recentLow: 95,
  }, {
    obi: 1.1,
    deltaZ: 1.0,
    cvdSlope: 1.0,
    breakoutBias: 1.0,
  });

  assert(negative.score < 50, 'negative metrics should produce a bearish score');

  const weightSum = Object.values(positive.weights).reduce((acc, value) => acc + value, 0);
  assert(Math.abs(weightSum - 1) < 0.00001, 'normalized weights should sum to 1');
}
