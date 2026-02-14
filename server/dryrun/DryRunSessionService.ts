import { DryRunEngine } from './DryRunEngine';
import { DryRunConfig, DryRunEventInput, DryRunEventLog, DryRunOrderBook, DryRunOrderRequest, DryRunStateSnapshot } from './types';
import { StrategySignal } from '../strategy/StrategyEngine';
import { AlphaDecayAnalyzer } from '../strategy/AlphaDecayAnalyzer';
import { AlertService } from '../notifications/AlertService';
import { PositionSizingService, DynamicSizingConfig } from './PositionSizingService';
import { DynamicStopLossService, DynamicStopLossConfig } from '../risk/DynamicStopLossService';
import { PerformanceCalculator, PerformanceMetrics } from '../metrics/PerformanceCalculator';
import { SessionStore } from './SessionStore';
import { LimitOrderStrategy, LimitStrategyMode } from './LimitOrderStrategy';
import { DryRunLogEvent, DryRunOrderflowMetrics, DryRunTradeLogger } from './DryRunTradeLogger';
import path from 'path';

export interface DryRunSessionStartInput {
  symbols?: string[];
  symbol?: string;
  runId?: string;
  walletBalanceStartUsdt: number;
  initialMarginUsdt: number;
  leverage: number;
  takerFeeRate?: number;
  maintenanceMarginRate?: number;
  fundingRate?: number;
  fundingRates?: Record<string, number>;
  fundingIntervalMs?: number;
  heartbeatIntervalMs?: number;
  debugAggressiveEntry?: boolean;
}

export interface DryRunConsoleLog {
  seq: number;
  timestampMs: number;
  symbol: string | null;
  level: 'INFO' | 'WARN' | 'ERROR';
  message: string;
}

export interface DryRunSymbolStatus {
  symbol: string;
  metrics: {
    markPrice: number;
    totalEquity: number;
    walletBalance: number;
    unrealizedPnl: number;
    realizedPnl: number;
    feePaid: number;
    fundingPnl: number;
    marginHealth: number;
  };
  performance?: PerformanceMetrics;
  risk?: {
    winStreak: number;
    lossStreak: number;
    dynamicLeverage: number;
    stopLossPrice: number | null;
    liquidationRisk?: {
      score: 'GREEN' | 'YELLOW' | 'ORANGE' | 'RED' | 'CRITICAL';
      timeToLiquidationMs: number | null;
      fundingRateImpact: number;
    };
  };
  position: {
    side: 'LONG' | 'SHORT';
    qty: number;
    entryPrice: number;
    markPrice: number;
    liqPrice: null;
  } | null;
  openLimitOrders: DryRunStateSnapshot['openLimitOrders'];
  lastEventTimestampMs: number;
  eventCount: number;
}

export interface DryRunSessionStatus {
  running: boolean;
  runId: string | null;
  symbols: string[];
  config: {
    walletBalanceStartUsdt: number;
    initialMarginUsdt: number;
    leverage: number;
    takerFeeRate: number;
    maintenanceMarginRate: number;
    fundingIntervalMs: number;
    heartbeatIntervalMs: number;
    debugAggressiveEntry: boolean;
  } | null;
  summary: {
    totalEquity: number;
    walletBalance: number;
    unrealizedPnl: number;
    realizedPnl: number;
    feePaid: number;
    fundingPnl: number;
    marginHealth: number;
    performance?: PerformanceMetrics;
  };
  perSymbol: Record<string, DryRunSymbolStatus>;
  logTail: DryRunConsoleLog[];
  alphaDecay: Array<{
    signalType: string;
    avgValidityMs: number;
    alphaDecayHalfLife: number;
    optimalEntryWindow: [number, number];
    optimalExitWindow: [number, number];
    sampleCount: number;
  }>;
}

type PendingEntryContext = {
  reason: 'STRATEGY_SIGNAL' | 'MANUAL_TEST' | 'DEBUG_AGGRESSIVE_ENTRY' | 'UNKNOWN';
  signalType: string | null;
  signalScore: number | null;
  candidate: StrategySignal['candidate'] | null;
  orderflow: DryRunOrderflowMetrics;
  boost?: StrategySignal['boost'];
  market?: StrategySignal['market'];
  timestampMs: number;
  leverage: number | null;
};

type ActiveTrade = {
  tradeId: string;
  side: 'LONG' | 'SHORT';
  entryTimeMs: number;
  entryPrice: number;
  qty: number;
  notional: number;
  marginUsed: number;
  leverage: number;
  pnlRealized: number;
  feeAcc: number;
  fundingAcc: number;
  signalType: string | null;
  signalScore: number | null;
  candidate: StrategySignal['candidate'] | null;
  orderflow: DryRunOrderflowMetrics;
};

type SymbolSession = {
  symbol: string;
  engine: DryRunEngine;
  fundingRate: number;
  lastEventTimestampMs: number;
  lastState: DryRunStateSnapshot;
  lastOrderBook: DryRunOrderBook;
  latestMarkPrice: number;
  lastMarkPrice: number;
  atr: number;
  avgAtr: number;
  priceHistory: number[];
  obi: number;
  volatilityRegime: 'LOW' | 'MEDIUM' | 'HIGH';
  winStreak: number;
  lossStreak: number;
  dynamicLeverage: number;
  stopLossPrice: number | null;
  performance: PerformanceCalculator;
  activeSignal: { type: string; timestampMs: number } | null;
  lastEntryEventTs: number;
  lastHeartbeatTs: number;
  lastDataLogTs: number;
  lastEmptyBookLogTs: number;
  lastPerfTs: number;
  realizedPnl: number;
  feePaid: number;
  fundingPnl: number;
  eventCount: number;
  manualOrders: DryRunOrderRequest[];
  logTail: DryRunEventLog[];
  pendingEntry: PendingEntryContext | null;
  pendingExitReason: string | null;
  tradeSeq: number;
  currentTrade: ActiveTrade | null;
  lastSnapshotLogTs: number;
};

const DEFAULT_TAKER_FEE_RATE = 0.0004;
const DEFAULT_MAINTENANCE_MARGIN_RATE = 0.005;
const DEFAULT_FUNDING_RATE = 0;
const DEFAULT_FUNDING_INTERVAL_MS = 8 * 60 * 60 * 1000;
const DEFAULT_EVENT_INTERVAL_MS = Number(process.env.DRY_RUN_EVENT_INTERVAL_MS || 250);
const DEFAULT_ORDERBOOK_DEPTH = Number(process.env.DRY_RUN_ORDERBOOK_DEPTH || 20);
const DEFAULT_TP_BPS = Number(process.env.DRY_RUN_TP_BPS || 15);
const DEFAULT_STOP_BPS = Number(process.env.DRY_RUN_STOP_BPS || 35);
const DEFAULT_ENTRY_COOLDOWN_MS = Number(process.env.DRY_RUN_ENTRY_COOLDOWN_MS || 5000);
const DEFAULT_HEARTBEAT_INTERVAL_MS = Number(process.env.DRY_RUN_HEARTBEAT_INTERVAL_MS || 10_000);
const CONSOLE_LOG_TAIL_LIMIT = Number(process.env.DRY_RUN_CONSOLE_TAIL_LIMIT || 500);
const ENGINE_LOG_TAIL_LIMIT = Number(process.env.DRY_RUN_ENGINE_TAIL_LIMIT || 120);
const DEFAULT_WIN_STREAK_MULT = Number(process.env.DRY_RUN_WIN_STREAK_MULT || 0.06);
const DEFAULT_LOSS_STREAK_DIV = Number(process.env.DRY_RUN_LOSS_STREAK_DIV || 0.25);
const DEFAULT_MARTINGALE_FACTOR = Number(process.env.DRY_RUN_MARTINGALE_FACTOR || 1.2);
const DEFAULT_MARTINGALE_MAX = Number(process.env.DRY_RUN_MARTINGALE_MAX || 3);
const DEFAULT_MAX_NOTIONAL = Number(process.env.DRY_RUN_MAX_NOTIONAL_USDT || 5000);
const DEFAULT_STOP_ATR_MULT = Number(process.env.DRY_RUN_STOP_ATR_MULT || 1.4);
const DEFAULT_STOP_VOL_FACTOR = Number(process.env.DRY_RUN_STOP_VOL_FACTOR || 0.2);
const DEFAULT_STOP_OBI_FACTOR = Number(process.env.DRY_RUN_STOP_OBI_FACTOR || 0.4);
const DEFAULT_STOP_MIN_DIST = Number(process.env.DRY_RUN_STOP_MIN_DIST || 0.5);
const DEFAULT_STOP_MAX_DIST = Number(process.env.DRY_RUN_STOP_MAX_DIST || 50);
const DEFAULT_ATR_WINDOW = Number(process.env.DRY_RUN_ATR_WINDOW || 14);
const DEFAULT_LARGE_LOSS_ALERT = Number(process.env.DRY_RUN_LARGE_LOSS_USDT || 500);
const DEFAULT_LIMIT_STRATEGY = String(process.env.DRY_RUN_LIMIT_STRATEGY || 'MARKET').toUpperCase();
const DEFAULT_PERF_SAMPLE_MS = Number(process.env.DRY_RUN_PERF_SAMPLE_MS || 2000);
const DEFAULT_TRADE_LOG_ENABLED = String(process.env.DRY_RUN_TRADE_LOGS || 'true').toLowerCase();
const DEFAULT_TRADE_LOG_DIR = String(process.env.DRY_RUN_LOG_DIR || path.join(process.cwd(), 'server', 'logs', 'dryrun'));
const DEFAULT_TRADE_LOG_QUEUE = Number(process.env.DRY_RUN_LOG_QUEUE_LIMIT || 10000);
const DEFAULT_TRADE_LOG_DROP = Number(process.env.DRY_RUN_LOG_DROP_THRESHOLD || 2000);
const DEFAULT_SNAPSHOT_LOG_MS = Number(process.env.DRY_RUN_SNAPSHOT_LOG_MS || 30_000);

