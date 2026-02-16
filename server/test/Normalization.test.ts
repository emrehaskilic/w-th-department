// Minimal assertion helper to avoid relying on Node's built-in assert
function assert(condition: any, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

import { NormalizationStore } from '../strategy/Normalization';

export function runTests() {
  const norm = new NormalizationStore(1000, 32);
  const baseTs = 1_000_000;
  for (let i = 0; i < 10; i += 1) {
    norm.update('x', i + 1, baseTs + i * 50);
  }

  const z = norm.zScore('x', 10);
  const p = norm.percentile('x', 10);
  assert(Number.isFinite(z), 'z-score should be finite');
  assert(p > 0.8, 'percentile for max sample should be high');

  // Sliding window eviction
  norm.update('x', 100, baseTs + 2000);
  const count = norm.count('x');
  assert(count <= 2, 'old samples should be evicted by sliding window');
}
