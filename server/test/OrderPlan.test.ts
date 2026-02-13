function assert(condition: any, message: string): void {
  if (!condition) throw new Error(message);
}

import { PlanRunner } from '../orchestrator/PlanRunner';
import { OrderPlanConfig, SymbolState } from '../orchestrator/types';
import { OrchestratorMetricsInput } from '../orchestrator/types';
import { PlannedOrder } from '../orchestrator/OrderPlan';
import { OpenOrderState } from '../orchestrator/types';

function baseConfig(): OrderPlanConfig {
  return {
    planEpochMs: 60_000,
    orderPrefix: 'p',
    planRebuildCooldownMs: 0,
    minMarginUsdt: 5,
    limitBufferBps: 5,
    defaultTickSize: 0.1,
    orderPriceTolerancePct: 0.05,
    orderQtyTolerancePct: 1,
    replaceThrottlePerSecond: 10,
    cancelStalePlanOrders: true,
    boot: {
      probeMarketPct: 0.2,
      waitReadyMs: 0,
      maxSpreadPct: 1,
      minObiDeep: 0,
      minDeltaZ: 0,
      allowMarket: false,
      retryMs: 10_000,
    },
    trend: {
      upEnter: 0.2,
      upExit: 0.1,
      downEnter: -0.2,
      downExit: -0.1,
      confirmTicks: 1,
      reversalConfirmTicks: 1,
      obiNorm: 1,
      deltaNorm: 1,
      cvdNorm: 1,
      scoreClamp: 1,
    },
    scaleIn: {
      levels: 2,
      stepPct: 0.1,
      maxAdds: 2,
      addOnlyIfTrendConfirmed: false,
      addMinUpnlUsdt: 0,
      addMinUpnlR: 0,
    },
    tp: {
      levels: 2,
      stepPcts: [0.2, 0.4],
      distribution: [50, 50],
      reduceOnly: true,
    },
    stop: {
      distancePct: 0.8,
      reduceOnly: true,
    },
    profitLock: {
      lockTriggerUsdt: 5,
      lockTriggerR: 0,
      maxDdFromPeakUsdt: 2,
      maxDdFromPeakR: 0,
    },
    reversalExitMode: 'MARKET',
    exitLimitBufferBps: 5,
    exitRetryMs: 0,
    allowFlip: false,
    initialMarginUsdt: 100,
    maxMarginUsdt: 0,
    stepUp: {
      mode: 'UPNL',
      stepPct: 0.2,
      triggerUsdt: 10,
      triggerR: 1,
      minTrendScore: 0.3,
      cooldownMs: 0,
    },
  };
}

function baseState(): SymbolState {
  return {
    symbol: 'BTCUSDT',
    halted: false,
    availableBalance: 1000,
    walletBalance: 1000,
    position: null,
    openOrders: new Map(),
    hasOpenEntryOrder: false,
    pendingEntry: false,
    cooldown_until_ms: 0,
    last_exit_event_time_ms: 0,
    marginRatio: 1,
    execQuality: {
      quality: 'GOOD',
      metricsPresent: true,
      freezeActive: false,
      lastLatencyMs: 10,
      lastSlippageBps: 1,
      lastSpreadPct: 0.01,
      recentLatencyMs: [],
      recentSlippageBps: [],
    },
  };
}

function makeMetrics(overrides: Partial<OrchestratorMetricsInput> = {}): OrchestratorMetricsInput {
  return {
    symbol: 'BTCUSDT',
    spread_pct: 0.01,
    prints_per_second: 2,
    best_bid: 100,
    best_ask: 100.1,
    legacyMetrics: {
      obiDeep: 0.3,
      deltaZ: 0.3,
      cvdSlope: 0.2,
    },
    ...overrides,
  };
}

function openOrdersFromPlanned(orders: PlannedOrder[]): Map<string, OpenOrderState> {
  const map = new Map<string, OpenOrderState>();
  for (const [idx, order] of orders.entries()) {
    map.set(order.clientOrderId, {
      orderId: `oid_${idx}`,
      clientOrderId: order.clientOrderId,
      side: order.side,
      orderType: order.type,
      status: 'NEW',
      origQty: order.qty,
      executedQty: 0,
      price: order.price || 0,
      reduceOnly: order.reduceOnly,
      event_time_ms: 0,
    });
  }
  return map;
}