function parseLimitStrategy(input: string): LimitStrategyMode {
  switch (input) {
    case 'PASSIVE':
      return 'PASSIVE';
    case 'SPLIT':
      return 'SPLIT';
    case 'AGGRESSIVE':
      return 'AGGRESSIVE';
    default:
      return 'MARKET';
  }
}

function finiteOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeSymbol(symbol: string): string {
  return String(symbol || '').trim().toUpperCase();
}

function roundTo(value: number, decimals: number): number {
  const m = Math.pow(10, Math.max(0, decimals));
  return Math.round(value * m) / m;
}

function normalizeSymbols(input: { symbols?: string[]; symbol?: string }): string[] {
  const out: string[] = [];
  if (Array.isArray(input.symbols)) {
    for (const raw of input.symbols) {
      const s = normalizeSymbol(String(raw || ''));
      if (s && !out.includes(s)) out.push(s);
    }
  }
  if (out.length === 0 && input.symbol) {
    const s = normalizeSymbol(input.symbol);
    if (s) out.push(s);
  }
  return out;
}

export class DryRunSessionService {
  private running = false;
  private runId: string | null = null;
  private runCounter = 0;
  private consoleSeq = 0;

  private config: DryRunSessionStatus['config'] = null;
  private symbols: string[] = [];
  private sessions = new Map<string, SymbolSession>();
  private logTail: DryRunConsoleLog[] = [];
  private sizingService: PositionSizingService;
  private stopLossService: DynamicStopLossService;
  private limitStrategy: LimitOrderStrategy;
  private alphaDecay = new AlphaDecayAnalyzer();
  private readonly alertService?: AlertService;
  private readonly sessionStore: SessionStore;
  private readonly tradeLogger?: DryRunTradeLogger;
  private readonly tradeLogEnabled: boolean;

  constructor(alertService?: AlertService) {
    const sizingConfig: DynamicSizingConfig = {
      baseLeverage: 10,
      winStreakMultiplier: DEFAULT_WIN_STREAK_MULT,
      lossStreakDivisor: DEFAULT_LOSS_STREAK_DIV,
      martingaleFactor: DEFAULT_MARTINGALE_FACTOR,
      martingaleMaxSteps: DEFAULT_MARTINGALE_MAX,
      marginHealthLeverageFactor: 2,
      minLeverage: 1,
      maxLeverage: 50,
      maxPositionNotionalUsdt: DEFAULT_MAX_NOTIONAL,
    };
    const stopConfig: DynamicStopLossConfig = {
      baseAtrMultiplier: DEFAULT_STOP_ATR_MULT,
      volatilityAdjustmentFactor: DEFAULT_STOP_VOL_FACTOR,
      obiAdjustmentFactor: DEFAULT_STOP_OBI_FACTOR,
      minStopDistance: DEFAULT_STOP_MIN_DIST,
      maxStopDistance: DEFAULT_STOP_MAX_DIST,
    };

    this.sizingService = new PositionSizingService(sizingConfig);
    this.stopLossService = new DynamicStopLossService(stopConfig);
    this.limitStrategy = new LimitOrderStrategy({
      mode: parseLimitStrategy(DEFAULT_LIMIT_STRATEGY),
      splitLevels: 3,
      passiveOffsetBps: 2,
      maxSlices: 4,
    });
    this.alertService = alertService;
    this.sessionStore = new SessionStore();
    this.tradeLogEnabled = !['false', '0', 'no'].includes(DEFAULT_TRADE_LOG_ENABLED);
    if (this.tradeLogEnabled) {
      this.tradeLogger = new DryRunTradeLogger({
        dir: DEFAULT_TRADE_LOG_DIR,
        queueLimit: finiteOr(DEFAULT_TRADE_LOG_QUEUE, 10000),
        dropHaltThreshold: finiteOr(DEFAULT_TRADE_LOG_DROP, 2000),
        onDropSpike: (count) => {
          this.addConsoleLog('WARN', null, `Dry Run log backlog dropped ${count} events`, Date.now());
        },
      });
    }
  }

