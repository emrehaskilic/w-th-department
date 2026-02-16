import { DecisionLog } from '../telemetry/DecisionLog';
import {
  DecisionReason,
  StrategyAction,
  StrategyActionType,
  StrategyConfig,
  StrategyDecision,
  StrategyInput,
  StrategyRegime,
  StrategySide,
  defaultStrategyConfig,
} from '../types/strategy';
import { NormalizationStore } from './Normalization';
import { DirectionalFlowScore } from './DirectionalFlowScore';
import { RegimeSelector } from './RegimeSelector';

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

export class NewStrategyV11 {
  private readonly config: StrategyConfig;
  private readonly norm: NormalizationStore;
  private readonly dfs: DirectionalFlowScore;
  private readonly regimeSelector: RegimeSelector;
  private readonly decisionLog?: DecisionLog;

  private lastDecisionTs = 0;
  private lastEntryTs = 0;
  private lastEntrySide: StrategySide | null = null;
  private lastEntryRegime: StrategyRegime = 'MR';
  private lastExitTs = 0;
  private lastExitSide: StrategySide | null = null;
  private lastAddTs = 0;
  private lastDfsPercentile = 0.5;
  private lastDeltaZ = 0;
  private prevPrice: number | null = null;
  private prevCvdSlope: number | null = null;
  private vwapBelowTicks = 0;
  private vwapAboveTicks = 0;

  constructor(config?: Partial<StrategyConfig>, decisionLog?: DecisionLog) {
    this.config = { ...defaultStrategyConfig, ...(config || {}) };
    const windowMs = Math.max(60_000, this.config.rollingWindowMin * 60_000);
    this.norm = new NormalizationStore(windowMs, 64);
    this.dfs = new DirectionalFlowScore(this.norm);
    this.regimeSelector = new RegimeSelector(this.norm, this.config.regimeLockTRMRTicks, this.config.regimeLockEVTicks);
    this.decisionLog = decisionLog;
  }

