import { DeterministicIdGenerator } from './DeterministicId';
import { MarketImpactSimulator } from './MarketImpactSimulator';
import {
  Fp,
  fpAbs,
  fpAdd,
  fpCmp,
  fpDiv,
  fpIsPositive,
  fpMax,
  fpMin,
  fpMul,
  fpRoundTo,
  fpSign,
  fpSub,
  fpZero,
  fromFp,
  toFp,
} from './DryRunMath';
import { assertMainnetProxyConfig } from './UpstreamGuard';
import {
  DryRunBookLevel,
  DryRunConfig,
  DryRunEventInput,
  DryRunEventLog,
  DryRunOrderBook,
  DryRunOrderRequest,
  DryRunOrderResult,
  DryRunSide,
  DryRunStateSnapshot,
} from './types';

type PositionInternal = {
  signedQty: Fp;
  entryPrice: Fp;
  entryTimestampMs: number;
} | null;

type PendingLimitOrder = {
  orderId: string;
  side: DryRunSide;
  price: Fp;
  remainingQty: Fp;
  reduceOnly: boolean;
  createdTsMs: number;
};

type FillComputation = {
  fillQty: Fp;
  remainingQty: Fp;
  notional: Fp;
  avgPrice: Fp;
  slippageBps?: number;
  marketImpactBps?: number;
};

function sideToSignedQty(side: DryRunSide, qty: Fp): Fp {
  return side === 'BUY' ? qty : -qty;
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(value);
}

export class DryRunEngine {
  private readonly cfg: {
    runId: string;
    takerFeeRate: Fp;
    maintenanceMarginRate: Fp;
    fundingRate: Fp;
    fundingIntervalMs: number;
    initialMarginUsdt: Fp;
    leverage: Fp;
  };

  private readonly idGen: DeterministicIdGenerator;
  private readonly marketImpactSimulator: MarketImpactSimulator;

  private walletBalance: Fp;
  private position: PositionInternal = null;
  private pendingLimits = new Map<string, PendingLimitOrder>();
  private logs: DryRunEventLog[] = [];
  private sequence = 0;
  private lastEventTs = 0;
  private lastFundingBoundaryTsUTC: number;
  private fundingBoundaryInitialized: boolean;

  constructor(config: DryRunConfig) {
    assertMainnetProxyConfig(config.proxy);
    if (config.fundingIntervalMs <= 0) {
      throw new Error('invalid_funding_interval_ms');
    }
    const leverage = Number.isFinite(config.leverage as number) ? Number(config.leverage) : 1;
    if (leverage <= 0) {
      throw new Error('invalid_leverage');
    }
    this.cfg = {
      runId: config.runId,
      takerFeeRate: toFp(config.takerFeeRate),
      maintenanceMarginRate: toFp(config.maintenanceMarginRate),
      fundingRate: toFp(config.fundingRate),
      fundingIntervalMs: config.fundingIntervalMs,
      initialMarginUsdt: toFp(config.initialMarginUsdt),
      leverage: toFp(leverage),
    };
    this.marketImpactSimulator = new MarketImpactSimulator(config.marketImpact);
    this.walletBalance = toFp(config.walletBalanceStartUsdt);
    this.idGen = new DeterministicIdGenerator(config.runId);
    this.fundingBoundaryInitialized = Number.isFinite(config.fundingBoundaryStartTsUTC as number);
    this.lastFundingBoundaryTsUTC = this.fundingBoundaryInitialized
      ? Number(config.fundingBoundaryStartTsUTC)
      : 0;
  }

