export type DryRunSide = 'BUY' | 'SELL';
export type DryRunOrderType = 'MARKET' | 'LIMIT';
export type DryRunTimeInForce = 'IOC' | 'GTC';

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
  reason: string | null;
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
  }>;
  lastFundingBoundaryTsUTC: number;
  marginHealth: number;
}
