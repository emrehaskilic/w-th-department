import { ExecutionEvent, OrderType, Side } from '../connectors/executionTypes';

export interface OrchestratorMetricsInput {
  symbol: string;
  canonical_time_ms?: number;
  exchange_event_time_ms?: number | null;
  spread_pct?: number | null;
  prints_per_second?: number | null;
  best_bid?: number | null;
  best_ask?: number | null;
  legacyMetrics?: {
    obiDeep?: number | null;
    deltaZ?: number | null;
    cvdSlope?: number | null;
  } | null;
}

export type ExecQualityLevel = 'UNKNOWN' | 'GOOD' | 'BAD';

export const GateMode = {
  V1_NO_LATENCY: 'V1_NO_LATENCY',
  V2_NETWORK_LATENCY: 'V2_NETWORK_LATENCY',
} as const;

export type GateMode = typeof GateMode[keyof typeof GateMode];

export interface GateConfig {
  mode: GateMode;
  maxSpreadPct: number;
  minObiDeep: number;
  v2?: {
    maxNetworkLatencyMs: number;
  };
}

export interface GateResult {
  mode: GateMode;
  passed: boolean;
  reason: string | null;
  network_latency_ms: number | null;
  checks: {
    hasRequiredMetrics: boolean;
    spreadOk: boolean;
    obiDeepOk: boolean;
    networkLatencyOk: boolean | null;
  };
}

export type DecisionActionType =
  | 'NOOP'
  | 'ENTRY_PROBE'
  | 'ADD_POSITION'
  | 'EXIT_MARKET'
  | 'CANCEL_OPEN_ENTRY_ORDERS';

export interface DecisionAction {
  type: DecisionActionType;
  symbol: string;
  event_time_ms: number;
  side?: Side;
  quantity?: number;
  reduceOnly?: boolean;
  expectedPrice?: number | null;
  reason?: string;
}

export interface OpenOrderState {
  orderId: string;
  clientOrderId: string;
  side: Side;
  orderType: OrderType;
  status: string;
  origQty: number;
  executedQty: number;
  reduceOnly: boolean;
  event_time_ms: number;
}

export interface MetricsEventEnvelope {
  kind: 'metrics';
  symbol: string;
  canonical_time_ms: number;
  exchange_event_time_ms: number | null;
  metrics: OrchestratorMetricsInput;
  gate: GateResult;
}

export interface ExecutionEventEnvelope {
  kind: 'execution';
  symbol: string;
  event_time_ms: number;
  execution: ExecutionEvent;
}

export type ActorEnvelope = MetricsEventEnvelope | ExecutionEventEnvelope;

export interface PositionState {
  side: 'LONG' | 'SHORT';
  qty: number;
  entryPrice: number;
  unrealizedPnlPct: number;
  addsUsed: number;
  peakPnlPct: number;
  profitLockActivated: boolean;
  hardStopPrice: number | null;
}

export interface ExecQualityState {
  quality: ExecQualityLevel;
  metricsPresent: boolean;
  freezeActive: boolean;
  lastLatencyMs: number | null;
  lastSlippageBps: number | null;
  lastSpreadPct: number | null;
  recentLatencyMs: number[];
  recentSlippageBps: number[];
}

export interface SymbolState {
  symbol: string;
  halted: boolean;
  availableBalance: number;
  walletBalance: number;
  position: PositionState | null;
  openOrders: Map<string, OpenOrderState>;
  hasOpenEntryOrder: boolean;
  pendingEntry: boolean;
  cooldown_until_ms: number;
  last_exit_event_time_ms: number;
  marginRatio: number | null;
  execQuality: ExecQualityState;
}

export interface OrchestratorConfig {
  maxLeverage: number;
  loggerQueueLimit: number;
  loggerDropHaltThreshold: number;
  gate: GateConfig;
  cooldown: { minMs: number; maxMs: number };
  startingMarginUsdt: number;
  minMarginUsdt: number;
  rampStepPct: number;
  rampDecayPct: number;
  rampMaxMult: number;
  hardStopLossPct: number;
  liquidationEmergencyMarginRatio: number;
  takerFeeBps: number;
  profitLockBufferBps: number;
}

