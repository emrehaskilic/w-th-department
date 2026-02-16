import { promises as fs } from 'fs';
import * as path from 'path';
import { StrategyDecisionLog } from '../types/strategy';

interface DecisionLogConfig {
  dir?: string;
  filename?: string;
  flushIntervalMs?: number;
  maxBatch?: number;
}

export class DecisionLog {
  private readonly filePath: string;
  private readonly flushIntervalMs: number;
  private readonly maxBatch: number;
  private readonly queue: StrategyDecisionLog[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;

  constructor(config?: DecisionLogConfig) {
    const dir = config?.dir ?? path.join(process.cwd(), 'logs');
    const filename = config?.filename ?? 'decision_log.jsonl';
    this.filePath = path.join(dir, filename);
    this.flushIntervalMs = Math.max(250, config?.flushIntervalMs ?? 1000);
    this.maxBatch = Math.max(10, config?.maxBatch ?? 200);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  record(entry: StrategyDecisionLog): void {
    this.queue.push(entry);
    if (this.queue.length >= this.maxBatch) {
      void this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    const batch = this.queue.splice(0, this.maxBatch);
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const payload = batch.map((e) => JSON.stringify(e)).join('\n') + '\n';
      await fs.appendFile(this.filePath, payload, 'utf8');
    } catch {
      // Swallow to avoid blocking main loop
    } finally {
      this.flushing = false;
    }
  }
}
