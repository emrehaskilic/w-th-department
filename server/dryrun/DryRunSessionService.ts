import { DryRunEngine } from './DryRunEngine';
import { DryRunConfig, DryRunEventInput, DryRunEventLog, DryRunOrderBook, DryRunOrderRequest, DryRunStateSnapshot } from './types';

export interface DryRunSessionStartInput {
  symbol: string;
  runId?: string;
  walletBalanceStartUsdt: number;
  initialMarginUsdt: number;
  leverage: number;
  takerFeeRate?: number;
  maintenanceMarginRate?: number;
  fundingRate?: number;
  fundingIntervalMs?: number;
}

export interface DryRunSessionStatus {
  running: boolean;
  runId: string | null;
  symbol: string | null;
  config: {
    walletBalanceStartUsdt: number;
    initialMarginUsdt: number;
    leverage: number;
    takerFeeRate: number;
    maintenanceMarginRate: number;
    fundingRate: number;
    fundingIntervalMs: number;
  } | null;
  metrics: {
    markPrice: number;
    totalEquity: number;
    walletBalance: number;
    unrealizedPnl: number;
    realizedPnl: number;
    feePaid: number;
    fundingPnl: number;
    marginHealth: number;
  };
  position: {
    side: 'LONG' | 'SHORT';
    qty: number;
    entryPrice: number;
    markPrice: number;
    liqPrice: null;
  } | null;
  openLimitOrders: DryRunStateSnapshot['openLimitOrders'];
  lastEventTimestampMs: number;
  logTail: DryRunEventLog[];
}

const DEFAULT_TAKER_FEE_RATE = 0.0004;
const DEFAULT_MAINTENANCE_MARGIN_RATE = 0.005;
const DEFAULT_FUNDING_RATE = 0;
const DEFAULT_FUNDING_INTERVAL_MS = 8 * 60 * 60 * 1000;
const DEFAULT_EVENT_INTERVAL_MS = Number(process.env.DRY_RUN_EVENT_INTERVAL_MS || 1000);
const DEFAULT_ORDERBOOK_DEPTH = Number(process.env.DRY_RUN_ORDERBOOK_DEPTH || 20);
const DEFAULT_TP_BPS = Number(process.env.DRY_RUN_TP_BPS || 15);
const DEFAULT_STOP_BPS = Number(process.env.DRY_RUN_STOP_BPS || 35);
const DEFAULT_ENTRY_COOLDOWN_MS = Number(process.env.DRY_RUN_ENTRY_COOLDOWN_MS || 5000);
const LOG_TAIL_LIMIT = Number(process.env.DRY_RUN_LOG_TAIL_LIMIT || 200);

function finiteOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeSymbol(symbol: string): string {
  return String(symbol || '').trim().toUpperCase();
}

function roundTo(value: number, decimals: number): number {
  const m = Math.pow(10, Math.max(0, decimals));
  return Math.round(value * m) / m;
}

export class DryRunSessionService {
  private engine: DryRunEngine | null = null;
  private running = false;
  private runId: string | null = null;
  private symbol: string | null = null;
  private config: DryRunSessionStatus['config'] = null;

  private runCounter = 0;
  private lastEventTimestampMs = 0;
  private lastState: DryRunStateSnapshot | null = null;
  private latestMarkPrice = 0;
  private lastMarkPrice = 0;
  private lastEntryEventTs = 0;

  private realizedPnl = 0;
  private feePaid = 0;
  private fundingPnl = 0;
  private logTail: DryRunEventLog[] = [];

  start(input: DryRunSessionStartInput): DryRunSessionStatus {
    const symbol = normalizeSymbol(input.symbol);
    if (!symbol) {
      throw new Error('symbol_required');
    }

    const walletBalanceStartUsdt = finiteOr(input.walletBalanceStartUsdt, 5000);
    const initialMarginUsdt = finiteOr(input.initialMarginUsdt, 200);
    const leverage = finiteOr(input.leverage, 10);

    if (!(walletBalanceStartUsdt > 0)) throw new Error('wallet_balance_start_must_be_positive');
    if (!(initialMarginUsdt > 0)) throw new Error('initial_margin_must_be_positive');
    if (!(leverage > 0)) throw new Error('leverage_must_be_positive');

    this.runCounter += 1;
    this.runId = String(input.runId || `dryrun-${symbol}-${this.runCounter}`);
    this.symbol = symbol;
    this.running = true;
    this.lastEventTimestampMs = 0;
    this.lastState = null;
    this.latestMarkPrice = 0;
    this.lastMarkPrice = 0;
    this.lastEntryEventTs = 0;
    this.realizedPnl = 0;
    this.feePaid = 0;
    this.fundingPnl = 0;
    this.logTail = [];

    const cfg: DryRunConfig = {
      runId: this.runId,
      walletBalanceStartUsdt,
      initialMarginUsdt,
      leverage,
      takerFeeRate: finiteOr(input.takerFeeRate, DEFAULT_TAKER_FEE_RATE),
      maintenanceMarginRate: finiteOr(input.maintenanceMarginRate, DEFAULT_MAINTENANCE_MARGIN_RATE),
      fundingRate: finiteOr(input.fundingRate, DEFAULT_FUNDING_RATE),
      fundingIntervalMs: Math.max(1, Math.trunc(finiteOr(input.fundingIntervalMs, DEFAULT_FUNDING_INTERVAL_MS))),
      proxy: {
        mode: 'backend-proxy',
        restBaseUrl: 'https://fapi.binance.com',
        marketWsBaseUrl: 'wss://fstream.binance.com/stream',
      },
    };

    this.engine = new DryRunEngine(cfg);
    this.config = {
      walletBalanceStartUsdt,
      initialMarginUsdt,
      leverage,
      takerFeeRate: cfg.takerFeeRate,
      maintenanceMarginRate: cfg.maintenanceMarginRate,
      fundingRate: cfg.fundingRate,
      fundingIntervalMs: cfg.fundingIntervalMs,
    };
    this.lastState = this.engine.getStateSnapshot();

    return this.getStatus();
  }