  start(input: DryRunSessionStartInput): DryRunSessionStatus {
    const symbols = normalizeSymbols(input);
    if (symbols.length === 0) {
      throw new Error('symbols_required');
    }

    const walletBalanceStartUsdt = finiteOr(input.walletBalanceStartUsdt, 5000);
    const initialMarginUsdt = finiteOr(input.initialMarginUsdt, 200);
    const leverage = finiteOr(input.leverage, 10);

    if (!(walletBalanceStartUsdt > 0)) throw new Error('wallet_balance_start_must_be_positive');
    if (!(initialMarginUsdt > 0)) throw new Error('initial_margin_must_be_positive');
    if (!(leverage > 0)) throw new Error('leverage_must_be_positive');

    this.runCounter += 1;
    const runIdBase = String(input.runId || `dryrun-${this.runCounter}`);
    const takerFeeRate = finiteOr(input.takerFeeRate, DEFAULT_TAKER_FEE_RATE);
    const maintenanceMarginRate = finiteOr(input.maintenanceMarginRate, DEFAULT_MAINTENANCE_MARGIN_RATE);
    const fundingIntervalMs = Math.max(1, Math.trunc(finiteOr(input.fundingIntervalMs, DEFAULT_FUNDING_INTERVAL_MS)));
    const heartbeatIntervalMs = Math.max(1_000, Math.trunc(finiteOr(input.heartbeatIntervalMs, DEFAULT_HEARTBEAT_INTERVAL_MS)));
    const debugAggressiveEntry = Boolean(input.debugAggressiveEntry);

    this.running = true;
    this.runId = runIdBase;
    this.symbols = [...symbols];
    this.sessions.clear();
    this.logTail = [];
    this.consoleSeq = 0;
    this.alphaDecay = new AlphaDecayAnalyzer();

    this.config = {
      walletBalanceStartUsdt,
      initialMarginUsdt,
      leverage,
      takerFeeRate,
      maintenanceMarginRate,
      fundingIntervalMs,
      heartbeatIntervalMs,
      debugAggressiveEntry,
    };

    this.sizingService = new PositionSizingService({
      baseLeverage: leverage,
      winStreakMultiplier: DEFAULT_WIN_STREAK_MULT,
      lossStreakDivisor: DEFAULT_LOSS_STREAK_DIV,
      martingaleFactor: DEFAULT_MARTINGALE_FACTOR,
      martingaleMaxSteps: DEFAULT_MARTINGALE_MAX,
      marginHealthLeverageFactor: 2,
      minLeverage: 1,
      maxLeverage: Math.max(leverage, 50),
      maxPositionNotionalUsdt: DEFAULT_MAX_NOTIONAL,
    });

    for (const symbol of this.symbols) {
      const fundingRate = Number.isFinite(input.fundingRates?.[symbol] as number)
        ? Number(input.fundingRates?.[symbol])
        : finiteOr(input.fundingRate, DEFAULT_FUNDING_RATE);

      const cfg: DryRunConfig = {
        runId: `${runIdBase}-${symbol}`,
        walletBalanceStartUsdt,
        initialMarginUsdt,
        leverage,
        takerFeeRate,
        maintenanceMarginRate,
        fundingRate,
        fundingIntervalMs,
        proxy: {
          mode: 'backend-proxy',
          restBaseUrl: 'https://fapi.binance.com',
          marketWsBaseUrl: 'wss://fstream.binance.com/stream',
        },
      };

      const engine = new DryRunEngine(cfg);
      const lastState = engine.getStateSnapshot();
      this.sessions.set(symbol, {
        symbol,
        engine,
        fundingRate,
        lastEventTimestampMs: 0,
        lastState,
        lastOrderBook: { bids: [], asks: [] },
        latestMarkPrice: 0,
        lastMarkPrice: 0,
        atr: 0,
        avgAtr: 0,
        priceHistory: [],
        obi: 0,
        volatilityRegime: 'MEDIUM',
        winStreak: 0,
        lossStreak: 0,
        dynamicLeverage: leverage,
        stopLossPrice: null,
        performance: new PerformanceCalculator(walletBalanceStartUsdt),
        activeSignal: null,
        lastEntryEventTs: 0,
        lastHeartbeatTs: 0,
        lastDataLogTs: 0,
        lastEmptyBookLogTs: 0,
        lastPerfTs: 0,
        realizedPnl: 0,
        feePaid: 0,
        fundingPnl: 0,
        eventCount: 0,
        manualOrders: [],
        logTail: [],
        pendingEntry: null,
        pendingExitReason: null,
        tradeSeq: 0,
        currentTrade: null,
        lastSnapshotLogTs: 0,
      });
    }

    this.addConsoleLog('INFO', null, `Dry Run Initialized with pairs: [${this.symbols.join(', ')}]`, 0);
    for (const symbol of this.symbols) {
      this.addConsoleLog('INFO', symbol, `Session ready. Funding rate=${this.sessions.get(symbol)?.fundingRate ?? 0}`, 0);
    }

    return this.getStatus();
  }

  stop(): DryRunSessionStatus {
    if (this.running) {
      this.addConsoleLog('INFO', null, 'Dry Run stopped by user.', 0);
    }
    this.running = false;
    return this.getStatus();
  }

  reset(): DryRunSessionStatus {
    this.running = false;
    this.runId = null;
    this.symbols = [];
    this.config = null;
    this.sessions.clear();
    this.logTail = [];
    this.consoleSeq = 0;
    this.alphaDecay = new AlphaDecayAnalyzer();
    return this.getStatus();
  }

  async saveSession(sessionId?: string): Promise<void> {
    if (!this.runId) {
      throw new Error('dry_run_not_initialized');
    }
    const id = sessionId || this.runId;
    const payload = {
      runId: this.runId,
      config: this.config,
      symbols: this.symbols,
      status: this.getStatus(),
      sessions: Array.from(this.sessions.values()).map((session) => ({
        symbol: session.symbol,
        lastState: session.lastState,
        latestMarkPrice: session.latestMarkPrice,
        lastMarkPrice: session.lastMarkPrice,
        atr: session.atr,
        avgAtr: session.avgAtr,
        priceHistory: session.priceHistory,
        obi: session.obi,
        volatilityRegime: session.volatilityRegime,
        winStreak: session.winStreak,
        lossStreak: session.lossStreak,
        dynamicLeverage: session.dynamicLeverage,
        stopLossPrice: session.stopLossPrice,
        activeSignal: session.activeSignal,
        performance: session.performance.getMetrics(),
        realizedPnl: session.realizedPnl,
        feePaid: session.feePaid,
        fundingPnl: session.fundingPnl,
        eventCount: session.eventCount,
        lastEventTimestampMs: session.lastEventTimestampMs,
      })),
    };
    await this.sessionStore.save(id, payload);
  }

  async loadSession(sessionId: string): Promise<DryRunSessionStatus> {
    const stored = await this.sessionStore.load(sessionId);
    if (!stored) {
      throw new Error('dry_run_session_not_found');
    }
    const payload: any = stored.payload;
    if (!payload?.config || !Array.isArray(payload?.symbols)) {
      throw new Error('dry_run_session_invalid');
    }

    this.running = false;
    const config = payload.config as NonNullable<DryRunSessionStatus['config']>;
    this.runId = payload.runId || sessionId;
    this.symbols = [...payload.symbols];
    this.config = config;
    this.sessions.clear();

    for (const symbol of this.symbols) {
      const sessionSnapshot = payload.sessions?.find((s: any) => s.symbol === symbol);
      const cfg: DryRunConfig = {
        runId: `${this.runId}-${symbol}`,
        walletBalanceStartUsdt: config.walletBalanceStartUsdt,
        initialMarginUsdt: config.initialMarginUsdt,
        leverage: config.leverage,
        takerFeeRate: config.takerFeeRate,
        maintenanceMarginRate: config.maintenanceMarginRate,
        fundingRate: 0,
        fundingIntervalMs: config.fundingIntervalMs,
        proxy: {
          mode: 'backend-proxy',
          restBaseUrl: 'https://fapi.binance.com',
          marketWsBaseUrl: 'wss://fstream.binance.com/stream',
        },
      };
      const engine = new DryRunEngine(cfg);
      if (sessionSnapshot?.lastState) {
        engine.restoreState(sessionSnapshot.lastState);
      }
      const perf = new PerformanceCalculator(config.walletBalanceStartUsdt);
      if (sessionSnapshot?.performance) {
        perf.restore(sessionSnapshot.performance);
      }
      this.sessions.set(symbol, {
        symbol,
        engine,
        fundingRate: 0,
        lastEventTimestampMs: sessionSnapshot?.lastEventTimestampMs || 0,
        lastState: sessionSnapshot?.lastState || engine.getStateSnapshot(),
        lastOrderBook: { bids: [], asks: [] },
        latestMarkPrice: sessionSnapshot?.latestMarkPrice || 0,
        lastMarkPrice: sessionSnapshot?.lastMarkPrice || 0,
        atr: sessionSnapshot?.atr || 0,
        avgAtr: sessionSnapshot?.avgAtr || 0,
        priceHistory: sessionSnapshot?.priceHistory || [],
        obi: sessionSnapshot?.obi || 0,
        volatilityRegime: sessionSnapshot?.volatilityRegime || 'MEDIUM',
        winStreak: sessionSnapshot?.winStreak || 0,
        lossStreak: sessionSnapshot?.lossStreak || 0,
        dynamicLeverage: sessionSnapshot?.dynamicLeverage || config.leverage,
        stopLossPrice: sessionSnapshot?.stopLossPrice ?? null,
        performance: perf,
        activeSignal: sessionSnapshot?.activeSignal ?? null,
        lastEntryEventTs: 0,
        lastHeartbeatTs: 0,
        lastDataLogTs: 0,
        lastEmptyBookLogTs: 0,
        lastPerfTs: 0,
        realizedPnl: sessionSnapshot?.realizedPnl || 0,
        feePaid: sessionSnapshot?.feePaid || 0,
        fundingPnl: sessionSnapshot?.fundingPnl || 0,
        eventCount: sessionSnapshot?.eventCount || 0,
        manualOrders: [],
        logTail: [],
        pendingEntry: null,
        pendingExitReason: null,
        tradeSeq: 0,
        currentTrade: null,
        lastSnapshotLogTs: 0,
      });
    }

    return this.getStatus();
  }

