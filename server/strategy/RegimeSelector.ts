import { NormalizationStore } from './Normalization';
import { StrategyRegime } from '../types/strategy';

export interface RegimeInput {
  nowMs: number;
  price: number;
  vwap: number;
  dfsPercentile: number;
  deltaZ: number;
  printsPerSecond: number;
  burstCount: number;
  volatility: number;
}

export interface RegimeOutput {
  regime: StrategyRegime;
  volLevel: number;
  scores: {
    eventScore: number;
    trendScore: number;
    meanRevScore: number;
  };
  reasons: string[];
}

export class RegimeSelector {
  private readonly norm: NormalizationStore;
  private readonly lockTRMR: number;
  private readonly lockEV: number;
  private regime: StrategyRegime = 'MR';
  private trmrStreak = 0;
  private evStreak = 0;
  private evExitStreak = 0;

  constructor(norm: NormalizationStore, lockTRMR: number, lockEV: number) {
    this.norm = norm;
    this.lockTRMR = Math.max(1, lockTRMR);
    this.lockEV = Math.max(1, lockEV);
  }

  update(input: RegimeInput): RegimeOutput {
    this.norm.update('vol', input.volatility, input.nowMs);
    this.norm.update('prints', input.printsPerSecond, input.nowMs);
    this.norm.update('burst', input.burstCount, input.nowMs);
    const dev = Math.abs(input.price - input.vwap);
    this.norm.update('dev', dev, input.nowMs);
    this.norm.update('deltaAbs', Math.abs(input.deltaZ), input.nowMs);

    const volLevel = this.norm.percentile('vol', input.volatility);
    const printsP = this.norm.percentile('prints', input.printsPerSecond);
    const burstP = this.norm.percentile('burst', input.burstCount);
    const devP = this.norm.percentile('dev', dev);

    const trendStrength = Math.abs(input.dfsPercentile - 0.5) * 2;

    const eventScore = (0.45 * volLevel) + (0.35 * printsP) + (0.20 * burstP);
    const meanRevScore = (0.6 * devP) + (0.4 * (1 - trendStrength));
    const trendScore = (0.7 * trendStrength) + (0.3 * (devP < 0.7 ? 1 : 0));

    let candidate: StrategyRegime = 'TR';
    if (eventScore >= 0.85) {
      candidate = 'EV';
    } else if (meanRevScore >= 0.6) {
      candidate = 'MR';
    } else {
      candidate = 'TR';
    }

    const reasons: string[] = [];

    if (candidate === 'EV' && eventScore >= 0.95) {
      this.evStreak += 1;
    } else {
      this.evStreak = 0;
    }

    if (this.regime !== 'EV' && this.evStreak >= this.lockEV) {
      this.regime = 'EV';
      this.evExitStreak = 0;
      reasons.push('REGIME_EV_OVERRIDE');
    }

    if (this.regime === 'EV') {
      if (candidate !== 'EV' && eventScore < 0.7) {
        this.evExitStreak += 1;
      } else {
        this.evExitStreak = 0;
      }
      if (this.evExitStreak >= this.lockEV) {
        this.regime = candidate === 'EV' ? 'TR' : candidate;
        this.trmrStreak = 0;
      }
    }

    if (this.regime !== 'EV' && candidate !== 'EV' && candidate !== this.regime) {
      this.trmrStreak += 1;
      if (this.trmrStreak >= this.lockTRMR) {
        this.regime = candidate;
        this.trmrStreak = 0;
        reasons.push('REGIME_TRMR_LOCK');
      } else {
        reasons.push('REGIME_LOCKED');
      }
    } else if (candidate === this.regime) {
      this.trmrStreak = 0;
    }

    return {
      regime: this.regime,
      volLevel,
      scores: {
        eventScore,
        trendScore,
        meanRevScore,
      },
      reasons,
    };
  }
}
