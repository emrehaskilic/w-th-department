export type OrderbookIntegrityLevel = 'OK' | 'DEGRADED' | 'CRITICAL';

export interface OrderbookIntegrityStatus {
  symbol: string;
  level: OrderbookIntegrityLevel;
  message: string;
  lastUpdateTimestamp: number;
  sequenceGapCount: number;
  crossedBookDetected: boolean;
  avgStalenessMs: number;
  reconnectCount: number;
  reconnectRecommended: boolean;
}

export interface OrderbookIntegrityInput {
  symbol: string;
  sequenceStart: number;
  sequenceEnd: number;
  eventTimeMs: number;
  bestBid: number | null;
  bestAsk: number | null;
  nowMs: number;
}

export interface OrderbookIntegrityConfig {
  staleWarnMs: number;
  staleCriticalMs: number;
  maxGapBeforeCritical: number;
  reconnectCooldownMs: number;
}

const DEFAULT_CONFIG: OrderbookIntegrityConfig = {
  staleWarnMs: 1500,
  staleCriticalMs: 5000,
  maxGapBeforeCritical: 3,
  reconnectCooldownMs: 15000,
};

export class OrderbookIntegrityMonitor {
  private readonly symbol: string;
  private readonly config: OrderbookIntegrityConfig;

  private lastSequenceEnd = 0;
  private lastUpdateTimestamp = 0;
  private sequenceGapCount = 0;
  private crossedBookDetected = false;
  private avgStalenessMs = 0;
  private reconnectCount = 0;
  private lastReconnectTimestamp = 0;

  constructor(symbol: string, config?: Partial<OrderbookIntegrityConfig>) {
    this.symbol = symbol;
    this.config = {
      ...DEFAULT_CONFIG,
      ...(config || {}),
    };
  }

  observe(input: OrderbookIntegrityInput): OrderbookIntegrityStatus {
    this.lastUpdateTimestamp = input.nowMs;

    if (this.lastSequenceEnd > 0 && input.sequenceStart > this.lastSequenceEnd + 1) {
      this.sequenceGapCount += 1;
    }
    this.lastSequenceEnd = Math.max(this.lastSequenceEnd, input.sequenceEnd);

    const stalenessMs = Math.max(0, input.nowMs - Math.max(0, input.eventTimeMs));
    this.avgStalenessMs = this.avgStalenessMs === 0
      ? stalenessMs
      : (this.avgStalenessMs * 0.85) + (stalenessMs * 0.15);

    this.crossedBookDetected = Boolean(
      input.bestBid !== null &&
      input.bestAsk !== null &&
      input.bestBid >= input.bestAsk
    );

    const level = this.deriveLevel(stalenessMs);
    const reconnectRecommended = this.shouldReconnect(level, input.nowMs);
    const message = this.buildMessage(level, stalenessMs);

    return {
      symbol: this.symbol,
      level,
      message,
      lastUpdateTimestamp: this.lastUpdateTimestamp,
      sequenceGapCount: this.sequenceGapCount,
      crossedBookDetected: this.crossedBookDetected,
      avgStalenessMs: Number(this.avgStalenessMs.toFixed(2)),
      reconnectCount: this.reconnectCount,
      reconnectRecommended,
    };
  }

  markReconnect(nowMs: number): void {
    this.reconnectCount += 1;
    this.lastReconnectTimestamp = nowMs;
  }

  getStatus(nowMs: number): OrderbookIntegrityStatus {
    const stalenessMs = this.lastUpdateTimestamp > 0 ? Math.max(0, nowMs - this.lastUpdateTimestamp) : nowMs;
    const level = this.deriveLevel(stalenessMs);
    return {
      symbol: this.symbol,
      level,
      message: this.buildMessage(level, stalenessMs),
      lastUpdateTimestamp: this.lastUpdateTimestamp,
      sequenceGapCount: this.sequenceGapCount,
      crossedBookDetected: this.crossedBookDetected,
      avgStalenessMs: Number(this.avgStalenessMs.toFixed(2)),
      reconnectCount: this.reconnectCount,
      reconnectRecommended: this.shouldReconnect(level, nowMs),
    };
  }

  private deriveLevel(stalenessMs: number): OrderbookIntegrityLevel {
    if (this.crossedBookDetected) {
      return 'CRITICAL';
    }
    if (stalenessMs > this.config.staleCriticalMs || this.sequenceGapCount > this.config.maxGapBeforeCritical) {
      return 'CRITICAL';
    }
    if (stalenessMs > this.config.staleWarnMs || this.sequenceGapCount > 0) {
      return 'DEGRADED';
    }
    return 'OK';
  }

  private shouldReconnect(level: OrderbookIntegrityLevel, nowMs: number): boolean {
    if (level !== 'CRITICAL') {
      return false;
    }
    return (nowMs - this.lastReconnectTimestamp) >= this.config.reconnectCooldownMs;
  }

  private buildMessage(level: OrderbookIntegrityLevel, stalenessMs: number): string {
    if (level === 'OK') {
      return 'orderbook_ok';
    }
    if (this.crossedBookDetected) {
      return 'crossed_book_detected';
    }
    if (stalenessMs > this.config.staleCriticalMs) {
      return 'orderbook_stale_critical';
    }
    if (stalenessMs > this.config.staleWarnMs) {
      return 'orderbook_stale_warning';
    }
    if (this.sequenceGapCount > this.config.maxGapBeforeCritical) {
      return 'sequence_gaps_critical';
    }
    return 'sequence_gap_detected';
  }
}