  async listSessions(): Promise<string[]> {
    return this.sessionStore.list();
  }

  getActiveSymbols(): string[] {
    return this.running ? [...this.symbols] : [];
  }

  isTrackingSymbol(symbol: string): boolean {
    const normalized = normalizeSymbol(symbol);
    return this.running && this.sessions.has(normalized);
  }

  submitManualTestOrder(symbol: string, side: 'BUY' | 'SELL' = 'BUY'): DryRunSessionStatus {
    const normalized = normalizeSymbol(symbol);
    const session = this.sessions.get(normalized);
    if (!this.running || !session || !this.config) {
      throw new Error('dry_run_not_running_for_symbol');
    }

    const referencePrice = session.latestMarkPrice > 0
      ? session.latestMarkPrice
      : (session.lastState.position?.entryPrice || 1);
    const qty = roundTo((this.config.initialMarginUsdt * this.config.leverage) / referencePrice, 6);
    if (!(qty > 0)) {
      throw new Error('manual_test_qty_invalid');
    }

    session.manualOrders.push({
      side,
      type: 'MARKET',
      qty,
      timeInForce: 'IOC',
      reduceOnly: false,
    });

    session.pendingEntry = {
      reason: 'MANUAL_TEST',
      signalType: null,
      signalScore: null,
      candidate: null,
      orderflow: this.buildOrderflowMetrics(undefined, session),
      market: this.buildMarketMetrics({ price: referencePrice }, session),
      timestampMs: Date.now(),
      leverage: this.config.leverage,
    };

    this.addConsoleLog('INFO', normalized, `Manual test order queued: ${side} ${qty}`, session.lastEventTimestampMs);
    return this.getStatus();
  }

  submitStrategySignal(symbol: string, signal: StrategySignal, timestampMs?: number): void {
    const normalized = normalizeSymbol(symbol);
    const session = this.sessions.get(normalized);
    if (!this.running || !session || !this.config) return;

    // Only process valid signals with a score
    if (!signal.signal || !signal.candidate || signal.score < 50) return;

    // Determine side based on signal type
    let side: 'BUY' | 'SELL' | null = null;
    if (signal.signal.includes('LONG')) side = 'BUY';
    if (signal.signal.includes('SHORT')) side = 'SELL';

    if (!side) return;

    const signalTs = Number.isFinite(timestampMs as number) ? Number(timestampMs) : Date.now();
    const orderflow = this.buildOrderflowMetrics(signal.orderflow, session);
    const market = this.buildMarketMetrics(signal.market, session);
    this.logTradeEvent({
      type: 'SIGNAL',
      runId: this.getRunId(),
      symbol: normalized,
      timestampMs: signalTs,
      side: side === 'BUY' ? 'LONG' : 'SHORT',
      signalType: signal.signal,
      score: signal.score,
      vetoReason: signal.vetoReason,
      candidate: signal.candidate,
      orderflow,
      boost: signal.boost,
      market,
    });

    // Avoid duplicate entries if already in a position
    if (session.lastState.position && session.lastState.position.side !== (side === 'BUY' ? 'LONG' : 'SHORT')) {
      // Optional: Close opposite position? For now, we stick to simple entry.
    }
    if (session.lastState.position) {
      // Already positioned. Ignore new entry signal for now unless it's a flip (not implemented yet).
      return;
    }

    // Calculate Quantity with dynamic sizing
    const referencePrice = signal.candidate.entryPrice;
    if (referencePrice <= 0) return;

    const sizing = this.sizingService.compute({
      walletBalanceUsdt: session.lastState.walletBalance,
      baseMarginUsdt: this.config.initialMarginUsdt,
      markPrice: referencePrice,
      winStreak: session.winStreak,
      lossStreak: session.lossStreak,
      marginHealth: session.lastState.marginHealth,
    });

    if (!(sizing.quantity > 0)) return;
    const qty = roundTo(sizing.quantity, 6);
    session.dynamicLeverage = sizing.leverage;
    session.engine.setLeverageOverride(sizing.leverage);

    const entryOrders = this.limitStrategy.buildEntryOrders({
      side,
      qty,
      markPrice: referencePrice,
      orderBook: session.lastOrderBook,
      urgency: Math.min(1, signal.score / 100),
    });

    for (const order of entryOrders) {
      session.manualOrders.push(order);
    }

    session.activeSignal = { type: signal.signal, timestampMs: signalTs };
    this.alphaDecay.recordSignal(normalized, signal.signal, signalTs);

    session.pendingEntry = {
      reason: 'STRATEGY_SIGNAL',
      signalType: signal.signal,
      signalScore: signal.score,
      candidate: signal.candidate,
      orderflow,
      boost: signal.boost,
      market,
      timestampMs: signalTs,
      leverage: sizing.leverage,
    };

    this.addConsoleLog('INFO', normalized, `Strategy Signal Executed: ${signal.signal} (${side} ${qty} @ ~${referencePrice})`, session.lastEventTimestampMs);
  }

