// [GITHUB VERIFIED] Backend implementation of OBI, VWAP, DeltaZ, CVD Slope, and Advanced Scores
import { OrderbookState, bestBid, bestAsk } from './OrderbookManager';

// Type for a trade used in the legacy metrics calculations
interface LegacyTrade {
    price: number;
    quantity: number;
    side: 'buy' | 'sell';
    timestamp: number;
}

/**
 * LegacyCalculator computes additional orderflow metrics that were
 * previously derived on the client.  These include various orderbook
 * imbalance scores, rolling delta windows, Z‐scores and session CVD
 * slope.  The implementation strives to be lightweight but still
 * produce values compatible with the original UI expectations.
 * 
 * Implements:
 * - OBI (Weighted, Deep, Divergence)
 * - Session VWAP
 * - Delta Z-Score
 * - CVD Slope
 * - Advanced Scores: Sweep, Breakout, Regime, Absorption
 * - Trade Signal
 */
export class LegacyCalculator {
    // Keep a rolling list of trades for delta calculations (max 10 seconds)
    private trades: LegacyTrade[] = [];
    // List of recent delta1s values for Z‐score computation
    private deltaHistory: number[] = [];
    // List of recent session CVD values for slope computation
    private cvdHistory: number[] = [];
    private cvdSession = 0;
    private totalVolume = 0;
    private totalNotional = 0;

    /**
     * Add a trade to the calculator.  Updates rolling windows and
     * cumulative session CVD/volume/notional statistics.
     */
    addTrade(trade: LegacyTrade) {
        const now = trade.timestamp;
        // Push new trade
        this.trades.push(trade);
        // Update session metrics
        this.totalVolume += trade.quantity;
        this.totalNotional += trade.quantity * trade.price;
        this.cvdSession += trade.side === 'buy' ? trade.quantity : -trade.quantity;
        // Remove old trades beyond 10 seconds
        const cutoff = now - 10_000;
        while (this.trades.length > 0 && this.trades[0].timestamp < cutoff) {
            this.trades.shift();
        }
        // Every trade, recompute delta1s and store for Z‐score.  Compute
        // delta1s as net volume over last 1s.
        const oneSecCutoff = now - 1_000;
        let delta1s = 0;
        let delta5s = 0;
        let count1s = 0;
        for (const t of this.trades) {
            if (t.timestamp >= oneSecCutoff) {
                delta1s += t.side === 'buy' ? t.quantity : -t.quantity;
                count1s++;
            }
            if (t.timestamp >= now - 5_000) {
                delta5s += t.side === 'buy' ? t.quantity : -t.quantity;
            }
        }
        // Store delta1s history for Z calculation (limit 60 entries)
        this.deltaHistory.push(delta1s);
        if (this.deltaHistory.length > 60) {
            this.deltaHistory.shift();
        }
        // Store cvdSession history for slope calculation (limit 60 entries)
        this.cvdHistory.push(this.cvdSession);
        if (this.cvdHistory.length > 60) {
            this.cvdHistory.shift();
        }
    }

