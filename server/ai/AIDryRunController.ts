import { DecisionLog } from '../telemetry/DecisionLog';
import { StrategyAction, StrategyActionType, StrategyDecision, StrategyDecisionLog, StrategyRegime, StrategySide } from '../types/strategy';
import { DryRunSessionService } from '../dryrun/DryRunSessionService';
import { generateContent } from './GoogleAIClient';

type AIDryRunConfig = {
  apiKey: string;
  model: string;
  decisionIntervalMs: number;
  temperature: number;
  maxOutputTokens: number;
};

type AIDryRunStatus = {
  active: boolean;
  model: string | null;
  decisionIntervalMs: number;
  temperature: number;
  maxOutputTokens: number;
  apiKeySet: boolean;
  lastError: string | null;
  symbols: string[];
};

type AIMetricsSnapshot = {
  symbol: string;
  timestampMs: number;
  decision: {
    regime: StrategyRegime;
    dfs: number;
    dfsPercentile: number;
    volLevel: number;
    gatePassed: boolean;
    thresholds: {
      longEntry: number;
      longBreak: number;
      shortEntry: number;
      shortBreak: number;
    };
  };
  market: {
    price: number;
    vwap: number;
    spreadPct: number | null;
    delta1s: number;
    delta5s: number;
    deltaZ: number;
    cvdSlope: number;
    obiWeighted: number;
    obiDeep: number;
    obiDivergence: number;
  };
  trades: {
    printsPerSecond: number;
    tradeCount: number;
    aggressiveBuyVolume: number;
    aggressiveSellVolume: number;
    burstCount: number;
    burstSide: 'buy' | 'sell' | null;
  };
  openInterest: {
    oiChangePct: number | null;
  };
  absorption: {
    value: number;
    side: 'buy' | 'sell' | null;
  };
  volatility: number;
  position: {
    side: StrategySide;
    qty: number;
    entryPrice: number;
    unrealizedPnlPct: number;
    addsUsed: number;
  } | null;
};