  ingestDepthEvent(input: {
    symbol: string;
    eventTimestampMs: number;
    orderBook: DryRunOrderBook;
    markPrice?: number;
  }): DryRunSessionStatus | null {
    if (!this.running || !this.config) return null;

    const symbol = normalizeSymbol(input.symbol);
    const session = this.sessions.get(symbol);
    if (!session) return null;

    const eventTimestampMs = Number(input.eventTimestampMs);
    if (!Number.isFinite(eventTimestampMs) || eventTimestampMs <= 0) return null;
    if (session.lastEventTimestampMs > 0 && eventTimestampMs <= session.lastEventTimestampMs) return null;
    if (session.lastEventTimestampMs > 0 && (eventTimestampMs - session.lastEventTimestampMs) < DEFAULT_EVENT_INTERVAL_MS) {
      return null;
    }

    const book = this.normalizeBook(input.orderBook);
    session.lastOrderBook = book;
    if (book.bids.length === 0 || book.asks.length === 0) {
      if (session.lastEmptyBookLogTs === 0 || (eventTimestampMs - session.lastEmptyBookLogTs) >= this.config.heartbeatIntervalMs) {
        this.addConsoleLog('WARN', symbol, 'Orderbook empty on one side. Waiting for full depth.', eventTimestampMs);
        session.lastEmptyBookLogTs = eventTimestampMs;
      }
      return null;
    }

    const bestBid = book.bids[0].price;
    const bestAsk = book.asks[0].price;
    const resolvedMarkPriceRaw = Number.isFinite(input.markPrice as number) && Number(input.markPrice) > 0
      ? Number(input.markPrice)
      : (bestBid + bestAsk) / 2;
    const markPrice = roundTo(resolvedMarkPriceRaw, 8);
    if (!(markPrice > 0)) return null;

    this.updateDerivedMetrics(session, book, markPrice);

    const prevPosition = session.lastState.position;
    const orders = this.buildDeterministicOrders(session, markPrice, eventTimestampMs);
    const event: DryRunEventInput = {
      timestampMs: eventTimestampMs,
      markPrice,
      orderBook: book,
      orders,
    };

    const out = session.engine.processEvent(event);

    const lastCheckMs = session.lastHeartbeatTs > 0 ? eventTimestampMs - session.lastHeartbeatTs : eventTimestampMs;
    session.lastEventTimestampMs = eventTimestampMs;
    session.lastState = out.state;
    session.lastMarkPrice = session.latestMarkPrice;
    session.latestMarkPrice = markPrice;
    session.realizedPnl += out.log.realizedPnl;
    session.feePaid += out.log.fee;
    session.fundingPnl += out.log.fundingImpact;
    session.eventCount += 1;
    session.logTail.push(out.log);
    if (session.logTail.length > ENGINE_LOG_TAIL_LIMIT) {
      session.logTail = session.logTail.slice(session.logTail.length - ENGINE_LOG_TAIL_LIMIT);
    }

    if (out.log.realizedPnl !== 0) {
      if (out.log.realizedPnl > 0) {
        session.winStreak += 1;
        session.lossStreak = 0;
      } else {
        session.lossStreak += 1;
        session.winStreak = 0;
      }
      const equity = session.lastState.walletBalance + this.computeUnrealizedPnl(session);
      session.performance.recordTrade({
        realizedPnl: out.log.realizedPnl,
        equity,
      });
      session.lastPerfTs = eventTimestampMs;

      if (this.alertService && out.log.realizedPnl <= -DEFAULT_LARGE_LOSS_ALERT) {
        this.alertService.send('LARGE_LOSS', `${symbol}: realized PnL ${roundTo(out.log.realizedPnl, 2)} USDT`, 'HIGH');
      }
    }

    if (out.log.realizedPnl === 0) {
      const equity = session.lastState.walletBalance + this.computeUnrealizedPnl(session);
      if (session.lastPerfTs === 0 || (eventTimestampMs - session.lastPerfTs) >= DEFAULT_PERF_SAMPLE_MS) {
        session.performance.recordEquity(equity);
        session.lastPerfTs = eventTimestampMs;
      }
    }

    if (prevPosition && !out.state.position && session.activeSignal) {
      this.alphaDecay.recordExit(symbol, eventTimestampMs);
      session.activeSignal = null;
    }

    if (session.lastDataLogTs === 0 || (eventTimestampMs - session.lastDataLogTs) >= 2_000) {
      this.addConsoleLog('INFO', symbol, `Market Data Received: ${symbol} @ ${markPrice}`, eventTimestampMs);
      session.lastDataLogTs = eventTimestampMs;
    }

    if (session.lastHeartbeatTs === 0 || (eventTimestampMs - session.lastHeartbeatTs) >= this.config.heartbeatIntervalMs) {
      const seconds = Math.max(1, Math.floor(lastCheckMs / 1000));
      this.addConsoleLog(
        'INFO',
        symbol,
        `Running... Scanning ${symbol}. Current Price: ${markPrice}. Last Check: ${seconds}s ago.`,
        eventTimestampMs
      );
      session.lastHeartbeatTs = eventTimestampMs;
    }

    if (out.log.fundingImpact !== 0) {
      this.addConsoleLog('INFO', symbol, `Funding applied: ${roundTo(out.log.fundingImpact, 8)} USDT`, eventTimestampMs);
    }

    if (out.log.orderResults.length > 0) {
      for (const order of out.log.orderResults) {
        this.addConsoleLog(
          'INFO',
          symbol,
          `Order ${order.type}/${order.side} ${order.status} fill=${roundTo(order.filledQty, 6)}/${roundTo(order.requestedQty, 6)} avg=${roundTo(order.avgFillPrice, 4)}`,
          eventTimestampMs
        );
      }
    }

    if (out.log.liquidationTriggered) {
      this.addConsoleLog('WARN', symbol, 'Liquidation triggered. Position force-closed.', eventTimestampMs);
    }

    this.handleTradeTransitions(session, prevPosition, out.log, out.state.position, eventTimestampMs);
    this.maybeLogSnapshot(session, eventTimestampMs);

    return this.getStatus();
  }

  getStatus(): DryRunSessionStatus {
    const perSymbol: Record<string, DryRunSymbolStatus> = {};

    let totalEquity = 0;
    let walletBalance = 0;
    let unrealizedPnl = 0;
    let realizedPnl = 0;
    let feePaid = 0;
    let fundingPnl = 0;
    let marginHealth = 0;
    let marginHealthInit = false;
    let totalWins = 0;
    let totalLosses = 0;
    let totalPnL = 0;
    let maxDrawdown = 0;
    let sharpeSum = 0;
    let sharpeCount = 0;

    for (const symbol of this.symbols) {
      const session = this.sessions.get(symbol);
      if (!session) continue;

      const symbolWallet = session.lastState.walletBalance;
      const symbolUnrealized = this.computeUnrealizedPnl(session);
      const symbolEquity = symbolWallet + symbolUnrealized;
      const symbolMarginHealth = session.lastState.marginHealth;

      totalEquity += symbolEquity;
      walletBalance += symbolWallet;
      unrealizedPnl += symbolUnrealized;
      realizedPnl += session.realizedPnl;
      feePaid += session.feePaid;
      fundingPnl += session.fundingPnl;
      if (!marginHealthInit) {
        marginHealth = symbolMarginHealth;
        marginHealthInit = true;
      } else {
        marginHealth = Math.min(marginHealth, symbolMarginHealth);
      }

      const perf = session.performance.getMetrics();
      totalWins += perf.winCount;
      totalLosses += perf.lossCount;
      totalPnL += perf.totalPnL;
      maxDrawdown = Math.max(maxDrawdown, perf.maxDrawdown);
      if (perf.sharpeRatio !== 0) {
        sharpeSum += perf.sharpeRatio;
        sharpeCount += 1;
      }

      perSymbol[symbol] = {
        symbol,
        metrics: {
          markPrice: session.latestMarkPrice,
          totalEquity: roundTo(symbolEquity, 8),
          walletBalance: roundTo(symbolWallet, 8),
          unrealizedPnl: roundTo(symbolUnrealized, 8),
          realizedPnl: roundTo(session.realizedPnl, 8),
          feePaid: roundTo(session.feePaid, 8),
          fundingPnl: roundTo(session.fundingPnl, 8),
          marginHealth: roundTo(symbolMarginHealth, 8),
        },
        performance: perf,
        risk: {
          winStreak: session.winStreak,
          lossStreak: session.lossStreak,
          dynamicLeverage: roundTo(session.dynamicLeverage, 2),
          stopLossPrice: session.stopLossPrice ? roundTo(session.stopLossPrice, 6) : null,
          liquidationRisk: this.computeLiquidationRisk(session, symbolMarginHealth),
        },
        position: session.lastState.position
          ? {
            side: session.lastState.position.side,
            qty: session.lastState.position.qty,
            entryPrice: session.lastState.position.entryPrice,
            markPrice: session.latestMarkPrice,
            liqPrice: null,
          }
          : null,
        openLimitOrders: session.lastState.openLimitOrders,
        lastEventTimestampMs: session.lastEventTimestampMs,
        eventCount: session.eventCount,
      };
    }

    return {
      running: this.running,
      runId: this.runId,
      symbols: [...this.symbols],
      config: this.config,
      summary: {
        totalEquity: roundTo(totalEquity, 8),
        walletBalance: roundTo(walletBalance, 8),
        unrealizedPnl: roundTo(unrealizedPnl, 8),
        realizedPnl: roundTo(realizedPnl, 8),
        feePaid: roundTo(feePaid, 8),
        fundingPnl: roundTo(fundingPnl, 8),
        marginHealth: roundTo(marginHealthInit ? marginHealth : 0, 8),
        performance: {
          totalPnL: roundTo(totalPnL, 8),
          winCount: totalWins,
          lossCount: totalLosses,
          totalTrades: totalWins + totalLosses,
          winRate: totalWins + totalLosses > 0 ? (totalWins / (totalWins + totalLosses)) * 100 : 0,
          maxDrawdown,
          sharpeRatio: sharpeCount > 0 ? sharpeSum / sharpeCount : 0,
          pnlCurve: [],
        },
      },
      perSymbol,
      logTail: [...this.logTail],
      alphaDecay: this.alphaDecay.getSummary(),
    };
  }

  private normalizeBook(orderBook: DryRunOrderBook): DryRunOrderBook {
    const depth = Math.max(1, Math.trunc(DEFAULT_ORDERBOOK_DEPTH));
    const normalize = (levels: Array<{ price: number; qty: number }>, asc: boolean) => {
      const sorted = levels
        .filter((l) => Number.isFinite(l.price) && l.price > 0 && Number.isFinite(l.qty) && l.qty > 0)
        .map((l) => ({ price: Number(l.price), qty: Number(l.qty) }))
        .sort((a, b) => asc ? a.price - b.price : b.price - a.price);
      return sorted.slice(0, depth);
    };

    return {
      bids: normalize(orderBook.bids || [], false),
      asks: normalize(orderBook.asks || [], true),
    };
  }

