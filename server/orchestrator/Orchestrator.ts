import * as path from 'path';
import { ExecutionConnector } from '../connectors/ExecutionConnector';
import { ExecutionEvent } from '../connectors/executionTypes';
import { BinanceExecutor } from '../execution/BinanceExecutor';
import { RiskManager } from '../risk/RiskManager';
import { SymbolActor } from './Actor';
import { DecisionEngine } from './Decision';
import { runGate } from './Gate';
import { OrchestratorLogger } from './Logger';
import { SizingRamp } from './SizingRamp';
import {
  DecisionAction,
  GateConfig,
  GateMode,
  GateResult,
  MetricsEventEnvelope,
  OrchestratorConfig,
  OrchestratorMetricsInput,
  SymbolState,
} from './types';

type ExpectedOrderMeta = { expectedPrice: number | null; sentAtMs: number; tag: 'entry' | 'add' | 'exit' };

type OrderAttemptReason =
  | 'EXEC_DISABLED'
  | 'NOT_READY'
  | 'MISSING_KEYS'
  | 'KILL_SWITCH'
  | 'RISK_BLOCK'
  | 'SIZE_ZERO'
  | 'SENT'
  | 'EXCHANGE_ERROR';

export class Orchestrator {
  private readonly realizedPnlBySymbol = new Map<string, number>();
  private readonly executionSymbols = new Set<string>();
  private readonly actors = new Map<string, SymbolActor>();
  private readonly ramps = new Map<string, SizingRamp>();
  private readonly riskManagers = new Map<string, RiskManager>();
  private readonly expectedOrderMeta = new Map<string, ExpectedOrderMeta>();
  private readonly decisionLedger: any[] = [];
  private readonly stateSnapshots = new Map<string, SymbolState>();
  private readonly executor: BinanceExecutor;
  private readonly logger: OrchestratorLogger;

  private killSwitch = false;
  private replayMode = false;

  private capitalSettings = {
    leverage: 10,
    totalMarginBudgetUsdt: 0,
    pairInitialMargins: {} as Record<string, number>,
  };

  constructor(
    private readonly connector: ExecutionConnector,
    private readonly config: OrchestratorConfig
  ) {
    this.capitalSettings.leverage = Math.min(this.connector.getPreferredLeverage(), config.maxLeverage);
    this.connector.setPreferredLeverage(this.capitalSettings.leverage);

    this.executor = new BinanceExecutor(this.connector);

    this.logger = new OrchestratorLogger({
      dir: path.join(process.cwd(), 'logs', 'orchestrator'),
      queueLimit: this.config.loggerQueueLimit,
      dropHaltThreshold: this.config.loggerDropHaltThreshold,
      onDropSpike: (dropCount) => {
        this.log('ORCHESTRATOR_LOG_DROP_SPIKE', { dropCount });
      },
    });

    this.connector.onExecutionEvent((event) => {
      if (event.type === 'TRADE_UPDATE') {
        const prev = this.realizedPnlBySymbol.get(event.symbol) || 0;
        this.realizedPnlBySymbol.set(event.symbol, prev + event.realizedPnl);
      }
      this.ingestExecutionEvent(event);
    });
  }

  getConnector() {
    return this.connector;
  }

  async start() {
    this.replayMode = false;
    await this.connector.start();
  }

  setKillSwitch(enabled: boolean) {
    this.killSwitch = Boolean(enabled);
  }

  ingest(metrics: OrchestratorMetricsInput) {
    const symbol = metrics.symbol.toUpperCase();
    this.connector.ensureSymbol(symbol);
    const envelope = this.buildMetricsEnvelope(symbol, metrics);
    this.logger.logMetrics({
      canonical_time_ms: envelope.canonical_time_ms,
      exchange_event_time_ms: envelope.exchange_event_time_ms,
      symbol,
      gate: envelope.gate,
      metrics: envelope.metrics,
    });
    this.ensureActor(symbol).enqueue(envelope);
  }

