import * as path from 'path';
import { ExecutionConnector } from '../connectors/ExecutionConnector';
import { ExecutionEvent, Side } from '../connectors/executionTypes';
import { DryRunExecutor } from '../execution/DryRunExecutor';
import { IExecutor } from '../execution/types';
import { TradeLogger } from '../logger/TradeLogger';
import { FundingRateMonitor } from '../metrics/FundingRateMonitor';
import { AlertService } from '../notifications/AlertService';
import { logger } from '../utils/logger';
import { SymbolActor } from './Actor';
import { DecisionEngine } from './Decision';
import { runGate } from './Gate';
import { OrchestratorLogger } from './Logger';
import { PlannedOrder } from './OrderPlan';
import { OrderMonitor } from './OrderMonitor';
import { PlanRunner, PlanTickResult } from './PlanRunner';
import { reconcilePosition } from './Reconciler';
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
  private readonly planRunners = new Map<string, PlanRunner>();
  private readonly expectedOrderMeta = new Map<string, ExpectedOrderMeta>();
  private readonly decisionLedger: any[] = [];
  private readonly stateSnapshots = new Map<string, SymbolState>();
  private readonly atrBySymbol = new Map<string, number>();
  private readonly executor: IExecutor;
  private readonly logger: OrchestratorLogger;
  private readonly orderMonitor: OrderMonitor;
  private readonly tradeLogger: TradeLogger;
  private readonly fundingRateMonitor = new FundingRateMonitor();
  private readonly fundingLastUpdateBySymbol = new Map<string, number>();
  private readonly fundingRefreshMs = Number(process.env.FUNDING_REFRESH_MS || 60_000);
  private readonly limitTimeoutMs = Number(process.env.LIMIT_ORDER_TIMEOUT_MS || 30_000);
  private orderMonitorTimer: NodeJS.Timeout | null = null;

  private killSwitch = false;
  private replayMode = false;
  private dailyLossState = {
    dayKey: this.currentDayKey(),
    startBalance: 0,
    realizedPnl: 0,
    triggered: false,
  };

  private capitalSettings = {
    leverage: 10,
    totalMarginBudgetUsdt: 0,
    pairInitialMargins: {} as Record<string, number>,
  };

  constructor(
    private readonly connector: ExecutionConnector,
    private readonly config: OrchestratorConfig,
    private readonly alertService?: AlertService
  ) {
    this.capitalSettings.leverage = Math.min(this.connector.getPreferredLeverage(), config.maxLeverage);
    this.connector.setPreferredLeverage(this.capitalSettings.leverage);

    this.executor = new DryRunExecutor(async (decision) => {
      return {
        ok: true,
        orderId: `dryrun-${Date.now()}`,
        executedQuantity: decision.quantity,
        executedPrice: decision.price,
        fee: '0',
        feeTier: 'MAKER',
      };
    });

    this.logger = new OrchestratorLogger({
      dir: path.join(process.cwd(), 'logs', 'orchestrator'),
      queueLimit: this.config.loggerQueueLimit,
      dropHaltThreshold: this.config.loggerDropHaltThreshold,
      onDropSpike: (dropCount) => {
        this.log('ORCHESTRATOR_LOG_DROP_SPIKE', { dropCount });
      },
    });

    this.tradeLogger = new TradeLogger(path.join(process.cwd(), 'logs', 'trades.jsonl'));
    this.orderMonitor = new OrderMonitor({
      queryOrder: (symbol, orderId) => this.connector.queryOrder(symbol, orderId),
      cancelOrder: (symbol, orderId, clientOrderId) => this.connector.cancelOrder({ symbol, orderId, clientOrderId }),
      placeLimitOrder: async (input) => this.placeLimitRepriceOrder(input),
      placeMarketOrder: async (fallback) => {
        await this.placeMarketFallbackOrder(fallback);
      },
      log: (event, detail) => this.log(event, detail || {}),
      maxRepriceAttempts: Number(process.env.LIMIT_REPRICE_MAX || 2),
    });

    this.connector.onExecutionEvent((event) => {
      if (event.type === 'TRADE_UPDATE') {
        const prev = this.realizedPnlBySymbol.get(event.symbol) || 0;
        this.realizedPnlBySymbol.set(event.symbol, prev + event.realizedPnl);
      }
      if (event.type === 'ORDER_UPDATE') {
        const terminal = event.status === 'FILLED' || event.status === 'CANCELED' || event.status === 'REJECTED' || event.status === 'EXPIRED';
        if (terminal) {
          this.orderMonitor.remove(event.orderId);
        }
      }
      this.ingestExecutionEvent(event);
    });
  }

  getConnector() {
    return this.connector;
  }

  private isDryRunOnly(): boolean {
    return true;
  }

  async start() {
    this.replayMode = false;
    await this.connector.start();
    if (!this.orderMonitorTimer) {
      this.orderMonitorTimer = setInterval(() => {
        this.orderMonitor.monitorLimitOrders().catch((e: any) => {
          this.log('LIMIT_MONITOR_LOOP_ERROR', { error: e?.message || 'monitor_failed' });
        });
      }, 1_000);
    }
  }

  setKillSwitch(enabled: boolean) {
    this.killSwitch = Boolean(enabled);
  }

  ingest(metrics: OrchestratorMetricsInput) {
    const symbol = metrics.symbol.toUpperCase();
    this.updateVolatilityFromMetrics(symbol, metrics);
    this.refreshFundingIfNeeded(symbol);
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
    this.updateVolatilityFromMetrics(symbol, input.metrics);
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
    this.planRunners.clear();
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
    if (this.orderMonitorTimer) {
      clearInterval(this.orderMonitorTimer);
      this.orderMonitorTimer = null;
    }
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
    }
    this.connector.setSymbols(normalized);
    await this.connector.syncState();
    if (this.connector.getStatus().hasCredentials) {
      await this.connector.ensureSymbolsReady();
    }

    for (const symbol of Array.from(this.actors.keys())) {
      if (!this.executionSymbols.has(symbol)) {
        this.actors.delete(symbol);
        this.planRunners.delete(symbol);
      }
    }
  }

  private log(event: string, data: any = {}) {
    logger.info(event, data);
  }

  private refreshFundingIfNeeded(symbol: string) {
    const normalized = symbol.toUpperCase();
    const now = Date.now();
    const last = this.fundingLastUpdateBySymbol.get(normalized) || 0;
    if (now - last < this.fundingRefreshMs) {
      return;
    }
    this.fundingLastUpdateBySymbol.set(normalized, now);
    this.fundingRateMonitor.updateFundingRate(normalized).catch((e: any) => {
      this.log('FUNDING_UPDATE_ERROR', { symbol: normalized, error: e?.message || 'funding_update_failed' });
    });
  }

  private isFundingShortBlocked(symbol: string): boolean {
    if (symbol.toUpperCase() !== 'ETHUSDT') {
      return false;
    }
    return this.fundingRateMonitor.isShortBlocked(symbol);
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
      allowedSides: this.config.plan.allowedSides,
      liquidationRiskConfig: {
        yellowThreshold: Number(process.env.LIQ_RISK_YELLOW_RATIO || 0.30),
        orangeThreshold: Number(process.env.LIQ_RISK_ORANGE_RATIO || 0.20),
        redThreshold: Number(process.env.LIQ_RISK_RED_RATIO || 0.10),
        criticalThreshold: Number(process.env.LIQ_RISK_CRITICAL_RATIO || 0.05),
        timeToLiquidationWarningMs: Number(process.env.LIQ_RISK_WARN_MS || (5 * 60 * 1000)),
        fundingRateImpactFactor: Number(process.env.LIQ_RISK_FUNDING_FACTOR || 2.5),
        volatilityImpactFactor: Number(process.env.LIQ_RISK_VOL_FACTOR || 1.2),
      },
      onLiquidationAlert: (message) => {
        this.alertService?.send('LIQUIDATION_RISK', message, 'CRITICAL');
      },
      takerFeeBps: this.config.takerFeeBps,
      profitLockBufferBps: this.config.profitLockBufferBps,
    });

    const planRunner = this.ensurePlanRunner(normalized);

    const actor = new SymbolActor({
      symbol: normalized,
      decisionEngine,
      planRunner,
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
      onPlanLogged: (record) => {
        this.decisionLedger.push(record);
        const state = this.actors.get(normalized)?.state;
        if (state) {
          this.stateSnapshots.set(normalized, state);
        }
        this.logger.logDecision(record.ts || Date.now(), record);
      },
      onPlanActions: async (result) => {
        await this.handlePlanActions(normalized, result);
      },
      onPlanEvent: (event) => {
        this.log(event.type, event.detail || {});
      },
      planOrderPrefix: this.config.plan.orderPrefix,
      getExpectedOrderMeta: (orderId) => this.expectedOrderMeta.get(orderId) || null,
      getStartingMarginUsdt: () => this.getStartingMarginUsdt(normalized),
      getCurrentMarginBudgetUsdt: () => this.getCurrentMarginBudgetUsdt(normalized),
      getRampMult: () => 1,
      getEffectiveLeverage: () => this.getEffectiveLeverage(),
      getExecutionReady: () => this.getExecutionGateState().ready,
      getBackoffActive: () => this.connector.isRateLimitBackoffActive(),
      getFundingShortBlocked: () => this.isFundingShortBlocked(normalized),
      getVolatilityFactor: (symbol) => this.getVolatilityFactor(symbol),
      onPositionClosed: (close) => this.onPositionClosed(normalized, close),
      markAddUsed: () => {},
      cooldownConfig: this.config.cooldown,
    });

    this.actors.set(normalized, actor);
    return actor;
  }

  private ensurePlanRunner(symbol: string): PlanRunner {
    const normalized = symbol.toUpperCase();
    const existing = this.planRunners.get(normalized);
    if (existing) {
      return existing;
    }
    const runner = new PlanRunner(this.config.plan);
    this.planRunners.set(normalized, runner);
    return runner;
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
    const budget = this.getStartingMarginUsdt(symbol);
    const wallet = this.connector.getWalletBalance() || 0;
    const symbolCount = Math.max(1, this.executionSymbols.size || 1);
    const walletCap = wallet > 0 ? wallet / symbolCount : 0;
    if (walletCap > 0) {
      return Math.min(budget, walletCap);
    }
    return budget;
  }

  private getEffectiveLeverage(): number {
    return Math.min(this.capitalSettings.leverage, this.config.maxLeverage);
  }

  private onPositionClosed(symbol: string, close: {
    realizedPnl: number;
    side: 'LONG' | 'SHORT';
    qty: number;
    entryPrice: number;
    exitPrice: number;
    openTimeMs: number;
    closeTimeMs: number;
    reason?: string;
    signalType?: string;
    orderflow?: {
      obiWeighted?: number | null;
      obiDeep?: number | null;
      deltaZ?: number | null;
      cvdSlope?: number | null;
    };
  }) {
    const daily = this.updateDailyLoss(close.realizedPnl);
    if (daily.triggered) {
      void this.triggerDailyKillSwitch('daily_drawdown', daily.drawdownPct);
    }

    const leverage = this.getEffectiveLeverage();
    const notional = close.entryPrice * close.qty;
    const margin = leverage > 0 ? notional / leverage : notional;
    const feeRate = this.config.takerFeeBps / 10_000;
    const feeUsdt = (notional + Math.abs(close.exitPrice * close.qty)) * feeRate;
    const netUsdt = close.realizedPnl - feeUsdt;
    const baseMargin = this.getStartingMarginUsdt(symbol);
    const rMultiple = baseMargin > 0 ? netUsdt / baseMargin : null;

    this.tradeLogger.append({
      tradeId: `${symbol}-${close.closeTimeMs}`,
      symbol,
      side: close.side,
      signalType: close.signalType || 'UNKNOWN',
      openTime: new Date(close.openTimeMs).toISOString(),
      closeTime: new Date(close.closeTimeMs).toISOString(),
      entry: {
        price: close.entryPrice,
        qty: close.qty,
        notional,
        margin,
        leverage,
      },
      exit: {
        price: close.exitPrice,
        reason: close.reason || 'POSITION_CLOSED',
        qty: close.qty,
      },
      orderflow: {
        obiWeighted: close.orderflow?.obiWeighted ?? null,
        obiDeep: close.orderflow?.obiDeep ?? null,
        deltaZ: close.orderflow?.deltaZ ?? null,
        cvdSlope: close.orderflow?.cvdSlope ?? null,
      },
      pnl: {
        grossUsdt: close.realizedPnl,
        feeUsdt,
        netUsdt,
        rMultiple,
      },
    });
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

  private async handlePlanActions(symbol: string, result: PlanTickResult) {
    if (this.replayMode) {
      return;
    }

    const actions = result.reconcile.actions;
    const ordered = result.planState === 'EXITING'
      ? [...actions.filter((a) => a.kind === 'CANCEL'), ...actions.filter((a) => a.kind !== 'CANCEL')]
      : actions;

    if (result.planState === 'EXITING') {
      for (const action of ordered) {
        if (action.kind === 'CANCEL') {
          await this.cancelPlannedOrder(symbol, action.existing);
        }
      }
      for (const order of result.immediateOrders) {
        await this.executePlannedOrder(order);
      }
    } else {
      for (const order of result.immediateOrders) {
        await this.executePlannedOrder(order);
      }
    }

    for (const action of ordered) {
      if (action.kind === 'CANCEL') {
        if (result.planState !== 'EXITING') {
          await this.cancelPlannedOrder(symbol, action.existing);
        }
        continue;
      }
      if (action.kind === 'REPLACE') {
        const canceled = await this.cancelPlannedOrder(symbol, action.existing);
        if (!canceled) {
          continue;
        }
        await this.executePlannedOrder(action.order);
        continue;
      }
      if (action.kind === 'PLACE') {
        await this.executePlannedOrder(action.order);
      }
    }
  }

  private async executePlannedOrder(order: PlannedOrder) {
    let side = order.side;
    const leverage = this.getEffectiveLeverage();
    const marginBudget = this.getCurrentMarginBudgetUsdt(order.symbol);
    const bufferBps = 0;

    if (order.role === 'FLATTEN') {
      const actualPosition = await reconcilePosition({
        symbol: order.symbol,
        fetchPositionRisk: (symbol) => this.connector.fetchPositionRisk(symbol),
        onLog: (message, detail) => this.log(message, detail || {}),
      });
      if (!actualPosition) {
        return;
      }
      side = actualPosition.side === 'LONG' ? 'SELL' : 'BUY';
      order = {
        ...order,
        side,
        qty: Math.min(order.qty, actualPosition.qty),
      };
    }

    let price = 0;
    if (order.type === 'LIMIT') {
      price = typeof order.price === 'number' && Number.isFinite(order.price) ? order.price : 0;
    } else {
      const expected = this.connector.expectedPrice(order.symbol, side, order.type, order.price ?? undefined);
      price = typeof expected === 'number' && Number.isFinite(expected) ? expected : (order.price || 0);
    }

    const auditBase = {
      symbol: order.symbol,
      side,
      price,
      qty: order.qty,
      notional: price > 0 ? price * order.qty : 0,
      leverage,
      marginBudget,
      bufferBps,
    };

    if (this.isDryRunOnly()) {
      this.log('DRY_RUN_PLANNED_ORDER', { ...auditBase, role: order.role });
      return;
    }

    if (this.killSwitch) {
      this.logOrderAttemptAudit({ ...auditBase, reasonCode: 'KILL_SWITCH' });
      return;
    }
    if (!this.connector.isExecutionEnabled()) {
      this.logOrderAttemptAudit({ ...auditBase, reasonCode: 'EXEC_DISABLED' });
      return;
    }

    const gate = this.getExecutionGateState();
    if (!gate.hasCredentials) {
      this.logOrderAttemptAudit({ ...auditBase, reasonCode: 'MISSING_KEYS' });
      return;
    }
    if (!gate.ready) {
      this.logOrderAttemptAudit({ ...auditBase, reasonCode: 'NOT_READY', readyReason: gate.readyReason });
      return;
    }

    if (!(order.qty > 0)) {
      this.logOrderAttemptAudit({ ...auditBase, reasonCode: 'SIZE_ZERO' });
      return;
    }

    if (order.type === 'LIMIT' && !(price > 0)) {
      this.logOrderAttemptAudit({ ...auditBase, reasonCode: 'RISK_BLOCK', error: 'missing_limit_price' });
      return;
    }

    let sizingQty = order.qty;
    let sizingNotional = auditBase.notional;
    let sizingPrice = price;
    try {
      const sizing = await this.connector.previewOrderSizing(order.symbol, side, order.qty, price > 0 ? price : null);
      sizingQty = sizing.qtyRounded;
      sizingNotional = sizing.notionalUsdt;
      if (!(sizingQty > 0)) {
        this.logOrderAttemptAudit({ ...auditBase, reasonCode: 'SIZE_ZERO' });
        return;
      }
      if (!order.reduceOnly && !sizing.minNotionalOk) {
        this.logOrderAttemptAudit({
          ...auditBase,
          qty: sizingQty,
          notional: sizingNotional,
          reasonCode: 'RISK_BLOCK',
          error: 'min_notional',
        });
        return;
      }
      if (!(price > 0)) {
        sizingPrice = sizing.markPrice;
      }
    } catch (e: any) {
      this.logOrderAttemptAudit({
        ...auditBase,
        reasonCode: 'RISK_BLOCK',
        error: e?.message || 'sizing_failed',
      });
      return;
    }

    try {
      const res = await this.connector.placeOrder({
        symbol: order.symbol,
        side,
        type: order.type,
        quantity: sizingQty,
        price: order.type === 'LIMIT' ? sizingPrice : undefined,
        stopPrice: order.stopPrice || undefined,
        timeInForce: order.timeInForce,
        reduceOnly: order.reduceOnly,
        clientOrderId: order.clientOrderId,
      });
      this.logOrderAttemptAudit({
        ...auditBase,
        qty: sizingQty,
        notional: sizingNotional,
        reasonCode: 'SENT',
      });
      if (res.orderId) {
        const tag = order.reduceOnly || ['TP', 'STOP', 'FLATTEN', 'FLIP'].includes(order.role)
          ? 'exit'
          : order.role === 'SCALE_IN'
            ? 'add'
            : 'entry';
        this.expectedOrderMeta.set(res.orderId, {
          expectedPrice: sizingPrice || null,
          sentAtMs: Date.now(),
          tag,
        });
        if (order.type === 'LIMIT' && (order.role === 'BOOT_PROBE' || order.role === 'SCALE_IN' || order.role === 'TP')) {
          this.orderMonitor.register({
            orderId: res.orderId,
            clientOrderId: order.clientOrderId,
            symbol: order.symbol,
            side,
            price: sizingPrice,
            qty: sizingQty,
            reduceOnly: order.reduceOnly,
            role: order.role,
            timeoutMs: this.limitTimeoutMs,
          });
        }
      }
      if (order.role === 'TP') {
        this.log('TP_PLACED', { symbol: order.symbol, price: sizingPrice, qty: sizingQty, clientOrderId: order.clientOrderId });
      }
    } catch (e: any) {
      this.logOrderAttemptAudit({
        ...auditBase,
        reasonCode: 'EXCHANGE_ERROR',
        error: e?.message || 'execution_failed',
      });
    }
  }

  private async placeMarketFallbackOrder(input: {
    symbol: string;
    side: Side;
    qty: number;
    reduceOnly: boolean;
    role: PlannedOrder['role'];
    fallbackFromOrderId: string;
  }) {
    if (!(input.qty > 0)) {
      return;
    }
    if (this.isDryRunOnly()) {
      this.log('DRY_RUN_MARKET_FALLBACK', { symbol: input.symbol, side: input.side, qty: input.qty });
      return;
    }
    try {
      await this.connector.placeOrder({
        symbol: input.symbol,
        side: input.side,
        type: 'MARKET',
        quantity: input.qty,
        reduceOnly: input.reduceOnly,
        clientOrderId: `to_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
      });
      this.log('LIMIT_TIMEOUT_FALLBACK_SENT', {
        symbol: input.symbol,
        side: input.side,
        qty: input.qty,
        reduceOnly: input.reduceOnly,
        role: input.role,
        fallbackFromOrderId: input.fallbackFromOrderId,
      });
    } catch (e: any) {
      this.log('LIMIT_TIMEOUT_FALLBACK_ERROR', {
        symbol: input.symbol,
        side: input.side,
        qty: input.qty,
        reduceOnly: input.reduceOnly,
        role: input.role,
        fallbackFromOrderId: input.fallbackFromOrderId,
        error: e?.message || 'fallback_failed',
      });
    }
  }

  private async cancelPlannedOrder(symbol: string, order: { orderId?: string; clientOrderId?: string }): Promise<boolean> {
    try {
      await this.connector.cancelOrder({
        symbol,
        orderId: order.orderId,
        clientOrderId: order.clientOrderId,
      });
      if (order.orderId) {
        this.orderMonitor.remove(order.orderId);
      }
      return true;
    } catch (e: any) {
      this.log('EXECUTION_CANCEL_ERROR', { symbol, error: e?.message || 'cancel_failed' });
      return false;
    }
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
          price: String(price),
          quantity: String(sizingQty),
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

  private updateVolatilityFromMetrics(symbol: string, metrics: OrchestratorMetricsInput) {
    const raw = Number(metrics.advancedMetrics?.volatilityIndex ?? 0);
    if (Number.isFinite(raw) && raw > 0) {
      this.atrBySymbol.set(symbol.toUpperCase(), raw);
    }
  }

  private getVolatilityFactor(symbol: string): number {
    const cfg = this.config.plan.volatilitySizing;
    if (!cfg || !cfg.enabled) return 1;
    const refSymbol = (cfg.referenceSymbol || 'ETHUSDT').toUpperCase();
    const refAtr = this.atrBySymbol.get(refSymbol) || 0;
    const symAtr = this.atrBySymbol.get(symbol.toUpperCase()) || 0;
    if (!(refAtr > 0) || !(symAtr > 0)) return 1;
    const raw = refAtr / symAtr;
    const minFactor = Number.isFinite(cfg.minFactor) ? cfg.minFactor : 0.2;
    const maxFactor = Number.isFinite(cfg.maxFactor) ? cfg.maxFactor : 2.0;
    return Math.max(minFactor, Math.min(maxFactor, raw));
  }

  private updateDailyLoss(realizedPnl: number): { triggered: boolean; drawdownPct: number | null } {
    const nowKey = this.currentDayKey();
    if (nowKey !== this.dailyLossState.dayKey) {
      this.dailyLossState = {
        dayKey: nowKey,
        startBalance: 0,
        realizedPnl: 0,
        triggered: false,
      };
    }
    if (this.dailyLossState.startBalance <= 0) {
      const wallet = this.connector.getWalletBalance() || 0;
      if (wallet > 0) {
        this.dailyLossState.startBalance = wallet;
      }
    }
    this.dailyLossState.realizedPnl += realizedPnl;
    if (!(this.dailyLossState.startBalance > 0)) {
      return { triggered: false, drawdownPct: null };
    }
    const drawdownPct = this.dailyLossState.realizedPnl / this.dailyLossState.startBalance;
    if (!this.dailyLossState.triggered && this.config.dailyKillSwitchPct > 0 && drawdownPct <= -this.config.dailyKillSwitchPct) {
      this.dailyLossState.triggered = true;
      return { triggered: true, drawdownPct };
    }
    return { triggered: false, drawdownPct };
  }

  private async triggerDailyKillSwitch(reason: string, drawdownPct: number | null) {
    if (this.killSwitch) return;
    this.killSwitch = true;
    this.log('DAILY_KILL_SWITCH_TRIGGERED', { reason, drawdownPct });
    this.alertService?.send('DAILY_KILL_SWITCH', `Kill switch engaged: ${reason}`, 'CRITICAL');

    if (this.isDryRunOnly()) {
      this.log('DRY_RUN_KILL_SWITCH', { reason, drawdownPct });
      return;
    }

    for (const [symbol, actor] of this.actors.entries()) {
      const position = actor.state.position;
      try {
        await this.connector.cancelAllOpenOrders(symbol);
      } catch (e: any) {
        this.log('KILL_SWITCH_CANCEL_ERROR', { symbol, error: e?.message || 'cancel_failed' });
      }
      if (!position || !(position.qty > 0)) {
        continue;
      }
      const side: Side = position.side === 'LONG' ? 'SELL' : 'BUY';
      try {
        await this.connector.placeOrder({
          symbol,
          side,
          type: 'MARKET',
          quantity: position.qty,
          reduceOnly: true,
          clientOrderId: `ks_${Date.now()}_${Math.floor(Math.random() * 10_000)}`,
        });
        this.log('KILL_SWITCH_FLATTEN_SENT', { symbol, side, qty: position.qty });
      } catch (e: any) {
        this.log('KILL_SWITCH_FLATTEN_ERROR', { symbol, error: e?.message || 'flatten_failed' });
      }
    }
  }

  private async placeLimitRepriceOrder(input: {
    symbol: string;
    side: Side;
    qty: number;
    reduceOnly: boolean;
    role: PlannedOrder['role'];
    repriceAttempt: number;
    previousOrderId: string;
    clientOrderId: string;
  }): Promise<{ orderId: string; clientOrderId: string; price: number } | null> {
    if (this.isDryRunOnly()) {
      this.log('DRY_RUN_LIMIT_REPRICE', { symbol: input.symbol, side: input.side, qty: input.qty });
      return { orderId: `dryrun-${Date.now()}`, clientOrderId: input.clientOrderId, price: 0 };
    }
    const price = this.getMakerLimitPrice(input.symbol, input.side);
    if (price == null || !(price > 0)) {
      this.log('LIMIT_REPRICE_PRICE_MISSING', { symbol: input.symbol, previousOrderId: input.previousOrderId });
      return null;
    }
    const safePrice = price;
    try {
      const res = await this.connector.placeOrder({
        symbol: input.symbol,
        side: input.side,
        type: 'LIMIT',
        quantity: input.qty,
        price: safePrice,
        timeInForce: 'GTC',
        reduceOnly: input.reduceOnly,
        clientOrderId: input.clientOrderId,
      });
      return { orderId: res.orderId, clientOrderId: input.clientOrderId, price: safePrice };
    } catch (e: any) {
      this.log('LIMIT_REPRICE_ERROR', {
        symbol: input.symbol,
        previousOrderId: input.previousOrderId,
        error: e?.message || 'reprice_failed',
      });
      return null;
    }
  }

  private getMakerLimitPrice(symbol: string, side: Side): number | null {
    const quote = this.connector.getQuote(symbol);
    if (quote && Number.isFinite(quote.bestBid) && Number.isFinite(quote.bestAsk)) {
      if (side === 'BUY') {
        return quote.bestBid > 0 ? quote.bestBid : null;
      }
      return quote.bestAsk > 0 ? quote.bestAsk : null;
    }
    const fallback = this.connector.expectedPrice(symbol, side, 'MARKET');
    if (!(typeof fallback === 'number' && Number.isFinite(fallback) && fallback > 0)) {
      return null;
    }
    const bufferBps = Number(process.env.LIMIT_REPRICE_BUFFER_BPS || this.config.plan.limitBufferBps || 2);
    const buffer = fallback * (bufferBps / 10_000);
    return side === 'BUY' ? Math.max(0, fallback - buffer) : fallback + buffer;
  }

  private currentDayKey(): string {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
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

export function createOrchestratorFromEnv(alertService?: AlertService): Orchestrator {
  const parseEnvFlag = (value: string | undefined): boolean => {
    if (!value) return false;
    const normalized = value.trim().replace(/^['"]|['"]$/g, '').toLowerCase();
    return normalized === 'true';
  };
  const parseNumberList = (value: string | undefined): number[] => {
    if (!value) return [];
    return value
      .split(',')
      .map((v) => Number(v.trim()))
      .filter((v) => Number.isFinite(v));
  };

  const executionEnabledEnv = parseEnvFlag(process.env.EXECUTION_ENABLED);
  const enableGateV2 = parseEnvFlag(process.env.ENABLE_GATE_V2);
  const gateMode: GateMode = enableGateV2 ? 'V2_NETWORK_LATENCY' : 'V1_NO_LATENCY';
  const gate: GateConfig = {
    mode: gateMode,
    maxSpreadPct: Number(process.env.MAX_SPREAD_PCT || 0.12),
    minObiDeep: Number(process.env.MIN_OBI_DEEP || 0.03),
    v2: {
      maxNetworkLatencyMs: Number(process.env.MAX_NETWORK_LATENCY_MS || 1500),
    },
  };

  const connector = new ExecutionConnector({
    enabled: executionEnabledEnv,
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

  const planConfig: OrchestratorConfig['plan'] = {
    planEpochMs: Number(process.env.PLAN_EPOCH_MS || 60_000),
    orderPrefix: String(process.env.PLAN_ORDER_PREFIX || 'p'),
    planRebuildCooldownMs: Number(process.env.PLAN_REBUILD_COOLDOWN_MS || 2000),
    minMarginUsdt: Number(process.env.MIN_MARGIN_USDT || 50),
    limitBufferBps: Number(process.env.LIMIT_BUFFER_BPS || 5),
    defaultTickSize: Number(process.env.DEFAULT_TICK_SIZE || 0.01),
    orderPriceTolerancePct: Number(process.env.PLAN_PRICE_TOL_PCT || 0.05),
    orderQtyTolerancePct: Number(process.env.PLAN_QTY_TOL_PCT || 1),
    replaceThrottlePerSecond: Number(process.env.PLAN_REPLACE_THROTTLE_PER_SEC || 5),
    cancelStalePlanOrders: parseEnvFlag(process.env.PLAN_CANCEL_STALE ?? 'true'),
    allowedSides: String(process.env.ALLOWED_SIDES || 'BOTH').toUpperCase() === 'LONG'
      ? 'LONG'
      : String(process.env.ALLOWED_SIDES || 'BOTH').toUpperCase() === 'SHORT'
        ? 'SHORT'
        : 'BOTH',
    volatilitySizing: {
      enabled: parseEnvFlag(process.env.VOLATILITY_SIZING_ENABLED ?? 'true'),
      referenceSymbol: String(process.env.VOLATILITY_REF_SYMBOL || 'ETHUSDT').toUpperCase(),
      minFactor: Number(process.env.VOLATILITY_MIN_FACTOR || 0.2),
      maxFactor: Number(process.env.VOLATILITY_MAX_FACTOR || 2.0),
    },
    boot: {
      probeMarketPct: Number(process.env.BOOT_PROBE_MARKET_PCT || 0.15),
      waitReadyMs: Number(process.env.BOOT_WAIT_READY_MS || 1500),
      maxSpreadPct: Number(process.env.BOOT_MAX_SPREAD_PCT || 0.12),
      minObiDeep: Number(process.env.BOOT_MIN_OBI_DEEP || 0.03),
      minDeltaZ: Number(process.env.BOOT_MIN_DELTA_Z || 0.15),
      allowMarket: parseEnvFlag(process.env.BOOT_ALLOW_MARKET ?? 'false'),
      retryMs: Number(process.env.BOOT_RETRY_MS || 5000),
    },
    trend: {
      upEnter: Number(process.env.TREND_UP_ENTER || 0.45),
      upExit: Number(process.env.TREND_UP_EXIT || 0.15),
      downEnter: Number(process.env.TREND_DOWN_ENTER || -0.45),
      downExit: Number(process.env.TREND_DOWN_EXIT || -0.15),
      confirmTicks: Number(process.env.TREND_CONFIRM_TICKS || 3),
      reversalConfirmTicks: Number(process.env.TREND_REVERSAL_CONFIRM_TICKS || 4),
      obiNorm: Number(process.env.TREND_OBI_NORM || 0.3),
      deltaNorm: Number(process.env.TREND_DELTA_NORM || 1.0),
      cvdNorm: Number(process.env.TREND_CVD_NORM || 0.8),
      scoreClamp: Number(process.env.TREND_SCORE_CLAMP || 1.0),
    },
    scaleIn: {
      levels: Number(process.env.SCALE_IN_LEVELS || 3),
      stepPct: Number(process.env.SCALE_IN_STEP_PCT || 0.15),
      maxAdds: Number(process.env.MAX_ADDS || 3),
      addOnlyIfTrendConfirmed: parseEnvFlag(process.env.ADD_ONLY_IF_TREND_CONFIRMED ?? 'true'),
      addMinUpnlUsdt: Number(process.env.ADD_MIN_UPNL_USDT || 0),
      addMinUpnlR: Number(process.env.ADD_MIN_UPNL_R || 0),
    },
    tp: {
      levels: Number(process.env.TP_LEVELS || 3),
      stepPcts: parseNumberList(process.env.TP_STEP_PCTS || '0.2,0.45,0.8'),
      distribution: parseNumberList(process.env.TP_DISTRIBUTION || '40,35,25'),
      reduceOnly: parseEnvFlag(process.env.TP_REDUCE_ONLY ?? 'true'),
    },
    stop: {
      distancePct: Number(process.env.STOP_DISTANCE_PCT || 0.8),
      reduceOnly: parseEnvFlag(process.env.STOP_REDUCE_ONLY ?? 'true'),
      riskPct: Number(process.env.STOP_RISK_PCT || 0),
    },
    profitLock: {
      lockTriggerUsdt: Number(process.env.LOCK_TRIGGER_USDT || 0),
      lockTriggerR: Number(process.env.LOCK_TRIGGER_R || 0.25),
      maxDdFromPeakUsdt: Number(process.env.MAX_DD_FROM_PEAK_USDT || 0),
      maxDdFromPeakR: Number(process.env.MAX_DD_FROM_PEAK_R || 0.15),
    },
    reversalExitMode: String(process.env.REVERSAL_EXIT_MODE || 'MARKET').toUpperCase() === 'LIMIT' ? 'LIMIT' : 'MARKET',
    exitLimitBufferBps: Number(process.env.EXIT_LIMIT_BUFFER_BPS || 5),
    exitRetryMs: Number(process.env.EXIT_RETRY_MS || 3000),
    allowFlip: parseEnvFlag(process.env.ALLOW_FLIP ?? 'false'),
    initialMarginUsdt: Number(process.env.INITIAL_MARGIN_USDT || process.env.STARTING_MARGIN_USDT || 0),
    maxMarginUsdt: Number(process.env.MAX_MARGIN_USDT || 0),
    stepUp: {
      mode: String(process.env.RISK_STEP_UP_MODE || 'UPNL').toUpperCase() === 'R_MULTIPLE'
        ? 'R_MULTIPLE'
        : String(process.env.RISK_STEP_UP_MODE || 'UPNL').toUpperCase() === 'TREND_SCORE'
          ? 'TREND_SCORE'
          : 'UPNL',
      stepPct: Number(process.env.STEP_UP_PCT || 0.2),
      triggerUsdt: Number(process.env.STEP_UP_TRIGGER_USDT || 0),
      triggerR: Number(process.env.STEP_UP_TRIGGER_R || 0.5),
      minTrendScore: Number(process.env.STEP_UP_MIN_TREND_SCORE || 0.4),
      cooldownMs: Number(process.env.STEP_UP_COOLDOWN_MS || 15000),
    },
  };

  return new Orchestrator(connector, {
    maxLeverage: Number(process.env.MAX_LEVERAGE || 125),
    loggerQueueLimit: Number(process.env.LOGGER_QUEUE_LIMIT || 10000),
    loggerDropHaltThreshold: Number(process.env.LOGGER_DROP_HALT_THRESHOLD || 500),
    gate,
    cooldown: {
      minMs: Number(process.env.COOLDOWN_MIN_MS || 1000),
      maxMs: Number(process.env.COOLDOWN_MAX_MS || 15000),
    },
    startingMarginUsdt: Number(process.env.STARTING_MARGIN_USDT || 0),
    minMarginUsdt: Number(process.env.MIN_MARGIN_USDT || 0),
    rampStepPct: Number(process.env.RAMP_STEP_PCT || 10),
    rampDecayPct: Number(process.env.RAMP_DECAY_PCT || 20),
    rampMaxMult: Number(process.env.RAMP_MAX_MULT || 5),
    hardStopLossPct: Number(process.env.HARD_STOP_LOSS_PCT || 1),
    dailyKillSwitchPct: Number(process.env.DAILY_KILL_SWITCH_PCT || 0.05),
    liquidationEmergencyMarginRatio: Number(process.env.LIQUIDATION_EMERGENCY_MARGIN_RATIO || 0.3),
    takerFeeBps: Number(process.env.TAKER_FEE_BPS || 4),
    profitLockBufferBps: Number(process.env.PROFIT_LOCK_BUFFER_BPS || 2),
    plan: planConfig,
  }, alertService);
}
