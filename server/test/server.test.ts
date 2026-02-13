import test from 'node:test';
import { testSuites } from './suites';

for (const suite of testSuites) {
    test(suite.name, () => {
        suite.fn();
    });
}