  private buildDeterministicOrders(session: SymbolSession, markPrice: number, eventTimestampMs: number): DryRunOrderRequest[] {
    if (!this.config) {
      return [];
    }

    if (session.manualOrders.length > 0) {
      return [session.manualOrders.shift() as DryRunOrderRequest];
    }

    const state = session.lastState;
    const orders: DryRunOrderRequest[] = [];

    // Disable internal random entry if we are waiting for strategy signals?
    // Actually, we can keep debugAggressiveEntry as a "noise" generator if explicitly enabled,
    // but default should be OFF for strategy replication.
    const entryCooldownMs = this.config.debugAggressiveEntry
      ? Math.max(500, Math.trunc(DEFAULT_ENTRY_COOLDOWN_MS / 2))
      : Math.max(0, Math.trunc(DEFAULT_ENTRY_COOLDOWN_MS));
    const hasOpenLimits = state.openLimitOrders.length > 0;

    if (!state.position && !hasOpenLimits) {
      if (session.lastEntryEventTs === 0 || (eventTimestampMs - session.lastEntryEventTs) >= entryCooldownMs) {
        // Only trigger internal random entry if debugAggressiveEntry is TRUE
        if (this.config.debugAggressiveEntry) {
          const side: 'BUY' | 'SELL' = this.resolveEntrySide(session, markPrice);
          const sizing = this.sizingService.compute({
            walletBalanceUsdt: session.lastState.walletBalance,
            baseMarginUsdt: this.config.initialMarginUsdt,
            markPrice,
            winStreak: session.winStreak,
            lossStreak: session.lossStreak,
            marginHealth: session.lastState.marginHealth,
          });
          const qty = roundTo(Math.max(0, sizing.quantity), 6);
          session.dynamicLeverage = sizing.leverage;
          session.engine.setLeverageOverride(sizing.leverage);
          if (qty > 0) {
            const entryOrders = this.limitStrategy.buildEntryOrders({
              side,
              qty,
              markPrice,
              orderBook: session.lastOrderBook,
              urgency: 0.3,
            });
            orders.push(...entryOrders);
            session.lastEntryEventTs = eventTimestampMs;
            if (!session.pendingEntry) {
              session.pendingEntry = {
                reason: 'DEBUG_AGGRESSIVE_ENTRY',
                signalType: null,
                signalScore: null,
                candidate: null,
                orderflow: this.buildOrderflowMetrics(undefined, session),
                market: this.buildMarketMetrics({ price: markPrice, atr: session.atr, avgAtr: session.avgAtr }, session),
                timestampMs: eventTimestampMs,
                leverage: sizing.leverage,
              };
            }
          }
        }
      }
      return orders;
    }

    if (!state.position) {
      return orders;
    }

    const position = state.position;
    if (!hasOpenLimits) {
      const tpBps = Math.max(1, DEFAULT_TP_BPS);
      const isLong = position.side === 'LONG';
      const multiplier = isLong ? (1 + (tpBps / 10000)) : (1 - (tpBps / 10000));
      const tpPrice = roundTo(position.entryPrice * multiplier, 8);
      const closeSide: 'BUY' | 'SELL' = isLong ? 'SELL' : 'BUY';
      orders.push({
        side: closeSide,
        type: 'LIMIT',
        qty: roundTo(position.qty, 6),
        price: tpPrice,
        timeInForce: 'GTC',
        reduceOnly: true,
      });
      session.pendingExitReason = 'TAKE_PROFIT_LIMIT';
      return orders;
    }

    const isLong = position.side === 'LONG';
    const dynamicStop = this.stopLossService.calculateStopPrice({
      side: position.side,
      markPrice,
      atr: session.atr || Math.max(0.5, (Math.abs(markPrice - position.entryPrice) * 0.02)),
      volatilityRegime: session.volatilityRegime,
      obiDivergence: session.obi,
      sweepStrength: 0,
    });
    session.stopLossPrice = dynamicStop || null;

    if (dynamicStop > 0) {
      const stopTriggered = isLong ? markPrice <= dynamicStop : markPrice >= dynamicStop;
      if (stopTriggered) {
        const closeSide: 'BUY' | 'SELL' = isLong ? 'SELL' : 'BUY';
        orders.push({
          side: closeSide,
          type: 'MARKET',
          qty: roundTo(position.qty, 6),
          timeInForce: 'IOC',
          reduceOnly: true,
        });
        session.pendingExitReason = 'STOP_LOSS_DYNAMIC';
      }
      return orders;
    }

    const stopBps = Math.max(1, DEFAULT_STOP_BPS);
    const pnlBps = isLong
      ? ((markPrice - position.entryPrice) / position.entryPrice) * 10000
      : ((position.entryPrice - markPrice) / position.entryPrice) * 10000;
    if (pnlBps <= -stopBps) {
      const closeSide: 'BUY' | 'SELL' = isLong ? 'SELL' : 'BUY';
      orders.push({
        side: closeSide,
        type: 'MARKET',
        qty: roundTo(position.qty, 6),
        timeInForce: 'IOC',
        reduceOnly: true,
      });
      session.pendingExitReason = 'STOP_LOSS_FIXED';
    }

    return orders;
  }

  private updateDerivedMetrics(session: SymbolSession, book: DryRunOrderBook, markPrice: number): void {
    session.priceHistory.push(markPrice);
    if (session.priceHistory.length > Math.max(DEFAULT_ATR_WINDOW * 4, 40)) {
      session.priceHistory = session.priceHistory.slice(session.priceHistory.length - Math.max(DEFAULT_ATR_WINDOW * 4, 40));
    }

    if (session.priceHistory.length >= 2) {
      const diffs: number[] = [];
      for (let i = 1; i < session.priceHistory.length; i += 1) {
        diffs.push(Math.abs(session.priceHistory[i] - session.priceHistory[i - 1]));
      }
      const window = diffs.slice(-DEFAULT_ATR_WINDOW);
      const longWindow = diffs.slice(-Math.max(DEFAULT_ATR_WINDOW * 2, 20));
      session.atr = window.length > 0 ? window.reduce((a, b) => a + b, 0) / window.length : session.atr;
      session.avgAtr = longWindow.length > 0 ? longWindow.reduce((a, b) => a + b, 0) / longWindow.length : session.avgAtr;
    }

    const topLevels = Math.min(10, book.bids.length, book.asks.length);
    let bidVol = 0;
    let askVol = 0;
    for (let i = 0; i < topLevels; i += 1) {
      bidVol += book.bids[i]?.qty ?? 0;
      askVol += book.asks[i]?.qty ?? 0;
    }
    const denom = bidVol + askVol;
    session.obi = denom > 0 ? (bidVol - askVol) / denom : 0;

    const ratio = session.avgAtr > 0 ? session.atr / session.avgAtr : 1;
    session.volatilityRegime = ratio > 1.5 ? 'HIGH' : ratio < 0.7 ? 'LOW' : 'MEDIUM';
  }

  private resolveEntrySide(session: SymbolSession, markPrice: number): 'BUY' | 'SELL' {
    if (session.lastMarkPrice <= 0) {
      return 'BUY';
    }
    return markPrice >= session.lastMarkPrice ? 'BUY' : 'SELL';
  }

  private computeUnrealizedPnl(session: SymbolSession): number {
    if (!session.lastState.position || !(session.latestMarkPrice > 0)) {
      return 0;
    }
    const pos = session.lastState.position;
    if (pos.side === 'LONG') {
      return (session.latestMarkPrice - pos.entryPrice) * pos.qty;
    }
    return (pos.entryPrice - session.latestMarkPrice) * pos.qty;
  }