  evaluate(input: StrategyInput): StrategyDecision {
    const nowMs = input.nowMs;
    const reasons: DecisionReason[] = [];
    const gate = this.dataQualityGate(input);

    if (!gate.passed) {
      reasons.push(gate.reason || 'GATE_PAUSED');
    }

    const dfsOut = this.dfs.compute({
      deltaZ: input.market.deltaZ,
      cvdSlope: input.market.cvdSlope,
      obiWeighted: input.market.obiWeighted,
      obiDeep: input.market.obiDeep,
      sweepStrength: input.market.delta1s,
      burstCount: input.trades.consecutiveBurst.count,
      burstSide: input.trades.consecutiveBurst.side,
      aggressiveBuyVolume: input.trades.aggressiveBuyVolume,
      aggressiveSellVolume: input.trades.aggressiveSellVolume,
      oiChangePct: input.openInterest?.oiChangePct ?? 0,
      price: input.market.price,
      prevPrice: this.prevPrice,
      prevCvd: this.prevCvdSlope,
      nowMs,
    });

    this.norm.update('delta1sAbs', Math.abs(input.market.delta1s), nowMs);
    this.norm.update('delta5sAbs', Math.abs(input.market.delta5s), nowMs);
    this.norm.update('prints', input.trades.printsPerSecond, nowMs);
    this.norm.update('flow', input.trades.aggressiveBuyVolume + input.trades.aggressiveSellVolume, nowMs);

    const regimeOut = this.regimeSelector.update({
      nowMs,
      price: input.market.price,
      vwap: input.market.vwap,
      dfsPercentile: dfsOut.dfsPercentile,
      deltaZ: input.market.deltaZ,
      printsPerSecond: input.trades.printsPerSecond,
      burstCount: input.trades.consecutiveBurst.count,
      volatility: input.volatility,
    });

    const thresholds = this.computeThresholds(regimeOut.volLevel);
    const actions: StrategyAction[] = [];

    this.updateVwapTicks(input.market.price, input.market.vwap);

    if (gate.passed) {
      this.lastDecisionTs = nowMs;
    }

    if (!gate.passed) {
      if (input.position) {
        const reduceAction = this.maybeSoftReduce(input, dfsOut.dfsPercentile, thresholds);
        if (reduceAction) {
          actions.push(reduceAction);
          reasons.push(reduceAction.reason);
        }
      }
      if (actions.length === 0) {
        actions.push({ type: StrategyActionType.NOOP, reason: 'GATE_PAUSED' });
      }
      return this.buildDecision(input, regimeOut.regime, dfsOut, thresholds, gate, actions, reasons);
    }

    if (!input.position) {
      const entryAction = this.evaluateEntry(input, dfsOut.dfsPercentile, dfsOut.dfs, regimeOut.regime, regimeOut.volLevel, thresholds, reasons);
      if (entryAction) {
        actions.push(entryAction);
        reasons.push(entryAction.reason);
        this.lastEntrySide = entryAction.side || null;
        this.lastEntryRegime = regimeOut.regime;
      } else {
        reasons.push('NO_SIGNAL');
        actions.push({ type: StrategyActionType.NOOP, reason: 'NO_SIGNAL' });
      }
    } else {
      const hardRev = this.checkHardReversal(input, dfsOut.dfsPercentile);
      if (hardRev.valid) {
        actions.push({ type: StrategyActionType.EXIT, side: input.position.side, reason: 'EXIT_HARD_REVERSAL' });
        actions.push({ type: StrategyActionType.ENTRY, side: this.flipSide(input.position.side), reason: 'HARD_REVERSAL_ENTRY', sizeMultiplier: 0.35 });
        reasons.push('EXIT_HARD_REVERSAL', 'HARD_REVERSAL_ENTRY');
        this.lastExitTs = nowMs;
        this.lastExitSide = input.position.side;
        this.lastEntryTs = nowMs;
        this.lastEntrySide = this.flipSide(input.position.side);
        this.lastEntryRegime = regimeOut.regime;
      } else {
        const hardExit = this.maybeHardExit(input, dfsOut.dfsPercentile, thresholds);
        if (hardExit) {
          actions.push(hardExit);
          reasons.push(hardExit.reason);
          this.lastExitTs = nowMs;
          this.lastExitSide = input.position.side;
        } else {
          const reduceAction = this.maybeSoftReduce(input, dfsOut.dfsPercentile, thresholds);
          if (reduceAction) {
            actions.push(reduceAction);
            reasons.push(reduceAction.reason);
          }

          const addAction = this.maybeAdd(input, dfsOut.dfsPercentile, regimeOut.volLevel);
          if (addAction) {
            actions.push(addAction);
            reasons.push(addAction.reason);
          }

          if (actions.length === 0) {
            actions.push({ type: StrategyActionType.NOOP, reason: 'NOOP' });
            reasons.push('NOOP');
          }
        }
      }
    }

    this.lastDfsPercentile = dfsOut.dfsPercentile;
    this.lastDeltaZ = input.market.deltaZ;
    this.prevPrice = input.market.price;
    this.prevCvdSlope = input.market.cvdSlope;

    return this.buildDecision(input, regimeOut.regime, dfsOut, thresholds, gate, actions, reasons);
  }

  private computeThresholds(volLevel: number) {
    let longEntry = this.config.dfsEntryLongBase;
    let shortEntry = this.config.dfsEntryShortBase;
    const longBreak = this.config.dfsBreakLongBase;
    const shortBreak = this.config.dfsBreakShortBase;

    if (volLevel > this.config.volHighP) {
      longEntry = 0.90;
      shortEntry = 0.10;
    } else if (volLevel < this.config.volLowP) {
      longEntry = 0.80;
      shortEntry = 0.20;
    }

    return { longEntry, shortEntry, longBreak, shortBreak };
  }

  private dataQualityGate(input: StrategyInput): { passed: boolean; reason: DecisionReason | null; details: Record<string, unknown> } {
    const details: Record<string, unknown> = {};
    if (input.source !== 'real' || (input.openInterest?.source && input.openInterest.source !== 'real')) {
      return { passed: false, reason: 'GATE_SOURCE_NOT_REAL', details: { source: input.source } };
    }
    const tradeLag = Math.max(0, input.nowMs - input.trades.lastUpdatedMs);
    const bookLag = Math.max(0, input.nowMs - input.orderbook.lastUpdatedMs);
    details.tradeLagMs = tradeLag;
    details.bookLagMs = bookLag;
    if (tradeLag > 1000) {
      return { passed: false, reason: 'GATE_STALE_TRADES', details };
    }
    if (bookLag > 2000) {
      return { passed: false, reason: 'GATE_STALE_ORDERBOOK', details };
    }
    if (input.trades.printsPerSecond < 0.2 || input.trades.tradeCount < 5) {
      details.printsPerSecond = input.trades.printsPerSecond;
      details.tradeCount = input.trades.tradeCount;
      return { passed: false, reason: 'GATE_LOW_PRINTS', details };
    }
    if ((input.orderbook.spreadPct ?? 0) > 0.5) {
      details.spreadPct = input.orderbook.spreadPct;
      return { passed: false, reason: 'GATE_WIDE_SPREAD', details };
    }
    return { passed: true, reason: null, details };
  }

