// Minimal assertion helper
function assert(condition: any, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

import { NewStrategyV11 } from '../strategy/NewStrategyV11';
import { StrategyInput, StrategyPositionState } from '../types/strategy';

function baseInput(nowMs: number, overrides: Partial<StrategyInput> = {}): StrategyInput {
  return {
    symbol: 'TEST',
    nowMs,
    source: 'real',
    orderbook: {
      lastUpdatedMs: nowMs,
      spreadPct: 0.05,
      bestBid: 100,
      bestAsk: 100.1,
    },
    trades: {
      lastUpdatedMs: nowMs,
      printsPerSecond: 5,
      tradeCount: 20,
      aggressiveBuyVolume: 10,
      aggressiveSellVolume: 5,
      consecutiveBurst: { side: 'buy', count: 3 },
    },
    market: {
      price: 100,
      vwap: 99.8,
      delta1s: 0.5,
      delta5s: 1.0,
      deltaZ: 0.5,
      cvdSlope: 0.2,
      obiWeighted: 0.2,
      obiDeep: 0.2,
      obiDivergence: 0.05,
    },
    openInterest: null,
    absorption: { value: 0, side: null },
    volatility: 0.5,
    position: null,
    ...overrides,
  };
}

export function runTests() {
  const strategy = new NewStrategyV11({ cooldownSameS: 20, cooldownFlipS: 60, hardRevTicks: 6 });
  let now = 1_000_000;

  // Warm-up with low dfs values
  for (let i = 0; i < 20; i += 1) {
    const input = baseInput(now + i * 1000, {
      market: {
        price: 100,
        vwap: 100,
        delta1s: -0.2,
        delta5s: -0.3,
        deltaZ: -0.4,
        cvdSlope: -0.1,
        obiWeighted: -0.1,
        obiDeep: -0.1,
        obiDivergence: -0.02,
      },
      trades: {
        lastUpdatedMs: now + i * 1000,
        printsPerSecond: 3,
        tradeCount: 15,
        aggressiveBuyVolume: 2,
        aggressiveSellVolume: 6,
        consecutiveBurst: { side: 'sell', count: 2 },
      },
    });
    strategy.evaluate(input);
  }

  // High dfs tick should trigger entry
  now += 21_000;
  const entryDecision = strategy.evaluate(baseInput(now, {
    market: {
      price: 101,
      vwap: 100,
      delta1s: 2.5,
      delta5s: 3.0,
      deltaZ: 3.5,
      cvdSlope: 1.2,
      obiWeighted: 0.8,
      obiDeep: 0.9,
      obiDivergence: 0.2,
    },
    trades: {
      lastUpdatedMs: now,
      printsPerSecond: 8,
      tradeCount: 30,
      aggressiveBuyVolume: 20,
      aggressiveSellVolume: 4,
      consecutiveBurst: { side: 'buy', count: 6 },
    },
  }));

  const hasEntry = entryDecision.actions.some((a) => a.type === 'ENTRY');
  assert(hasEntry, 'should generate entry after high dfs');

  // Simulate position and exit conditions
  const position: StrategyPositionState = {
    side: 'LONG',
    qty: 1,
    entryPrice: 101,
    unrealizedPnlPct: 0.01,
    addsUsed: 0,
  };

  // Push below VWAP ticks to allow hard exit
  for (let i = 0; i < 4; i += 1) {
    now += 1000;
    strategy.evaluate(baseInput(now, {
      position,
      market: {
        price: 99.5,
        vwap: 100,
        delta1s: -1.5,
        delta5s: -1.2,
        deltaZ: -2.5,
        cvdSlope: -0.8,
        obiWeighted: -0.6,
        obiDeep: -0.7,
        obiDivergence: -0.2,
      },
      trades: {
        lastUpdatedMs: now,
        printsPerSecond: 6,
        tradeCount: 25,
        aggressiveBuyVolume: 4,
        aggressiveSellVolume: 12,
        consecutiveBurst: { side: 'sell', count: 5 },
      },
    }));
  }

  const exitDecision = strategy.evaluate(baseInput(now + 1000, {
    position,
    market: {
      price: 99.2,
      vwap: 100,
      delta1s: -2.0,
      delta5s: -1.8,
      deltaZ: -3.0,
      cvdSlope: -1.2,
      obiWeighted: -0.8,
      obiDeep: -0.9,
      obiDivergence: -0.3,
    },
    trades: {
      lastUpdatedMs: now + 1000,
      printsPerSecond: 6,
      tradeCount: 25,
      aggressiveBuyVolume: 3,
      aggressiveSellVolume: 12,
      consecutiveBurst: { side: 'sell', count: 6 },
    },
  }));

  const hasExit = exitDecision.actions.some((a) => a.type === 'EXIT');
  assert(hasExit, 'should generate hard exit after break');

  // Cooldown should block immediate re-entry
  const reentryDecision = strategy.evaluate(baseInput(now + 2000, {
    market: {
      price: 101,
      vwap: 100,
      delta1s: 2.5,
      delta5s: 3.0,
      deltaZ: 3.5,
      cvdSlope: 1.2,
      obiWeighted: 0.8,
      obiDeep: 0.9,
      obiDivergence: 0.2,
    },
    trades: {
      lastUpdatedMs: now + 2000,
      printsPerSecond: 8,
      tradeCount: 30,
      aggressiveBuyVolume: 20,
      aggressiveSellVolume: 4,
      consecutiveBurst: { side: 'buy', count: 6 },
    },
  }));

  const blocked = reentryDecision.actions.every((a) => a.type === 'NOOP');
  assert(blocked, 'cooldown should block immediate re-entry');
}
