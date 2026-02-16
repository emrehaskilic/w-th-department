import { DryRunSessionService } from '../dryrun';
import { StrategySignal } from '../types/strategy';

const symbol = 'BTCUSDT';
const service = new DryRunSessionService();

service.start({
  symbols: [symbol],
  runId: 'dryrun-replay-001',
  walletBalanceStartUsdt: 5000,
  initialMarginUsdt: 200,
  leverage: 10,
  makerFeeRate: 0.0002,
  takerFeeRate: 0.0004,
  heartbeatIntervalMs: 1000,
  debugAggressiveEntry: false,
});

let ts = 1_700_000_000_000;
const spread = 0.02;

function book(price: number) {
  const bid = Number((price - (spread / 2)).toFixed(2));
  const ask = Number((price + (spread / 2)).toFixed(2));
  return {
    bids: [{ price: bid, qty: 50 }],
    asks: [{ price: ask, qty: 50 }],
  };
}

function tick(price: number, stepMs = 1000) {
  ts += stepMs;
  service.ingestDepthEvent({
    symbol,
    eventTimestampMs: ts,
    orderBook: book(price),
    markPrice: price,
  });
}

function makeSignal(side: 'LONG' | 'SHORT', price: number, score = 80): StrategySignal {
  const signal = side === 'LONG' ? 'BREAKOUT_LONG' : 'BREAKOUT_SHORT';
  const tp = side === 'LONG' ? price * 1.02 : price * 0.98;
  const sl = side === 'LONG' ? price * 0.98 : price * 1.02;
  return {
    signal,
    score,
    vetoReason: null,
    candidate: {
      entryPrice: price,
      tpPrice: tp,
      slPrice: sl,
    },
    orderflow: {
      obiWeighted: 0.2,
      obiDeep: 0.2,
      deltaZ: 0.3,
      cvdSlope: 0.1,
    },
    market: {
      price,
      atr: 0.1,
      avgAtr: 0.1,
      recentHigh: price * 1.01,
      recentLow: price * 0.99,
    },
  };
}

function signal(side: 'LONG' | 'SHORT', price: number, score = 80) {
  service.submitStrategySignal(symbol, makeSignal(side, price, score), ts);
}

async function main() {
  // Warm-up ticks for ATR.
  for (let i = 0; i < 20; i += 1) {
    tick(100 + (i * 0.05));
  }

  // Entry + flip blocked.
  signal('LONG', 100.95);
  tick(100.95);
  signal('SHORT', 100.95);

  // Add-on while winning.
  tick(101.6, 61_000);
  signal('LONG', 101.6);
  tick(101.7);
  tick(101.4);

  // Trail stop exit.
  tick(102.4);
  tick(102.0);

  // Profit lock exit (short trade).
  signal('SHORT', 102.0);
  tick(102.0);
  tick(101.3);
  tick(101.9);

  // Let logger flush and close.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const logger = (service as any).tradeLogger;
  if (logger && typeof logger.shutdown === 'function') {
    logger.shutdown();
  }
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});