  private computeLiquidationRisk(session: SymbolSession, marginHealth: number): NonNullable<DryRunSymbolStatus['risk']>['liquidationRisk'] {
    const thresholds = { yellow: 0.3, orange: 0.2, red: 0.1, critical: 0.05 };
    let score: 'GREEN' | 'YELLOW' | 'ORANGE' | 'RED' | 'CRITICAL' = 'GREEN';
    if (marginHealth <= thresholds.critical) score = 'CRITICAL';
    else if (marginHealth <= thresholds.red) score = 'RED';
    else if (marginHealth <= thresholds.orange) score = 'ORANGE';
    else if (marginHealth <= thresholds.yellow) score = 'YELLOW';

    const positionNotional = session.lastState.position
      ? session.lastState.position.qty * (session.latestMarkPrice || 0)
      : 0;
    const fundingImpact = session.fundingRate * positionNotional;
    const volFactor = session.volatilityRegime === 'HIGH' ? 1.4 : session.volatilityRegime === 'LOW' ? 0.8 : 1;
    const baseMs = 5 * 60 * 1000;
    const timeToLiquidationMs = marginHealth > 0
      ? Math.max(0, Math.round(baseMs * (marginHealth / thresholds.yellow) / volFactor))
      : 0;

    return {
      score,
      timeToLiquidationMs,
      fundingRateImpact: roundTo(fundingImpact, 4),
    };
  }

  private handleTradeTransitions(
    session: SymbolSession,
    prevPosition: DryRunStateSnapshot['position'],
    log: DryRunEventLog,
    nextPosition: DryRunStateSnapshot['position'],
    eventTimestampMs: number
  ): void {
    if (!this.tradeLogger || !this.tradeLogEnabled) return;

    const prevSide = prevPosition?.side ?? null;
    const nextSide = nextPosition?.side ?? null;
    const orderResults = Array.isArray(log.orderResults) ? log.orderResults : [];

    let closingRealized = 0;
    let closingFee = 0;
    let closingQty = 0;
    let closingNotional = 0;
    let openingFee = 0;

    if (prevSide) {
      for (const order of orderResults) {
        const fee = Number.isFinite(order.fee) ? Number(order.fee) : 0;
        const realized = Number.isFinite(order.realizedPnl) ? Number(order.realizedPnl) : 0;
        const filledQty = Number.isFinite(order.filledQty) ? Number(order.filledQty) : 0;
        const avgPrice = Number.isFinite(order.avgFillPrice) ? Number(order.avgFillPrice) : 0;
        if (this.isClosingOrder(prevSide, order.side)) {
          closingFee += fee;
          closingRealized += realized;
          if (filledQty > 0 && avgPrice > 0) {
            closingQty += filledQty;
            closingNotional += filledQty * avgPrice;
          }
        } else {
          openingFee += fee;
        }
      }
    } else {
      for (const order of orderResults) {
        const fee = Number.isFinite(order.fee) ? Number(order.fee) : 0;
        openingFee += fee;
      }
    }

    const fundingImpact = Number.isFinite(log.fundingImpact) ? Number(log.fundingImpact) : 0;
    const liquidation = log.liquidationTriggered || orderResults.some((o) => o.reason === 'FORCED_LIQUIDATION');

    if (prevSide && prevPosition && !session.currentTrade) {
      session.currentTrade = this.buildFallbackTradeFromPosition(session, prevPosition, eventTimestampMs);
    }

    if (!prevSide && nextSide && nextPosition) {
      this.openTrade(session, nextPosition, eventTimestampMs, openingFee);
      return;
    }

    if (prevSide && !nextSide) {
      this.applyTradeAcc(session, closingRealized, closingFee, fundingImpact);
      const exitPrice = closingQty > 0 ? closingNotional / closingQty : session.latestMarkPrice;
      const reason = this.resolveExitReason(session, liquidation, closingRealized, null);
      this.closeTrade(session, eventTimestampMs, exitPrice, prevPosition?.qty || 0, reason);
      return;
    }

    if (prevSide && nextSide && nextPosition) {
      const flipped = prevSide !== nextSide;
      if (flipped) {
        this.applyTradeAcc(session, closingRealized, closingFee, fundingImpact);
        const exitPrice = closingQty > 0 ? closingNotional / closingQty : session.latestMarkPrice;
        const reason = this.resolveExitReason(session, liquidation, closingRealized, 'FLIP');
        this.closeTrade(session, eventTimestampMs, exitPrice, prevPosition?.qty || 0, reason);
        this.openTrade(session, nextPosition, eventTimestampMs, openingFee);
        return;
      }

      this.applyTradeAcc(session, closingRealized, closingFee + openingFee, fundingImpact);
      this.updateTradePosition(session, nextPosition);
    }
  }

  private openTrade(
    session: SymbolSession,
    position: NonNullable<DryRunStateSnapshot['position']>,
    eventTimestampMs: number,
    openingFee: number
  ): void {
    const context = session.pendingEntry;
    const leverage = context?.leverage || session.dynamicLeverage || this.config?.leverage || 1;
    const entryPrice = Number(position.entryPrice) || 0;
    const qty = Number(position.qty) || 0;
    const notional = entryPrice * qty;
    const marginUsed = leverage > 0 ? notional / leverage : 0;
    const tradeId = `${this.getRunId()}-${session.symbol}-${++session.tradeSeq}`;
    const orderflow = context?.orderflow || this.buildOrderflowMetrics(undefined, session);

    session.currentTrade = {
      tradeId,
      side: position.side,
      entryTimeMs: eventTimestampMs,
      entryPrice,
      qty,
      notional,
      marginUsed,
      leverage,
      pnlRealized: 0,
      feeAcc: openingFee,
      fundingAcc: 0,
      signalType: context?.signalType ?? null,
      signalScore: context?.signalScore ?? null,
      candidate: context?.candidate ?? null,
      orderflow,
    };

    this.logTradeEvent({
      type: 'ENTRY',
      runId: this.getRunId(),
      symbol: session.symbol,
      timestampMs: eventTimestampMs,
      tradeId,
      side: position.side,
      entryPrice,
      qty,
      notional,
      marginUsed,
      leverage,
      reason: context?.reason || 'UNKNOWN',
      signalType: context?.signalType ?? null,
      signalScore: context?.signalScore ?? null,
      orderflow,
      candidate: context?.candidate ?? null,
    });

    session.pendingEntry = null;
  }

  private closeTrade(
    session: SymbolSession,
    eventTimestampMs: number,
    exitPrice: number,
    qty: number,
    reason: string
  ): void {
    const trade = session.currentTrade || this.buildFallbackTrade(session, eventTimestampMs, qty);
    const realized = trade.pnlRealized;
    const feeUsdt = trade.feeAcc;
    const fundingUsdt = trade.fundingAcc;
    const net = realized - feeUsdt + fundingUsdt;
    const returnPct = trade.marginUsed > 0 ? (net / trade.marginUsed) * 100 : null;
    const rMultiple = this.computeRMultiple(trade, net);

    this.logTradeEvent({
      type: 'EXIT',
      runId: this.getRunId(),
      symbol: session.symbol,
      timestampMs: eventTimestampMs,
      tradeId: trade.tradeId,
      side: trade.side,
      entryTimeMs: trade.entryTimeMs,
      entryPrice: trade.entryPrice,
      exitPrice,
      qty: trade.qty || qty,
      reason,
      durationMs: Math.max(0, eventTimestampMs - trade.entryTimeMs),
      pnl: {
        realizedUsdt: Number(realized.toFixed(8)),
        feeUsdt: Number(feeUsdt.toFixed(8)),
        fundingUsdt: Number(fundingUsdt.toFixed(8)),
        netUsdt: Number(net.toFixed(8)),
        returnPct: returnPct === null ? null : Number(returnPct.toFixed(4)),
        rMultiple: rMultiple === null ? null : Number(rMultiple.toFixed(4)),
      },
      cumulative: this.buildCumulativeSummary(),
      orderflow: trade.orderflow,
      candidate: trade.candidate ?? null,
    });

    session.currentTrade = null;
    session.pendingExitReason = null;
  }