  private evaluateEntry(
    input: StrategyInput,
    dfsP: number,
    dfs: number,
    regime: StrategyRegime,
    volLevel: number,
    thresholds: { longEntry: number; shortEntry: number },
    reasons: DecisionReason[]
  ): StrategyAction | null {
    const desiredSide = this.selectEntrySide(input, dfsP, regime, thresholds);
    if (!desiredSide) return null;

    if (this.isInCooldown(desiredSide, input.nowMs, volLevel)) {
      reasons.push('ENTRY_BLOCKED_COOLDOWN');
      return null;
    }

    if (this.isInMHT(desiredSide, input.nowMs, volLevel)) {
      reasons.push('ENTRY_BLOCKED_MHT');
      return null;
    }

    const filtersOk = this.entryFilters(input, dfsP, dfs, regime, volLevel, thresholds, desiredSide);
    if (!filtersOk) {
      reasons.push('ENTRY_BLOCKED_FILTERS');
      return null;
    }

    this.lastEntryTs = input.nowMs;
    return {
      type: StrategyActionType.ENTRY,
      side: desiredSide,
      reason: regime === 'EV' ? 'ENTRY_EV' : regime === 'MR' ? 'ENTRY_MR' : 'ENTRY_TR',
      expectedPrice: input.market.price,
    };
  }

  private selectEntrySide(
    input: StrategyInput,
    dfsP: number,
    regime: StrategyRegime,
    thresholds: { longEntry: number; shortEntry: number }
  ): StrategySide | null {
    if (regime === 'EV') {
      if (dfsP >= Math.max(0.9, thresholds.longEntry)) return 'LONG';
      if (dfsP <= Math.min(0.1, thresholds.shortEntry)) return 'SHORT';
      return null;
    }
    if (dfsP >= thresholds.longEntry) return 'LONG';
    if (dfsP <= thresholds.shortEntry) return 'SHORT';
    return null;
  }

  private entryFilters(
    input: StrategyInput,
    dfsP: number,
    dfs: number,
    regime: StrategyRegime,
    volLevel: number,
    thresholds: { longEntry: number; shortEntry: number },
    desiredSide: StrategySide
  ): boolean {
    const price = input.market.price;
    const vwap = input.market.vwap;

    if (regime === 'TR') {
      if (desiredSide === 'LONG') {
        return (
          price >= vwap &&
          dfsP >= thresholds.longEntry &&
          input.market.cvdSlope > 0 &&
          input.market.delta5s > 0 &&
          input.market.obiDeep > 0
        );
      }
      return (
        price <= vwap &&
        dfsP <= thresholds.shortEntry &&
        input.market.cvdSlope < 0 &&
        input.market.delta5s < 0 &&
        input.market.obiDeep < 0
      );
    }

    if (regime === 'MR') {
      const devP = this.norm.percentile('dev', Math.abs(price - vwap));
      const deltaAbsP = this.norm.percentile('deltaAbs', Math.abs(input.market.deltaZ));
      const deltaImproving = desiredSide === 'LONG'
        ? input.market.deltaZ > this.lastDeltaZ
        : input.market.deltaZ < this.lastDeltaZ;
      const absorptionOk = input.absorption?.value ? (input.absorption.side === (desiredSide === 'LONG' ? 'buy' : 'sell')) : false;
      const obiDivOk = desiredSide === 'LONG' ? input.market.obiDivergence > 0 : input.market.obiDivergence < 0;
      const evLow = volLevel < 0.8;
      return devP >= 0.7 && deltaAbsP >= 0.8 && deltaImproving && absorptionOk && obiDivOk && evLow;
    }

    if (regime === 'EV') {
      const burstSide = input.trades.consecutiveBurst.side;
      const burstAligned = burstSide && (desiredSide === 'LONG' ? burstSide === 'buy' : burstSide === 'sell');
      const volHigh = volLevel > 0.8;
      const dfsGate = dfsP >= (volHigh ? 0.95 : 0.90);
      return burstAligned && dfsGate && Math.sign(dfs) === (desiredSide === 'LONG' ? 1 : -1);
    }

    return false;
  }

