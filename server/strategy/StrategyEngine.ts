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
    avgAtr?: number;
    recentHigh: number;
    recentLow: number;
    obi: number;
    deltaZ: number;
    cvdSlope: number;
    ready: boolean;
    vetoReason: string | null;
}

interface ThresholdConfig {
    obiThreshold: number;
    deltaZThreshold: number;
    cvdSlopeMin: number;
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
        const thresholds = this.getDynamicThresholds(inputs.atr, inputs.avgAtr || inputs.atr);
        const { price, recentHigh, recentLow, atr, obi, deltaZ } = inputs;
        const threshold = atr * 0.8; // Minor breach (scalp mode)

        // Sweep High (Short Opportunity)
        if (price > recentHigh && price < recentHigh + threshold) {
            if (obi < -thresholds.obiThreshold && deltaZ < -thresholds.deltaZThreshold) {
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
            if (obi > thresholds.obiThreshold && deltaZ > thresholds.deltaZThreshold) {
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
        const thresholds = this.getDynamicThresholds(inputs.atr, inputs.avgAtr || inputs.atr);
        const { price, recentHigh, recentLow, obi, cvdSlope, deltaZ, atr } = inputs;

        // Breakout High
        const breakoutBuffer = atr * 0.25;
        if (price > recentHigh - breakoutBuffer) {
            if (obi > thresholds.obiThreshold && cvdSlope > thresholds.cvdSlopeMin && deltaZ > thresholds.deltaZThreshold) {
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
        if (price < recentLow + breakoutBuffer) {
            if (obi < -thresholds.obiThreshold && cvdSlope < -thresholds.cvdSlopeMin && deltaZ < -thresholds.deltaZThreshold) {
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

    private getDynamicThresholds(atr: number, avgAtr: number): ThresholdConfig {
        const safeAvgAtr = avgAtr > 0 ? avgAtr : atr;
        const volRatio = safeAvgAtr > 0 ? atr / safeAvgAtr : 1;

        if (volRatio > 1.5) {
            return { obiThreshold: 0.10, deltaZThreshold: 0.20, cvdSlopeMin: 0.01 };
        }
        if (volRatio < 0.7) {
            return { obiThreshold: 0.25, deltaZThreshold: 0.50, cvdSlopeMin: 0.05 };
        }
        return { obiThreshold: 0.15, deltaZThreshold: 0.30, cvdSlopeMin: 0.02 };
    }
}
