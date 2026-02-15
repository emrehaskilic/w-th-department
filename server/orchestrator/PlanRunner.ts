import { OrderType, Side, TimeInForce } from '../connectors/executionTypes';
import { OrderPlanConfig, OrchestratorMetricsInput, SymbolState } from './types';
import {
  calculateLimitPrice,
  getOrderTypeConfig,
  isMarketLikeOrderType,
  OrderRole,
  OrderTag,
  PlanState,
  PlannedOrder,
  PlanReconcileResult,
  PlanTickSummary,
  TrendState,
  buildClientOrderId,
  buildPlanId,
  parseClientOrderId,
} from './OrderPlan';
import { TrendStateMachine } from './TrendStateMachine';
import { reconcileOrders } from './Reconciler';

export interface PlanTickInput {
  symbol: string;
  nowMs: number;
  metrics: OrchestratorMetricsInput;
  gatePassed: boolean;
  state: SymbolState;
  executionReady: boolean;
  leverage: number;
  currentMarginBudgetUsdt: number;
  startingMarginUsdt: number;
  volatilityFactor?: number;
  freezeActive?: boolean;
  backoffActive?: boolean;
  fundingShortBlocked?: boolean;
  tickSize?: number;
}

export interface PlanTickResult {
  planId: string | null;
  planState: PlanState;
  trendState: TrendState;
  trendScore: number;
  confirmCount: number;
  desiredOrders: PlannedOrder[];
  immediateOrders: PlannedOrder[];
  reconcile: PlanReconcileResult;
  summary: PlanTickSummary;
  events: Array<{ type: string; detail?: Record<string, any> }>;
}

interface PlanContext {
  planId: string | null;
  planState: PlanState;
  side: Side | null;
  createdAtMs: number;
  budgetUsdt: number;
  readySinceMs: number | null;
  bootAttemptAtMs: number | null;
  exitAttemptAtMs: number | null;
  lastPlanBuildMs: number;
  lastPlanKey: string | null;
  lastDesiredOrders: PlannedOrder[];
  peakUpnl: number;
  profitLockTriggered: boolean;
  lastStepUpAtMs: number;
}

export class PlanRunner {
  private readonly trend: TrendStateMachine;
  private ctx: PlanContext;

  constructor(private readonly config: OrderPlanConfig) {
    this.trend = new TrendStateMachine({
      upEnter: config.trend.upEnter,
      upExit: config.trend.upExit,
      downEnter: config.trend.downEnter,
      downExit: config.trend.downExit,
      confirmTicks: config.trend.confirmTicks,
      reversalConfirmTicks: config.trend.reversalConfirmTicks,
    });

    this.ctx = this.createEmptyContext();
  }

