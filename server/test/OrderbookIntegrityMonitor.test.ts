import assert from 'node:assert/strict';

import { OrderbookIntegrityMonitor } from '../metrics/OrderbookIntegrityMonitor';

export function runTests() {
  const monitor = new OrderbookIntegrityMonitor('BTCUSDT', {
    staleWarnMs: 500,
    staleCriticalMs: 1200,
    maxGapBeforeCritical: 2,
    reconnectCooldownMs: 1000,
  });

  const now = 1_700_000_000_000;
  const ok = monitor.observe({
    symbol: 'BTCUSDT',
    sequenceStart: 10,
    sequenceEnd: 12,
    eventTimeMs: now - 10,
    bestBid: 100,
    bestAsk: 100.1,
    nowMs: now,
  });
  assert(ok.level === 'OK', 'fresh and ordered update should be OK');

  const gap = monitor.observe({
    symbol: 'BTCUSDT',
    sequenceStart: 20,
    sequenceEnd: 21,
    eventTimeMs: now + 100,
    bestBid: 100.05,
    bestAsk: 100.2,
    nowMs: now + 120,
  });
  assert(gap.sequenceGapCount >= 1, 'gap counter should increment');
  assert(gap.level !== 'OK', 'sequence gap should degrade integrity');

  const crossed = monitor.observe({
    symbol: 'BTCUSDT',
    sequenceStart: 22,
    sequenceEnd: 22,
    eventTimeMs: now + 200,
    bestBid: 101,
    bestAsk: 100.9,
    nowMs: now + 250,
  });
  assert(crossed.level === 'CRITICAL', 'crossed book must be critical');
  assert(crossed.reconnectRecommended, 'critical crossed book should recommend reconnect');
}
