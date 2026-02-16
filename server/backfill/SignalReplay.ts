import { MarketDataArchive, ArchiveEvent } from './MarketDataArchive';
import { LegacyCalculator } from '../metrics/LegacyCalculator';
import { NewStrategyV11 } from '../strategy/NewStrategyV11';
import { createOrderbookState, applySnapshot } from '../metrics/OrderbookManager';
import { TimeAndSales } from '../metrics/TimeAndSales';

export interface SignalReplayResult {
  symbol: string;
  signals: Array<{
    timestampMs: number;
    signal: string | null;
    score: number;
    confidence?: string;
  }>;
  sampleCount: number;
}

function updateAtr(history: number[], price: number, window = 14): number {
  history.push(price);
  while (history.length > window + 1) history.shift();
  if (history.length < 2) return 0;
  const diffs = [] as number[];
  for (let i = 1; i < history.length; i += 1) {
    diffs.push(Math.abs(history[i] - history[i - 1]));
  }
  return diffs.reduce((acc, v) => acc + v, 0) / diffs.length;
}

export class SignalReplay {
  constructor(private readonly archive: MarketDataArchive) {}

  async replay(symbol: string, options: { fromMs?: number; toMs?: number; limit?: number } = {}): Promise<SignalReplayResult> {
    const events = await this.archive.loadEvents(symbol, {
      fromMs: options.fromMs,
      toMs: options.toMs,
      limit: options.limit,
      types: ['orderbook', 'trade'],
    });

    const orderbook = createOrderbookState();
    const legacy = new LegacyCalculator();
    const tas = new TimeAndSales();
    const strategy = new NewStrategyV11();
    const signals: SignalReplayResult['signals'] = [];
    const priceHistory: number[] = [];
    let atr = 0;

    for (const event of events) {
      if (event.type === 'orderbook') {
        applySnapshot(orderbook, {
          lastUpdateId: event.payload.lastUpdateId || 0,
          bids: event.payload.bids || [],
          asks: event.payload.asks || [],
        });
      }

      if (event.type === 'trade') {
        const price = Number(event.payload.price || event.payload.p || 0);
        const qty = Number(event.payload.quantity || event.payload.q || 0);
        const side = event.payload.side || (event.payload.m ? 'sell' : 'buy');
        if (price > 0) {
          atr = updateAtr(priceHistory, price);
        }
        tas.addTrade({ price, quantity: qty, side, timestamp: event.timestampMs });
        legacy.addTrade({ price, quantity: qty, side, timestamp: event.timestampMs });
        const metrics = legacy.computeMetrics(orderbook);
        if (metrics) {
          const tasMetrics = tas.computeMetrics();
          const decision = strategy.evaluate({
            symbol,
            nowMs: event.timestampMs,
            source: 'real',
            orderbook: {
              lastUpdatedMs: event.timestampMs,
              spreadPct: null,
              bestBid: null,
              bestAsk: null,
            },
            trades: {
              lastUpdatedMs: event.timestampMs,
              printsPerSecond: tasMetrics.printsPerSecond,
              tradeCount: tasMetrics.tradeCount,
              aggressiveBuyVolume: tasMetrics.aggressiveBuyVolume,
              aggressiveSellVolume: tasMetrics.aggressiveSellVolume,
              consecutiveBurst: tasMetrics.consecutiveBurst,
            },
            market: {
              price,
              vwap: metrics.vwap || price,
              delta1s: metrics.delta1s || 0,
              delta5s: metrics.delta5s || 0,
              deltaZ: metrics.deltaZ || 0,
              cvdSlope: metrics.cvdSlope || 0,
              obiWeighted: metrics.obiWeighted || 0,
              obiDeep: metrics.obiDeep || 0,
              obiDivergence: metrics.obiDivergence || 0,
            },
            openInterest: null,
            absorption: null,
            volatility: atr,
            position: null,
          });
          signals.push({
            timestampMs: event.timestampMs,
            signal: decision.actions[0]?.reason ?? null,
            score: Math.round((decision.dfsPercentile || 0) * 100),
            confidence: decision.gatePassed ? 'PASS' : 'BLOCKED',
          });
        }
      }
    }

    return { symbol, signals, sampleCount: signals.length };
  }
}
