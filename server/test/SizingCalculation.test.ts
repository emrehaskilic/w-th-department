import assert from 'node:assert/strict';

import { computeSizingFromBudget } from '../orchestrator/SizingMath';

export function runTests() {
  const normal = computeSizingFromBudget({
    startingMarginUsdt: 10,
    currentMarginBudgetUsdt: 10,
    leverage: 25,
    markPrice: 50000,
    stepSize: 0.000001,
    minNotionalUsdt: 5,
  });

  assert(normal.qtyRounded > 0, 'qty should be > 0 for starting_margin=10, leverage=25, price=50000');
  assert(normal.blockedReason === null, 'normal case should not be blocked');

  const blocked = computeSizingFromBudget({
    startingMarginUsdt: 0.01,
    currentMarginBudgetUsdt: 0.01,
    leverage: 1,
    markPrice: 50000,
    stepSize: 0.001,
    minNotionalUsdt: 5,
  });

  assert(blocked.qtyRounded === 0 || blocked.minNotionalOk === false, 'tiny budget should fail sizing');
  assert(blocked.blockedReason === 'min_notional', 'tiny budget should produce min_notional block');
}
