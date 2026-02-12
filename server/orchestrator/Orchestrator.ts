import * as path from 'path';
import { ExecutionConnector } from '../connectors/ExecutionConnector';
import { ExecutionEvent } from '../connectors/executionTypes';
import { BinanceExecutor } from '../execution/BinanceExecutor';
import { RiskManager } from '../risk/RiskManager';
import { SymbolActor } from './Actor';
import { DecisionEngine } from './Decision';
import { runGate } from './Gate';
import { OrchestratorLogger } from './Logger';
import { PlannedOrder } from './OrderPlan';
import { PlanRunner, PlanTickResult } from './PlanRunner';
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
  private readonly planRunners = new Map<string, PlanRunner>();
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
        this.planRunners.delete(symbol);
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
      getRampMult: () => this.getRampMult(normalized),
      getEffectiveLeverage: () => this.getEffectiveLeverage(),
      getExecutionReady: () => this.getExecutionGateState().ready,
      onPositionClosed: (realizedPnl) => this.onPositionClosed(normalized, realizedPnl),
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
    const side = order.side;
    const leverage = this.getEffectiveLeverage();
    const marginBudget = this.getCurrentMarginBudgetUsdt(order.symbol);
    const bufferBps = 0;

    let price = 0;
    if (order.type === 'LIMIT') {
      price = typeof order.price === 'number' && Number.isFinite(order.price) ? order.price : 0;
    } else {
      const expected = this.connector.expectedPrice(order.symbol, side, 'MARKET');
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

    if (!order.reduceOnly) {
      const risk = this.getRiskManager(order.symbol);
      const riskCheck = risk.check(order.symbol, side, sizingPrice, sizingQty, {
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
        return;
      }
    }

    try {
      const res = await this.connector.placeOrder({
        symbol: order.symbol,
        side,
        type: order.type,
        quantity: sizingQty,
        price: order.type === 'LIMIT' ? sizingPrice : undefined,
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
      }
      if (!order.reduceOnly) {
        this.getRiskManager(order.symbol).recordTrade(order.symbol);
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

  private async cancelPlannedOrder(symbol: string, order: { orderId?: string; clientOrderId?: string }): Promise<boolean> {
    try {
      await this.connector.cancelOrder({
        symbol,
        orderId: order.orderId,
        clientOrderId: order.clientOrderId,
      });
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

  const planConfig = {
    planEpochMs: Number(process.env.PLAN_EPOCH_MS || 60_000),
    orderPrefix: String(process.env.PLAN_ORDER_PREFIX || 'p'),
    planRebuildCooldownMs: Number(process.env.PLAN_REBUILD_COOLDOWN_MS || 2000),
    orderPriceTolerancePct: Number(process.env.PLAN_PRICE_TOL_PCT || 0.05),
    orderQtyTolerancePct: Number(process.env.PLAN_QTY_TOL_PCT || 1),
    replaceThrottlePerSecond: Number(process.env.PLAN_REPLACE_THROTTLE_PER_SEC || 5),
    cancelStalePlanOrders: parseEnvFlag(process.env.PLAN_CANCEL_STALE ?? 'true'),
    boot: {
      probeMarketPct: Number(process.env.BOOT_PROBE_MARKET_PCT || 0.15),
      waitReadyMs: Number(process.env.BOOT_WAIT_READY_MS || 1500),
      maxSpreadPct: Number(process.env.BOOT_MAX_SPREAD_PCT || 0.12),
      minObiDeep: Number(process.env.BOOT_MIN_OBI_DEEP || 0.03),
      minDeltaZ: Number(process.env.BOOT_MIN_DELTA_Z || 0.15),
      allowMarket: parseEnvFlag(process.env.BOOT_ALLOW_MARKET ?? 'true'),
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
    profitLock: {
      lockTriggerUsdt: Number(process.env.LOCK_TRIGGER_USDT || 0),
      lockTriggerR: Number(process.env.LOCK_TRIGGER_R || 0.25),
      maxDdFromPeakUsdt: Number(process.env.MAX_DD_FROM_PEAK_USDT || 0),
      maxDdFromPeakR: Number(process.env.MAX_DD_FROM_PEAK_R || 0.25),
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
    liquidationEmergencyMarginRatio: Number(process.env.LIQUIDATION_EMERGENCY_MARGIN_RATIO || 0.3),
    takerFeeBps: Number(process.env.TAKER_FEE_BPS || 4),
    profitLockBufferBps: Number(process.env.PROFIT_LOCK_BUFFER_BPS || 2),
    plan: planConfig,
  });
}
