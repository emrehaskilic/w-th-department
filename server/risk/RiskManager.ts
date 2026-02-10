export interface RiskConfig {
    maxPositionNotionalUsdt: number;
    cooldownMs: number;
    maxSlippagePct: number;
}

export class RiskManager {
    private config: RiskConfig;
    private lastTradeTs: Map<string, number> = new Map();

    constructor(config: RiskConfig = {
        maxPositionNotionalUsdt: 500,
        cooldownMs: 60_000,
        maxSlippagePct: 0.1
    }) {
        this.config = config;
    }

    public check(symbol: string, side: 'BUY' | 'SELL', price: number, quantity: number): { ok: boolean; reason: string | null } {
        const now = Date.now();
        const lastTs = this.lastTradeTs.get(symbol) || 0;

        if (now - lastTs < this.config.cooldownMs) {
            return { ok: false, reason: 'COOLDOWN_ACTIVE' };
        }

        const notional = price * quantity;
        if (notional > this.config.maxPositionNotionalUsdt) {
            return { ok: false, reason: 'EXCEEDS_MAX_NOTIONAL' };
        }

        return { ok: true, reason: null };
    }

    public recordTrade(symbol: string) {
        this.lastTradeTs.set(symbol, Date.now());
    }
}
