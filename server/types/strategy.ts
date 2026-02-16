export const StrategyRegime = {
  EV: 'EV',
  TR: 'TR',
  MR: 'MR',
} as const;

export type StrategyRegime = typeof StrategyRegime[keyof typeof StrategyRegime];

export const StrategySide = {
  LONG: 'LONG',
  SHORT: 'SHORT',
} as const;

export type StrategySide = typeof StrategySide[keyof typeof StrategySide];

export const StrategyActionType = {
  NOOP: 'NOOP',
  ENTRY: 'ENTRY',
  ADD: 'ADD',
  REDUCE: 'REDUCE',
  EXIT: 'EXIT',
} as const;

export type StrategyActionType = typeof StrategyActionType[keyof typeof StrategyActionType];

export type DecisionReason =
  | 'GATE_PAUSED'
  | 'GATE_SOURCE_NOT_REAL'
  | 'GATE_STALE_TRADES'
  | 'GATE_STALE_ORDERBOOK'
  | 'GATE_LOW_PRINTS'
  | 'GATE_WIDE_SPREAD'
  | 'REGIME_LOCKED'
  | 'REGIME_EV_OVERRIDE'
  | 'REGIME_TRMR_LOCK'
  | 'ENTRY_TR'
  | 'ENTRY_MR'
  | 'ENTRY_EV'
  | 'ENTRY_BLOCKED_COOLDOWN'
  | 'ENTRY_BLOCKED_MHT'
  | 'ENTRY_BLOCKED_GATE'
  | 'ENTRY_BLOCKED_FILTERS'
  | 'ADD_WINNER'
  | 'ADD_BLOCKED'
  | 'REDUCE_SOFT'
  | 'REDUCE_EXHAUSTION'
  | 'EXIT_HARD'
  | 'EXIT_HARD_REVERSAL'
  | 'HARD_REVERSAL_ENTRY'
  | 'HARD_REVERSAL_REJECTED'
  | 'NO_SIGNAL'
  | 'NOOP';

export interface StrategyAction {
  type: StrategyActionType;
  side?: StrategySide;
  reason: DecisionReason;
  expectedPrice?: number | null;
  sizeMultiplier?: number;
  reducePct?: number;
  metadata?: Record<string, unknown>;
}

export interface StrategyDecisionLog {
  timestampMs: number;
  symbol: string;
  regime: StrategyRegime;
  gate: {
    passed: boolean;
    reason: DecisionReason | null;
    details: Record<string, unknown>;
  };
  dfs: number;
  dfsPercentile: number;
  volLevel: number;
  thresholds: {
    longEntry: number;
    longBreak: number;
    shortEntry: number;
    shortBreak: number;
  };
  reasons: DecisionReason[];
  actions: StrategyAction[];
  stats: Record<string, number | null>;
}

export interface StrategyDecision {
  symbol: string;
  timestampMs: number;
  regime: StrategyRegime;
  dfs: number;
  dfsPercentile: number;
  volLevel: number;
  gatePassed: boolean;
  actions: StrategyAction[];
  reasons: DecisionReason[];
  log: StrategyDecisionLog;
}

export interface StrategyPositionState {
  side: StrategySide;
  qty: number;
  entryPrice: number;
  unrealizedPnlPct: number;
  addsUsed: number;
  peakPnlPct?: number;
}

export interface StrategyInput {
  symbol: string;
  nowMs: number;
  source: 'real' | 'mock' | 'synthetic' | 'unknown';
  orderbook: {
    lastUpdatedMs: number;
    spreadPct?: number | null;
    bestBid?: number | null;
    bestAsk?: number | null;
  };
  trades: {
    lastUpdatedMs: number;
    printsPerSecond: number;
    tradeCount: number;
    aggressiveBuyVolume: number;
    aggressiveSellVolume: number;
    consecutiveBurst: { side: 'buy' | 'sell' | null; count: number };
  };
  market: {
    price: number;
    vwap: number;
    delta1s: number;
    delta5s: number;
    deltaZ: number;
    cvdSlope: number;
    obiWeighted: number;
    obiDeep: number;
    obiDivergence: number;
  };
  openInterest?: {
    oiChangePct: number;
    lastUpdatedMs: number;
    source: 'real' | 'mock' | 'unknown';
  } | null;
  absorption?: {
    value: number; // 0 or 1
    side: 'buy' | 'sell' | null;
  } | null;
  volatility: number;
  position: StrategyPositionState | null;
}

