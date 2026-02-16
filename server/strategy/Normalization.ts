const EPS = 1e-12;

type Sample = { value: number; ts: number };

class RollingWelford {
  private n = 0;
  private mean = 0;
  private m2 = 0;

  add(value: number): void {
    this.n += 1;
    const delta = value - this.mean;
    this.mean += delta / this.n;
    const delta2 = value - this.mean;
    this.m2 += delta * delta2;
  }

  remove(value: number): void {
    if (this.n <= 1) {
      this.reset();
      return;
    }
    const n1 = this.n - 1;
    const mean1 = (this.n * this.mean - value) / n1;
    const m2_1 = this.m2 - (value - this.mean) * (value - mean1);
    this.n = n1;
    this.mean = mean1;
    this.m2 = Math.max(0, m2_1);
  }

  reset(): void {
    this.n = 0;
    this.mean = 0;
    this.m2 = 0;
  }

  get count(): number {
    return this.n;
  }

  getMean(): number {
    return this.mean;
  }

  getVariance(): number {
    if (this.n <= 1) return 0;
    return this.m2 / (this.n - 1);
  }

  zScore(value: number): number {
    const variance = this.getVariance();
    const std = variance > 0 ? Math.sqrt(variance) : 0;
    if (std < EPS) return 0;
    return (value - this.mean) / std;
  }
}

class RollingHistogram {
  private readonly bins: number;
  private min = 0;
  private max = 0;
  private counts: number[];
  private total = 0;
  private dirty = true;

  constructor(bins = 64) {
    this.bins = bins;
    this.counts = new Array(bins).fill(0);
  }

  reset(): void {
    this.min = 0;
    this.max = 0;
    this.counts.fill(0);
    this.total = 0;
    this.dirty = true;
  }

  markDirty(): void {
    this.dirty = true;
  }

  rebuild(samples: Sample[]): void {
    this.reset();
    if (samples.length === 0) return;
    let min = samples[0].value;
    let max = samples[0].value;
    for (const s of samples) {
      if (s.value < min) min = s.value;
      if (s.value > max) max = s.value;
    }
    this.min = min;
    this.max = max;
    if (Math.abs(max - min) < EPS) {
      this.counts[0] = samples.length;
      this.total = samples.length;
      this.dirty = false;
      return;
    }
    for (const s of samples) {
      const idx = this.bucketIndex(s.value);
      this.counts[idx] += 1;
      this.total += 1;
    }
    this.dirty = false;
  }

  add(value: number, samples: Sample[]): void {
    if (this.total === 0) {
      this.min = value;
      this.max = value;
      this.counts[0] = 1;
      this.total = 1;
      this.dirty = false;
      return;
    }
    if (value < this.min || value > this.max) {
      this.rebuild(samples);
      return;
    }
    const idx = this.bucketIndex(value);
    this.counts[idx] += 1;
    this.total += 1;
  }

  remove(value: number): void {
    if (this.total === 0) return;
    if (value <= this.min || value >= this.max) {
      this.markDirty();
      return;
    }
    const idx = this.bucketIndex(value);
    if (this.counts[idx] > 0) {
      this.counts[idx] -= 1;
      this.total -= 1;
    }
    if (this.total <= 0) {
      this.reset();
    }
  }

  cdf(value: number, samples: Sample[]): number {
    if (this.total === 0) return 0.5;
    if (this.dirty) {
      this.rebuild(samples);
    }
    if (this.total === 0) return 0.5;
    if (value <= this.min) return 0;
    if (value >= this.max) return 1;
    const idx = this.bucketIndex(value);
    let acc = 0;
    for (let i = 0; i < idx; i += 1) {
      acc += this.counts[i];
    }
    const bucketStart = this.min + (this.max - this.min) * (idx / this.bins);
    const bucketEnd = this.min + (this.max - this.min) * ((idx + 1) / this.bins);
    const within = bucketEnd > bucketStart ? (value - bucketStart) / (bucketEnd - bucketStart) : 0;
    const approx = (acc + this.counts[idx] * within) / Math.max(1, this.total);
    return Math.max(0, Math.min(1, approx));
  }

  private bucketIndex(value: number): number {
    if (Math.abs(this.max - this.min) < EPS) return 0;
    const ratio = (value - this.min) / (this.max - this.min);
    const idx = Math.floor(ratio * this.bins);
    return Math.max(0, Math.min(this.bins - 1, idx));
  }
}

export class RollingStats {
  private readonly windowMs: number;
  private readonly samples: Sample[] = [];
  private readonly welford = new RollingWelford();
  private readonly histogram: RollingHistogram;

  constructor(windowMs: number, bins = 64) {
    this.windowMs = windowMs;
    this.histogram = new RollingHistogram(bins);
  }

  update(value: number, ts: number): void {
    if (!Number.isFinite(value)) return;
    this.samples.push({ value, ts });
    this.welford.add(value);
    this.histogram.add(value, this.samples);
    this.evictOld(ts);
  }

  zScore(value: number): number {
    return this.welford.zScore(value);
  }

  percentile(value: number): number {
    return this.histogram.cdf(value, this.samples);
  }

  count(): number {
    return this.welford.count;
  }

  private evictOld(nowTs: number): void {
    const cutoff = nowTs - this.windowMs;
    while (this.samples.length > 0 && this.samples[0].ts < cutoff) {
      const sample = this.samples.shift();
      if (!sample) break;
      this.welford.remove(sample.value);
      this.histogram.remove(sample.value);
    }
  }
}

export class NormalizationStore {
  private readonly windowMs: number;
  private readonly bins: number;
  private readonly stats = new Map<string, RollingStats>();

  constructor(windowMs: number, bins = 64) {
    this.windowMs = windowMs;
    this.bins = bins;
  }

  update(key: string, value: number, ts: number): void {
    if (!Number.isFinite(value)) return;
    this.getStats(key).update(value, ts);
  }

  zScore(key: string, value: number): number {
    return this.getStats(key).zScore(value);
  }

  percentile(key: string, value: number): number {
    return this.getStats(key).percentile(value);
  }

  count(key: string): number {
    return this.getStats(key).count();
  }

  private getStats(key: string): RollingStats {
    if (!this.stats.has(key)) {
      this.stats.set(key, new RollingStats(this.windowMs, this.bins));
    }
    return this.stats.get(key)!;
  }
}