  private maybeAdd(input: StrategyInput, dfsP: number, volLevel: number): StrategyAction | null {
    if (!input.position) return null;
    if (input.position.addsUsed >= this.config.addSizing.length) return null;
    if (input.position.unrealizedPnlPct <= 0) return null;
    if (dfsP < 0.75 || dfsP < this.lastDfsPercentile) return null;
    const side = input.position.side;
    if (side === 'LONG' && input.market.cvdSlope <= 0) return null;
    if (side === 'SHORT' && input.market.cvdSlope >= 0) return null;
    if (Math.abs(input.market.price - input.market.vwap) > Math.abs(input.market.vwap) * 0.01) return null;

    const addIndex = input.position.addsUsed;
    const sizeMultiplier = this.config.addSizing[addIndex] ?? 0.4;
    this.lastAddTs = input.nowMs;

    return {
      type: StrategyActionType.ADD,
      side: input.position.side,
      reason: 'ADD_WINNER',
      sizeMultiplier: clamp(sizeMultiplier, 0.1, 1),
      expectedPrice: input.market.price,
      metadata: { volLevel },
    };
  }

  private maybeSoftReduce(
    input: StrategyInput,
    dfsP: number,
    thresholds: { longBreak: number; shortBreak: number }
  ): StrategyAction | null {
    if (!input.position) return null;
    const side = input.position.side;
    const weakening = this.lastDfsPercentile >= 0.85 && dfsP <= 0.6;
    const breakLevel = side === 'LONG' ? dfsP <= thresholds.longBreak : dfsP >= thresholds.shortBreak;
    if (weakening || breakLevel) {
      return {
        type: StrategyActionType.REDUCE,
        side,
        reason: 'REDUCE_SOFT',
        reducePct: weakening ? 0.5 : 0.3,
        expectedPrice: input.market.price,
      };
    }
    return null;
  }

  private maybeHardExit(
    input: StrategyInput,
    dfsP: number,
    thresholds: { longBreak: number; shortBreak: number }
  ): StrategyAction | null {
    if (!input.position) return null;
    const side = input.position.side;
    const price = input.market.price;
    const vwap = input.market.vwap;
    const vwapHoldTicks = this.config.hardRevTicks;
    if (side === 'LONG') {
      const vwapHold = this.vwapBelowTicks >= Math.max(3, Math.floor(vwapHoldTicks / 2));
      if (price < vwap && vwapHold && dfsP <= thresholds.longBreak) {
        return { type: StrategyActionType.EXIT, side, reason: 'EXIT_HARD', expectedPrice: price };
      }
    }
    if (side === 'SHORT') {
      const vwapHold = this.vwapAboveTicks >= Math.max(3, Math.floor(vwapHoldTicks / 2));
      if (price > vwap && vwapHold && dfsP >= thresholds.shortBreak) {
        return { type: StrategyActionType.EXIT, side, reason: 'EXIT_HARD', expectedPrice: price };
      }
    }
    return null;
  }

  private checkHardReversal(
    input: StrategyInput,
    dfsP: number
  ): { valid: boolean; reason: DecisionReason } {
    if (!input.position) return { valid: false, reason: 'HARD_REVERSAL_REJECTED' };
    const side = input.position.side;
    const price = input.market.price;
    const vwap = input.market.vwap;
    const devP = this.norm.percentile('dev', Math.abs(price - vwap));
    const deltaAbsP = this.norm.percentile('deltaAbs', Math.abs(input.market.deltaZ));
    const delta1sP = this.norm.percentile('delta1sAbs', Math.abs(input.market.delta1s));
    const delta5sP = this.norm.percentile('delta5sAbs', Math.abs(input.market.delta5s));

    const extreme = devP > 0.95 && (deltaAbsP > 0.95 || delta1sP > 0.95 || delta5sP > 0.95);

    const absorptionOk = this.config.hardRevRequireAbsorption
      ? Boolean(input.absorption?.value) && (input.absorption?.side === (side === 'LONG' ? 'sell' : 'buy'))
      : true;

    const printsHigh = this.norm.percentile('prints', input.trades.printsPerSecond) > 0.8;
    const flowHigh = this.norm.percentile('flow', input.trades.aggressiveBuyVolume + input.trades.aggressiveSellVolume) > 0.8;
    const priceStall = this.prevPrice !== null ? Math.abs(price - this.prevPrice) <= Math.abs(price) * 0.0002 : false;

    const stall = absorptionOk && printsHigh && flowHigh && priceStall;

    const obiDiv = input.market.obiDivergence;
    const obiDivOpposite = side === 'LONG' ? obiDiv < 0 : obiDiv > 0;

    const counterAggression = side === 'LONG'
      ? dfsP <= this.config.hardRevDfsP && input.market.cvdSlope < 0 && input.market.obiDeep < 0
      : dfsP >= (1 - this.config.hardRevDfsP) && input.market.cvdSlope > 0 && input.market.obiDeep > 0;

    const vwapHold = side === 'LONG'
      ? this.vwapBelowTicks >= this.config.hardRevTicks
      : this.vwapAboveTicks >= this.config.hardRevTicks;

    if (extreme && stall && obiDivOpposite && counterAggression && vwapHold) {
      return { valid: true, reason: 'EXIT_HARD_REVERSAL' };
    }

    return { valid: false, reason: 'HARD_REVERSAL_REJECTED' };
  }