  tick(input: PlanTickInput): PlanTickResult {
    const { symbol, nowMs, metrics, gatePassed, state } = input;
    const events: Array<{ type: string; detail?: Record<string, any> }> = [];

    const trendScore = this.computeTrendScore(metrics);
    const trendSnapshot = this.trend.update(trendScore);
    const trendState = trendSnapshot.state;
    const confirmCount = trendSnapshot.confirmCount;
    const trendConfirmed = confirmCount >= Math.max(1, this.config.trend.confirmTicks);

    const position = state.position;
    const openOrders = Array.from(state.openOrders.values());

    this.updateReadySince(input.executionReady, nowMs);

    const prevState = this.ctx.planState;
    this.updatePlanState(position, openOrders.length === 0);
    if (prevState !== this.ctx.planState && this.ctx.planState === 'ACTIVE') {
      events.push({ type: 'PLAN_ACTIVATED', detail: { planId: this.ctx.planId } });
    }

    const budgetBase = this.resolveInitialBudget(input);
    const blocked = this.shouldBlockNewPosition({
      trendState,
      freezeActive: input.freezeActive ?? state.execQuality.freezeActive,
      backoffActive: input.backoffActive ?? false,
    });
    if (this.ctx.planId === null && this.ctx.planState === 'FLATTENED') {
      this.ctx.planState = 'BOOT';
    }

    if (this.ctx.planState === 'BOOT') {
      const side = this.pickBootSide(metrics, trendState);
      const bootGateOk = this.bootGateOk(metrics);
      const readyWaitOk = this.readyWaitOk(nowMs);
      const marginOk = this.validateMargin(budgetBase * input.leverage, input.leverage);
      const fundingBlocked = symbol === 'ETHUSDT' && side === 'SELL' && Boolean(input.fundingShortBlocked);
      if (!blocked.blocked && side && bootGateOk && readyWaitOk && marginOk && !fundingBlocked) {
        this.startNewPlan(symbol, side, trendState, budgetBase, nowMs);
        events.push({ type: 'PLAN_STARTED', detail: { planId: this.ctx.planId, side } });
      } else if (blocked.blocked) {
        events.push({ type: blocked.reason || 'NEW_POSITION_BLOCKED' });
      } else if (!marginOk) {
        events.push({ type: 'MIN_MARGIN_BLOCKED' });
      } else if (fundingBlocked) {
        events.push({ type: 'FUNDING_RATE_UNFAVORABLE_ETH_SHORT' });
      }
    }

    if (this.ctx.planId && this.ctx.planState !== 'FLATTENED') {
      this.updateBudgetStepUp(input, trendScore, trendConfirmed, events);
    }

    const exitReason = this.evaluateExitReason(position, trendState, trendConfirmed, events);
    if (exitReason) {
      this.ctx.planState = 'EXITING';
      events.push({ type: exitReason });
    }

    if (!position && this.ctx.planState === 'EXITING' && openOrders.length === 0) {
      this.ctx.planState = 'FLATTENED';
      this.ctx.planId = null;
      this.ctx.side = null;
      this.ctx.lastDesiredOrders = [];
      this.ctx.lastPlanKey = null;
      events.push({ type: 'FLATTENED' });
    }

    const immediateOrders = this.buildImmediateOrders(input, trendState, trendConfirmed, events);

    const shouldRebuild = this.shouldRebuildPlan(nowMs, position, trendState, trendScore, gatePassed);
    const desiredOrders = shouldRebuild
      ? this.buildDesiredOrders(input, trendState, trendConfirmed, gatePassed, events)
      : this.ctx.lastDesiredOrders;

    if (shouldRebuild) {
      this.ctx.lastPlanBuildMs = nowMs;
      this.ctx.lastDesiredOrders = desiredOrders;
    }

    const reconcile = this.ctx.planId
      ? reconcileOrders({
          planId: this.ctx.planId,
          desired: desiredOrders,
          openOrders,
          config: {
            orderPrefix: this.config.orderPrefix,
            priceTolerancePct: this.config.orderPriceTolerancePct,
            qtyTolerancePct: this.config.orderQtyTolerancePct,
            replaceThrottlePerSecond: this.config.replaceThrottlePerSecond,
            cancelStalePlanOrders: this.config.cancelStalePlanOrders,
          },
          nowMs,
        })
      : { actions: [], created: [], canceled: [], replaced: [] };

    const summary = this.buildSummary(symbol, trendState, trendScore, confirmCount, desiredOrders, openOrders, reconcile);

    return {
      planId: this.ctx.planId,
      planState: this.ctx.planState,
      trendState,
      trendScore,
      confirmCount,
      desiredOrders,
      immediateOrders,
      reconcile,
      summary,
      events,
    };
  }

  private createEmptyContext(): PlanContext {
    return {
      planId: null,
      planState: 'FLATTENED',
      side: null,
      createdAtMs: 0,
      budgetUsdt: 0,
      readySinceMs: null,
      bootAttemptAtMs: null,
      exitAttemptAtMs: null,
      lastPlanBuildMs: 0,
      lastPlanKey: null,
      lastDesiredOrders: [],
      peakUpnl: 0,
      profitLockTriggered: false,
      lastStepUpAtMs: 0,
    };
  }

  private computeTrendScore(metrics: OrchestratorMetricsInput): number {
    const obi = Number(metrics.legacyMetrics?.obiDeep ?? 0);
    const deltaZ = Number(metrics.legacyMetrics?.deltaZ ?? 0);
    const cvdSlope = Number(metrics.legacyMetrics?.cvdSlope ?? 0);

    const score =
      (obi / this.safeNorm(this.config.trend.obiNorm)) * 0.4 +
      (deltaZ / this.safeNorm(this.config.trend.deltaNorm)) * 0.3 +
      (cvdSlope / this.safeNorm(this.config.trend.cvdNorm)) * 0.3;

    const clamp = Math.max(0.1, this.config.trend.scoreClamp);
    return Math.max(-clamp, Math.min(clamp, score));
  }

  private safeNorm(value: number): number {
    if (!Number.isFinite(value) || value === 0) {
      return 1;
    }
    return Math.abs(value);
  }

