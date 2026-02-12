import { TrendState } from './OrderPlan';

export interface TrendConfig {
  upEnter: number;
  upExit: number;
  downEnter: number;
  downExit: number;
  confirmTicks: number;
  reversalConfirmTicks: number;
}

export interface TrendSnapshot {
  state: TrendState;
  score: number;
  confirmCount: number;
  candidateState: TrendState;
}

export class TrendStateMachine {
  private state: TrendState = 'CHOP';
  private score = 0;
  private candidateState: TrendState = 'CHOP';
  private candidateCount = 0;
  private confirmCount = 0;

  constructor(private readonly cfg: TrendConfig) {}

  update(score: number): TrendSnapshot {
    this.score = score;
    const candidate = this.computeCandidate(score);
    if (candidate === this.candidateState) {
      this.candidateCount += 1;
    } else {
      this.candidateState = candidate;
      this.candidateCount = 1;
    }

    if (candidate !== this.state) {
      const threshold = this.isReversal(candidate) ? this.cfg.reversalConfirmTicks : this.cfg.confirmTicks;
      if (this.candidateCount >= Math.max(1, threshold)) {
        this.state = candidate;
        this.confirmCount = 1;
      }
    } else {
      this.confirmCount += 1;
    }

    return {
      state: this.state,
      score: this.score,
      confirmCount: this.confirmCount,
      candidateState: this.candidateState,
    };
  }

  getSnapshot(): TrendSnapshot {
    return {
      state: this.state,
      score: this.score,
      confirmCount: this.confirmCount,
      candidateState: this.candidateState,
    };
  }

  private computeCandidate(score: number): TrendState {
    if (this.state === 'CHOP') {
      if (score >= this.cfg.upEnter) return 'UP';
      if (score <= this.cfg.downEnter) return 'DOWN';
      return 'CHOP';
    }

    if (this.state === 'UP') {
      if (score <= this.cfg.downEnter) return 'DOWN';
      if (score <= this.cfg.upExit) return 'CHOP';
      return 'UP';
    }

    if (score >= this.cfg.upEnter) return 'UP';
    if (score >= this.cfg.downExit) return 'CHOP';
    return 'DOWN';
  }

  private isReversal(candidate: TrendState): boolean {
    return (this.state === 'UP' && candidate === 'DOWN') || (this.state === 'DOWN' && candidate === 'UP');
  }
}
