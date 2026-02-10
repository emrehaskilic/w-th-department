import { ExecutionConnector } from '../connectors/ExecutionConnector';
import {
  OrchestratorConfig,
  OrchestratorMetricsInput,
} from './types';

export class Orchestrator {
  private readonly realizedPnlBySymbol = new Map<string, number>();
  private readonly executionSymbols = new Set<string>();

  private capitalSettings = {
    leverage: 10,
  };

  constructor(
    private readonly connector: ExecutionConnector,
    private readonly config: OrchestratorConfig
  ) {
    this.capitalSettings.leverage = Math.min(this.connector.getPreferredLeverage(), config.maxLeverage);
    this.connector.setPreferredLeverage(this.capitalSettings.leverage);

    this.connector.onExecutionEvent((event) => {
      if (event.type === 'TRADE_UPDATE') {
        const prev = this.realizedPnlBySymbol.get(event.symbol) || 0;
        this.realizedPnlBySymbol.set(event.symbol, prev + event.realizedPnl);
      }
    });
  }

  getConnector() {
    return this.connector;
  }

  async start() {
    await this.connector.start();
  }

  ingest(metrics: OrchestratorMetricsInput) {
    const symbol = metrics.symbol.toUpperCase();
    this.connector.ensureSymbol(symbol);
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

    for (const sym of selectedSymbols) {
      totalRealized += this.realizedPnlBySymbol.get(sym) || 0;
    }

    return {
      connection: connectorStatus,
      selectedSymbols,
      settings: this.capitalSettings,
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
  }) {
    if (typeof input.leverage === 'number' && Number.isFinite(input.leverage) && input.leverage > 0) {
      this.capitalSettings.leverage = Math.min(input.leverage, this.config.maxLeverage);
      this.connector.setPreferredLeverage(this.capitalSettings.leverage);
    }
    return this.capitalSettings;
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
    }
    this.connector.setSymbols(normalized);
    await this.connector.syncState();
  }
}

export function createOrchestratorFromEnv(): Orchestrator {
  const executionEnabledEnv = String(process.env.EXECUTION_ENABLED || 'false').toLowerCase();

  const connector = new ExecutionConnector({
    enabled: executionEnabledEnv === 'true' || executionEnabledEnv === '1',
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
  });
}