// Compatibility signal interface for dry-run engines.
export interface StrategySignal {
  signal: string | null;
  score: number;
  vetoReason: string | null;
  candidate: {
    entryPrice: number;
    tpPrice?: number;
    slPrice?: number;
  } | null;
  boost?: {
    score: number;
    contributions: Record<string, number>;
    timeframeMultipliers: Record<string, number>;
  };
  orderflow?: {
    obiWeighted?: number | null;
    obiDeep?: number | null;
    deltaZ?: number | null;
    cvdSlope?: number | null;
  };
  market?: {
    price?: number | null;
    atr?: number | null;
    avgAtr?: number | null;
    recentHigh?: number | null;
    recentLow?: number | null;
  };
}

export interface StrategyConfig {
  decisionTickMs: number;
  rollingWindowMin: number;
  regimeLockTRMRTicks: number;
  regimeLockEVTicks: number;
  volHighP: number;
  volLowP: number;
  dfsEntryLongBase: number;
  dfsBreakLongBase: number;
  dfsEntryShortBase: number;
  dfsBreakShortBase: number;
  mhtTRs: number;
  mhtMRs: number;
  mhtEVs: number;
  cooldownSameS: number;
  cooldownFlipS: number;
  hardRevTicks: number;
  hardRevDfsP: number;
  hardRevRequireAbsorption: boolean;
  defensiveAddEnabled: boolean;
  dryRun: boolean;
  addSizing: number[];
}

export const defaultStrategyConfig: StrategyConfig = {
  decisionTickMs: Number(process.env.DECISION_TICK_MS || 1000),
  rollingWindowMin: Number(process.env.ROLLING_WINDOW_MIN || 60),
  regimeLockTRMRTicks: Number(process.env.REGIME_LOCK_TRMR_TICKS || 20),
  regimeLockEVTicks: Number(process.env.REGIME_LOCK_EV_TICKS || 5),
  volHighP: Number(process.env.VOL_HIGH_P || 0.8),
  volLowP: Number(process.env.VOL_LOW_P || 0.2),
  dfsEntryLongBase: Number(process.env.DFS_ENTRY_LONG_BASE || 0.85),
  dfsBreakLongBase: Number(process.env.DFS_BREAK_LONG_BASE || 0.55),
  dfsEntryShortBase: Number(process.env.DFS_ENTRY_SHORT_BASE || 0.15),
  dfsBreakShortBase: Number(process.env.DFS_BREAK_SHORT_BASE || 0.45),
  mhtTRs: Number(process.env.MHT_TR_S || 120),
  mhtMRs: Number(process.env.MHT_MR_S || 60),
  mhtEVs: Number(process.env.MHT_EV_S || 10),
  cooldownSameS: Number(process.env.COOLDOWN_SAME_S || 20),
  cooldownFlipS: Number(process.env.COOLDOWN_FLIP_S || 120),
  hardRevTicks: Number(process.env.HARDREV_TICKS || 8),
  hardRevDfsP: Number(process.env.HARDREV_DFS_P || 0.10),
  hardRevRequireAbsorption: String(process.env.HARDREV_REQUIRE_ABSORPTION || 'true').toLowerCase() === 'true',
  defensiveAddEnabled: String(process.env.DEFENSIVE_ADD_ENABLED || 'false').toLowerCase() === 'true',
  dryRun: String(process.env.DRY_RUN || 'true').toLowerCase() === 'true',
  addSizing: [1.0, 0.6, 0.4],
};