  private updateTradePosition(session: SymbolSession, position: NonNullable<DryRunStateSnapshot['position']>): void {
    if (!session.currentTrade) return;
    const leverage = session.dynamicLeverage || session.currentTrade.leverage || this.config?.leverage || 1;
    const entryPrice = Number(position.entryPrice) || session.currentTrade.entryPrice;
    const qty = Number(position.qty) || session.currentTrade.qty;
    const notional = entryPrice * qty;
    const marginUsed = leverage > 0 ? notional / leverage : session.currentTrade.marginUsed;

    session.currentTrade.side = position.side;
    session.currentTrade.entryPrice = entryPrice;
    session.currentTrade.qty = qty;
    session.currentTrade.notional = notional;
    session.currentTrade.marginUsed = marginUsed;
    session.currentTrade.leverage = leverage;
  }

  private applyTradeAcc(session: SymbolSession, realized: number, fee: number, funding: number): void {
    const trade = session.currentTrade;
    if (!trade) return;
    trade.pnlRealized += realized;
    trade.feeAcc += fee;
    trade.fundingAcc += funding;
  }

  private resolveExitReason(
    session: SymbolSession,
    liquidation: boolean,
    realized: number,
    fallback: string | null
  ): string {
    if (liquidation) return 'LIQUIDATION';
    if (fallback) return fallback;
    if (session.pendingExitReason) return session.pendingExitReason;
    if (realized > 0) return 'TAKE_PROFIT';
    if (realized < 0) return 'STOP_LOSS';
    return 'CLOSE';
  }

  private computeRMultiple(trade: ActiveTrade, net: number): number | null {
    const sl = trade.candidate?.slPrice;
    if (!Number.isFinite(sl) || !(trade.qty > 0)) return null;
    const risk = Math.abs(trade.entryPrice - Number(sl)) * trade.qty;
    if (!(risk > 0)) return null;
    return net / risk;
  }

  private buildFallbackTradeFromPosition(
    session: SymbolSession,
    position: NonNullable<DryRunStateSnapshot['position']>,
    eventTimestampMs: number
  ): ActiveTrade {
    const leverage = session.dynamicLeverage || this.config?.leverage || 1;
    const entryPrice = Number(position.entryPrice) || session.latestMarkPrice || 0;
    const size = Number(position.qty) || 0;
    const notional = entryPrice * size;
    const marginUsed = leverage > 0 ? notional / leverage : 0;
    const tradeId = `${this.getRunId()}-${session.symbol}-${++session.tradeSeq}`;
    return {
      tradeId,
      side: position.side,
      entryTimeMs: eventTimestampMs,
      entryPrice,
      qty: size,
      notional,
      marginUsed,
      leverage,
      pnlRealized: 0,
      feeAcc: 0,
      fundingAcc: 0,
      signalType: null,
      signalScore: null,
      candidate: null,
      orderflow: this.buildOrderflowMetrics(undefined, session),
    };
  }

  private buildFallbackTrade(session: SymbolSession, eventTimestampMs: number, qty: number): ActiveTrade {
    if (session.lastState.position) {
      return this.buildFallbackTradeFromPosition(session, session.lastState.position, eventTimestampMs);
    }
    const leverage = session.dynamicLeverage || this.config?.leverage || 1;
    const entryPrice = session.latestMarkPrice || 0;
    const size = qty || 0;
    const notional = entryPrice * size;
    const marginUsed = leverage > 0 ? notional / leverage : 0;
    const tradeId = `${this.getRunId()}-${session.symbol}-${++session.tradeSeq}`;
    return {
      tradeId,
      side: 'LONG',
      entryTimeMs: eventTimestampMs,
      entryPrice,
      qty: size,
      notional,
      marginUsed,
      leverage,
      pnlRealized: 0,
      feeAcc: 0,
      fundingAcc: 0,
      signalType: null,
      signalScore: null,
      candidate: null,
      orderflow: this.buildOrderflowMetrics(undefined, session),
    };
  }

  private buildCumulativeSummary(): { totalPnL: number; totalTrades: number; winCount: number; winRate: number } {
    const perf = this.getStatus().summary.performance;
    if (!perf) {
      return { totalPnL: 0, totalTrades: 0, winCount: 0, winRate: 0 };
    }
    return {
      totalPnL: Number(perf.totalPnL.toFixed(8)),
      totalTrades: perf.totalTrades,
      winCount: perf.winCount,
      winRate: perf.winRate,
    };
  }

  private maybeLogSnapshot(session: SymbolSession, eventTimestampMs: number): void {
    if (!this.tradeLogger || !this.tradeLogEnabled) return;
    const intervalMs = Math.max(0, Math.trunc(DEFAULT_SNAPSHOT_LOG_MS));
    if (intervalMs === 0) return;
    if (session.lastSnapshotLogTs > 0 && (eventTimestampMs - session.lastSnapshotLogTs) < intervalMs) return;

    const unrealized = this.computeUnrealizedPnl(session);
    const totalEquity = session.lastState.walletBalance + unrealized;
    this.logTradeEvent({
      type: 'SNAPSHOT',
      runId: this.getRunId(),
      symbol: session.symbol,
      timestampMs: eventTimestampMs,
      markPrice: session.latestMarkPrice,
      walletBalance: roundTo(session.lastState.walletBalance, 8),
      totalEquity: roundTo(totalEquity, 8),
      unrealizedPnl: roundTo(unrealized, 8),
      realizedPnl: roundTo(session.realizedPnl, 8),
      feePaid: roundTo(session.feePaid, 8),
      fundingPnl: roundTo(session.fundingPnl, 8),
      marginHealth: roundTo(session.lastState.marginHealth, 8),
      position: session.lastState.position
        ? {
          side: session.lastState.position.side,
          qty: roundTo(session.lastState.position.qty, 6),
          entryPrice: roundTo(session.lastState.position.entryPrice, 8),
        }
        : null,
    });

    session.lastSnapshotLogTs = eventTimestampMs;
  }

  private buildOrderflowMetrics(
    input?: StrategySignal['orderflow'],
    session?: SymbolSession
  ): DryRunOrderflowMetrics {
    const norm = (value: unknown): number | null => {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    };
    return {
      obiWeighted: norm(input?.obiWeighted),
      obiDeep: norm(input?.obiDeep ?? session?.obi),
      deltaZ: norm(input?.deltaZ),
      cvdSlope: norm(input?.cvdSlope),
    };
  }

  private buildMarketMetrics(
    input?: StrategySignal['market'] & { price?: number | null },
    session?: SymbolSession
  ): { price: number | null; atr: number | null; avgAtr: number | null; recentHigh: number | null; recentLow: number | null } {
    const norm = (value: unknown): number | null => {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    };
    return {
      price: norm(input?.price ?? session?.latestMarkPrice),
      atr: norm(input?.atr ?? session?.atr),
      avgAtr: norm(input?.avgAtr ?? session?.avgAtr),
      recentHigh: norm(input?.recentHigh),
      recentLow: norm(input?.recentLow),
    };
  }

  private isClosingOrder(prevSide: 'LONG' | 'SHORT', orderSide: 'BUY' | 'SELL'): boolean {
    return (prevSide === 'LONG' && orderSide === 'SELL') || (prevSide === 'SHORT' && orderSide === 'BUY');
  }

  private logTradeEvent(event: DryRunLogEvent): void {
    if (!this.tradeLogger || !this.tradeLogEnabled) return;
    this.tradeLogger.log(event);
  }

  private getRunId(): string {
    return this.runId || 'dryrun';
  }

  private addConsoleLog(
    level: 'INFO' | 'WARN' | 'ERROR',
    symbol: string | null,
    message: string,
    timestampMs: number
  ): void {
    this.consoleSeq += 1;
    const logItem: DryRunConsoleLog = {
      seq: this.consoleSeq,
      timestampMs: timestampMs > 0 ? timestampMs : Date.now(),
      symbol,
      level,
      message,
    };
    this.logTail.push(logItem);
    if (this.logTail.length > CONSOLE_LOG_TAIL_LIMIT) {
      this.logTail = this.logTail.slice(this.logTail.length - CONSOLE_LOG_TAIL_LIMIT);
    }
  }
}