  processEvent(event: DryRunEventInput): { log: DryRunEventLog; state: DryRunStateSnapshot } {
    if (!Number.isFinite(event.timestampMs) || event.timestampMs <= 0) {
      throw new Error(`invalid_event_timestamp:${event.timestampMs}`);
    }
    if (event.timestampMs < this.lastEventTs) {
      throw new Error(`non_monotonic_event_timestamp:${event.timestampMs}<${this.lastEventTs}`);
    }
    this.lastEventTs = event.timestampMs;

    const markPrice = toFp(event.markPrice);
    const book = this.normalizeBook(event.orderBook);

    if (!this.fundingBoundaryInitialized) {
      this.lastFundingBoundaryTsUTC = Math.floor(event.timestampMs / this.cfg.fundingIntervalMs) * this.cfg.fundingIntervalMs;
      this.fundingBoundaryInitialized = true;
    }

    const walletBefore = this.walletBalance;
    let realizedPnl = fpZero;
    let fee = fpZero;
    let fundingImpact = fpZero;
    let liquidationTriggered = false;
    const orderResults: DryRunOrderResult[] = [];

    fundingImpact = this.applyFundingWithGapLoop(event.timestampMs, markPrice);

    const pendingResults = this.processPendingLimitOrders(event.timestampMs, book);
    for (const r of pendingResults) {
      realizedPnl = fpAdd(realizedPnl, r.realizedPnlFp);
      fee = fpAdd(fee, r.feeFp);
      orderResults.push(r.result);
    }

    for (const order of event.orders || []) {
      const result = this.executeOrder(order, event.timestampMs, book);
      realizedPnl = fpAdd(realizedPnl, result.realizedPnlFp);
      fee = fpAdd(fee, result.feeFp);
      orderResults.push(result.result);
    }

    const liquidation = this.checkAndForceLiquidation(event.timestampMs, book, markPrice);
    if (liquidation) {
      liquidationTriggered = true;
      realizedPnl = fpAdd(realizedPnl, liquidation.realizedPnlFp);
      fee = fpAdd(fee, liquidation.feeFp);
      orderResults.push(liquidation.result);
    }

    const expectedAfterRaw = fpAdd(fpSub(fpAdd(walletBefore, realizedPnl), fee), fundingImpact);
    const expectedAfter = liquidationTriggered && expectedAfterRaw < 0n ? 0n : expectedAfterRaw;
    if (expectedAfter !== this.walletBalance) {
      throw new Error(`wallet_reconciliation_failed:${fromFp(walletBefore)}=>${fromFp(this.walletBalance)} expected ${fromFp(expectedAfter)}`);
    }

    this.sequence += 1;
    const marginHealth = this.computeMarginHealth(markPrice);
    const log: DryRunEventLog = {
      runId: this.cfg.runId,
      eventTimestampMs: event.timestampMs,
      sequence: this.sequence,
      eventId: this.idGen.nextEventId(event.timestampMs),
      walletBalanceBefore: fpRoundTo(walletBefore, 8),
      walletBalanceAfter: fpRoundTo(this.walletBalance, 8),
      realizedPnl: fpRoundTo(realizedPnl, 8),
      fee: fpRoundTo(fee, 8),
      fundingImpact: fpRoundTo(fundingImpact, 8),
      reconciliationExpectedAfter: fpRoundTo(expectedAfter, 8),
      marginHealth,
      liquidationTriggered,
      orderResults,
    };
    this.logs.push(log);

    return { log, state: this.getStateSnapshot(markPrice) };
  }

  run(events: DryRunEventInput[]): { logs: DryRunEventLog[]; finalState: DryRunStateSnapshot } {
    let state = this.getStateSnapshot(fpZero);
    for (const event of events) {
      const result = this.processEvent(event);
      state = result.state;
    }
    return { logs: [...this.logs], finalState: state };
  }

  getLogs(): DryRunEventLog[] {
    return [...this.logs];
  }

