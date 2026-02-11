import { ExecutionConnector } from '../connectors/ExecutionConnector';

export interface ExecutionDecision {
    symbol: string;
    side: 'BUY' | 'SELL';
    price: number;
    quantity: number;
    reduceOnly?: boolean;
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
            const res = await (this.connector as any).placeOrder({
                symbol: decision.symbol,
                side: decision.side,
                type: 'MARKET',
                quantity: decision.quantity,
                reduceOnly: decision.reduceOnly ? true : undefined,
                clientOrderId: `bot_${Date.now()}`
            });
            return { ok: true, orderId: res.orderId };
        } catch (e: any) {
            return { ok: false, error: e.message };
        }
    }
}
