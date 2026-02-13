import { ExecutionConnector } from '../connectors/ExecutionConnector';
import { OrderType, TimeInForce } from '../connectors/executionTypes';

export interface ExecutionDecision {
    symbol: string;
    side: 'BUY' | 'SELL';
    price: number;
    quantity: number;
    type?: OrderType;
    timeInForce?: TimeInForce;
    stopPrice?: number;
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
                type: decision.type || 'MARKET',
                quantity: decision.quantity,
                price: decision.type === 'LIMIT' ? decision.price : undefined,
                stopPrice: decision.stopPrice,
                timeInForce: decision.timeInForce,
                reduceOnly: decision.reduceOnly ? true : undefined,
                clientOrderId: `bot_${Date.now()}`
            });
            return { ok: true, orderId: res.orderId };
        } catch (e: any) {
            return { ok: false, error: e.message };
        }
    }
}