  getStateSnapshot(markPriceInput?: Fp): DryRunStateSnapshot {
    const markPrice = markPriceInput ?? (this.position ? this.position.entryPrice : fpZero);
    const openLimitOrders = Array.from(this.pendingLimits.values()).map((o) => ({
      orderId: o.orderId,
      side: o.side,
      price: fpRoundTo(o.price, 8),
      remainingQty: fpRoundTo(o.remainingQty, 8),
      reduceOnly: o.reduceOnly,
      createdTsMs: o.createdTsMs,
    }));
    return {
      walletBalance: fpRoundTo(this.walletBalance, 8),
      position: this.position
        ? {
            side: this.position.signedQty > 0n ? 'LONG' : 'SHORT',
            qty: fpRoundTo(fpAbs(this.position.signedQty), 8),
            entryPrice: fpRoundTo(this.position.entryPrice, 8),
          }
        : null,
      openLimitOrders,
      lastFundingBoundaryTsUTC: this.lastFundingBoundaryTsUTC,
      marginHealth: this.computeMarginHealth(markPrice),
    };
  }

  private normalizeBook(orderBook: DryRunOrderBook): DryRunOrderBook {
    const norm = (levels: DryRunBookLevel[]): DryRunBookLevel[] => {
      return levels
        .filter((l) => Number.isFinite(l.price) && l.price > 0 && Number.isFinite(l.qty) && l.qty > 0)
        .map((l) => ({ price: l.price, qty: l.qty }));
    };
    return {
      bids: norm(orderBook.bids).sort((a, b) => b.price - a.price),
      asks: norm(orderBook.asks).sort((a, b) => a.price - b.price),
    };
  }

  private applyFundingWithGapLoop(eventTimestampMs: number, markPrice: Fp): Fp {
    let totalFunding = fpZero;
    let nextBoundary = this.lastFundingBoundaryTsUTC + this.cfg.fundingIntervalMs;
    while (eventTimestampMs >= nextBoundary) {
      let impact = fpZero;
      if (this.position && this.position.signedQty !== 0n) {
        const sideSign = this.position.signedQty > 0n ? 1n : -1n;
        const notional = fpMul(fpAbs(this.position.signedQty), markPrice);
        const signedNotional = sideSign > 0n ? notional : -notional;
        impact = fpMul(-signedNotional, this.cfg.fundingRate);
        this.walletBalance = fpAdd(this.walletBalance, impact);
      }
      totalFunding = fpAdd(totalFunding, impact);
      this.lastFundingBoundaryTsUTC = nextBoundary;
      nextBoundary += this.cfg.fundingIntervalMs;
    }
    return totalFunding;
  }

  private processPendingLimitOrders(timestampMs: number, book: DryRunOrderBook): Array<{
    result: DryRunOrderResult;
    realizedPnlFp: Fp;
    feeFp: Fp;
  }> {
    const out: Array<{ result: DryRunOrderResult; realizedPnlFp: Fp; feeFp: Fp }> = [];
    for (const pending of Array.from(this.pendingLimits.values())) {
      const execution = this.executeWithOrderbook({
        orderId: pending.orderId,
        side: pending.side,
        type: 'LIMIT',
        tif: 'GTC',
        reduceOnly: pending.reduceOnly,
        price: pending.price,
        qty: pending.remainingQty,
        timestampMs,
        book,
        forced: false,
      });
      out.push({
        result: execution.result,
        realizedPnlFp: execution.realizedPnlFp,
        feeFp: execution.feeFp,
      });
      if (execution.remainingAfter > 0n) {
        const prev = this.pendingLimits.get(pending.orderId);
        if (prev) {
          prev.remainingQty = execution.remainingAfter;
        }
      } else {
        this.pendingLimits.delete(pending.orderId);
      }
    }
    return out;
  }

