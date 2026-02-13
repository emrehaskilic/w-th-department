export interface KlineData {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    timestamp: number;
}

export interface SymbolBackfillState {
    atr: number;
    avgAtr: number;
    recentHigh: number;
    recentLow: number;
    ready: boolean;
    vetoReason: string | null;
}

export class KlineBackfill {
    private symbol: string;
    private restBaseUrl: string;
    private state: SymbolBackfillState = {
        atr: 0,
        avgAtr: 0,
        recentHigh: 0,
        recentLow: 0,
        ready: false,
        vetoReason: 'INITIALIZING',
    };

    constructor(symbol: string, restBaseUrl: string = 'https://fapi.binance.com') {
        this.symbol = symbol;
        this.restBaseUrl = restBaseUrl;
    }

    public getState(): SymbolBackfillState {
        return this.state;
    }

    public async performBackfill(limit: number = 500): Promise<void> {
        try {
            const url = `${this.restBaseUrl}/fapi/v1/klines?symbol=${this.symbol}&interval=1m&limit=${limit}`;
            const res = await fetch(url);
            if (!res.ok) throw new Error(`Status ${res.status}`);
            const data: any = await res.json();

            if (!Array.isArray(data) || data.length === 0) {
                this.state.vetoReason = 'NO_KLINE_DATA';
                return;
            }

            const klines: KlineData[] = data.map((d: any) => ({
                timestamp: d[0],
                open: parseFloat(d[1]),
                high: parseFloat(d[2]),
                low: parseFloat(d[3]),
                close: parseFloat(d[4]),
                volume: parseFloat(d[5]),
            }));

            // Compute ATR (Simple)
            let totalTr = 0;
            const trSeries: number[] = [];
            for (let i = 1; i < klines.length; i++) {
                const tr = Math.max(
                    klines[i].high - klines[i].low,
                    Math.abs(klines[i].high - klines[i - 1].close),
                    Math.abs(klines[i].low - klines[i - 1].close)
                );
                totalTr += tr;
                trSeries.push(tr);
            }
            this.state.avgAtr = totalTr / (klines.length - 1);
            const atrWindow = trSeries.slice(-14);
            this.state.atr = atrWindow.length > 0
                ? atrWindow.reduce((sum, v) => sum + v, 0) / atrWindow.length
                : this.state.avgAtr;

            // Recent High/Low (Window)
            let high = -Infinity;
            let low = Infinity;
            for (const k of klines) {
                if (k.high > high) high = k.high;
                if (k.low < low) low = k.low;
            }
            this.state.recentHigh = high;
            this.state.recentLow = low;

            if (this.state.atr > 0 && this.state.recentHigh > 0) {
                this.state.ready = true;
                this.state.vetoReason = null;
            } else {
                this.state.vetoReason = 'ZERO_ATR_OR_LEVELS';
            }

        } catch (e: any) {
            this.state.vetoReason = `BACKFILL_FAILED: ${e.message}`;
        }
    }
}
