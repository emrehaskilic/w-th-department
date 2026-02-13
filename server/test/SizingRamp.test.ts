function assert(condition: any, message: string): void {
  if (!condition) throw new Error(message);
}

import { SizingRamp } from '../orchestrator/SizingRamp';

export function runTests() {
  const ramp = new SizingRamp({
    startingMarginUsdt: 10,
    minMarginUsdt: 5,
    rampStepPct: 10,
    rampDecayPct: 20,
    rampMaxMult: 5,
  });

  let state = ramp.getState();
  assert(state.currentMarginBudgetUsdt === 10, 'initial budget should equal starting margin');

  state = ramp.onTradeClosed(1);
  assert(Math.abs(state.currentMarginBudgetUsdt - 12) < 1e-9, 'success should increase budget by asymmetric compounding');

  // Push to max clamp (10 * 5 = 50)
  for (let i = 0; i < 30; i++) {
    state = ramp.onTradeClosed(1);
  }
  assert(state.currentMarginBudgetUsdt <= 50, 'budget should not exceed max clamp');

  // Fail path should decay and clamp to minimum
  for (let i = 0; i < 100; i++) {
    state = ramp.onTradeClosed(-1);
  }
  assert(state.currentMarginBudgetUsdt >= 5, 'budget should not go below min clamp');
}