  ingestLoggedMetrics(input: {
    symbol: string;
    canonical_time_ms: number;
    exchange_event_time_ms: number | null;
    metrics: OrchestratorMetricsInput;
    gate: GateResult;
  }) {
    const symbol = input.symbol.toUpperCase();
    const envelope: MetricsEventEnvelope = {
      kind: 'metrics',
      symbol,
      canonical_time_ms: input.canonical_time_ms,
      exchange_event_time_ms: input.exchange_event_time_ms,
      metrics: { ...input.metrics, symbol },
      gate: input.gate,
    };
    this.ensureActor(symbol).enqueue(envelope);
  }

  ingestExecutionReplay(event: ExecutionEvent) {
    this.ensureActor(event.symbol.toUpperCase()).enqueue({
      kind: 'execution',
      symbol: event.symbol.toUpperCase(),
      event_time_ms: event.event_time_ms,
      execution: event,
    });
  }

  async flush() {
    await Promise.all([...this.actors.values()].map((actor) => this.waitForIdle(actor)));
  }

  resetForReplay() {
    this.replayMode = true;
    this.decisionLedger.length = 0;
    this.stateSnapshots.clear();
    this.expectedOrderMeta.clear();
    this.actors.clear();
    this.ramps.clear();
    this.riskManagers.clear();
  }

  getDecisionLedger() {
    return [...this.decisionLedger];
  }

  getStateSnapshot() {
    const out: Record<string, SymbolState> = {};
    for (const [symbol, state] of this.stateSnapshots.entries()) {
      out[symbol] = state;
    }
    return out;
  }

  getExecutionStatus() {
    const connectorStatus = this.connector.getStatus();
    const selectedSymbols = Array.from(this.executionSymbols);

    let totalRealized = 0;
    let totalUnrealized = 0;
    let totalWallet = 0;
    let totalAvailable = 0;

    // Get current balances from connector cache (synced via refresh/syncState)
    totalWallet = this.connector.getWalletBalance() || 0;
    totalAvailable = this.connector.getAvailableBalance() || 0;
    this.capitalSettings.totalMarginBudgetUsdt = Math.max(0, totalWallet);

    for (const sym of selectedSymbols) {
      totalRealized += this.realizedPnlBySymbol.get(sym) || 0;
    }

    return {
      connection: connectorStatus,
      selectedSymbols,
      settings: {
        leverage: this.capitalSettings.leverage,
        totalMarginBudgetUsdt: this.capitalSettings.totalMarginBudgetUsdt,
        pairInitialMargins: { ...this.capitalSettings.pairInitialMargins },
      },
      wallet: {
        totalWalletUsdt: totalWallet,
        availableBalanceUsdt: totalAvailable,
        realizedPnl: totalRealized,
        unrealizedPnl: totalUnrealized,
        totalPnl: totalRealized + totalUnrealized,
        lastUpdated: Date.now()
      },
      openPosition: null,
      openPositions: {},
    };
  }

  async updateCapitalSettings(input: {
    leverage?: number;
    pairInitialMargins?: Record<string, number>;
  }) {
    if (typeof input.leverage === 'number' && Number.isFinite(input.leverage) && input.leverage > 0) {
      this.capitalSettings.leverage = Math.min(input.leverage, this.config.maxLeverage);
      this.connector.setPreferredLeverage(this.capitalSettings.leverage);
    }

    if (input.pairInitialMargins && typeof input.pairInitialMargins === 'object') {
      const normalized: Record<string, number> = {};
      for (const [symbol, rawMargin] of Object.entries(input.pairInitialMargins)) {
        const margin = Number(rawMargin);
        if (Number.isFinite(margin) && margin > 0) {
          normalized[symbol.toUpperCase()] = margin;
        }
      }
      this.capitalSettings.pairInitialMargins = normalized;
      for (const [symbol, margin] of Object.entries(normalized)) {
        this.ensureRamp(symbol).updateConfig({ startingMarginUsdt: margin });
        this.ensureRamp(symbol).forceBudget(margin);
      }
    }

    this.capitalSettings.totalMarginBudgetUsdt = Math.max(0, this.connector.getWalletBalance() || 0);

    return {
      leverage: this.capitalSettings.leverage,
      totalMarginBudgetUsdt: this.capitalSettings.totalMarginBudgetUsdt,
      pairInitialMargins: { ...this.capitalSettings.pairInitialMargins },
    };
  }

