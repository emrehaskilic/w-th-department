import * as fs from 'fs';
import * as path from 'path';

export type DryRunLogEventType = 'SIGNAL' | 'ENTRY' | 'EXIT' | 'SNAPSHOT';

export interface DryRunOrderflowMetrics {
  obiWeighted: number | null;
  obiDeep: number | null;
  deltaZ: number | null;
  cvdSlope: number | null;
}

export interface DryRunSignalLog {
  type: 'SIGNAL';
  runId: string;
  symbol: string;
  timestampMs: number;
  side: 'LONG' | 'SHORT';
  signalType: string;
  score: number;
  vetoReason: string | null;
  candidate: {
    entryPrice: number;
    tpPrice: number;
    slPrice: number;
  } | null;
  orderflow: DryRunOrderflowMetrics;
  boost?: {
    score: number;
    contributions?: Record<string, number> | null;
    timeframeMultipliers?: Record<string, number> | null;
  };
  market?: {
    price: number | null;
    atr: number | null;
    avgAtr: number | null;
    recentHigh: number | null;
    recentLow: number | null;
  };
}

export interface DryRunEntryLog {
  type: 'ENTRY';
  runId: string;
  symbol: string;
  timestampMs: number;
  tradeId: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  qty: number;
  notional: number;
  marginUsed: number;
  leverage: number;
  reason: string;
  signalType: string | null;
  signalScore: number | null;
  orderflow: DryRunOrderflowMetrics;
  candidate: DryRunSignalLog['candidate'] | null;
}

export interface DryRunExitLog {
  type: 'EXIT';
  runId: string;
  symbol: string;
  timestampMs: number;
  tradeId: string;
  side: 'LONG' | 'SHORT';
  entryTimeMs: number;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  reason: string;
  durationMs: number;
  pnl: {
    realizedUsdt: number;
    feeUsdt: number;
    fundingUsdt: number;
    netUsdt: number;
    returnPct: number | null;
    rMultiple: number | null;
  };
  cumulative?: {
    totalPnL: number;
    totalTrades: number;
    winCount: number;
    winRate: number;
  };
  orderflow: DryRunOrderflowMetrics;
  candidate: DryRunSignalLog['candidate'] | null;
}

export interface DryRunSnapshotLog {
  type: 'SNAPSHOT';
  runId: string;
  symbol: string;
  timestampMs: number;
  markPrice: number;
  walletBalance: number;
  totalEquity: number;
  unrealizedPnl: number;
  realizedPnl: number;
  feePaid: number;
  fundingPnl: number;
  marginHealth: number;
  position: {
    side: 'LONG' | 'SHORT';
    qty: number;
    entryPrice: number;
  } | null;
}

export type DryRunLogEvent = DryRunSignalLog | DryRunEntryLog | DryRunExitLog | DryRunSnapshotLog;

export interface DryRunLoggerConfig {
  dir: string;
  queueLimit?: number;
  dropHaltThreshold?: number;
  onDropSpike?: (count: number) => void;
}

type QueueItem = {
  eventTimeMs: number;
  payload: DryRunLogEvent;
};

export class DryRunTradeLogger {
  private readonly queue: QueueItem[] = [];
  private readonly streams = new Map<string, fs.WriteStream>();
  private flushing = false;
  private dropCount = 0;
  private dropWindowCount = 0;
  private readonly queueLimit: number;
  private readonly dropHaltThreshold: number;
  private readonly onDropSpike?: (count: number) => void;

  constructor(private readonly config: DryRunLoggerConfig) {
    fs.mkdirSync(config.dir, { recursive: true });
    this.queueLimit = Number.isFinite(config.queueLimit as number) ? Number(config.queueLimit) : 10000;
    this.dropHaltThreshold = Number.isFinite(config.dropHaltThreshold as number)
      ? Number(config.dropHaltThreshold)
      : 2000;
    this.onDropSpike = config.onDropSpike;

    setInterval(() => {
      if (this.dropWindowCount >= this.dropHaltThreshold && this.onDropSpike) {
        this.onDropSpike(this.dropWindowCount);
      }
      this.dropWindowCount = 0;
    }, 10_000);
  }

  log(event: DryRunLogEvent): void {
    const eventTimeMs = Number.isFinite(event.timestampMs) && event.timestampMs > 0
      ? event.timestampMs
      : Date.now();
    this.enqueue({ eventTimeMs, payload: event });
  }

  shutdown(): void {
    for (const stream of this.streams.values()) {
      stream.end();
    }
    this.streams.clear();
  }

  private enqueue(item: QueueItem): void {
    if (this.queue.length >= this.queueLimit) {
      this.dropCount += 1;
      this.dropWindowCount += 1;
      return;
    }

    this.queue.push(item);
    if (!this.flushing) {
      this.flushing = true;
      setImmediate(() => this.flush());
    }
  }

  private flush(): void {
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      const line = JSON.stringify(item.payload) + '\n';
      const stream = this.getStream(item.eventTimeMs);
      const ok = stream.write(line);
      if (!ok && this.queue.length < this.queueLimit) {
        this.queue.unshift(item);
        stream.once('drain', () => this.flush());
        this.flushing = false;
        return;
      }
    }

    this.flushing = false;
  }

  private getStream(eventTimeMs: number): fs.WriteStream {
    const date = this.dateToken(eventTimeMs);
    const key = `dryrun:${date}`;
    const existing = this.streams.get(key);
    if (existing) return existing;

    const filePath = path.join(this.config.dir, `dryrun_${date}.jsonl`);
    const stream = fs.createWriteStream(filePath, { flags: 'a' });
    this.streams.set(key, stream);
    return stream;
  }

  private dateToken(eventTimeMs: number): string {
    const d = new Date(eventTimeMs);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${yyyy}${mm}${dd}`;
  }
}