  private updateReadySince(ready: boolean, nowMs: number) {
    if (!ready) {
      this.ctx.readySinceMs = null;
      return;
    }
    if (this.ctx.readySinceMs === null) {
      this.ctx.readySinceMs = nowMs;
    }
  }

  private readyWaitOk(nowMs: number): boolean {
    if (this.ctx.readySinceMs === null) return false;
    return nowMs - this.ctx.readySinceMs >= this.config.boot.waitReadyMs;
  }

  private bootGateOk(metrics: OrchestratorMetricsInput): boolean {
    const spread = Number(metrics.spread_pct ?? Number.POSITIVE_INFINITY);
    const obi = Math.abs(Number(metrics.legacyMetrics?.obiDeep ?? 0));
    const spreadOk = Number.isFinite(spread) && spread <= this.config.boot.maxSpreadPct;
    const obiOk = this.config.boot.minObiDeep <= 0 || (Number.isFinite(obi) && obi >= this.config.boot.minObiDeep);
    return spreadOk && obiOk;
  }

  private pickBootSide(metrics: OrchestratorMetricsInput, trendState: TrendState): Side | null {
    if (trendState === 'UP') return this.filterSide('BUY');
    if (trendState === 'DOWN') return this.filterSide('SELL');
    const deltaZ = Number(metrics.legacyMetrics?.deltaZ ?? 0);
    if (Math.abs(deltaZ) >= this.config.boot.minDeltaZ) {
      return this.filterSide(deltaZ > 0 ? 'BUY' : 'SELL');
    }
    const cvdSlope = Number(metrics.legacyMetrics?.cvdSlope ?? 0);
    if (Math.abs(cvdSlope) >= this.config.boot.minDeltaZ) {
      return this.filterSide(cvdSlope > 0 ? 'BUY' : 'SELL');
    }
    return null;
  }

  private startNewPlan(symbol: string, side: Side, trendState: TrendState, budgetUsdt: number, nowMs: number) {
    const epochBucket = Math.floor(nowMs / Math.max(1, this.config.planEpochMs));
    this.ctx.planId = buildPlanId({
      symbol,
      side,
      epochBucket,
      trendState,
      initialMarginUsdt: budgetUsdt,
    });
    this.ctx.planState = 'BUILDING';
    this.ctx.side = side;
    this.ctx.createdAtMs = nowMs;
    this.ctx.budgetUsdt = budgetUsdt;
    this.ctx.bootAttemptAtMs = null;
    this.ctx.exitAttemptAtMs = null;
    this.ctx.lastPlanKey = null;
    this.ctx.lastDesiredOrders = [];
    this.ctx.peakUpnl = 0;
    this.ctx.profitLockTriggered = false;
    this.ctx.lastStepUpAtMs = 0;
  }

  private resolveInitialBudget(input: PlanTickInput): number {
    const explicit = Number(this.config.initialMarginUsdt || 0);
    const base = explicit > 0 ? explicit : input.startingMarginUsdt;
    const walletCap = Number.isFinite(input.currentMarginBudgetUsdt) && input.currentMarginBudgetUsdt > 0
      ? Math.min(base, input.currentMarginBudgetUsdt)
      : base;
    const volFactor = this.resolveVolatilityFactor(input);
    const adjusted = walletCap * volFactor;
    if (Number.isFinite(this.config.maxMarginUsdt) && this.config.maxMarginUsdt > 0) {
      return Math.min(adjusted, this.config.maxMarginUsdt);
    }
    return Math.max(0, adjusted);
  }

  private updatePlanState(position: SymbolState['position'], noOpenOrders: boolean) {
    if (!position) {
      if (this.ctx.planState === 'ACTIVE' && noOpenOrders) {
        this.ctx.planState = 'FLATTENED';
      }
      return;
    }
    if (this.ctx.planState !== 'EXITING') {
      this.ctx.planState = 'ACTIVE';
    }
  }

  private shouldRebuildPlan(
    nowMs: number,
    position: SymbolState['position'],
    trendState: TrendState,
    trendScore: number,
    gatePassed: boolean
  ): boolean {
    const key = `${this.ctx.planState}|${this.ctx.planId}|${this.ctx.side}|${Math.round(this.ctx.budgetUsdt)}|${position?.qty || 0}|${trendState}|${trendScore.toFixed(2)}|${gatePassed}`;
    if (this.ctx.lastPlanKey !== key) {
      this.ctx.lastPlanKey = key;
      return true;
    }
    if (nowMs - this.ctx.lastPlanBuildMs >= this.config.planRebuildCooldownMs) {
      return true;
    }
    return false;
  }