  async setExecutionEnabled(enabled: boolean) {
    this.connector.setEnabled(enabled);
  }

  async listTestnetFuturesPairs(): Promise<string[]> {
    return this.connector.fetchExchangeInfo();
  }

  async connectExecution(apiKey: string, apiSecret: string) {
    this.connector.setCredentials(apiKey, apiSecret);
    await this.connector.connect();
  }

  async disconnectExecution() {
    await this.connector.disconnect();
  }

  async refreshExecutionState() {
    if (this.executionSymbols.size > 0) {
      const realizedSnapshot = await this.connector.fetchRealizedPnlBySymbol(Array.from(this.executionSymbols));
      for (const [symbol, realized] of realizedSnapshot) {
        this.realizedPnlBySymbol.set(symbol, realized);
      }
    }
    await this.connector.syncState();
    return this.getExecutionStatus();
  }

  async setExecutionSymbols(symbols: string[]) {
    const normalized = symbols.map((s) => s.toUpperCase());
    this.executionSymbols.clear();
    for (const symbol of normalized) {
      this.executionSymbols.add(symbol);
      this.ensureActor(symbol);
      this.ensureRamp(symbol);
    }
    this.connector.setSymbols(normalized);
    await this.connector.syncState();
    if (this.connector.getStatus().hasCredentials) {
      await this.connector.ensureSymbolsReady();
    }

    for (const symbol of Array.from(this.ramps.keys())) {
      if (!this.executionSymbols.has(symbol)) {
        this.ramps.delete(symbol);
        this.actors.delete(symbol);
        this.riskManagers.delete(symbol);
      }
    }
  }

