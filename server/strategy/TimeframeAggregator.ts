export interface TimeframeSample {
  timestampMs: number;
  values: Record<string, number>;
}

const DEFAULT_WINDOWS_MS = [1000, 5000, 30000, 60000] as const;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function signOrZero(value: number): -1 | 0 | 1 {
  if (value > 0) return 1;
  if (value < 0) return -1;
  return 0;
}

export class TimeframeAggregator {
  private readonly windowsMs: number[];
  private readonly maxHistoryMs: number;
  private history: TimeframeSample[] = [];

  constructor(
    windowsMs: number[] = [...DEFAULT_WINDOWS_MS],
    maxHistoryMs = 70000
  ) {
    this.windowsMs = windowsMs.filter((w) => Number.isFinite(w) && w > 0).sort((a, b) => a - b);
    this.maxHistoryMs = Math.max(maxHistoryMs, this.windowsMs[this.windowsMs.length - 1] ?? 0);
  }

  add(values: Record<string, number>, timestampMs: number): void {
    if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
      return;
    }
    this.history.push({ timestampMs, values: { ...values } });
    this.prune(timestampMs);
  }

  getTimeframeMultipliers(currentValues: Record<string, number>, timestampMs: number): Record<string, number> {
    const multipliers: Record<string, number> = {};
    this.prune(timestampMs);

    const metricKeys = Object.keys(currentValues);
    for (const metric of metricKeys) {
      const current = currentValues[metric];
      if (!Number.isFinite(current)) {
        multipliers[metric] = 1;
        continue;
      }

      const currentSign = signOrZero(current);
      let matches = 0;
      let samples = 0;

      for (const windowMs of this.windowsMs) {
        const avg = this.getAverage(metric, timestampMs - windowMs, timestampMs);
        if (avg === null) {
          continue;
        }
        samples += 1;
        if (signOrZero(avg) === currentSign) {
          matches += 1;
        }
      }

      if (samples === 0) {
        multipliers[metric] = 1;
        continue;
      }

      const ratio = matches / samples;
      multipliers[metric] = clamp(0.75 + ratio * 0.5, 0.75, 1.25);
    }

    return multipliers;
  }

  private getAverage(metric: string, fromTs: number, toTs: number): number | null {
    let sum = 0;
    let count = 0;

    for (const sample of this.history) {
      if (sample.timestampMs < fromTs || sample.timestampMs > toTs) {
        continue;
      }
      const value = sample.values[metric];
      if (!Number.isFinite(value)) {
        continue;
      }
      sum += value;
      count += 1;
    }

    if (count === 0) {
      return null;
    }
    return sum / count;
  }

  private prune(nowMs: number): void {
    const cutoff = nowMs - this.maxHistoryMs;
    if (this.history.length === 0) {
      return;
    }
    this.history = this.history.filter((sample) => sample.timestampMs >= cutoff);
  }
}