  private updateBudgetStepUp(
    input: PlanTickInput,
    trendScore: number,
    trendConfirmed: boolean,
    events: Array<{ type: string; detail?: Record<string, any> }>
  ) {
    if (!input.state.position || !this.ctx.planId) return;
    if (!trendConfirmed) return;
    const nowMs = input.nowMs;
    if (nowMs - this.ctx.lastStepUpAtMs < this.config.stepUp.cooldownMs) {
      return;
    }

    const upnl = input.state.position.unrealizedPnlPct;
    if (upnl <= 0) {
      return;
    }
    const base = this.resolveInitialBudget(input);
    const rMultiple = base > 0 ? upnl / base : 0;
    const trendOk = Math.abs(trendScore) >= this.config.stepUp.minTrendScore;

    let trigger = false;
    if (this.config.stepUp.mode === 'UPNL') {
      trigger = upnl >= this.config.stepUp.triggerUsdt;
    } else if (this.config.stepUp.mode === 'R_MULTIPLE') {
      trigger = rMultiple >= this.config.stepUp.triggerR;
    } else {
      trigger = trendOk;
    }

    if (!trigger) {
      return;
    }

    const nextBudget = this.ctx.budgetUsdt * (1 + this.config.stepUp.stepPct);
    const maxBudget = this.config.maxMarginUsdt > 0 ? this.config.maxMarginUsdt : Number.POSITIVE_INFINITY;
    const adjusted = Math.min(maxBudget, nextBudget);
    if (adjusted <= this.ctx.budgetUsdt) {
      return;
    }

    this.ctx.budgetUsdt = adjusted;
    this.ctx.lastStepUpAtMs = nowMs;
    events.push({ type: 'PLAN_BUDGET_STEP_UP', detail: { budgetUsdt: adjusted } });
  }

  private evaluateExitReason(
    position: SymbolState['position'],
    trendState: TrendState,
    trendConfirmed: boolean,
    events: Array<{ type: string; detail?: Record<string, any> }>
  ): string | null {
    if (!position || !this.ctx.planId) {
      return null;
    }

    const upnl = position.unrealizedPnlPct;
    if (upnl > this.ctx.peakUpnl) {
      this.ctx.peakUpnl = upnl;
    }

    const base = Math.max(1, this.ctx.budgetUsdt || 1);
    const profitLockState = {
      activated: this.ctx.profitLockTriggered,
      peakUpnlR: this.ctx.peakUpnl / base,
    };
    const shouldFlattenForProfitLock = this.checkProfitLock(upnl, upnl / base, profitLockState);
    this.ctx.profitLockTriggered = profitLockState.activated;
    this.ctx.peakUpnl = Math.max(this.ctx.peakUpnl, profitLockState.peakUpnlR * base);
    if (shouldFlattenForProfitLock.shouldFlatten) {
      this.ctx.profitLockTriggered = true;
      events.push({
        type: 'PROFIT_LOCK_TRIGGERED',
        detail: {
          drawdown: this.ctx.peakUpnl - upnl,
          peak: this.ctx.peakUpnl,
        },
      });
      return 'PROFIT_LOCK_TRIGGERED';
    }

    if (trendConfirmed) {
      if (position.side === 'LONG' && trendState === 'DOWN') {
        events.push({ type: 'REVERSAL_DETECTED', detail: { side: 'LONG' } });
        return 'REVERSAL_DETECTED';
      }
      if (position.side === 'SHORT' && trendState === 'UP') {
        events.push({ type: 'REVERSAL_DETECTED', detail: { side: 'SHORT' } });
        return 'REVERSAL_DETECTED';
      }
    }

    return null;
  }