  private log(event: string, data: any = {}) {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...data
    }));
  }

  private buildMetricsEnvelope(symbol: string, metrics: OrchestratorMetricsInput): MetricsEventEnvelope {
    const canonicalTime = Number.isFinite(metrics.canonical_time_ms as number)
      ? Number(metrics.canonical_time_ms)
      : Date.now();
    const exchangeTime = typeof metrics.exchange_event_time_ms === 'number'
      ? Number(metrics.exchange_event_time_ms)
      : null;
    const gate = runGate({
      canonical_time_ms: canonicalTime,
      exchange_event_time_ms: exchangeTime,
      metrics,
    }, this.config.gate);
    return {
      kind: 'metrics',
      symbol,
      canonical_time_ms: canonicalTime,
      exchange_event_time_ms: exchangeTime,
      metrics: { ...metrics, symbol },
      gate,
    };
  }

  private ingestExecutionEvent(event: ExecutionEvent) {
    const symbol = event.symbol.toUpperCase();
    this.logger.logExecution(event.event_time_ms, { event });
    this.ensureActor(symbol).enqueue({
      kind: 'execution',
      symbol,
      event_time_ms: event.event_time_ms,
      execution: event,
    });
  }

  private ensureActor(symbol: string): SymbolActor {
    const normalized = symbol.toUpperCase();
    const existing = this.actors.get(normalized);
    if (existing) {
      return existing;
    }

    const decisionEngine = new DecisionEngine({
      expectedPrice: (sym, side, type, limitPrice) => this.connector.expectedPrice(sym, side, type, limitPrice),
      getCurrentMarginBudgetUsdt: (sym) => this.getCurrentMarginBudgetUsdt(sym),
      getMaxLeverage: () => this.getEffectiveLeverage(),
      hardStopLossPct: this.config.hardStopLossPct,
      liquidationEmergencyMarginRatio: this.config.liquidationEmergencyMarginRatio,
      takerFeeBps: this.config.takerFeeBps,
      profitLockBufferBps: this.config.profitLockBufferBps,
    });

    const actor = new SymbolActor({
      symbol: normalized,
      decisionEngine,
      onActions: async (actions) => {
        await this.handleActions(normalized, actions);
      },
      onDecisionLogged: (record) => {
        this.decisionLedger.push(record);
        this.stateSnapshots.set(normalized, record.state);
        this.logger.logDecision(record.canonical_time_ms, record);
      },
      onExecutionLogged: (event, state) => {
        this.stateSnapshots.set(normalized, state);
        this.logger.logExecution(event.event_time_ms, { event, state });
      },
      getExpectedOrderMeta: (orderId) => this.expectedOrderMeta.get(orderId) || null,
      getStartingMarginUsdt: () => this.getStartingMarginUsdt(normalized),
      getCurrentMarginBudgetUsdt: () => this.getCurrentMarginBudgetUsdt(normalized),
      getRampMult: () => this.getRampMult(normalized),
      getEffectiveLeverage: () => this.getEffectiveLeverage(),
      onPositionClosed: (realizedPnl) => this.onPositionClosed(normalized, realizedPnl),
      markAddUsed: () => {},
      cooldownConfig: this.config.cooldown,
    });

    this.actors.set(normalized, actor);
    return actor;
  }

  private ensureRamp(symbol: string): SizingRamp {
    const normalized = symbol.toUpperCase();
    const existing = this.ramps.get(normalized);
    if (existing) {
      return existing;
    }

    const startingMargin = this.getStartingMarginUsdt(normalized);
    const ramp = new SizingRamp({
      startingMarginUsdt: startingMargin,
      minMarginUsdt: this.config.minMarginUsdt,
      rampStepPct: this.config.rampStepPct,
      rampDecayPct: this.config.rampDecayPct,
      rampMaxMult: this.config.rampMaxMult,
    });

    this.ramps.set(normalized, ramp);
    return ramp;
  }

  private getRiskManager(symbol: string): RiskManager {
    const normalized = symbol.toUpperCase();
    const existing = this.riskManagers.get(normalized);
    if (existing) {
      return existing;
    }
    const manager = new RiskManager();
    this.riskManagers.set(normalized, manager);
    return manager;
  }

  private getStartingMarginUsdt(symbol: string): number {
    const override = Number(this.capitalSettings.pairInitialMargins[symbol]);
    if (Number.isFinite(override) && override > 0) {
      return override;
    }
    return Math.max(0, Number(this.config.startingMarginUsdt || 0));
  }

  private getCurrentMarginBudgetUsdt(symbol: string): number {
    const override = Number(this.capitalSettings.pairInitialMargins[symbol]);
    if (Number.isFinite(override) && override > 0) {
      return override;
    }
    const ramp = this.ensureRamp(symbol);
    const budget = ramp.getCurrentMarginBudgetUsdt();
    const wallet = this.connector.getWalletBalance() || 0;
    const symbolCount = Math.max(1, this.executionSymbols.size || 1);
    const walletCap = wallet > 0 ? wallet / symbolCount : 0;
    if (walletCap > 0) {
      return Math.min(budget, walletCap);
    }
    return budget;
  }

  private getRampMult(symbol: string): number {
    return this.ensureRamp(symbol).getState().rampMult;
  }

  private getEffectiveLeverage(): number {
    return Math.min(this.capitalSettings.leverage, this.config.maxLeverage);
  }

  private onPositionClosed(symbol: string, realizedPnl: number) {
    const ramp = this.ensureRamp(symbol);
    ramp.onTradeClosed(realizedPnl);
  }

  private getExecutionGateState() {
    const status = this.connector.getStatus();
    const hasCredentials = Boolean(status.hasCredentials);
    const ready = Boolean(status.ready);
    const executionAllowed = this.connector.isExecutionEnabled() && !this.killSwitch && hasCredentials && ready;
    return {
      executionAllowed,
      hasCredentials,
      ready,
      readyReason: status.readyReason,
    };
  }

  private logOrderAttemptAudit(data: {
    reasonCode: OrderAttemptReason;
    symbol: string;
    side: 'BUY' | 'SELL';
    price: number;
    qty: number;
    notional: number;
    leverage: number;
    marginBudget: number;
    bufferBps: number;
    error?: string;
    readyReason?: string | null;
  }) {
    this.log('ORDER_ATTEMPT_AUDIT', {
      reason_code: data.reasonCode,
      symbol: data.symbol,
      side: data.side,
      price: data.price,
      qty: data.qty,
      notional: data.notional,
      leverage: data.leverage,
      marginBudget: data.marginBudget,
      bufferBps: data.bufferBps,
      error: data.error,
      readyReason: data.readyReason,
    });
  }

  private async handleActions(symbol: string, actions: DecisionAction[]) {
    if (this.replayMode) {
      return;
    }

    for (const action of actions) {
      if (action.type === 'NOOP') {
        continue;
      }

      if (action.type === 'CANCEL_OPEN_ENTRY_ORDERS') {
        try {
          await this.connector.cancelAllOpenOrders(symbol);
        } catch (e: any) {
          this.log('EXECUTION_CANCEL_ERROR', { symbol, error: e?.message || 'cancel_failed' });
        }
        continue;
      }

      const side = action.side;
      if (!side) {
        continue;
      }

      let quantity = typeof action.quantity === 'number' ? action.quantity : 0;
      if (action.type === 'EXIT_MARKET' && quantity <= 0) {
        quantity = this.actors.get(symbol)?.state.position?.qty ?? 0;
      }

      const expectedPrice = action.expectedPrice ?? this.connector.expectedPrice(symbol, side, 'MARKET');
      const price = typeof expectedPrice === 'number' && Number.isFinite(expectedPrice) ? expectedPrice : 0;
      const leverage = this.getEffectiveLeverage();
      const marginBudget = this.getCurrentMarginBudgetUsdt(symbol);
      const bufferBps = 0;
      const auditBase = {
        symbol,
        side,
        price,
        qty: quantity,
        notional: price > 0 ? price * quantity : 0,
        leverage,
        marginBudget,
        bufferBps,
      };

      const gate = this.getExecutionGateState();
      if (this.killSwitch) {
        this.logOrderAttemptAudit({ ...auditBase, reasonCode: 'KILL_SWITCH' });
        continue;
      }
      if (!this.connector.isExecutionEnabled()) {
        this.logOrderAttemptAudit({ ...auditBase, reasonCode: 'EXEC_DISABLED' });
        continue;
      }
      if (!gate.hasCredentials) {
        this.logOrderAttemptAudit({ ...auditBase, reasonCode: 'MISSING_KEYS' });
        continue;
      }
      if (!gate.ready) {
        this.logOrderAttemptAudit({ ...auditBase, reasonCode: 'NOT_READY', readyReason: gate.readyReason });
        continue;
      }
      if (!(quantity > 0)) {
        this.logOrderAttemptAudit({ ...auditBase, reasonCode: 'SIZE_ZERO' });
        continue;
      }

      let sizingQty = quantity;
      let sizingNotional = auditBase.notional;
      try {
        const sizing = await this.connector.previewOrderSizing(symbol, side, quantity, price > 0 ? price : null);
        sizingQty = sizing.qtyRounded;
        sizingNotional = sizing.notionalUsdt;
        if (!(sizingQty > 0) || !sizing.minNotionalOk) {
          this.logOrderAttemptAudit({
            ...auditBase,
            qty: sizingQty,
            notional: sizingNotional,
            reasonCode: 'RISK_BLOCK',
            error: 'min_notional',
          });
          continue;
        }
      } catch (e: any) {
        this.logOrderAttemptAudit({
          ...auditBase,
          reasonCode: 'RISK_BLOCK',
          error: e?.message || 'sizing_failed',
        });
        continue;
      }

      const risk = this.getRiskManager(symbol);
      const riskCheck = risk.check(symbol, side, price, sizingQty, {
        maxPositionNotionalUsdt: marginBudget > 0 ? marginBudget * leverage * 1.02 : undefined,
      });
      if (!riskCheck.ok) {
        this.logOrderAttemptAudit({
          ...auditBase,
          qty: sizingQty,
          notional: sizingNotional,
          reasonCode: 'RISK_BLOCK',
          error: riskCheck.reason || 'risk_blocked',
        });
        continue;
      }

      const reduceOnly = Boolean(action.reduceOnly);
      try {
        const res = await this.executor.execute({
          symbol,
          side,
          price,
          quantity: sizingQty,
          reduceOnly,
        });
        this.logOrderAttemptAudit({
          ...auditBase,
          qty: sizingQty,
          notional: sizingNotional,
          reasonCode: res.ok ? 'SENT' : 'EXCHANGE_ERROR',
          error: res.ok ? undefined : res.error,
        });
        if (res.ok && res.orderId) {
          const tag = action.type === 'ADD_POSITION' ? 'add' : action.type === 'EXIT_MARKET' ? 'exit' : 'entry';
          this.expectedOrderMeta.set(res.orderId, {
            expectedPrice: price || null,
            sentAtMs: Date.now(),
            tag,
          });
        }
        if (res.ok) {
          risk.recordTrade(symbol);
        }
      } catch (e: any) {
        const msg = e?.message || 'execution_failed';
        this.logOrderAttemptAudit({
          ...auditBase,
          qty: sizingQty,
          notional: sizingNotional,
          reasonCode: 'EXCHANGE_ERROR',
          error: msg,
        });
      }
    }
  }

  private async waitForIdle(actor: SymbolActor): Promise<void> {
    if (actor.isIdle()) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (actor.isIdle()) {
          clearInterval(timer);
          resolve();
        }
      }, 10);
    });
  }
}