  private executeOrder(
    input: DryRunOrderRequest,
    timestampMs: number,
    book: DryRunOrderBook
  ): {
    result: DryRunOrderResult;
    realizedPnlFp: Fp;
    feeFp: Fp;
  } {
    const qty = toFp(input.qty);
    const side = input.side;
    const type = input.type;
    const tif = input.type === 'MARKET' ? 'IOC' : (input.timeInForce || 'GTC');
    const reduceOnly = Boolean(input.reduceOnly);
    const price = type === 'LIMIT' ? toFp(Number(input.price || 0)) : fpZero;
    const orderId = this.idGen.nextOrderId({
      timestampMs,
      side,
      qty: input.qty,
      type,
      price: input.price,
    });

    if (isUuidLike(orderId)) {
      throw new Error(`invalid_random_like_order_id:${orderId}`);
    }

    if (qty <= 0n) {
      return { result: this.makeRejected(orderId, side, type, input.qty, 'INVALID_QTY'), realizedPnlFp: fpZero, feeFp: fpZero };
    }

    if (type === 'LIMIT' && price <= 0n) {
      return { result: this.makeRejected(orderId, side, type, input.qty, 'INVALID_LIMIT_PRICE'), realizedPnlFp: fpZero, feeFp: fpZero };
    }

    if (reduceOnly) {
      const currentSign = this.position ? fpSign(this.position.signedQty) : 0;
      const sideSign = side === 'BUY' ? 1 : -1;
      if (currentSign === 0 || currentSign === sideSign) {
        return { result: this.makeRejected(orderId, side, type, input.qty, 'REDUCE_ONLY_REJECTED'), realizedPnlFp: fpZero, feeFp: fpZero };
      }
    }

    const execution = this.executeWithOrderbook({
      orderId,
      side,
      type,
      tif,
      reduceOnly,
      price,
      qty,
      timestampMs,
      book,
      forced: false,
    });

    if (type === 'LIMIT' && tif === 'GTC' && execution.remainingAfter > 0n) {
      this.pendingLimits.set(orderId, {
        orderId,
        side,
        price,
        remainingQty: execution.remainingAfter,
        reduceOnly,
        createdTsMs: timestampMs,
      });
    }

    return {
      result: execution.result,
      realizedPnlFp: execution.realizedPnlFp,
      feeFp: execution.feeFp,
    };
  }

  private executeWithOrderbook(input: {
    orderId: string;
    side: DryRunSide;
    type: 'MARKET' | 'LIMIT';
    tif: 'IOC' | 'GTC';
    reduceOnly: boolean;
    price: Fp;
    qty: Fp;
    timestampMs: number;
    book: DryRunOrderBook;
    forced: boolean;
  }): { result: DryRunOrderResult; remainingAfter: Fp; realizedPnlFp: Fp; feeFp: Fp } {
    const requestedQty = input.qty;
    const allowedQty = this.applyPositionCapBeforeExecution(input.side, requestedQty, input.reduceOnly, input.price, input.type, input.book);
    if (allowedQty <= 0n) {
      return {
        result: this.makeRejected(input.orderId, input.side, input.type, fromFp(requestedQty), 'POSITION_LIMIT_REJECTED'),
        remainingAfter: fpZero,
        realizedPnlFp: fpZero,
        feeFp: fpZero,
      };
    }

    const fill = this.computeFill({
      side: input.side,
      type: input.type,
      tif: input.tif,
      price: input.price,
      qty: allowedQty,
      book: input.book,
      forceFullClose: input.forced,
      markPriceFallback: input.type === 'LIMIT' ? input.price : this.bestMarketPrice(input.side, input.book),
    });

    const pnlAndTrades = this.applyFillToPosition(input.side, fill.fillQty, fill.avgPrice, input.timestampMs);
    const fee = fpMul(fill.notional, this.cfg.takerFeeRate);
    this.walletBalance = fpSub(fpAdd(this.walletBalance, pnlAndTrades.realizedPnl), fee);
    if (this.walletBalance < 0n) {
      this.walletBalance = 0n;
    }

    const status = this.resolveStatus(input.type, input.tif, requestedQty, fill.fillQty, fill.remainingQty);
    const remainingAfter = input.type === 'LIMIT' && input.tif === 'GTC' ? fill.remainingQty : fpZero;

    return {
      result: {
        orderId: input.orderId,
        status,
        side: input.side,
        type: input.type,
        requestedQty: fpRoundTo(requestedQty, 8),
        filledQty: fpRoundTo(fill.fillQty, 8),
        remainingQty: fpRoundTo(fill.remainingQty, 8),
        avgFillPrice: fpRoundTo(fill.avgPrice, 8),
        fee: fpRoundTo(fee, 8),
        realizedPnl: fpRoundTo(pnlAndTrades.realizedPnl, 8),
        slippageBps: fill.slippageBps,
        marketImpactBps: fill.marketImpactBps,
        reason: status === 'REJECTED' ? 'ORDER_REJECTED' : null,
        tradeIds: pnlAndTrades.tradeIds,
      },
      remainingAfter,
      realizedPnlFp: pnlAndTrades.realizedPnl,
      feeFp: fee,
    };
  }

