import { OrderType, Side } from '../connectors/executionTypes';
import { OpenOrderState } from './types';

export type PlanState = 'BOOT' | 'BUILDING' | 'ACTIVE' | 'EXITING' | 'FLATTENED';
export type TrendState = 'UP' | 'DOWN' | 'CHOP';
export type OrderRole = 'BOOT_PROBE' | 'SCALE_IN' | 'TP' | 'STOP' | 'FLATTEN' | 'FLIP';

export interface OrderTag {
  planId: string;
  role: OrderRole;
  levelIndex: number;
  symbol: string;
  side: Side;
}

export interface PlannedOrder {
  planId: string;
  role: OrderRole;
  levelIndex: number;
  symbol: string;
  side: Side;
  type: OrderType;
  price: number | null;
  qty: number;
  reduceOnly: boolean;
  clientOrderId: string;
  tag: OrderTag;
}

export type PlanAction =
  | { kind: 'PLACE'; order: PlannedOrder; reason: string }
  | { kind: 'CANCEL'; existing: OpenOrderState; reason: string }
  | { kind: 'REPLACE'; existing: OpenOrderState; order: PlannedOrder; reason: string };

export interface PlanReconcileResult {
  actions: PlanAction[];
  created: PlannedOrder[];
  canceled: OpenOrderState[];
  replaced: Array<{ existing: OpenOrderState; desired: PlannedOrder }>;
}

export interface PlanTickSummary {
  symbol: string;
  planId: string | null;
  planState: PlanState;
  trendState: TrendState;
  trendScore: number;
  confirmCount: number;
  desiredOrdersCount: number;
  openOrdersCount: number;
  actions: {
    created: Array<{ role: OrderRole; level: number; price: number | null; qty: number }>;
    canceled: Array<{ role: OrderRole; level: number; price: number | null; qty: number }>;
    replaced: Array<{ role: OrderRole; level: number; price: number | null; qty: number }>;
  };
}

const ROLE_CODES: Record<OrderRole, string> = {
  BOOT_PROBE: 'BP',
  SCALE_IN: 'SI',
  TP: 'TP',
  STOP: 'ST',
  FLATTEN: 'FL',
  FLIP: 'FP',
};

const CODE_ROLES: Record<string, OrderRole> = Object.fromEntries(
  Object.entries(ROLE_CODES).map(([role, code]) => [code, role as OrderRole])
) as Record<string, OrderRole>;

export function buildPlanId(input: {
  symbol: string;
  side: Side;
  epochBucket: number;
  trendState: TrendState;
  initialMarginUsdt: number;
}): string {
  const key = `${input.symbol}|${input.side}|${input.epochBucket}|${input.trendState}|${Math.round(input.initialMarginUsdt)}`;
  return hashToBase36(key).slice(0, 10);
}

export function buildClientOrderId(tag: OrderTag, prefix = 'p'): string {
  const roleCode = ROLE_CODES[tag.role] || 'XX';
  const level = Math.max(0, Math.floor(tag.levelIndex));
  const id = `${prefix}${tag.planId}_${roleCode}${level}`;
  return id.length > 36 ? id.slice(0, 36) : id;
}

export function parseClientOrderId(clientOrderId: string, prefix = 'p'): OrderTag | null {
  if (!clientOrderId || !clientOrderId.startsWith(prefix)) {
    return null;
  }
  const match = new RegExp(`^${prefix}([a-z0-9]+)_([A-Z]{2})(\\d+)$`).exec(clientOrderId);
  if (!match) return null;
  const [, planId, roleCode, levelRaw] = match;
  const role = CODE_ROLES[roleCode];
  if (!role) return null;
  const levelIndex = Number(levelRaw);
  return {
    planId,
    role,
    levelIndex,
    symbol: '',
    side: 'BUY',
  };
}

export function tagMatchesPlan(tag: OrderTag | null, planId: string): boolean {
  return Boolean(tag && tag.planId === planId);
}

export function isPlanOrder(order: OpenOrderState, prefix = 'p'): boolean {
  return Boolean(order.clientOrderId && order.clientOrderId.startsWith(prefix));
}

function hashToBase36(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const unsigned = hash >>> 0;
  return unsigned.toString(36);
}
