import http from 'node:http';
import { httpOptions } from './auth/clientAuth.mjs';

http.get(httpOptions('/api/health'), (res) => {
  let data = '';
  res.on('data', (chunk) => {
    data += chunk;
  });
  res.on('end', () => {
    const health = JSON.parse(data);
    console.log('=== SYMBOL INTEGRITY CHECK ===\n');

    for (const [symbol, info] of Object.entries(health.symbols || {})) {
      const d = info;
      const bid = d?.bookLevels?.bestBid;
      console.log(`Symbol: ${symbol}`);
      console.log(`  Status: ${d?.status}`);
      console.log(`  Best Bid: ${bid}`);
      console.log(`  Best Ask: ${d?.bookLevels?.bestAsk}`);
      console.log(`  Book Size: ${d?.bookLevels?.bids} bids, ${d?.bookLevels?.asks} asks`);
      console.log(`  Last Snapshot Update ID: ${d?.snapshotLastUpdateId}`);
      console.log('');

      let expectedRange = '';
      if (symbol === 'BTCUSDT') {
        expectedRange = '[60000-100000]';
        console.log(
          bid < 60000 || bid > 100000
            ? `  FAIL: BTC price ${bid} is OUT OF RANGE ${expectedRange}`
            : `  PASS: BTC price ${bid} is IN RANGE ${expectedRange}`
        );
      } else if (symbol === 'ETHUSDT') {
        expectedRange = '[2000-5000]';
        console.log(
          bid < 2000 || bid > 5000
            ? `  FAIL: ETH price ${bid} is OUT OF RANGE ${expectedRange}`
            : `  PASS: ETH price ${bid} is IN RANGE ${expectedRange}`
        );
      } else if (symbol === 'SOLUSDT') {
        expectedRange = '[50-300]';
        console.log(
          bid < 50 || bid > 300
            ? `  FAIL: SOL price ${bid} is OUT OF RANGE ${expectedRange}`
            : `  PASS: SOL price ${bid} is IN RANGE ${expectedRange}`
        );
      }
      console.log('');
    }
  });
}).on('error', (error) => console.error(error));
