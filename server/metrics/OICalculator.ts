export interface OIPanelMetrics {
    currentOI: number;
    oiChangeAbs: number;
    oiChangePct: number;
    stabilityMsg: string;
    lastUpdated: number;
}

export class OICalculator {
    private symbol: string;
    private restBaseUrl: string;
    private metrics: OIPanelMetrics = {
        currentOI: 0,
        oiChangeAbs: 0,
        oiChangePct: 0,
        stabilityMsg: 'INITIALIZING',
        lastUpdated: 0,
    };

    private lastPollTs = 0;

    constructor(symbol: string, restBaseUrl: string = 'https://fapi.binance.com') {
        this.symbol = symbol;
        this.restBaseUrl = restBaseUrl;
    }

    public getMetrics(): OIPanelMetrics {
        return this.metrics;
    }

    public async update(): Promise<void> {
        const now = Date.now();
        this.lastPollTs = now;

        try {
            // 1) Current OI
            const curRes = await fetch(`${this.restBaseUrl}/fapi/v1/openInterest?symbol=${this.symbol}`);
            const curData: any = await curRes.json();
            const currentOI = parseFloat(curData.openInterest);

            // 2) Hist OI (for delta) - 5m period
            // We get the last few entries to find 15m or 5m delta
            const histUrl = `${this.restBaseUrl}/futures/data/openInterestHist?symbol=${this.symbol}&period=5m&limit=10`;
            const histRes = await fetch(histUrl);
            const histData: any = await histRes.json();

            let oiChangeAbs = 0;
            let oiChangePct = 0;

            if (Array.isArray(histData) && histData.length > 1) {
                const head = histData[histData.length - 1];
                const tail = histData[0]; // ~45-50 mins ago if limit=10, period=5m
                // Let's try to find one closer to 15 mins ago? 
                // Index histData.length - 4 would be roughly 15m ago if period is 5m
                const referenceIdx = Math.max(0, histData.length - 4);
                const reference = histData[referenceIdx];

                const refVal = parseFloat(reference.sumOpenInterest);
                const curVal = parseFloat(head.sumOpenInterest);

                oiChangeAbs = curVal - refVal;
                oiChangePct = refVal > 0 ? (oiChangeAbs / refVal) * 100 : 0;
            }

            this.metrics = {
                currentOI,
                oiChangeAbs,
                oiChangePct,
                stabilityMsg: 'STABLE',
                lastUpdated: now,
            };
        } catch (e: any) {
            this.metrics.stabilityMsg = `ERR: ${e.message}`;
        }
    }
}
