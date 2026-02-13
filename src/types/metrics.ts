export interface SignalDisplay {
  signal: 'SWEEP_FADE_LONG' | 'SWEEP_FADE_SHORT' | 'BREAKOUT_LONG' | 'BREAKOUT_SHORT' | null;
  score: number;
  confidence?: 'LOW' | 'MEDIUM' | 'HIGH';
  vetoReason: string | null;
  candidate: {
    entryPrice: number;
    tpPrice: number;
    slPrice: number;
  } | null;
  boost?: {
    score: number;
    contributions: Record<string, number>;
    timeframeMultipliers: Record<string, number>;
  };
}

export interface SnapshotMetadata {
  eventId: number;
  stateHash: string;
  ts: number;
}
export interface CvdTfMetrics {
  cvd: number;
  delta: number;
  state: 'Normal' | 'High Vol' | 'Extreme';
}

/**
 * Legacy orderflow metrics that were formerly computed in the
 * frontend.  These values are derived from both trades and the
 * orderbook on the server.  They maintain parity with the original
 * "Orderflow Matrix" UI.
 */
export interface LegacyMetrics {
  price: number;
  obiWeighted: number;
  obiDeep: number;
  obiDivergence: number;
  delta1s: number;
  delta5s: number;
  deltaZ: number;
  cvdSession: number;
  cvdSlope: number;
  vwap: number;
  totalVolume: number;
  totalNotional: number;
  tradeCount: number;
}

/**
 * Time and sales summary metrics derived from the trade tape.  These
 * values summarise aggressive buy and sell volume, trade counts and
 * distribution, bid/ask dominance and microburst detection.
 */
export interface TimeAndSalesMetrics {
  aggressiveBuyVolume: number;
  aggressiveSellVolume: number;
  tradeCount: number;
  smallTrades: number;
  midTrades: number;
  largeTrades: number;
  bidHitAskLiftRatio: number;
  consecutiveBurst: {
    side: 'buy' | 'sell';
    count: number;
  };
  printsPerSecond: number;
}

/**
 * Open interest metrics (futures context).  Delta is the change in
 * open interest since the previous update.  Source describes whether
 * the data comes from the real exchange or a mock feed.
 */
export interface OpenInterestMetrics {
  openInterest: number;
  oiChangeAbs: number;
  oiChangePct: number;
  oiDeltaWindow: number;
  lastUpdated: number;
  source: 'real' | 'mock';
  stabilityMsg?: string;
}

/**
 * Funding rate metrics.  ``rate`` is the current funding rate,
 * ``timeToFundingMs`` is the milliseconds until the next funding
 * event and ``trend`` indicates whether the rate is rising, falling
 * or flat.  Source indicates real or mock.
 */
export interface FundingContext {
  rate: number;
  timeToFundingMs: number;
  trend: 'up' | 'down' | 'flat';
  source: 'real' | 'mock';
}

/**
 * The structure of a single ``metrics`` message from the server.
 * Each message contains data for one symbol.  The UI should not
 * perform any calculations on these fields; they are ready for
 * rendering.
 */
export interface MetricsMessage {
  type: 'metrics';
  symbol: string;
  state: 'LIVE' | 'STALE' | 'RESYNCING';
  snapshot: SnapshotMetadata;
  timeAndSales: TimeAndSalesMetrics;
  cvd: {
    tf1m: CvdTfMetrics;
    tf5m: CvdTfMetrics;
    tf15m: CvdTfMetrics;
  };
  absorption: number | null;
  openInterest: OpenInterestMetrics | null;
  funding: FundingContext | null;
  legacyMetrics: LegacyMetrics;
  orderbookIntegrity?: {
    symbol: string;
    level: 'OK' | 'DEGRADED' | 'CRITICAL';
    message: string;
    lastUpdateTimestamp: number;
    sequenceGapCount: number;
    crossedBookDetected: boolean;
    avgStalenessMs: number;
    reconnectCount: number;
    reconnectRecommended: boolean;
  };
  signalDisplay: SignalDisplay;
  advancedMetrics: {
    sweepFadeScore: number;
    breakoutScore: number;
    volatilityIndex: number;
  };
  bids: [number, number, number][];
  asks: [number, number, number][];
  midPrice: number | null;
  lastUpdateId?: number;
}

/**
 * Per symbol state stored in the Dashboard.  Each symbol maps to
 * its latest metrics message.  We do not store derived values on
 * the client.
 */
export type MetricsState = Record<string, MetricsMessage>;
