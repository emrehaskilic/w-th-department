import { SignalBooster, SignalConfidence } from './SignalBooster';
import { TimeframeAggregator } from './TimeframeAggregator';

export type SignalType = 'SWEEP_FADE_LONG' | 'SWEEP_FADE_SHORT' | 'BREAKOUT_LONG' | 'BREAKOUT_SHORT' | null;

export interface StrategySignal {
    signal: SignalType;
    score: number;
    confidence?: SignalConfidence;
    vetoReason: string | null;
    candidate: {
        entryPrice: number;
        tpPrice: number;
        slPrice: number;
    } | null;
    boost?: {
        score: number;
        contributions: Record<string, number>;
        timeframeMultipliers: Record<string, number>;
    };
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
    private readonly signalBooster = new SignalBooster();
    private readonly timeframeAggregator = new TimeframeAggregator();

    public compute(inputs: StrategyInputs): StrategySignal {
        const now = Date.now();
        const rawMetrics = {
            obi: inputs.obi,
            deltaZ: inputs.deltaZ,
            cvdSlope: inputs.cvdSlope,
        };
        this.timeframeAggregator.add(rawMetrics, now);
        const timeframeMultipliers = this.timeframeAggregator.getTimeframeMultipliers(rawMetrics, now);
        const boost = this.signalBooster.boost({
            obi: inputs.obi,
            deltaZ: inputs.deltaZ,
            cvdSlope: inputs.cvdSlope,
            atr: inputs.atr,
            avgAtr: inputs.avgAtr || inputs.atr,
            price: inputs.price,
            recentHigh: inputs.recentHigh,
            recentLow: inputs.recentLow,
        }, timeframeMultipliers);

        if (!inputs.ready) {
            return {
                signal: null,
                score: 0,
                confidence: boost.confidence,
                vetoReason: inputs.vetoReason || 'NOT_READY',
                candidate: null,
                boost: {
                    score: Math.round(boost.score),
                    contributions: boost.contributions,
                    timeframeMultipliers,
                },
            };
        }

        // 1) Sweep-Fade Strategy
        const sweepFade = this.checkSweepFade(inputs);
        if (sweepFade.signal) {
            return this.withBoost(sweepFade, boost, timeframeMultipliers);
        }

        // 2) Imbalance-Breakout Strategy
        const breakout = this.checkBreakout(inputs);
        if (breakout.signal) {
            return this.withBoost(breakout, boost, timeframeMultipliers);
        }

        return {
            signal: null,
            score: Math.round(boost.score),
            confidence: boost.confidence,
            vetoReason: 'NO_CRITERIA_MET',
            candidate: null,
            boost: {
                score: Math.round(boost.score),
                contributions: boost.contributions,
                timeframeMultipliers,
            },
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

    private withBoost(
        baseSignal: StrategySignal,
        boost: ReturnType<SignalBooster['boost']>,
        timeframeMultipliers: Record<string, number>
    ): StrategySignal {
        const mergedScore = Math.round(Math.max(0, Math.min(100, (baseSignal.score * 0.55) + (boost.score * 0.45))));
        if (mergedScore < 50) {
            return {
                signal: null,
                score: mergedScore,
                confidence: boost.confidence,
                vetoReason: 'LOW_CONFIDENCE',
                candidate: null,
                boost: {
                    score: Math.round(boost.score),
                    contributions: boost.contributions,
                    timeframeMultipliers,
                },
            };
        }

        return {
            ...baseSignal,
            score: mergedScore,
            confidence: boost.confidence,
            boost: {
                score: Math.round(boost.score),
                contributions: boost.contributions,
                timeframeMultipliers,
            },
        };
    }
}