  private resolveStatus(
    type: 'MARKET' | 'LIMIT',
    tif: 'IOC' | 'GTC',
    requestedQty: Fp,
    fillQty: Fp,
    remainingQty: Fp
  ): 'FILLED' | 'PARTIALLY_FILLED' | 'NEW' | 'CANCELED' | 'REJECTED' | 'EXPIRED' {
    if (fillQty === 0n && requestedQty > 0n && type === 'LIMIT' && tif === 'GTC') {
      return 'NEW';
    }
    if (remainingQty === 0n && fillQty > 0n) {
      return 'FILLED';
    }
    if (fillQty > 0n && remainingQty > 0n) {
      return tif === 'IOC' ? 'PARTIALLY_FILLED' : 'PARTIALLY_FILLED';
    }
    if (fillQty === 0n && tif === 'IOC') {
      return 'EXPIRED';
    }
    return 'CANCELED';
  }

  private applyPositionCapBeforeExecution(
    side: DryRunSide,
    requestedQty: Fp,
    reduceOnly: boolean,
    orderPrice: Fp,
    type: 'MARKET' | 'LIMIT',
    book: DryRunOrderBook
  ): Fp {
    if (requestedQty <= 0n) return fpZero;
    const signedDelta = sideToSignedQty(side, requestedQty);
    const currentQty = this.position ? this.position.signedQty : fpZero;

    if (reduceOnly) {
      if (currentQty === 0n) return fpZero;
      if (fpSign(currentQty) === fpSign(signedDelta)) return fpZero;
      return fpMin(fpAbs(requestedQty), fpAbs(currentQty));
    }

    const closePart = fpSign(currentQty) !== 0 && fpSign(currentQty) !== fpSign(signedDelta)
      ? fpMin(fpAbs(signedDelta), fpAbs(currentQty))
      : fpZero;
    const openingPart = fpSub(fpAbs(signedDelta), closePart);
    if (openingPart === 0n) {
      return requestedQty;
    }

    const referencePrice = type === 'LIMIT'
      ? orderPrice
      : this.bestMarketPrice(side, book);
    if (referencePrice <= 0n) {
      return fpZero;
    }
    const maxNotional = fpMul(this.cfg.initialMarginUsdt, this.cfg.leverage);
    const maxAbsQty = fpDiv(maxNotional, referencePrice);
    const currentAfterCloseAbs = fpSub(fpAbs(currentQty), closePart);
    const availableOpenAbs = fpMax(fpZero, fpSub(maxAbsQty, currentAfterCloseAbs));
    const openingUsed = fpMin(openingPart, availableOpenAbs);
    const allowedAbs = fpAdd(closePart, openingUsed);
    return allowedAbs;
  }

  private bestMarketPrice(side: DryRunSide, book: DryRunOrderBook): Fp {
    if (side === 'BUY') {
      if (book.asks.length === 0) return fpZero;
      return toFp(book.asks[0].price);
    }
    if (book.bids.length === 0) return fpZero;
    return toFp(book.bids[0].price);
  }

