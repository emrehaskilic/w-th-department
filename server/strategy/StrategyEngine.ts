export type SignalType = 'SWEEP_FADE_LONG' | 'SWEEP_FADE_SHORT' | 'BREAKOUT_LONG' | 'BREAKOUT_SHORT' | null;

export interface StrategySignal {
    signal: SignalType;
    score: number;
    vetoReason: string | null;
    candidate: {
        entryPrice: number;
        tpPrice: number;
        slPrice: number;
    } | null;
}

export interface StrategyInputs {
    price: number;
    atr: number;
    recentHigh: number;
    recentLow: number;
    obi: number;
    deltaZ: number;
    cvdSlope: number;
    ready: boolean;
    vetoReason: string | null;
}

export class StrategyEngine {
    public compute(inputs: StrategyInputs): StrategySignal {
        if (!inputs.ready) {
            return {
                signal: null,
                score: 0,
                vetoReason: inputs.vetoReason || 'NOT_READY',
                candidate: null,
            };
        }

        // 1) Sweep-Fade Strategy
        const sweepFade = this.checkSweepFade(inputs);
        if (sweepFade.signal) return sweepFade;

        // 2) Imbalance-Breakout Strategy
        const breakout = this.checkBreakout(inputs);
        if (breakout.signal) return breakout;

        return {
            signal: null,
            score: 0,
            vetoReason: 'NO_CRITERIA_MET',
            candidate: null,
        };
    }

    private checkSweepFade(inputs: StrategyInputs): StrategySignal {
        const { price, recentHigh, recentLow, atr, obi, deltaZ } = inputs;
        const threshold = atr * 0.2; // Minor breach

        // Sweep High (Short Opportunity)
        if (price > recentHigh && price < recentHigh + threshold) {
            if (obi < -0.3 && deltaZ < -1) {
                return {
                    signal: 'SWEEP_FADE_SHORT',
                    score: 75,
                    vetoReason: null,
                    candidate: {
                        entryPrice: price,
                        tpPrice: price - atr * 1.5,
                        slPrice: price + atr * 0.5,
                    },
                };
            }
        }

        // Sweep Low (Long Opportunity)
        if (price < recentLow && price > recentLow - threshold) {
            if (obi > 0.3 && deltaZ > 1) {
                return {
                    signal: 'SWEEP_FADE_LONG',
                    score: 75,
                    vetoReason: null,
                    candidate: {
                        entryPrice: price,
                        tpPrice: price + atr * 1.5,
                        slPrice: price - atr * 0.5,
                    },
                };
            }
        }

        return { signal: null, score: 0, vetoReason: null, candidate: null };
    }

    private checkBreakout(inputs: StrategyInputs): StrategySignal {
        const { price, recentHigh, recentLow, obi, cvdSlope, deltaZ, atr } = inputs;

        // Breakout High
        if (price > recentHigh) {
            if (obi > 0.5 && cvdSlope > 0 && deltaZ > 1.5) {
                return {
                    signal: 'BREAKOUT_LONG',
                    score: 85,
                    vetoReason: null,
                    candidate: {
                        entryPrice: price,
                        tpPrice: price + atr * 2,
                        slPrice: price - atr * 0.75,
                    },
                };
            }
        }

        // Breakout Low
        if (price < recentLow) {
            if (obi < -0.5 && cvdSlope < 0 && deltaZ < -1.5) {
                return {
                    signal: 'BREAKOUT_SHORT',
                    score: 85,
                    vetoReason: null,
                    candidate: {
                        entryPrice: price,
                        tpPrice: price - atr * 2,
                        slPrice: price + atr * 0.75,
                    },
                };
            }
        }

        return { signal: null, score: 0, vetoReason: null, candidate: null };
    }
}