  private isInCooldown(side: StrategySide, nowMs: number, volLevel: number): boolean {
    if (this.lastExitTs <= 0 || !this.lastExitSide) return false;
    const flip = this.lastExitSide !== side;
    const volAdj = this.volMultiplier(volLevel);
    const cooldownMs = flip\n+      ? this.config.cooldownFlipS * 1000 * volAdj\n+      : this.config.cooldownSameS * 1000;
    return nowMs < this.lastExitTs + cooldownMs;
  }

  private isInMHT(side: StrategySide, nowMs: number, volLevel: number): boolean {
    if (this.lastEntryTs <= 0 || !this.lastEntrySide) return false;
    if (side === this.lastEntrySide) return false;
    const elapsed = nowMs - this.lastEntryTs;
    const base = this.mhtBaseMs(this.lastEntryRegime);
    const mhtMs = base * this.volMultiplier(volLevel);
    return elapsed < mhtMs;
  }

  private updateVwapTicks(price: number, vwap: number): void {
    if (price < vwap) {
      this.vwapBelowTicks += 1;
      this.vwapAboveTicks = 0;
    } else if (price > vwap) {
      this.vwapAboveTicks += 1;
      this.vwapBelowTicks = 0;
    }
  }

  private flipSide(side: StrategySide): StrategySide {
    return side === 'LONG' ? 'SHORT' : 'LONG';
  }

  private mhtBaseMs(regime: StrategyRegime): number {
    if (regime === 'EV') return this.config.mhtEVs * 1000;
    if (regime === 'MR') return this.config.mhtMRs * 1000;
    return this.config.mhtTRs * 1000;
  }

  private volMultiplier(volLevel: number): number {
    if (volLevel > this.config.volHighP) return 1.5;
    if (volLevel < this.config.volLowP) return 0.75;
    return 1;
  }

  private buildDecision(
    input: StrategyInput,
    regime: StrategyRegime,
    dfsOut: { dfs: number; dfsPercentile: number },
    thresholds: { longEntry: number; longBreak: number; shortEntry: number; shortBreak: number },
    gate: { passed: boolean; reason: DecisionReason | null; details: Record<string, unknown> },
    actions: StrategyAction[],
    reasons: DecisionReason[]
  ): StrategyDecision {
    const log = {
      timestampMs: input.nowMs,
      symbol: input.symbol,
      regime,
      gate,
      dfs: dfsOut.dfs,
      dfsPercentile: dfsOut.dfsPercentile,
      volLevel: this.norm.percentile('vol', input.volatility),
      thresholds: {
        longEntry: thresholds.longEntry,
        longBreak: thresholds.longBreak,
        shortEntry: thresholds.shortEntry,
        shortBreak: thresholds.shortBreak,
      },
      reasons,
      actions,
      stats: {
        price: input.market.price,
        vwap: input.market.vwap,
        deltaZ: input.market.deltaZ,
        cvdSlope: input.market.cvdSlope,
        obiDeep: input.market.obiDeep,
        printsPerSecond: input.trades.printsPerSecond,
      },
    };

    if (this.decisionLog) {
      this.decisionLog.record(log);
    }

    return {
      symbol: input.symbol,
      timestampMs: input.nowMs,
      regime,
      dfs: dfsOut.dfs,
      dfsPercentile: dfsOut.dfsPercentile,
      volLevel: log.volLevel,
      gatePassed: gate.passed,
      actions,
      reasons,
      log,
    };
  }
}