  private computeFill(input: {
    side: DryRunSide;
    type: 'MARKET' | 'LIMIT';
    tif: 'IOC' | 'GTC';
    price: Fp;
    qty: Fp;
    book: DryRunOrderBook;
    forceFullClose: boolean;
    markPriceFallback: Fp;
  }): FillComputation & { slippageBps: number; marketImpactBps: number } {
    const targetQty = input.qty;
    if (targetQty <= 0n) {
      return {
        fillQty: fpZero,
        remainingQty: fpZero,
        notional: fpZero,
        avgPrice: fpZero,
        slippageBps: 0,
        marketImpactBps: 0,
      };
    }

    const levels = input.side === 'BUY' ? input.book.asks : input.book.bids;
    let remaining = targetQty;
    let filled = fpZero;
    let notional = fpZero;

    for (const level of levels) {
      const levelPrice = toFp(level.price);
      const levelQty = toFp(level.qty);
      if (levelQty <= 0n) continue;

      if (input.type === 'LIMIT') {
        const touch = input.side === 'BUY'
          ? fpCmp(levelPrice, input.price) <= 0
          : fpCmp(levelPrice, input.price) >= 0;
        if (!touch) {
          break;
        }
      }

      if (remaining <= 0n) break;
      const takeQty = fpMin(remaining, levelQty);
      filled = fpAdd(filled, takeQty);
      remaining = fpSub(remaining, takeQty);
      notional = fpAdd(notional, fpMul(takeQty, levelPrice));
    }

    if (input.forceFullClose && remaining > 0n) {
      let vwap = fpZero;
      if (filled > 0n) {
        vwap = fpDiv(notional, filled);
      } else {
        vwap = input.markPriceFallback > 0n ? input.markPriceFallback : toFp(1);
      }
      notional = fpAdd(notional, fpMul(remaining, vwap));
      filled = targetQty;
      remaining = fpZero;
    }

    let avgPrice = filled > 0n ? fpDiv(notional, filled) : fpZero;
    let slippageBps = 0;
    let marketImpactBps = 0;

    if (filled > 0n && avgPrice > 0n) {
      const impact = this.marketImpactSimulator.adjustFill({
        side: input.side,
        type: input.type,
        tif: input.tif,
        requestedQty: targetQty,
        filledQty: filled,
        avgFillPrice: avgPrice,
        book: input.book,
      });
      avgPrice = impact.adjustedAvgFillPrice;
      notional = fpMul(filled, avgPrice);
      slippageBps = impact.slippageBps;
      marketImpactBps = impact.marketImpactBps;
    }

    return {
      fillQty: filled,
      remainingQty: remaining,
      notional,
      avgPrice,
      slippageBps,
      marketImpactBps,
    };
  }

  private applyFillToPosition(
    side: DryRunSide,
    fillQty: Fp,
    fillPrice: Fp,
    timestampMs: number
  ): { realizedPnl: Fp; tradeIds: string[] } {
    if (fillQty <= 0n) {
      return { realizedPnl: fpZero, tradeIds: [] };
    }

    const delta = sideToSignedQty(side, fillQty);
    const currentQty = this.position ? this.position.signedQty : fpZero;

    if (currentQty === 0n) {
      this.position = {
        signedQty: delta,
        entryPrice: fillPrice,
        entryTimestampMs: timestampMs,
      };
      return { realizedPnl: fpZero, tradeIds: [] };
    }

    const currentSign = fpSign(currentQty);
    const deltaSign = fpSign(delta);
    const tradeIds: string[] = [];
    let realized = fpZero;

    if (currentSign === deltaSign) {
      const absOld = fpAbs(currentQty);
      const absDelta = fpAbs(delta);
      const newAbs = fpAdd(absOld, absDelta);
      const weightedNotional = fpAdd(fpMul(absOld, this.position!.entryPrice), fpMul(absDelta, fillPrice));
      const newEntry = fpDiv(weightedNotional, newAbs);
      this.position = {
        signedQty: fpAdd(currentQty, delta),
        entryPrice: newEntry,
        entryTimestampMs: this.position!.entryTimestampMs,
      };
      return { realizedPnl: realized, tradeIds };
    }

    const closeQty = fpMin(fpAbs(currentQty), fpAbs(delta));
    realized = fpMul(fpSub(fillPrice, this.position!.entryPrice), fpMul(closeQty, toFp(currentSign)));
    tradeIds.push(
      this.idGen.nextTradeId({
        entryTimestampMs: this.position!.entryTimestampMs,
        closeTimestampMs: timestampMs,
        side: currentSign > 0 ? 'LONG' : 'SHORT',
        qty: fpRoundTo(closeQty, 8),
      })
    );

    const newQty = fpAdd(currentQty, delta);
    if (newQty === 0n) {
      this.position = null;
      return { realizedPnl: realized, tradeIds };
    }

    if (fpSign(newQty) === currentSign) {
      this.position = {
        signedQty: newQty,
        entryPrice: this.position!.entryPrice,
        entryTimestampMs: this.position!.entryTimestampMs,
      };
      return { realizedPnl: realized, tradeIds };
    }

    this.position = {
      signedQty: newQty,
      entryPrice: fillPrice,
      entryTimestampMs: timestampMs,
    };
    return { realizedPnl: realized, tradeIds };
  }

