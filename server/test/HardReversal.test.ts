// Minimal assertion helper
function assert(condition: any, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

import { NewStrategyV11 } from '../strategy/NewStrategyV11';
import { StrategyInput, StrategyPositionState } from '../types/strategy';

function makeInput(nowMs: number, overrides: Partial<StrategyInput> = {}): StrategyInput {
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
      printsPerSecond: 8,
      tradeCount: 25,
      aggressiveBuyVolume: 5,
      aggressiveSellVolume: 20,
      consecutiveBurst: { side: 'sell', count: 7 },
    },
    market: {
      price: 99.0,
      vwap: 100.0,
      delta1s: -3.0,
      delta5s: -2.5,
      deltaZ: -3.5,
      cvdSlope: -1.2,
      obiWeighted: -0.8,
      obiDeep: -0.9,
      obiDivergence: -0.4,
    },
    openInterest: null,
    absorption: { value: 1, side: 'sell' },
    volatility: 1.5,
    position: null,
    ...overrides,
  };
}

export function runTests() {
  const strategy = new NewStrategyV11({ hardRevTicks: 5 });
  let now = 2_000_000;

  // Warm-up baseline
  for (let i = 0; i < 15; i += 1) {
    strategy.evaluate(makeInput(now + i * 1000, {
      market: {
        price: 100,
        vwap: 100,
        delta1s: 0.1,
        delta5s: 0.1,
        deltaZ: 0.1,
        cvdSlope: 0.05,
        obiWeighted: 0.05,
        obiDeep: 0.05,
        obiDivergence: 0.01,
      },
      trades: {
        lastUpdatedMs: now + i * 1000,
        printsPerSecond: 3,
        tradeCount: 15,
        aggressiveBuyVolume: 8,
        aggressiveSellVolume: 7,
        consecutiveBurst: { side: 'buy', count: 2 },
      },
      absorption: { value: 0, side: null },
    }));
  }

  const position: StrategyPositionState = {
    side: 'LONG',
    qty: 1,
    entryPrice: 101,
    unrealizedPnlPct: -0.01,
    addsUsed: 0,
  };

  // Feed vwap-below ticks to satisfy persistence
  for (let i = 0; i < 5; i += 1) {
    now += 1000;
    strategy.evaluate(makeInput(now, { position }));
  }

  // Hard reversal tick
  now += 1000;
  const decision = strategy.evaluate(makeInput(now, {
    position,
    market: {
      price: 98.9,
      vwap: 100.0,
      delta1s: -4.5,
      delta5s: -4.0,
      deltaZ: -4.2,
      cvdSlope: -2.0,
      obiWeighted: -0.9,
      obiDeep: -1.0,
      obiDivergence: -0.5,
    },
    trades: {
      lastUpdatedMs: now,
      printsPerSecond: 12,
      tradeCount: 40,
      aggressiveBuyVolume: 4,
      aggressiveSellVolume: 30,
      consecutiveBurst: { side: 'sell', count: 10 },
    },
    absorption: { value: 1, side: 'sell' },
  }));

  const hasHardExit = decision.actions.some((a) => a.reason === 'EXIT_HARD_REVERSAL');
  const hasHardEntry = decision.actions.some((a) => a.reason === 'HARD_REVERSAL_ENTRY');
  assert(hasHardExit && hasHardEntry, 'hard reversal should emit exit and entry');
}