  private buildImmediateOrders(
    input: PlanTickInput,
    trendState: TrendState,
    trendConfirmed: boolean,
    events: Array<{ type: string; detail?: Record<string, any> }>
  ): PlannedOrder[] {
    if (!this.ctx.planId || !this.ctx.side) {
      return [];
    }

    const immediate: PlannedOrder[] = [];
    const symbol = input.symbol;
    const position = input.state.position;

    if (this.ctx.planState === 'BUILDING' || this.ctx.planState === 'BOOT') {
      const bootGateOk = this.bootGateOk(input.metrics);
      if (bootGateOk) {
        const shouldAttempt = this.shouldAttemptBoot(input.nowMs);
        if (shouldAttempt) {
          const price = this.resolveMarketPrice(input.metrics, this.ctx.side);
          const limitPrice = calculateLimitPrice(
            price,
            this.ctx.side,
            input.tickSize || this.config.defaultTickSize || 0.01,
            this.config.limitBufferBps
          );
          const qty = this.qtyFromBudget(this.ctx.budgetUsdt * this.config.boot.probeMarketPct, limitPrice, input.leverage);
          if (qty > 0 && limitPrice > 0 && this.validateMargin(limitPrice * qty, input.leverage)) {
            immediate.push(this.makeOrder({
              symbol,
              side: this.ctx.side,
              role: 'BOOT_PROBE',
              levelIndex: 0,
              price: limitPrice,
              qty,
            }));
            events.push({ type: 'BOOT_PROBE_ENTRY', detail: { side: this.ctx.side, qty, price: limitPrice, type: 'LIMIT' } });
            this.ctx.bootAttemptAtMs = input.nowMs;
          }
        }
      }
    }

    if (this.ctx.planState === 'EXITING' && position && this.config.reversalExitMode === 'MARKET') {
      const nowMs = input.nowMs;
      if (!this.ctx.exitAttemptAtMs || nowMs - this.ctx.exitAttemptAtMs >= this.config.exitRetryMs) {
        const side: Side = position.side === 'LONG' ? 'SELL' : 'BUY';
        const price = this.resolveMarketPrice(input.metrics, side);
        if (price > 0) {
          immediate.push(this.makeOrder({
            symbol,
            side,
            role: 'FLATTEN',
            levelIndex: 0,
            price,
            qty: position.qty,
          }));
          this.ctx.exitAttemptAtMs = nowMs;
        }
      }
    }

    return immediate;
  }

  private buildDesiredOrders(
    input: PlanTickInput,
    trendState: TrendState,
    trendConfirmed: boolean,
    gatePassed: boolean,
    events: Array<{ type: string; detail?: Record<string, any> }>
  ): PlannedOrder[] {
    if (!this.ctx.planId || !this.ctx.side) {
      return [];
    }

    const desired: PlannedOrder[] = [];
    const symbol = input.symbol;
    const position = input.state.position;
    const leverage = input.leverage;
    const midPrice = this.resolveMidPrice(input.metrics);

    if (this.ctx.planState !== 'EXITING') {
      const remainingBudget = this.remainingBudget(position, midPrice, leverage);
      if (remainingBudget > 0 && this.validateMargin(remainingBudget * leverage, leverage)) {
        const scaleIn = this.buildScaleInOrders({
          symbol,
          side: this.ctx.side,
          budgetUsdt: remainingBudget,
          leverage,
          basePrice: midPrice,
          position,
          trendState,
          trendConfirmed,
          gatePassed,
        });
        desired.push(...scaleIn);
      }
    }

    if (position) {
      const stopOrder = this.buildStopOrder(symbol, position, leverage);
      if (stopOrder) {
        desired.push(stopOrder);
      }
      const tpOrders = this.buildTpOrders(symbol, position);
      desired.push(...tpOrders);
    }

    if (this.ctx.planState === 'EXITING' && position && this.config.reversalExitMode === 'LIMIT') {
      const exitOrder = this.buildExitOrder(symbol, position, input.metrics);
      if (exitOrder) {
        desired.push(exitOrder);
      }
    }

    return desired;
  }

  private shouldAttemptBoot(nowMs: number): boolean {
    if (!this.ctx.bootAttemptAtMs) {
      return true;
    }
    return nowMs - this.ctx.bootAttemptAtMs >= this.config.boot.retryMs;
  }

  private remainingBudget(position: SymbolState['position'], midPrice: number, leverage: number): number {
    if (!position || midPrice <= 0 || leverage <= 0) {
      return Math.max(0, this.ctx.budgetUsdt - (this.ctx.budgetUsdt * this.config.boot.probeMarketPct));
    }
    const notional = position.qty * midPrice;
    const usedMargin = notional / leverage;
    return Math.max(0, this.ctx.budgetUsdt - usedMargin);
  }

