import { NormalizationStore } from './Normalization';

const EPS = 1e-12;

type BurstSide = 'buy' | 'sell' | null;

export interface DirectionalFlowInput {
  deltaZ: number;
  cvdSlope: number;
  obiWeighted: number;
  obiDeep: number;
  sweepStrength: number;
  burstCount: number;
  burstSide: BurstSide;
  aggressiveBuyVolume: number;
  aggressiveSellVolume: number;
  oiChangePct: number;
  price: number;
  prevPrice: number | null;
  prevCvd: number | null;
  nowMs: number;
}

export interface DirectionalFlowOutput {
  dfs: number;
  dfsPercentile: number;
  components: Record<string, number>;
}

export interface DirectionalFlowWeights {
  w1: number;
  w2: number;
  w3: number;
  w4: number;
  w5: number;
  w6: number;
  w7: number;
  w8: number;
}

const DEFAULT_WEIGHTS: DirectionalFlowWeights = {
  w1: 0.22,
  w2: 0.18,
  w3: 0.12,
  w4: 0.14,
  w5: 0.12,
  w6: 0.08,
  w7: 0.08,
  w8: 0.06,
};

export class DirectionalFlowScore {
  private readonly norm: NormalizationStore;
  private readonly weights: DirectionalFlowWeights;

  constructor(norm: NormalizationStore, weights?: Partial<DirectionalFlowWeights>) {
    this.norm = norm;
    this.weights = { ...DEFAULT_WEIGHTS, ...(weights || {}) };
  }

  compute(input: DirectionalFlowInput): DirectionalFlowOutput {
    const pressure = input.aggressiveBuyVolume / (input.aggressiveSellVolume + EPS);
    const logP = Math.log(Math.max(EPS, pressure));

    this.norm.update('deltaZ', input.deltaZ, input.nowMs);
    this.norm.update('cvdSlope', input.cvdSlope, input.nowMs);
    this.norm.update('logP', logP, input.nowMs);
    this.norm.update('obiWeighted', input.obiWeighted, input.nowMs);
    this.norm.update('obiDeep', input.obiDeep, input.nowMs);
    this.norm.update('sweepStrength', Math.abs(input.sweepStrength), input.nowMs);
    this.norm.update('burstCount', input.burstCount, input.nowMs);
    this.norm.update('oiChangePct', input.oiChangePct, input.nowMs);

    const zDelta = input.deltaZ;
    const zCvd = this.norm.zScore('cvdSlope', input.cvdSlope);
    const zLogP = this.norm.zScore('logP', logP);
    const zObiW = this.norm.zScore('obiWeighted', input.obiWeighted);
    const zObiD = this.norm.zScore('obiDeep', input.obiDeep);

    const sweepP = this.norm.percentile('sweepStrength', Math.abs(input.sweepStrength));
    const sweepSigned = Math.sign(input.sweepStrength || 0) * sweepP;

    const burstP = this.norm.percentile('burstCount', input.burstCount);
    const burstSigned = (input.burstSide === 'buy' ? 1 : input.burstSide === 'sell' ? -1 : 0) * burstP;

    const priceChange = input.prevPrice !== null ? input.price - input.prevPrice : 0;
    const cvdChange = input.prevCvd !== null ? input.cvdSlope - input.prevCvd : 0;
    const oiZ = this.norm.zScore('oiChangePct', input.oiChangePct);
    const oiImpulse = Math.sign(priceChange || 0) * Math.sign(cvdChange || 0) * oiZ;

    const dfs =
      (this.weights.w1 * zDelta) +
      (this.weights.w2 * zCvd) +
      (this.weights.w3 * zLogP) +
      (this.weights.w4 * zObiW) +
      (this.weights.w5 * zObiD) +
      (this.weights.w6 * sweepSigned) +
      (this.weights.w7 * burstSigned) +
      (this.weights.w8 * oiImpulse);

    this.norm.update('dfs', dfs, input.nowMs);
    const dfsPercentile = this.norm.percentile('dfs', dfs);

    return {
      dfs,
      dfsPercentile,
      components: {
        zDelta,
        zCvd,
        zLogP,
        zObiW,
        zObiD,
        sweepSigned,
        burstSigned,
        oiImpulse,
      },
    };
  }
}
