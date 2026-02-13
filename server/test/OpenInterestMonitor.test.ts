// Minimal assertion helper
function assert(condition: any, message: string): void {
  if (!condition) throw new Error(message);
}

import { OpenInterestMonitor } from '../metrics/OpenInterestMonitor';

/**
 * Tests for the OpenInterestMonitor.  We manually call update() to
 * simulate receiving open interest values and verify that the delta
 * is computed correctly.
 */
export function runTests() {
  const mon = new OpenInterestMonitor('BTCUSDT');
  let received: any = null;
  mon.onUpdate(m => {
    received = m;
  });
  // First update: delta should be 0 (no previous value)
  mon.update(1000);
  assert(received !== null, 'should receive metrics');
  assert(received.openInterest === 1000, 'open interest value');
  assert(received.oiChangeAbs === 0, 'first delta should be 0');
  // Second update: delta should reflect change
  mon.update(1500);
  assert(received.openInterest === 1500, 'open interest updated');
  assert(received.oiChangeAbs === 500, 'delta should be difference');
}
