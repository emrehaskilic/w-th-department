export type SignalConfidence = 'LOW' | 'MEDIUM' | 'HIGH';

export interface SignalBoostMetrics {
  obi: number;
  deltaZ: number;
  cvdSlope: number;
  atr: number;
  avgAtr: number;
  price: number;
  recentHigh: number;
  recentLow: number;
}

export interface SignalBoostResult {
  score: number;
  confidence: SignalConfidence;
  contributions: Record<string, number>;
  weights: Record<string, number>;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function safeDiv(numerator: number, denominator: number, fallback = 0): number {
  if (!Number.isFinite(denominator) || denominator === 0) {
    return fallback;
  }
  return numerator / denominator;
}

export class SignalBooster {
  boost(metrics: SignalBoostMetrics, timeframeMultipliers: Record<string, number>): SignalBoostResult {
    const avgAtr = metrics.avgAtr > 0 ? metrics.avgAtr : metrics.atr;
    const volRatio = avgAtr > 0 ? metrics.atr / avgAtr : 1;

    const baseWeights: Record<string, number> = {
      obi: 0.35,
      deltaZ: 0.25,
      cvdSlope: 0.25,
      breakoutBias: 0.15,
    };
    const weights = this.applyDynamicWeights(baseWeights, volRatio);

    const rangeMid = (metrics.recentHigh + metrics.recentLow) / 2;
    const rangeSpan = Math.max(Math.abs(metrics.recentHigh - metrics.recentLow), metrics.atr, 1e-9);

    const normalized = {
      obi: clamp(metrics.obi * 4, -1, 1),
      deltaZ: clamp(metrics.deltaZ / 3, -1, 1),
      cvdSlope: clamp(metrics.cvdSlope * 50, -1, 1),
      breakoutBias: clamp((metrics.price - rangeMid) / rangeSpan, -1, 1),
    };

    const contributions: Record<string, number> = {};
    let weightedSum = 0;
    let weightTotal = 0;

    for (const key of Object.keys(weights)) {
      const weight = weights[key];
      const value = normalized[key as keyof typeof normalized];
      const tf = clamp(timeframeMultipliers[key] ?? 1, 0.5, 1.5);
      const contribution = value * weight * tf;
      contributions[key] = contribution;
      weightedSum += contribution;
      weightTotal += weight;
    }

    const normalizedScore = weightTotal > 0 ? weightedSum / weightTotal : 0;
    const score = clamp(((normalizedScore + 1) / 2) * 100, 0, 100);

    let confidence: SignalConfidence = 'LOW';
    if (score >= 75) {
      confidence = 'HIGH';
    } else if (score >= 55) {
      confidence = 'MEDIUM';
    }

    return {
      score,
      confidence,
      contributions,
      weights,
    };
  }

  private applyDynamicWeights(base: Record<string, number>, volRatio: number): Record<string, number> {
    const out = { ...base };

    if (volRatio > 1.5) {
      out.breakoutBias *= 1.4;
      out.cvdSlope *= 1.2;
      out.obi *= 0.85;
    } else if (volRatio < 0.7) {
      out.obi *= 1.25;
      out.deltaZ *= 1.15;
      out.breakoutBias *= 0.8;
    }

    const sum = Object.values(out).reduce((acc, v) => acc + v, 0);
    if (sum <= 0) {
      return base;
    }

    const normalized: Record<string, number> = {};
    for (const [k, v] of Object.entries(out)) {
      normalized[k] = safeDiv(v, sum, base[k] ?? 0);
    }
    return normalized;
  }
}