  private buildScaleInOrders(input: {
    symbol: string;
    side: Side;
    budgetUsdt: number;
    leverage: number;
    basePrice: number;
    position: SymbolState['position'];
    trendState: TrendState;
    trendConfirmed: boolean;
    gatePassed: boolean;
  }): PlannedOrder[] {
    if (input.basePrice <= 0 || input.budgetUsdt <= 0 || !input.gatePassed) {
      return [];
    }
    if (this.config.scaleIn.addOnlyIfTrendConfirmed && !input.trendConfirmed) {
      return [];
    }

    if (input.position) {
      const upnl = input.position.unrealizedPnlPct;
      if (this.config.scaleIn.addMinUpnlUsdt > 0 && upnl < this.config.scaleIn.addMinUpnlUsdt) {
        return [];
      }
      if (this.config.scaleIn.addMinUpnlR > 0) {
        const base = Math.max(1, this.ctx.budgetUsdt || 1);
        const upnlR = upnl / base;
        if (upnlR < this.config.scaleIn.addMinUpnlR) {
          return [];
        }
      }
    }

    const remainingAdds = input.position
      ? Math.max(0, this.config.scaleIn.maxAdds - input.position.addsUsed)
      : this.config.scaleIn.maxAdds;

    const levels = Math.max(0, Math.min(this.config.scaleIn.levels, remainingAdds));
    if (levels <= 0) {
      return [];
    }

    const perLevelBudget = input.budgetUsdt / levels;
    const orders: PlannedOrder[] = [];

    for (let i = 0; i < levels; i++) {
      const step = this.config.scaleIn.stepPct * (i + 1) / 100;
      const price = input.side === 'BUY'
        ? input.basePrice * (1 - step)
        : input.basePrice * (1 + step);
      const qty = this.qtyFromBudget(perLevelBudget, price, input.leverage);
      if (qty <= 0 || price <= 0) {
        continue;
      }
      if (!this.validateMargin(price * qty, input.leverage)) {
        continue;
      }
      orders.push(this.makeOrder({
        symbol: input.symbol,
        side: input.side,
        role: 'SCALE_IN',
        levelIndex: i,
        price,
        qty,
      }));
    }

    return orders;
  }

  private buildTpOrders(symbol: string, position: NonNullable<SymbolState['position']>): PlannedOrder[] {
    const levels = Math.max(0, this.config.tp.levels);
    if (levels <= 0) return [];

    const stepPcts = this.normalizeTpSteps(levels);
    const distribution = this.normalizeDistribution(levels);
    const orders: PlannedOrder[] = [];
    const baseQty = position.qty;

    for (let i = 0; i < levels; i++) {
      const pct = stepPcts[i];
      const qty = Number((baseQty * (distribution[i] / 100)).toFixed(6));
      if (qty <= 0) continue;
      const price = position.side === 'LONG'
        ? position.entryPrice * (1 + pct / 100)
        : position.entryPrice * (1 - pct / 100);
      const side: Side = position.side === 'LONG' ? 'SELL' : 'BUY';
      orders.push(this.makeOrder({
        symbol,
        side,
        role: 'TP',
        levelIndex: i,
        price,
        qty,
      }));
    }
    return orders;
  }

  private buildStopOrder(symbol: string, position: NonNullable<SymbolState['position']>, leverage: number): PlannedOrder | null {
    const distPct = this.resolveStopDistancePct(this.config.stop.distancePct, leverage);
    const side: Side = position.side === 'LONG' ? 'SELL' : 'BUY';
    const stopPrice = position.side === 'LONG'
      ? position.entryPrice * (1 - distPct / 100)
      : position.entryPrice * (1 + distPct / 100);
    if (!(stopPrice > 0) || !(position.qty > 0)) {
      return null;
    }
    return this.makeOrder({
      symbol,
      side,
      role: 'STOP',
      levelIndex: 0,
      price: stopPrice,
      stopPrice,
      qty: position.qty,
      reduceOnly: this.config.stop.reduceOnly,
    });
  }

