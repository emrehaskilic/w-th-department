import { testSuites } from './suites';

let total = 0;
let passed = 0;
for (const suite of testSuites) {
  total++;
  try {
    suite.fn();
    passed++;
    console.log(`PASS ${suite.name}`);
  } catch (e: any) {
    console.error(`FAIL ${suite.name}: ${e.message}`);
  }
}
console.log(`OK ${passed}/${total}`);
if (passed !== total) {
  process.exitCode = 1;
}
