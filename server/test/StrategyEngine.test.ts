import assert from 'node:assert/strict';

import { StrategyEngine } from '../strategy/StrategyEngine';

export function runTests() {
  const engine = new StrategyEngine();

  const signal = engine.compute({
    price: 101,
    atr: 2,
    avgAtr: 1.6,
    recentHigh: 101.2,
    recentLow: 95,
    obi: 0.45,
    deltaZ: 1.1,
    cvdSlope: 0.03,
    ready: true,
    vetoReason: null,
  });

  assert(signal.signal !== null, 'favorable setup should produce a strategy signal');
  assert(signal.score >= 50, 'boosted signal should keep score above execution threshold');
  assert(Boolean(signal.confidence), 'signal should include confidence');
  assert(Boolean(signal.boost), 'signal should include boost metadata');

  const notReady = engine.compute({
    price: 100,
    atr: 2,
    avgAtr: 2,
    recentHigh: 105,
    recentLow: 95,
    obi: 0.1,
    deltaZ: 0.1,
    cvdSlope: 0,
    ready: false,
    vetoReason: 'INITIALIZING',
  });

  assert(notReady.signal === null, 'not-ready state must not emit signal');
  assert(notReady.vetoReason === 'INITIALIZING', 'not-ready veto reason should be preserved');
}
