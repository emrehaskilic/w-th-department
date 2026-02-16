export type DryRunSide = 'BUY' | 'SELL';
export type DryRunOrderType = 'MARKET' | 'LIMIT';
export type DryRunTimeInForce = 'IOC' | 'GTC';
export type DryRunReasonCode =
  | 'ENTRY_MARKET'
  | 'ADD_MARKET'
  | 'EXIT_MARKET'
  | 'REDUCE_SOFT'
  | 'REDUCE_EXHAUSTION'
  | 'HARD_REVERSAL_EXIT'
  | 'HARD_REVERSAL_ENTRY'
  | 'ADDON_MAKER'
  | 'REDUCE_PARTIAL'
  | 'PROFITLOCK'
  | 'TRAIL_STOP'
  | 'FLIP_BLOCKED'
  | 'FLIP_CONFIRMED'
  | 'RISK_EMERGENCY'
  | 'LIMIT_POSTONLY_REJECT'
  | 'LIMIT_TTL_CANCEL';

export interface DryRunBookLevel {
  price: number;
  qty: number;
}

export interface DryRunOrderBook {
  bids: DryRunBookLevel[];
  asks: DryRunBookLevel[];
}

export interface DryRunOrderRequest {
  side: DryRunSide;
  type: DryRunOrderType;
  qty: number;
  price?: number;
  timeInForce?: DryRunTimeInForce;
  reduceOnly?: boolean;
  postOnly?: boolean;
  ttlMs?: number;
  clientOrderId?: string;
  reasonCode?: DryRunReasonCode;
  addonIndex?: number;
  repriceAttempt?: number;
}

export interface DryRunEventInput {
  timestampMs: number;
  markPrice: number;
  orderBook: DryRunOrderBook;
  orders?: DryRunOrderRequest[];
}

export interface DryRunProxyConfig {
  mode: 'backend-proxy';
  restBaseUrl: string;
  marketWsBaseUrl: string;
}

export interface DryRunMarketImpactConfig {
  impactFactorBps?: number;
  maxSlippageBps?: number;
  queuePenaltyBps?: number;
  topDepthLevels?: number;
}

export interface DryRunConfig {
  runId: string;
  walletBalanceStartUsdt: number;
  initialMarginUsdt: number;
  leverage?: number;
  makerFeeRate: number;
  takerFeeRate: number;
  maintenanceMarginRate: number;
  fundingRate: number;
  fundingIntervalMs: number;
  fundingBoundaryStartTsUTC?: number;
  proxy: DryRunProxyConfig;
  marketImpact?: DryRunMarketImpactConfig;
}

export interface DryRunPosition {
  side: 'LONG' | 'SHORT';
  qty: number;
  entryPrice: number;
  entryTimestampMs?: number;
}

export interface DryRunOrderResult {
  orderId: string;
  status: 'FILLED' | 'PARTIALLY_FILLED' | 'NEW' | 'CANCELED' | 'REJECTED' | 'EXPIRED';
  side: DryRunSide;
  type: DryRunOrderType;
  requestedQty: number;
  filledQty: number;
  remainingQty: number;
  avgFillPrice: number;
  fee: number;
  realizedPnl: number;
  slippageBps?: number;
  marketImpactBps?: number;
  maePct?: number;
  mfePct?: number;
  reason: string | null;
  reasonCode?: DryRunReasonCode | null;
  clientOrderId?: string | null;
  postOnly?: boolean;
  maker?: boolean;
  addonIndex?: number | null;
  repriceAttempt?: number | null;
  tradeIds: string[];
}

export interface DryRunEventLog {
  runId: string;
  eventTimestampMs: number;
  sequence: number;
  eventId: string;
  walletBalanceBefore: number;
  walletBalanceAfter: number;
  realizedPnl: number;
  fee: number;
  fundingImpact: number;
  reconciliationExpectedAfter: number;
  marginHealth: number;
  liquidationTriggered: boolean;
  orderResults: DryRunOrderResult[];
}

export interface DryRunStateSnapshot {
  walletBalance: number;
  position: DryRunPosition | null;
  openLimitOrders: Array<{
    orderId: string;
    side: DryRunSide;
    price: number;
    remainingQty: number;
    reduceOnly: boolean;
    createdTsMs: number;
    clientOrderId?: string | null;
    postOnly?: boolean;
    ttlMs?: number | null;
    reasonCode?: DryRunReasonCode | null;
    addonIndex?: number | null;
    repriceAttempt?: number | null;
  }>;
  lastFundingBoundaryTsUTC: number;
  marginHealth: number;
}