export function createOrchestratorFromEnv(): Orchestrator {
  const executionEnabledEnv = String(process.env.EXECUTION_ENABLED || 'false').toLowerCase();
  const enableGateV2 = String(process.env.ENABLE_GATE_V2 || 'false').toLowerCase() === 'true';
  const gateMode: GateMode = enableGateV2 ? 'V2_NETWORK_LATENCY' : 'V1_NO_LATENCY';
  const gate: GateConfig = {
    mode: gateMode,
    maxSpreadPct: Number(process.env.MAX_SPREAD_PCT || 0.08),
    minObiDeep: Number(process.env.MIN_OBI_DEEP || 0.05),
    v2: {
      maxNetworkLatencyMs: Number(process.env.MAX_NETWORK_LATENCY_MS || 1500),
    },
  };

  const connector = new ExecutionConnector({
    enabled: executionEnabledEnv === 'true',
    apiKey: process.env.BINANCE_TESTNET_API_KEY,
    apiSecret: process.env.BINANCE_TESTNET_API_SECRET,
    restBaseUrl: process.env.BINANCE_TESTNET_REST_BASE || 'https://testnet.binancefuture.com',
    userDataWsBaseUrl: process.env.BINANCE_TESTNET_USER_WS_BASE || 'wss://stream.binancefuture.com',
    marketWsBaseUrl: process.env.BINANCE_TESTNET_MARKET_WS_BASE || 'wss://stream.binancefuture.com',
    recvWindowMs: Number(process.env.BINANCE_RECV_WINDOW_MS || 5000),
    defaultMarginType: (String(process.env.DEFAULT_MARGIN_TYPE || 'ISOLATED').toUpperCase() === 'CROSSED' ? 'CROSSED' : 'ISOLATED'),
    defaultLeverage: Number(process.env.DEFAULT_SYMBOL_LEVERAGE || 20),
    dualSidePosition: String(process.env.POSITION_MODE || 'ONE-WAY').toUpperCase() === 'HEDGE',
  });

  return new Orchestrator(connector, {
    maxLeverage: Number(process.env.MAX_LEVERAGE || 125),
    loggerQueueLimit: Number(process.env.LOGGER_QUEUE_LIMIT || 10000),
    loggerDropHaltThreshold: Number(process.env.LOGGER_DROP_HALT_THRESHOLD || 500),
    gate,
    cooldown: {
      minMs: Number(process.env.COOLDOWN_MIN_MS || 2000),
      maxMs: Number(process.env.COOLDOWN_MAX_MS || 30000),
    },
    startingMarginUsdt: Number(process.env.STARTING_MARGIN_USDT || 0),
    minMarginUsdt: Number(process.env.MIN_MARGIN_USDT || 0),
    rampStepPct: Number(process.env.RAMP_STEP_PCT || 10),
    rampDecayPct: Number(process.env.RAMP_DECAY_PCT || 20),
    rampMaxMult: Number(process.env.RAMP_MAX_MULT || 5),
    hardStopLossPct: Number(process.env.HARD_STOP_LOSS_PCT || 1),
    liquidationEmergencyMarginRatio: Number(process.env.LIQUIDATION_EMERGENCY_MARGIN_RATIO || 0.3),
    takerFeeBps: Number(process.env.TAKER_FEE_BPS || 4),
    profitLockBufferBps: Number(process.env.PROFIT_LOCK_BUFFER_BPS || 2),
  });
}
