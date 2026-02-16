import { DecisionAction, GateResult, OrchestratorMetricsInput, SymbolState } from './types';
import { OrderType } from '../connectors/executionTypes';
import { NewStrategyV11 } from '../strategy/NewStrategyV11';
import { RiskGovernorV11 } from '../risk/RiskGovernorV11';
import { StrategyInput, StrategySide } from '../types/strategy';

export interface DecisionDependencies {
  expectedPrice: (symbol: string, side: 'BUY' | 'SELL', type: OrderType, limitPrice?: number) => number | null;
  getCurrentMarginBudgetUsdt: (symbol: string) => number;
  getMaxLeverage: () => number;
  hardStopLossPct: number;
  liquidationEmergencyMarginRatio: number;
  allowedSides?: 'BOTH' | 'LONG' | 'SHORT';
  liquidationRiskConfig?: {
    yellowThreshold?: number;
    orangeThreshold?: number;
    redThreshold?: number;
    criticalThreshold?: number;
    timeToLiquidationWarningMs?: number;
    fundingRateImpactFactor?: number;
    volatilityImpactFactor?: number;
  };
  onLiquidationAlert?: (message: string) => void;
  takerFeeBps: number;
  profitLockBufferBps: number;
}

export class DecisionEngine {
  private readonly strategy = new NewStrategyV11();
  private readonly risk = new RiskGovernorV11();

  constructor(private readonly deps: DecisionDependencies) {}

  evaluate(input: {
    symbol: string;
    event_time_ms: number;
    gate: GateResult;
    metrics: OrchestratorMetricsInput;
    state: SymbolState;
  }): DecisionAction[] {
    const { gate, metrics, state, symbol, event_time_ms } = input;
    if (!gate.passed) {
      return [{ type: 'NOOP', symbol, event_time_ms, reason: `gate_fail:${gate.reason || 'unknown'}` }];
    }

    const price = this.resolveMarketPrice(metrics, state.position?.side || null) ?? 0;
    const dfsInput: StrategyInput = {
      symbol,
      nowMs: event_time_ms,
      source: 'real',
      orderbook: {
        lastUpdatedMs: metrics.exchange_event_time_ms ?? event_time_ms,
        spreadPct: metrics.spread_pct ?? null,
        bestBid: metrics.best_bid ?? null,
        bestAsk: metrics.best_ask ?? null,
      },
      trades: {
        lastUpdatedMs: metrics.exchange_event_time_ms ?? event_time_ms,
        printsPerSecond: metrics.prints_per_second ?? 0,
        tradeCount: Math.max(0, Math.round((metrics.prints_per_second ?? 0) * 60)),
        aggressiveBuyVolume: 0,
        aggressiveSellVolume: 0,
        consecutiveBurst: { side: null, count: 0 },
      },
      market: {
        price,
        vwap: price,
        delta1s: 0,
        delta5s: 0,
        deltaZ: metrics.legacyMetrics?.deltaZ ?? 0,
        cvdSlope: metrics.legacyMetrics?.cvdSlope ?? 0,
        obiWeighted: 0,
        obiDeep: metrics.legacyMetrics?.obiDeep ?? 0,
        obiDivergence: 0,
      },
      openInterest: null,
      absorption: null,
      volatility: metrics.advancedMetrics?.volatilityIndex ?? 0,
      position: state.position
        ? {
            side: state.position.side === 'LONG' ? 'LONG' : 'SHORT',
            qty: state.position.qty,
            entryPrice: state.position.entryPrice,
            unrealizedPnlPct: state.position.unrealizedPnlPct,
            addsUsed: state.position.addsUsed,
            peakPnlPct: state.position.peakPnlPct,
          }
        : null,
    };

    const decision = this.strategy.evaluate(dfsInput);
    const actions: DecisionAction[] = [];

    for (const act of decision.actions) {
      if (act.type === 'NOOP') continue;
      const side = act.side ? this.toOrderSide(act.side) : null;
      if (!side) continue;

      if (act.type === 'ENTRY' || act.type === 'ADD') {
        if (!this.isSideAllowed(side)) {
          actions.push({ type: 'NOOP', symbol, event_time_ms, reason: 'side_not_allowed' });
          continue;
        }
        const expectedPrice = this.deps.expectedPrice(symbol, side, 'MARKET');
        const priceRef = expectedPrice ?? price;
        const riskSizing = this.risk.compute({
          equity: this.deps.getCurrentMarginBudgetUsdt(symbol),
          price: priceRef,
          vwap: priceRef,
          volatility: metrics.advancedMetrics?.volatilityIndex ?? 0,
          regime: decision.regime,
          liquidationDistance: null,
        });
        const qty = riskSizing.qty * (act.sizeMultiplier ?? 1);
        actions.push({
          type: act.type === 'ENTRY' ? 'ENTRY_PROBE' : 'ADD_POSITION',
          symbol,
          event_time_ms,
          side,
          quantity: qty,
          reduceOnly: false,
          expectedPrice: priceRef,
          reason: act.reason,
        });
        continue;
      }

      if (act.type === 'REDUCE' || act.type === 'EXIT') {
        const positionQty = state.position?.qty ?? 0;
        const reducePct = act.reducePct ?? 1;
        const qty = act.type === 'REDUCE' ? positionQty * reducePct : positionQty;
        actions.push({
          type: 'EXIT_MARKET',
          symbol,
          event_time_ms,
          side,
          quantity: qty,
          reduceOnly: true,
          expectedPrice: price,
          reason: act.reason,
        });
      }
    }

    return actions.length > 0 ? actions : [{ type: 'NOOP', symbol, event_time_ms, reason: 'no_action' }];
  }

  private resolveMarketPrice(metrics: OrchestratorMetricsInput, positionSide: 'LONG' | 'SHORT' | null): number | null {
    if (positionSide === 'LONG') {
      const px = metrics.best_bid ?? metrics.best_ask ?? null;
      return typeof px === 'number' && Number.isFinite(px) ? px : null;
    }
    if (positionSide === 'SHORT') {
      const px = metrics.best_ask ?? metrics.best_bid ?? null;
      return typeof px === 'number' && Number.isFinite(px) ? px : null;
    }
    const bid = metrics.best_bid;
    const ask = metrics.best_ask;
    if (typeof bid === 'number' && Number.isFinite(bid) && typeof ask === 'number' && Number.isFinite(ask) && bid > 0 && ask > 0) {
      return (bid + ask) / 2;
    }
    return null;
  }

  private toOrderSide(side: StrategySide): 'BUY' | 'SELL' {
    return side === 'LONG' ? 'BUY' : 'SELL';
  }

  private isSideAllowed(side: 'BUY' | 'SELL'): boolean {
    const allowed = (this.deps.allowedSides || 'BOTH').toUpperCase();
    if (allowed === 'BOTH') return true;
    if (allowed === 'LONG') return side === 'BUY';
    if (allowed === 'SHORT') return side === 'SELL';
    return true;
  }
}
