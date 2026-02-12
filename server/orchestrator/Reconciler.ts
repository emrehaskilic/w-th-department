import { OpenOrderState } from './types';
import {
  PlannedOrder,
  PlanReconcileResult,
  PlanAction,
  OrderRole,
  OrderTag,
  parseClientOrderId,
  isPlanOrder,
} from './OrderPlan';

export interface ReconcileConfig {
  orderPrefix: string;
  priceTolerancePct: number;
  qtyTolerancePct: number;
  replaceThrottlePerSecond: number;
  cancelStalePlanOrders: boolean;
}

export function reconcileOrders(input: {
  planId: string;
  desired: PlannedOrder[];
  openOrders: OpenOrderState[];
  config: ReconcileConfig;
  nowMs: number;
}): PlanReconcileResult {
  const { planId, desired, openOrders, config } = input;

  const desiredByKey = new Map<string, PlannedOrder>();
  for (const d of desired) {
    const key = orderKey(d.planId, d.role, d.levelIndex);
    desiredByKey.set(key, d);
  }

  const existingByKey = new Map<string, { order: OpenOrderState; tag: OrderTag }>();
  const staleOrders: OpenOrderState[] = [];
  for (const order of openOrders) {
    if (!isPlanOrder(order, config.orderPrefix)) {
      continue;
    }
    const parsed = parseClientOrderId(order.clientOrderId, config.orderPrefix);
    if (!parsed) continue;
    const tag = { ...parsed, symbol: '', side: order.side };
    if (tag.planId !== planId) {
      staleOrders.push(order);
      continue;
    }
    const key = orderKey(tag.planId, tag.role, tag.levelIndex);
    existingByKey.set(key, { order, tag });
  }

  const actions: PlanAction[] = [];
  const created: PlannedOrder[] = [];
  const canceled: OpenOrderState[] = [];
  const replaced: Array<{ existing: OpenOrderState; desired: PlannedOrder }> = [];

  if (config.cancelStalePlanOrders) {
    for (const order of staleOrders) {
      actions.push({ kind: 'CANCEL', existing: order, reason: 'stale_plan' });
      canceled.push(order);
    }
  }

  for (const [key, desiredOrder] of desiredByKey.entries()) {
    const existing = existingByKey.get(key)?.order;
    if (!existing) {
      actions.push({ kind: 'PLACE', order: desiredOrder, reason: 'missing_order' });
      created.push(desiredOrder);
      continue;
    }

    if (!withinTolerance(existing, desiredOrder, config)) {
      actions.push({ kind: 'REPLACE', existing, order: desiredOrder, reason: 'price_or_qty_mismatch' });
      replaced.push({ existing, desired: desiredOrder });
    }
  }

  for (const [key, existing] of existingByKey.entries()) {
    if (!desiredByKey.has(key)) {
      actions.push({ kind: 'CANCEL', existing: existing.order, reason: 'not_desired' });
      canceled.push(existing.order);
    }
  }

  const throttled = throttleActions(actions, config.replaceThrottlePerSecond);
  if (throttled.length < actions.length) {
    return { actions: throttled, created, canceled, replaced };
  }

  return { actions, created, canceled, replaced };
}

function orderKey(planId: string, role: OrderRole, level: number): string {
  return `${planId}|${role}|${level}`;
}

function withinTolerance(existing: OpenOrderState, desired: PlannedOrder, cfg: ReconcileConfig): boolean {
  if (existing.orderType !== desired.type) {
    return false;
  }

  const desiredQty = desired.qty;
  const qtyDiffPct = pctDiff(existing.origQty, desiredQty);
  if (qtyDiffPct > cfg.qtyTolerancePct) {
    return false;
  }

  if (desired.type === 'MARKET') {
    return true;
  }

  const desiredPrice = desired.price ?? 0;
  const priceDiffPct = pctDiff(existing.price, desiredPrice);
  return priceDiffPct <= cfg.priceTolerancePct;
}

function pctDiff(a: number, b: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.abs(a - b) / Math.abs(b) * 100;
}

function throttleActions(actions: PlanAction[], maxPerSecond: number): PlanAction[] {
  if (!Number.isFinite(maxPerSecond) || maxPerSecond <= 0) {
    return actions;
  }
  const cancels = actions.filter((a) => a.kind === 'CANCEL');
  const replaces = actions.filter((a) => a.kind === 'REPLACE');
  const places = actions.filter((a) => a.kind === 'PLACE');
  const limited = [...replaces, ...places].slice(0, maxPerSecond);
  return [...cancels, ...limited];
}