  stop(): DryRunSessionStatus {
    this.running = false;
    return this.getStatus();
  }

  reset(): DryRunSessionStatus {
    this.running = false;
    this.engine = null;
    this.runId = null;
    this.symbol = null;
    this.config = null;
    this.lastEventTimestampMs = 0;
    this.lastState = null;
    this.latestMarkPrice = 0;
    this.lastMarkPrice = 0;
    this.lastEntryEventTs = 0;
    this.realizedPnl = 0;
    this.feePaid = 0;
    this.fundingPnl = 0;
    this.logTail = [];
    return this.getStatus();
  }

  getActiveSymbol(): string | null {
    return this.running ? this.symbol : null;
  }

  ingestDepthEvent(input: {
    symbol: string;
    eventTimestampMs: number;
    orderBook: DryRunOrderBook;
    markPrice?: number;
  }): DryRunSessionStatus | null {
    if (!this.running || !this.engine || !this.symbol) return null;
    const symbol = normalizeSymbol(input.symbol);
    if (symbol !== this.symbol) return null;

    const eventTimestampMs = Number(input.eventTimestampMs);
    if (!Number.isFinite(eventTimestampMs) || eventTimestampMs <= 0) return null;
    if (this.lastEventTimestampMs > 0 && eventTimestampMs <= this.lastEventTimestampMs) return null;
    if (this.lastEventTimestampMs > 0 && (eventTimestampMs - this.lastEventTimestampMs) < DEFAULT_EVENT_INTERVAL_MS) {
      return null;
    }

    const book = this.normalizeBook(input.orderBook);
    if (book.bids.length === 0 || book.asks.length === 0) return null;

    const bestBid = book.bids[0].price;
    const bestAsk = book.asks[0].price;
    const resolvedMarkPriceRaw = Number.isFinite(input.markPrice as number) && Number(input.markPrice) > 0
      ? Number(input.markPrice)
      : (bestBid + bestAsk) / 2;
    const markPrice = roundTo(resolvedMarkPriceRaw, 8);
    if (!(markPrice > 0)) return null;

    const orders = this.buildDeterministicOrders(markPrice, eventTimestampMs);
    const event: DryRunEventInput = {
      timestampMs: eventTimestampMs,
      markPrice,
      orderBook: book,
      orders,
    };

    const out = this.engine.processEvent(event);
    this.lastEventTimestampMs = eventTimestampMs;
    this.lastState = out.state;
    this.lastMarkPrice = this.latestMarkPrice;
    this.latestMarkPrice = markPrice;
    this.realizedPnl += out.log.realizedPnl;
    this.feePaid += out.log.fee;
    this.fundingPnl += out.log.fundingImpact;
    this.logTail.push(out.log);
    if (this.logTail.length > LOG_TAIL_LIMIT) {
      this.logTail = this.logTail.slice(this.logTail.length - LOG_TAIL_LIMIT);
    }
    return this.getStatus();
  }

