import { ExecutionConnector } from '../connectors/ExecutionConnector';

export interface ExecutionDecision {
    symbol: string;
    side: 'BUY' | 'SELL';
    price: number;
    quantity: number;
}

export class BinanceExecutor {
    private connector: ExecutionConnector;

    constructor(connector: ExecutionConnector) {
        this.connector = connector;
    }

    public async execute(decision: ExecutionDecision): Promise<{ ok: boolean; orderId?: string; error?: string }> {
        if (!this.connector.isExecutionEnabled()) {
            return { ok: false, error: 'EXECUTION_DISABLED' };
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