export function runTests() {
  // Idempotency: same tick should not create duplicate actions when open orders match desired.
  {
    const runner = new PlanRunner(baseConfig());
    const state = baseState();
    const metrics = makeMetrics();
    const first = runner.tick({
      symbol: 'BTCUSDT',
      nowMs: 1000,
      metrics,
      gatePassed: true,
      state,
      executionReady: true,
      leverage: 10,
      currentMarginBudgetUsdt: 100,
      startingMarginUsdt: 100,
    });

    state.openOrders = openOrdersFromPlanned(first.desiredOrders);
    for (let i = 0; i < 10; i++) {
      const result = runner.tick({
        symbol: 'BTCUSDT',
        nowMs: 1000,
        metrics,
        gatePassed: true,
        state,
        executionReady: true,
        leverage: 10,
        currentMarginBudgetUsdt: 100,
        startingMarginUsdt: 100,
      });
      assert(result.reconcile.actions.length === 0, 'idempotency: no new actions expected with matching open orders');
    }
  }

  // Reversal: trend flips against position -> exit plan with reduce-only market.
  {
    const runner = new PlanRunner(baseConfig());
    const state = baseState();
    runner.tick({
      symbol: 'BTCUSDT',
      nowMs: 1000,
      metrics: makeMetrics({ legacyMetrics: { obiDeep: 0.4, deltaZ: 0.4, cvdSlope: 0.4 } }),
      gatePassed: true,
      state,
      executionReady: true,
      leverage: 10,
      currentMarginBudgetUsdt: 100,
      startingMarginUsdt: 100,
    });

    state.position = {
      side: 'LONG',
      qty: 1,
      entryPrice: 100,
      unrealizedPnlPct: 5,
      addsUsed: 0,
      peakPnlPct: 5,
      profitLockActivated: false,
      hardStopPrice: null,
    };

    const result = runner.tick({
      symbol: 'BTCUSDT',
      nowMs: 2000,
      metrics: makeMetrics({ legacyMetrics: { obiDeep: -0.6, deltaZ: -0.6, cvdSlope: -0.6 } }),
      gatePassed: true,
      state,
      executionReady: true,
      leverage: 10,
      currentMarginBudgetUsdt: 100,
      startingMarginUsdt: 100,
    });

    assert(result.planState === 'EXITING', 'reversal should move plan to EXITING');
    assert(result.immediateOrders.some((o) => o.reduceOnly && o.role === 'FLATTEN'), 'reversal should emit reduce-only flatten order');
  }

  // Profit lock: drawdown from peak triggers exit.
  {
    const runner = new PlanRunner(baseConfig());
    const state = baseState();
    runner.tick({
      symbol: 'BTCUSDT',
      nowMs: 1000,
      metrics: makeMetrics({ legacyMetrics: { obiDeep: 0.4, deltaZ: 0.4, cvdSlope: 0.4 } }),
      gatePassed: true,
      state,
      executionReady: true,
      leverage: 10,
      currentMarginBudgetUsdt: 100,
      startingMarginUsdt: 100,
    });

    state.position = {
      side: 'LONG',
      qty: 1,
      entryPrice: 100,
      unrealizedPnlPct: 10,
      addsUsed: 0,
      peakPnlPct: 10,
      profitLockActivated: false,
      hardStopPrice: null,
    };

    runner.tick({
      symbol: 'BTCUSDT',
      nowMs: 2000,
      metrics: makeMetrics({ legacyMetrics: { obiDeep: 0.4, deltaZ: 0.4, cvdSlope: 0.4 } }),
      gatePassed: true,
      state,
      executionReady: true,
      leverage: 10,
      currentMarginBudgetUsdt: 100,
      startingMarginUsdt: 100,
    });

    state.position.unrealizedPnlPct = 6;
    const result = runner.tick({
      symbol: 'BTCUSDT',
      nowMs: 3000,
      metrics: makeMetrics({ legacyMetrics: { obiDeep: 0.4, deltaZ: 0.4, cvdSlope: 0.4 } }),
      gatePassed: true,
      state,
      executionReady: true,
      leverage: 10,
      currentMarginBudgetUsdt: 100,
      startingMarginUsdt: 100,
    });

    assert(result.planState === 'EXITING', 'profit lock drawdown should move plan to EXITING');
    assert(result.events.some((e) => e.type === 'PROFIT_LOCK_TRIGGERED'), 'profit lock event should be emitted');
  }

  // TP ladder: desired orders include reduce-only TP levels.
  {
    const runner = new PlanRunner(baseConfig());
    const state = baseState();
    runner.tick({
      symbol: 'BTCUSDT',
      nowMs: 1000,
      metrics: makeMetrics({ legacyMetrics: { obiDeep: 0.4, deltaZ: 0.4, cvdSlope: 0.4 } }),
      gatePassed: true,
      state,
      executionReady: true,
      leverage: 10,
      currentMarginBudgetUsdt: 100,
      startingMarginUsdt: 100,
    });

    state.position = {
      side: 'LONG',
      qty: 2,
      entryPrice: 100,
      unrealizedPnlPct: 3,
      addsUsed: 0,
      peakPnlPct: 3,
      profitLockActivated: false,
      hardStopPrice: null,
    };

    const result = runner.tick({
      symbol: 'BTCUSDT',
      nowMs: 2000,
      metrics: makeMetrics({ legacyMetrics: { obiDeep: 0.4, deltaZ: 0.4, cvdSlope: 0.4 } }),
      gatePassed: true,
      state,
      executionReady: true,
      leverage: 10,
      currentMarginBudgetUsdt: 100,
      startingMarginUsdt: 100,
    });

    const tpOrders = result.desiredOrders.filter((o) => o.role === 'TP');
    assert(tpOrders.length === 2, 'tp ladder should create expected number of orders');
    assert(tpOrders.every((o) => o.reduceOnly), 'tp orders must be reduce-only');
  }
}
