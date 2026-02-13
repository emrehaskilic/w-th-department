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

export interface ExecutionResult {
  ok: boolean;
  orderId?: string;
  error?: string;
}

export interface IExecutor {
  execute(decision: ExecutionDecision): Promise<ExecutionResult>;
}

