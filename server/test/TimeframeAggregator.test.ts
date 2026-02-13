import assert from 'node:assert/strict';

import { TimeframeAggregator } from '../strategy/TimeframeAggregator';

export function runTests() {
  const tfa = new TimeframeAggregator([1000, 5000, 10000], 15000);
  const base = 1_700_000_000_000;

  tfa.add({ obi: 0.2, deltaZ: 0.8 }, base + 1000);
  tfa.add({ obi: 0.3, deltaZ: 0.9 }, base + 2000);
  tfa.add({ obi: 0.25, deltaZ: 1.1 }, base + 3000);

  const aligned = tfa.getTimeframeMultipliers({ obi: 0.4, deltaZ: 1.2 }, base + 3500);
  assert(aligned.obi > 1, 'aligned metric should get confirmation multiplier > 1');
  assert(aligned.deltaZ > 1, 'aligned metric should get confirmation multiplier > 1');

  tfa.add({ obi: -0.7, deltaZ: -1.4 }, base + 12000);
  const mixed = tfa.getTimeframeMultipliers({ obi: 0.1, deltaZ: 0.2 }, base + 12500);
  assert(mixed.obi < aligned.obi, 'contradicting recent sample should reduce multiplier');
}