    /**
     * Compute the current legacy metrics given the current orderbook
     * state.  The orderbook is used to derive imbalance scores.  The
     * function returns an object containing all metrics required for
     * the original UI.  Undefined values are returned as null.
     */
    computeMetrics(ob: OrderbookState) {
        // Helper to calculate raw volume for a given depth (descending for bids, ascending for asks)
        const calcVolume = (levels: Map<number, number>, depth: number, isAsk: boolean): number => {
            const entries = Array.from(levels.entries());
            // Sort: Bids Descending, Asks Ascending
            entries.sort((a, b) => isAsk ? a[0] - b[0] : b[0] - a[0]);
            let vol = 0;
            for (let i = 0; i < Math.min(depth, entries.length); i++) {
                vol += entries[i][1];
            }
            return vol;
        };

        const epsilon = 1e-9;

        // --- A) OBI Weighted (Normalized) ---
        // Top 10 levels
        const bidVol10 = calcVolume(ob.bids, 10, false);
        const askVol10 = calcVolume(ob.asks, 10, true);

        const rawObiWeighted = bidVol10 - askVol10;
        const denomWeighted = bidVol10 + askVol10;
        // Range: [-1, +1]
        const obiWeighted = rawObiWeighted / Math.max(denomWeighted, epsilon);

        // --- B) OBI Deep Book (Normalized) ---
        // Top 50 levels (representing deep liquidty)
        const bidVol50 = calcVolume(ob.bids, 50, false);
        const askVol50 = calcVolume(ob.asks, 50, true);

        const rawObiDeep = bidVol50 - askVol50;
        const denomDeep = bidVol50 + askVol50;
        // Range: [-1, +1]
        const obiDeep = rawObiDeep / Math.max(denomDeep, epsilon);

        // --- C) OBI Divergence (Stable Definition) ---
        // Difference between weighted (near) and deep OBI
        // Range: [-2, +2]
        const obiDivergence = obiWeighted - obiDeep;
        // Recompute rolling delta windows.
        // Use last trade timestamp as reference to avoid clock skew between 
        // Binance server time and local time.
        const refTime = this.trades.length > 0
            ? this.trades[this.trades.length - 1].timestamp
            : Date.now();
        let delta1s = 0;
        let delta5s = 0;
        for (const t of this.trades) {
            if (t.timestamp >= refTime - 1_000) {
                delta1s += t.side === 'buy' ? t.quantity : -t.quantity;
            }
            if (t.timestamp >= refTime - 5_000) {
                delta5s += t.side === 'buy' ? t.quantity : -t.quantity;
            }
        }
        // Z‐score of delta1s: (value - mean) / std
        let deltaZ = 0;
        if (this.deltaHistory.length >= 5) {
            const mean = this.deltaHistory.reduce((a, b) => a + b, 0) / this.deltaHistory.length;
            const variance = this.deltaHistory.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / this.deltaHistory.length;
            const std = Math.sqrt(variance) || 1;
            deltaZ = (delta1s - mean) / std;
        }
        // CVD slope: simple linear regression on the last cvdHistory values
        let cvdSlope = 0;
        const historyLen = this.cvdHistory.length;
        if (historyLen >= 2) {
            // Compute slope using least squares
            const xs = [...Array(historyLen).keys()].map(i => i);
            const ys = this.cvdHistory;
            const n = historyLen;
            const sumX = xs.reduce((a, b) => a + b, 0);
            const sumY = ys.reduce((a, b) => a + b, 0);
            const sumXX = xs.reduce((a, b) => a + b * b, 0);
            const sumXY = xs.reduce((sum, x, i) => sum + x * ys[i], 0);
            const denom = n * sumXX - sumX * sumX;
            if (denom !== 0) {
                cvdSlope = (n * sumXY - sumX * sumY) / denom;
            }
        }
        // VWAP: totalNotional / totalVolume
        const vwap = this.totalVolume > 0 ? this.totalNotional / this.totalVolume : 0;
        // Compose object
        const bestBidPrice = bestBid(ob) ?? 0;
        const bestAskPrice = bestAsk(ob) ?? 0;
        const midPrice = (bestBidPrice + bestAskPrice) / 2;

        // ===== ADVANCED METRICS CALCULATIONS =====

        // --- Sweep/Fade Score ---
        // Measures aggressive buying vs selling momentum
        // Positive = aggressive buyers sweeping asks, Negative = aggressive sellers hitting bids
        let sweepFadeScore = 0;
        if (this.trades.length >= 2) {
            const recentTrades = this.trades.slice(-20); // Last 20 trades
            let buyVol = 0, sellVol = 0;
            for (const t of recentTrades) {
                if (t.side === 'buy') buyVol += t.quantity;
                else sellVol += t.quantity;
            }
            const total = buyVol + sellVol;
            if (total > 0) {
                sweepFadeScore = (buyVol - sellVol) / total; // Range: [-1, +1]
            }
        }

        // --- Breakout Score (Momentum) ---
        // Measures price momentum based on recent price movement direction
        // Uses the slope of recent trade prices
        let breakoutScore = 0;
        if (this.trades.length >= 5) {
            const recentPrices = this.trades.slice(-10).map(t => t.price);
            if (recentPrices.length >= 2) {
                const firstHalf = recentPrices.slice(0, Math.floor(recentPrices.length / 2));
                const secondHalf = recentPrices.slice(Math.floor(recentPrices.length / 2));
                const avgFirst = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
                const avgSecond = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
                // Normalize by typical price movement (use spread as reference)
                const spread = bestAskPrice - bestBidPrice;
                if (spread > 0) {
                    breakoutScore = Math.max(-1, Math.min(1, (avgSecond - avgFirst) / (spread * 5)));
                }
            }
        }

        // --- Regime Weight (Volatility) ---
        // Measures market volatility based on price range in recent trades
        let regimeWeight = 0;
        if (this.trades.length >= 5) {
            const recentPrices = this.trades.slice(-20).map(t => t.price);
            const minPrice = Math.min(...recentPrices);
            const maxPrice = Math.max(...recentPrices);
            const range = maxPrice - minPrice;
            const avgPrice = recentPrices.reduce((a, b) => a + b, 0) / recentPrices.length;
            // Normalize range relative to price (as percentage)
            if (avgPrice > 0) {
                const rangePct = (range / avgPrice) * 100;
                // Scale: 0-0.1% = low vol, 0.1-0.5% = normal, >0.5% = high vol
                regimeWeight = Math.min(1, rangePct * 2); // Cap at 1
            }
        }

        // --- Absorption Score ---
        // Detects absorption: large volume with small price movement
        // Calculated from trade data: high volume + low price change = absorption
        let absorptionScore = 0;
        if (this.trades.length >= 5) {
            const window = this.trades.slice(-30);
            const totalVol = window.reduce((sum, t) => sum + t.quantity, 0);
            const prices = window.map(t => t.price);
            const priceChange = Math.abs(prices[prices.length - 1] - prices[0]);
            const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;

            if (avgPrice > 0 && totalVol > 0) {
                // High volume with low price change = absorption
                const priceChangePct = (priceChange / avgPrice) * 100;
                const volumeNorm = Math.min(totalVol / 10, 1); // Normalize volume
                // Low price change + high volume = high absorption
                if (priceChangePct < 0.05 && volumeNorm > 0.2) {
                    absorptionScore = volumeNorm * (1 - priceChangePct * 20);
                }
            }
        }

        // --- Signal ---
        // Simple composite signal: OBI + DeltaZ + Slope
        let tradeSignal = 0; // 0=Neutral, 1=Buy, -1=Sell
        if (obiWeighted > 0.25 && deltaZ > 1.0 && cvdSlope > 0) tradeSignal = 1;
        else if (obiWeighted < -0.25 && deltaZ < -1.0 && cvdSlope < 0) tradeSignal = -1;

        return {
            price: midPrice,
            obiWeighted,
            obiDeep,
            obiDivergence,
            delta1s,
            delta5s,
            deltaZ,
            cvdSession: this.cvdSession,
            cvdSlope,
            vwap,
            totalVolume: this.totalVolume,
            totalNotional: this.totalNotional,
            absorptionScore,
            sweepFadeScore,
            breakoutScore,
            regimeWeight,
            tradeCount: this.trades.length,
            tradeSignal
        };
    }
}