  private buildExitOrder(symbol: string, position: NonNullable<SymbolState['position']>, metrics: OrchestratorMetricsInput): PlannedOrder | null {
    const nowMs = Date.now();
    if (this.ctx.exitAttemptAtMs && nowMs - this.ctx.exitAttemptAtMs < this.config.exitRetryMs) {
      return null;
    }
    const side: Side = position.side === 'LONG' ? 'SELL' : 'BUY';
    if (this.config.reversalExitMode === 'MARKET') {
      const price = this.resolveMarketPrice(metrics, side);
      if (!price || price <= 0) return null;
      this.ctx.exitAttemptAtMs = nowMs;
      return this.makeOrder({
        symbol,
        side,
        role: 'FLATTEN',
        levelIndex: 0,
        price,
        qty: position.qty,
      });
    }

    const base = this.resolveMarketPrice(metrics, side);
    if (!base || base <= 0) return null;
    const buffer = this.config.exitLimitBufferBps / 10_000;
    const price = side === 'SELL' ? base * (1 - buffer) : base * (1 + buffer);
    this.ctx.exitAttemptAtMs = nowMs;
    return this.makeOrder({
      symbol,
      side,
      role: 'FLATTEN',
      levelIndex: 0,
      price,
      qty: position.qty,
      type: 'LIMIT',
    });
  }

  private makeOrder(input: {
    symbol: string;
    side: Side;
    role: OrderRole;
    levelIndex: number;
    price: number;
    stopPrice?: number;
    qty: number;
    type?: OrderType;
    timeInForce?: TimeInForce;
    reduceOnly?: boolean;
  }): PlannedOrder {
    const roleConfig = getOrderTypeConfig(input.role);
    const type = input.type || roleConfig.orderType;
    const timeInForce = input.timeInForce || roleConfig.timeInForce;
    const reduceOnly = typeof input.reduceOnly === 'boolean' ? input.reduceOnly : roleConfig.reduceOnly;
    const tag: OrderTag = {
      planId: this.ctx.planId || 'na',
      role: input.role,
      levelIndex: input.levelIndex,
      symbol: input.symbol,
      side: input.side,
    };
    const clientOrderId = buildClientOrderId(tag, this.config.orderPrefix);
    return {
      planId: this.ctx.planId || 'na',
      role: input.role,
      levelIndex: input.levelIndex,
      symbol: input.symbol,
      side: input.side,
      type,
      timeInForce,
      price: isMarketLikeOrderType(type) ? null : input.price,
      stopPrice: type === 'STOP_MARKET' || type === 'TAKE_PROFIT_MARKET'
        ? (typeof input.stopPrice === 'number' ? input.stopPrice : input.price)
        : null,
      qty: input.qty,
      reduceOnly,
      clientOrderId,
      tag,
    };
  }

  private qtyFromBudget(budgetUsdt: number, price: number, leverage: number): number {
    if (!Number.isFinite(budgetUsdt) || budgetUsdt <= 0) return 0;
    if (!Number.isFinite(price) || price <= 0) return 0;
    const notional = budgetUsdt * leverage;
    const qty = notional / price;
    return Number.isFinite(qty) && qty > 0 ? Number(qty.toFixed(6)) : 0;
  }

  private resolveMidPrice(metrics: OrchestratorMetricsInput): number {
    const bid = Number(metrics.best_bid ?? 0);
    const ask = Number(metrics.best_ask ?? 0);
    if (bid > 0 && ask > 0) {
      return (bid + ask) / 2;
    }
    return bid > 0 ? bid : ask;
  }

  private resolveVolatilityFactor(input: PlanTickInput): number {
    const cfg = this.config.volatilitySizing;
    if (!cfg || !cfg.enabled) {
      return 1;
    }
    const raw = Number(input.volatilityFactor);
    if (!Number.isFinite(raw) || raw <= 0) {
      return 1;
    }
    const minFactor = Number.isFinite(cfg.minFactor) ? cfg.minFactor : 0.2;
    const maxFactor = Number.isFinite(cfg.maxFactor) ? cfg.maxFactor : 2.0;
    return Math.max(minFactor, Math.min(maxFactor, raw));
  }

  private filterSide(side: Side | null): Side | null {
    if (!side) return null;
    const allowed = (this.config.allowedSides || 'BOTH').toUpperCase();
    if (allowed === 'BOTH') return side;
    if (allowed === 'LONG') return side === 'BUY' ? side : null;
    if (allowed === 'SHORT') return side === 'SELL' ? side : null;
    return side;
  }

  private resolveStopDistancePct(defaultPct: number, leverage: number): number {
    const riskPct = Number(this.config.stop.riskPct ?? 0);
    if (riskPct > 0 && Number.isFinite(leverage) && leverage > 0) {
      return Math.max(0.01, riskPct / leverage);
    }
    return Math.max(0.01, defaultPct);
  }

