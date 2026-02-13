import { Side } from '../connectors/executionTypes';
import { OrderRole } from './OrderPlan';

export interface PendingLimitOrder {
  orderId: string;
  clientOrderId: string;
  symbol: string;
  side: Side;
  price: number;
  qty: number;
  filledQty: number;
  reduceOnly: boolean;
  role: OrderRole;
  createdAtMs: number;
  timeoutMs: number;
}

const DEFAULT_LIMIT_ORDER_TIMEOUT_MS = 30_000;

export class OrderMonitor {
  private readonly pendingLimitOrders = new Map<string, PendingLimitOrder>();

  constructor(
    private readonly deps: {
      queryOrder: (symbol: string, orderId: string) => Promise<{ status: string; executedQty: number }>;
      cancelOrder: (symbol: string, orderId: string, clientOrderId?: string) => Promise<void>;
      placeMarketOrder: (input: {
        symbol: string;
        side: Side;
        qty: number;
        reduceOnly: boolean;
        role: OrderRole;
        fallbackFromOrderId: string;
      }) => Promise<void>;
      log?: (event: string, detail?: Record<string, any>) => void;
    }
  ) { }

  register(input: {
    orderId: string;
    clientOrderId: string;
    symbol: string;
    side: Side;
    price: number;
    qty: number;
    reduceOnly: boolean;
    role: OrderRole;
    createdAtMs?: number;
    timeoutMs?: number;
  }) {
    const timeoutMs = Number.isFinite(input.timeoutMs as number)
      ? Math.max(1_000, Number(input.timeoutMs))
      : DEFAULT_LIMIT_ORDER_TIMEOUT_MS;

    this.pendingLimitOrders.set(input.orderId, {
      orderId: input.orderId,
      clientOrderId: input.clientOrderId,
      symbol: input.symbol,
      side: input.side,
      price: input.price,
      qty: input.qty,
      filledQty: 0,
      reduceOnly: input.reduceOnly,
      role: input.role,
      createdAtMs: input.createdAtMs || Date.now(),
      timeoutMs,
    });
  }

  remove(orderId: string) {
    this.pendingLimitOrders.delete(orderId);
  }

  size(): number {
    return this.pendingLimitOrders.size;
  }

  async monitorLimitOrders(): Promise<void> {
    for (const order of Array.from(this.pendingLimitOrders.values())) {
      const nowMs = Date.now();
      const timedOut = nowMs - order.createdAtMs > order.timeoutMs;

      if (timedOut) {
        this.deps.log?.('LIMIT_TIMEOUT', {
          symbol: order.symbol,
          orderId: order.orderId,
          clientOrderId: order.clientOrderId,
          role: order.role,
        });

        try {
          await this.deps.cancelOrder(order.symbol, order.orderId, order.clientOrderId);
        } catch (e: any) {
          this.deps.log?.('LIMIT_TIMEOUT_CANCEL_ERROR', {
            symbol: order.symbol,
            orderId: order.orderId,
            error: e?.message || 'cancel_failed',
          });
        }

        const remainingQty = Math.max(0, order.qty - order.filledQty);
        if (remainingQty > 0) {
          await this.deps.placeMarketOrder({
            symbol: order.symbol,
            side: order.side,
            qty: remainingQty,
            reduceOnly: order.reduceOnly,
            role: order.role,
            fallbackFromOrderId: order.orderId,
          });
        }
        this.pendingLimitOrders.delete(order.orderId);
        continue;
      }

      try {
        const status = await this.deps.queryOrder(order.symbol, order.orderId);
        if (status.status === 'FILLED') {
          this.pendingLimitOrders.delete(order.orderId);
          this.deps.log?.('LIMIT_FILLED', {
            symbol: order.symbol,
            orderId: order.orderId,
            price: order.price,
            role: order.role,
          });
        } else if (status.status === 'PARTIALLY_FILLED') {
          order.filledQty = Number(status.executedQty || 0);
        } else if (status.status === 'CANCELED' || status.status === 'REJECTED' || status.status === 'EXPIRED') {
          this.pendingLimitOrders.delete(order.orderId);
        }
      } catch (e: any) {
        this.deps.log?.('LIMIT_MONITOR_ERROR', {
          symbol: order.symbol,
          orderId: order.orderId,
          error: e?.message || 'query_failed',
        });
      }
    }
  }
}