type AIAction = {
  action: 'HOLD' | 'ENTRY' | 'EXIT' | 'REDUCE' | 'ADD';
  side?: 'LONG' | 'SHORT';
  sizeMultiplier?: number;
  reducePct?: number;
  reason?: string;
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const normalizeSide = (raw?: string | null): StrategySide | null => {
  const value = String(raw || '').trim().toUpperCase();
  if (!value) return null;
  if (value === 'LONG' || value === 'BUY') return 'LONG';
  if (value === 'SHORT' || value === 'SELL') return 'SHORT';
  return null;
};

export class AIDryRunController {
  private active = false;
  private config: AIDryRunConfig | null = null;
  private symbols = new Set<string>();
  private readonly lastDecisionTs = new Map<string, number>();
  private readonly pending = new Set<string>();
  private lastError: string | null = null;

  constructor(
    private readonly dryRunSession: DryRunSessionService,
    private readonly decisionLog?: DecisionLog,
    private readonly log?: (event: string, data?: Record<string, unknown>) => void
  ) {}

  start(input: { symbols: string[]; apiKey: string; model: string; decisionIntervalMs?: number; temperature?: number; maxOutputTokens?: number }): void {
    const symbols = input.symbols.map((s) => s.toUpperCase()).filter(Boolean);
    this.symbols = new Set(symbols);
    this.config = {
      apiKey: input.apiKey,
      model: input.model,
      decisionIntervalMs: Math.max(250, Number(input.decisionIntervalMs ?? 1000)),
      temperature: Number.isFinite(input.temperature as number) ? Number(input.temperature) : 0,
      maxOutputTokens: Math.max(64, Number(input.maxOutputTokens ?? 256)),
    };
    this.active = true;
    this.lastError = null;
    this.log?.('AI_DRY_RUN_START', { symbols, model: this.config.model });
  }

  stop(): void {
    this.active = false;
    this.symbols.clear();
    this.pending.clear();
    this.log?.('AI_DRY_RUN_STOP', {});
  }

  isActive(): boolean {
    return this.active && !!this.config;
  }

  isTrackingSymbol(symbol: string): boolean {
    return this.isActive() && this.symbols.has(symbol.toUpperCase());
  }

  getStatus(): AIDryRunStatus {
    return {
      active: this.isActive(),
      model: this.config?.model ?? null,
      decisionIntervalMs: this.config?.decisionIntervalMs ?? 0,
      temperature: this.config?.temperature ?? 0,
      maxOutputTokens: this.config?.maxOutputTokens ?? 0,
      apiKeySet: Boolean(this.config?.apiKey),
      lastError: this.lastError,
      symbols: [...this.symbols],
    };
  }

  async onMetrics(snapshot: AIMetricsSnapshot): Promise<void> {
    if (!this.isActive() || !this.config) return;
    if (!this.isTrackingSymbol(snapshot.symbol)) return;
    if (!snapshot.decision.gatePassed) return;

    const nowMs = snapshot.timestampMs;
    const lastTs = this.lastDecisionTs.get(snapshot.symbol) || 0;
    if (nowMs - lastTs < this.config.decisionIntervalMs) return;
    if (this.pending.has(snapshot.symbol)) return;

    this.pending.add(snapshot.symbol);
    try {
      const prompt = this.buildPrompt(snapshot);
      const response = await generateContent(this.config, prompt);
      if (!response.text) {
        this.lastError = 'ai_empty_response';
        this.log?.('AI_DRY_RUN_ERROR', { symbol: snapshot.symbol, error: this.lastError });
        return;
      }
      const action = this.parseAction(response.text);
      if (!action) {
        this.lastError = 'ai_parse_failed';
        this.log?.('AI_DRY_RUN_ERROR', { symbol: snapshot.symbol, error: this.lastError });
        return;
      }
      if ((action.action === 'ENTRY' || action.action === 'ADD') && !action.side) {
        this.lastError = 'ai_invalid_side';
        this.log?.('AI_DRY_RUN_ERROR', { symbol: snapshot.symbol, error: this.lastError });
        return;
      }

      const decision = this.buildDecision(snapshot, action);
      if (decision.actions.length > 0) {
        this.dryRunSession.submitStrategyDecision(snapshot.symbol, decision, snapshot.timestampMs);
      }

      this.lastDecisionTs.set(snapshot.symbol, nowMs);
      this.recordDecisionLog(snapshot, decision, action);
      this.lastError = null;
    } catch (error: any) {
      this.lastError = error?.message || 'ai_decision_failed';
      this.log?.('AI_DRY_RUN_ERROR', { symbol: snapshot.symbol, error: this.lastError });
    } finally {
      this.pending.delete(snapshot.symbol);
    }
  }

  private buildPrompt(snapshot: AIMetricsSnapshot): string {
    const pos = snapshot.position;
    const payload = {
      symbol: snapshot.symbol,
      timestampMs: snapshot.timestampMs,
      gatePassed: snapshot.decision.gatePassed,
      regime: snapshot.decision.regime,
      dfs: snapshot.decision.dfs,
      dfsPercentile: snapshot.decision.dfsPercentile,
      volLevel: snapshot.decision.volLevel,
      thresholds: snapshot.decision.thresholds,
      market: snapshot.market,
      trades: snapshot.trades,
      openInterest: snapshot.openInterest,
      absorption: snapshot.absorption,
      volatility: snapshot.volatility,
      position: pos
        ? {
            side: pos.side,
            qty: pos.qty,
            entryPrice: pos.entryPrice,
            unrealizedPnlPct: pos.unrealizedPnlPct,
            addsUsed: pos.addsUsed,
          }
        : null,
    };

    return [
      'You are an autonomous trading decision engine for a futures paper-trading simulation.',
      'Use only the provided metrics. Output strict JSON ONLY with no extra text.',
      'Allowed actions: HOLD, ENTRY, EXIT, REDUCE, ADD.',
      'Rules:',
      '- If gatePassed=false, output HOLD.',
      '- If position is null, do not output ADD/REDUCE/EXIT.',
      '- If position exists, ENTRY should only be used to flip after EXIT; otherwise use ADD/REDUCE/EXIT.',
      '- sizeMultiplier must be between 0.1 and 2.0 when provided.',
      '- reducePct must be between 0.1 and 1.0 when provided.',
      'Output JSON schema:',
      '{"action":"HOLD"} or {"action":"ENTRY","side":"LONG|SHORT","sizeMultiplier":0.5,"reason":"..."}',
      '{"action":"ADD","side":"LONG|SHORT","sizeMultiplier":0.5,"reason":"..."}',
      '{"action":"REDUCE","reducePct":0.5,"reason":"..."}',
      '{"action":"EXIT","reason":"..."}',
      '',
      'Snapshot:',
      JSON.stringify(payload),
    ].join('\n');
  }

  private parseAction(text: string): AIAction | null {
    const trimmed = text.trim();
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    const jsonText = trimmed.slice(start, end + 1);
    try {
      const parsed = JSON.parse(jsonText) as AIAction;
      if (!parsed || typeof parsed.action !== 'string') return null;
      const rawAction = parsed.action.trim().toUpperCase();
      let action: AIAction['action'] | null = null;
      let side = normalizeSide(parsed.side);
      if (['HOLD', 'ENTRY', 'EXIT', 'REDUCE', 'ADD'].includes(rawAction)) {
        action = rawAction as AIAction['action'];
      } else if (rawAction === 'BUY' || rawAction === 'LONG') {
        action = 'ENTRY';
        side = side ?? 'LONG';
      } else if (rawAction === 'SELL' || rawAction === 'SHORT') {
        action = 'ENTRY';
        side = side ?? 'SHORT';
      } else {
        return null;
      }
      return {
        action,
        side: side ?? undefined,
        sizeMultiplier: parsed.sizeMultiplier,
        reducePct: parsed.reducePct,
        reason: parsed.reason,
      };
    } catch {
      return null;
    }
  }

  private buildDecision(snapshot: AIMetricsSnapshot, aiAction: AIAction): StrategyDecision {
    const actions: StrategyAction[] = [];
    const nowMs = snapshot.timestampMs;
    const regime = snapshot.decision.regime;

    if (aiAction.action === 'HOLD') {
      actions.push({ type: StrategyActionType.NOOP, reason: 'NOOP', metadata: { ai: true, note: aiAction.reason || null } });
    }

    if (aiAction.action === 'ENTRY' && aiAction.side) {
      actions.push({
        type: StrategyActionType.ENTRY,
        side: aiAction.side as StrategySide,
        reason: 'ENTRY_TR',
        expectedPrice: snapshot.market.price,
        sizeMultiplier: clamp(Number(aiAction.sizeMultiplier ?? 1), 0.1, 2),
        metadata: { ai: true, note: aiAction.reason || null },
      });
    }

    if (aiAction.action === 'ADD' && aiAction.side) {
      actions.push({
        type: StrategyActionType.ADD,
        side: aiAction.side as StrategySide,
        reason: 'ADD_WINNER',
        expectedPrice: snapshot.market.price,
        sizeMultiplier: clamp(Number(aiAction.sizeMultiplier ?? 0.5), 0.1, 2),
        metadata: { ai: true, note: aiAction.reason || null },
      });
    }

    if (aiAction.action === 'REDUCE') {
      actions.push({
        type: StrategyActionType.REDUCE,
        reason: 'REDUCE_SOFT',
        reducePct: clamp(Number(aiAction.reducePct ?? 0.5), 0.1, 1),
        metadata: { ai: true, note: aiAction.reason || null },
      });
    }

    if (aiAction.action === 'EXIT') {
      actions.push({
        type: StrategyActionType.EXIT,
        reason: 'EXIT_HARD',
        metadata: { ai: true, note: aiAction.reason || null },
      });
    }

    const log: StrategyDecisionLog = {
      timestampMs: nowMs,
      symbol: snapshot.symbol,
      regime,
      gate: { passed: snapshot.decision.gatePassed, reason: null, details: { ai: true } },
      dfs: snapshot.decision.dfs,
      dfsPercentile: snapshot.decision.dfsPercentile,
      volLevel: snapshot.decision.volLevel,
      thresholds: snapshot.decision.thresholds,
      reasons: actions.map((a) => a.reason),
      actions,
      stats: {
        aiDecision: 1,
      },
    };

    return {
      symbol: snapshot.symbol,
      timestampMs: nowMs,
      regime,
      dfs: snapshot.decision.dfs,
      dfsPercentile: snapshot.decision.dfsPercentile,
      volLevel: snapshot.decision.volLevel,
      gatePassed: snapshot.decision.gatePassed,
      reasons: actions.map((a) => a.reason),
      actions,
      log,
    };
  }

  private recordDecisionLog(snapshot: AIMetricsSnapshot, decision: StrategyDecision, action: AIAction): void {
    if (!this.decisionLog) return;
    const payload: StrategyDecisionLog = {
      ...decision.log,
      stats: {
        ...decision.log.stats,
        aiAction: action.action,
      },
    };
    this.decisionLog.record(payload);
  }
}
