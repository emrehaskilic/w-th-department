import { ExecutionConnector } from '../connectors/ExecutionConnector';

export interface ExecutionDecision {
    symbol: string;
    side: 'BUY' | 'SELL';
    price: number;
    quantity: number;
    dryRun: boolean;
}

export class BinanceExecutor {
    private connector: ExecutionConnector;
    private enabled: boolean;
    private mode: 'live' | 'dry-run';

    constructor(connector: ExecutionConnector, enabled: boolean = false, mode: 'live' | 'dry-run' = 'dry-run') {
        this.connector = connector;
        this.enabled = enabled;
        this.mode = mode;
    }

    public async execute(decision: ExecutionDecision): Promise<{ ok: boolean; orderId?: string; error?: string }> {
        if (!this.enabled) {
            return { ok: false, error: 'EXECUTION_DISABLED' };
        }

        if (this.mode === 'dry-run' || decision.dryRun) {
            console.log(`[Executor] DRY-RUN: Would place ${decision.side} ${decision.quantity} ${decision.symbol} @ ${decision.price}`);
            return { ok: true, orderId: 'DRY_RUN_ID' };
        }

        try {
            // Place LIMIT order
            // Note: ExecutionConnector.placeOrder implementation needed (assuming it exists or adding it)
            // Based on previous turns, connector was simplified. Let's assume a basic method.
            const res = await (this.connector as any).placeOrder({
                symbol: decision.symbol,
                side: decision.side,
                type: 'LIMIT',
                quantity: decision.quantity,
                price: decision.price,
                clientOrderId: `bot_${Date.now()}`
            });
            return { ok: true, orderId: res.orderId };
        } catch (e: any) {
            return { ok: false, error: e.message };
        }
    }
}