  private resolveMarketPrice(metrics: OrchestratorMetricsInput, side: Side): number {
    const bid = Number(metrics.best_bid ?? 0);
    const ask = Number(metrics.best_ask ?? 0);
    if (side === 'BUY') {
      return ask > 0 ? ask : bid;
    }
    return bid > 0 ? bid : ask;
  }

  private normalizeTpSteps(levels: number): number[] {
    if (this.config.tp.stepPcts.length >= levels) {
      return this.config.tp.stepPcts.slice(0, levels);
    }
    if (this.config.tp.stepPcts.length > 0) {
      const base = this.config.tp.stepPcts[0];
      return Array.from({ length: levels }, (_, i) => base * (i + 1));
    }
    return Array.from({ length: levels }, (_, i) => 0.2 * (i + 1));
  }

  private normalizeDistribution(levels: number): number[] {
    if (this.config.tp.distribution.length >= levels) {
      return normalizePercentages(this.config.tp.distribution.slice(0, levels));
    }
    if (this.config.tp.distribution.length > 0) {
      return normalizePercentages(this.config.tp.distribution);
    }
    const equal = Array.from({ length: levels }, () => 100 / levels);
    return normalizePercentages(equal);
  }

  private shouldBlockNewPosition(input: {
    trendState: TrendState;
    freezeActive: boolean;
    backoffActive: boolean;
  }): { blocked: boolean; reason?: string } {
    if (input.trendState === 'CHOP') {
      return { blocked: true, reason: 'CHOP_MARKET_NO_NEW_POSITIONS' };
    }
    if (input.freezeActive) {
      return { blocked: true, reason: 'EXECUTION_FROZEN' };
    }
    if (input.backoffActive) {
      return { blocked: true, reason: 'RATE_LIMIT_BACKOFF' };
    }
    return { blocked: false };
  }

  private validateMargin(notional: number, leverage: number): boolean {
    if (!Number.isFinite(notional) || notional <= 0 || !Number.isFinite(leverage) || leverage <= 0) {
      return false;
    }
    const margin = notional / leverage;
    return margin >= this.config.minMarginUsdt;
  }

  private checkProfitLock(
    upnlUsdt: number,
    upnlR: number,
    state: { activated: boolean; peakUpnlR: number }
  ): { shouldFlatten: boolean } {
    const shouldActivateByUsdt = this.config.profitLock.lockTriggerUsdt > 0 && upnlUsdt >= this.config.profitLock.lockTriggerUsdt;
    const shouldActivateByR = this.config.profitLock.lockTriggerR > 0 && upnlR >= this.config.profitLock.lockTriggerR;
    if (!state.activated && (shouldActivateByUsdt || shouldActivateByR)) {
      state.activated = true;
      state.peakUpnlR = upnlR;
    }

    if (state.activated) {
      if (upnlR > state.peakUpnlR) {
        state.peakUpnlR = upnlR;
      }
      if (state.peakUpnlR - upnlR >= this.config.profitLock.maxDdFromPeakR) {
        return { shouldFlatten: true };
      }
    }

    return { shouldFlatten: false };
  }

  private buildSummary(
    symbol: string,
    trendState: TrendState,
    trendScore: number,
    confirmCount: number,
    desiredOrders: PlannedOrder[],
    openOrders: Array<{ clientOrderId: string; price: number; origQty: number }>,
    reconcile: PlanReconcileResult
  ): PlanTickSummary {
    const actions = {
      created: reconcile.created.map((o) => ({ role: o.role, level: o.levelIndex, price: o.price, qty: o.qty })),
      canceled: reconcile.canceled.map((o) => {
        const parsed = parseClientOrderId(o.clientOrderId || '', this.config.orderPrefix);
        const role = parsed?.role ?? 'SCALE_IN';
        const level = parsed?.levelIndex ?? 0;
        return { role, level, price: o.price, qty: o.origQty };
      }),
      replaced: reconcile.replaced.map((r) => ({ role: r.desired.role, level: r.desired.levelIndex, price: r.desired.price, qty: r.desired.qty })),
    };
    return {
      symbol,
      planId: this.ctx.planId,
      planState: this.ctx.planState,
      trendState,
      trendScore,
      confirmCount,
      desiredOrdersCount: desiredOrders.length,
      openOrdersCount: openOrders.length,
      actions,
    };
  }
}

function normalizePercentages(values: number[]): number[] {
  const total = values.reduce((sum, v) => sum + v, 0);
  if (total <= 0) {
    return values.map(() => 0);
  }
  return values.map((v) => (v / total) * 100);
}