  getStatus(): DryRunSessionStatus {
    const walletBalance = this.lastState?.walletBalance ?? this.config?.walletBalanceStartUsdt ?? 0;
    const unrealizedPnl = this.computeUnrealizedPnl();
    const totalEquity = walletBalance + unrealizedPnl;
    const marginHealth = this.lastState?.marginHealth ?? 0;

    const position = this.lastState?.position
      ? {
          side: this.lastState.position.side,
          qty: this.lastState.position.qty,
          entryPrice: this.lastState.position.entryPrice,
          markPrice: this.latestMarkPrice,
          liqPrice: null,
        }
      : null;

    return {
      running: this.running,
      runId: this.runId,
      symbol: this.symbol,
      config: this.config,
      metrics: {
        markPrice: this.latestMarkPrice,
        totalEquity: roundTo(totalEquity, 8),
        walletBalance: roundTo(walletBalance, 8),
        unrealizedPnl: roundTo(unrealizedPnl, 8),
        realizedPnl: roundTo(this.realizedPnl, 8),
        feePaid: roundTo(this.feePaid, 8),
        fundingPnl: roundTo(this.fundingPnl, 8),
        marginHealth: roundTo(marginHealth, 8),
      },
      position,
      openLimitOrders: this.lastState?.openLimitOrders || [],
      lastEventTimestampMs: this.lastEventTimestampMs,
      logTail: [...this.logTail],
    };
  }

  private normalizeBook(orderBook: DryRunOrderBook): DryRunOrderBook {
    const depth = Math.max(1, Math.trunc(DEFAULT_ORDERBOOK_DEPTH));
    const normalize = (levels: Array<{ price: number; qty: number }>, asc: boolean) => {
      const sorted = levels
        .filter((l) => Number.isFinite(l.price) && l.price > 0 && Number.isFinite(l.qty) && l.qty > 0)
        .map((l) => ({ price: Number(l.price), qty: Number(l.qty) }))
        .sort((a, b) => asc ? a.price - b.price : b.price - a.price);
      return sorted.slice(0, depth);
    };
    return {
      bids: normalize(orderBook.bids || [], false),
      asks: normalize(orderBook.asks || [], true),
    };
  }

  private buildDeterministicOrders(markPrice: number, eventTimestampMs: number): DryRunOrderRequest[] {
    if (!this.config || !this.lastState) {
      return [];
    }

    const state = this.lastState;
    const orders: DryRunOrderRequest[] = [];
    const entryCooldownMs = Math.max(0, Math.trunc(DEFAULT_ENTRY_COOLDOWN_MS));
    const hasOpenLimits = state.openLimitOrders.length > 0;

    if (!state.position && !hasOpenLimits) {
      if (this.lastEntryEventTs === 0 || (eventTimestampMs - this.lastEntryEventTs) >= entryCooldownMs) {
        const side: 'BUY' | 'SELL' = this.resolveEntrySide(markPrice);
        const targetNotional = this.config.initialMarginUsdt * this.config.leverage;
        const qtyRaw = targetNotional / markPrice;
        const qty = roundTo(Math.max(0, qtyRaw), 6);
        if (qty > 0) {
          orders.push({ side, type: 'MARKET', qty, timeInForce: 'IOC', reduceOnly: false });
          this.lastEntryEventTs = eventTimestampMs;
        }
      }
      return orders;
    }

    if (!state.position) {
      return orders;
    }

    const position = state.position;
    if (!hasOpenLimits) {
      const tpBps = Math.max(1, DEFAULT_TP_BPS);
      const isLong = position.side === 'LONG';
      const multiplier = isLong ? (1 + (tpBps / 10000)) : (1 - (tpBps / 10000));
      const tpPrice = roundTo(position.entryPrice * multiplier, 8);
      const closeSide: 'BUY' | 'SELL' = isLong ? 'SELL' : 'BUY';
      orders.push({
        side: closeSide,
        type: 'LIMIT',
        qty: roundTo(position.qty, 6),
        price: tpPrice,
        timeInForce: 'GTC',
        reduceOnly: true,
      });
      return orders;
    }

    const stopBps = Math.max(1, DEFAULT_STOP_BPS);
    const isLong = position.side === 'LONG';
    const pnlBps = isLong
      ? ((markPrice - position.entryPrice) / position.entryPrice) * 10000
      : ((position.entryPrice - markPrice) / position.entryPrice) * 10000;
    if (pnlBps <= -stopBps) {
      const closeSide: 'BUY' | 'SELL' = isLong ? 'SELL' : 'BUY';
      orders.push({
        side: closeSide,
        type: 'MARKET',
        qty: roundTo(position.qty, 6),
        timeInForce: 'IOC',
        reduceOnly: true,
      });
    }

    return orders;
  }

  private resolveEntrySide(markPrice: number): 'BUY' | 'SELL' {
    if (this.lastMarkPrice <= 0) {
      return 'BUY';
    }
    return markPrice >= this.lastMarkPrice ? 'BUY' : 'SELL';
  }

  private computeUnrealizedPnl(): number {
    if (!this.lastState?.position || !(this.latestMarkPrice > 0)) {
      return 0;
    }
    const pos = this.lastState.position;
    if (pos.side === 'LONG') {
      return (this.latestMarkPrice - pos.entryPrice) * pos.qty;
    }
    return (pos.entryPrice - this.latestMarkPrice) * pos.qty;
  }
}