  private checkAndForceLiquidation(
    timestampMs: number,
    book: DryRunOrderBook,
    markPrice: Fp
  ): {
    result: DryRunOrderResult;
    realizedPnlFp: Fp;
    feeFp: Fp;
  } | null {
    if (!this.position || this.position.signedQty === 0n) {
      return null;
    }

    const qtyAbs = fpAbs(this.position.signedQty);
    const unrealized = fpMul(fpSub(markPrice, this.position.entryPrice), this.position.signedQty);
    const equity = fpAdd(this.walletBalance, unrealized);
    const maintenanceMargin = fpMul(fpMul(qtyAbs, markPrice), this.cfg.maintenanceMarginRate);
    const estCloseFee = fpMul(fpMul(qtyAbs, markPrice), this.cfg.takerFeeRate);
    const triggerThreshold = fpAdd(maintenanceMargin, estCloseFee);

    if (fpCmp(equity, triggerThreshold) > 0) {
      return null;
    }

    const closeSide: DryRunSide = this.position.signedQty > 0n ? 'SELL' : 'BUY';
    const orderId = this.idGen.nextOrderId({
      timestampMs,
      side: closeSide,
      qty: fpRoundTo(qtyAbs, 8),
      type: 'MARKET',
      price: fpRoundTo(markPrice, 8),
    });

    const execution = this.executeWithOrderbook({
      orderId,
      side: closeSide,
      type: 'MARKET',
      tif: 'IOC',
      reduceOnly: true,
      price: markPrice,
      qty: qtyAbs,
      timestampMs,
      book,
      forced: true,
    });

    this.pendingLimits.clear();
    return {
      result: {
        ...execution.result,
        status: 'FILLED',
        remainingQty: 0,
        reason: 'FORCED_LIQUIDATION',
      },
      realizedPnlFp: execution.realizedPnlFp,
      feeFp: execution.feeFp,
    };
  }

  private computeMarginHealth(markPrice: Fp): number {
    const qtyAbs = this.position ? fpAbs(this.position.signedQty) : fpZero;
    const unrealized = this.position ? fpMul(fpSub(markPrice, this.position.entryPrice), this.position.signedQty) : fpZero;
    const equity = fpAdd(this.walletBalance, unrealized);
    const maintenance = fpMul(fpMul(qtyAbs, markPrice), this.cfg.maintenanceMarginRate);
    if (equity <= 0n) {
      return -1;
    }
    return fpRoundTo(fpDiv(fpSub(equity, maintenance), equity), 8);
  }

  private makeRejected(
    orderId: string,
    side: DryRunSide,
    type: 'MARKET' | 'LIMIT',
    requestedQty: number,
    reason: string
  ): DryRunOrderResult {
    return {
      orderId,
      status: 'REJECTED',
      side,
      type,
      requestedQty,
      filledQty: 0,
      remainingQty: requestedQty,
      avgFillPrice: 0,
      fee: 0,
      realizedPnl: 0,
      reason,
      tradeIds: [],
    };
  }
}
