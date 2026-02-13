import http from 'node:http';
import { httpOptions } from './auth/clientAuth.mjs';

function fetchHealth() {
  return new Promise((resolve, reject) => {
    http.get(httpOptions('/api/health'), (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        resolve(JSON.parse(data));
      });
    }).on('error', reject);
  });
}

async function test() {
  console.log('=== OBI Broadcast Verification Test ===');
  console.log('Sampling over 10 seconds...\n');

  const startTime = Date.now();
  await fetchHealth();

  await new Promise((resolve) => setTimeout(resolve, 10_000));

  const endHealth = await fetchHealth();
  const elapsed = Date.now() - startTime;

  console.log(`Elapsed: ${elapsed}ms`);
  console.log('=== FULL HEALTH RESPONSE ===');
  console.log(JSON.stringify(endHealth, null, 2));

  console.log('\n=== VERIFICATION RESULTS ===\n');

  for (const [symbol, data] of Object.entries(endHealth.symbols || {})) {
    const d = data;
    console.log(`Symbol: ${symbol}`);
    console.log(`  Status: ${d.status}`);
    console.log(`  Depth Applies (10s): ${d.applyCount10s}`);
    console.log(`  Metrics Broadcasts (10s): ${d.metricsBroadcastCount10s}`);
    console.log(`    - Depth-triggered: ${d.metricsBroadcastDepthCount10s}`);
    console.log(`    - Trade-triggered: ${d.metricsBroadcastTradeCount10s}`);
    console.log(`  Last Broadcast Reason: ${d.lastMetricsBroadcastReason}`);
    console.log(`  Last Broadcast Ts: ${d.lastMetricsBroadcastTs}`);
    console.log(`  Book Levels: ${d.bookLevels.bids} bids, ${d.bookLevels.asks} asks`);
    console.log(`  Best Bid/Ask: ${d.bookLevels.bestBid} / ${d.bookLevels.bestAsk}`);
    console.log('');

    const depthBroadcasts = d.metricsBroadcastDepthCount10s || 0;
    const hasBook = d.bookLevels.bids > 0 && d.bookLevels.asks > 0;
    const isLive = d.status === 'LIVE';

    if (depthBroadcasts > 0 && hasBook && isLive) {
      console.log(`  PASS: metricsBroadcastDepthCount10s=${depthBroadcasts} > 0 && Book OK && LIVE`);
    } else {
      console.log(`  FAIL: depthBroadcasts=${depthBroadcasts}, hasBook=${hasBook}, isLive=${isLive}`);
    }
    console.log('');
  }

  console.log('=== TEST COMPLETE ===');
}

test().catch((error) => {
  console.error('Test failed:', error?.message || error);
  process.exit(1);
});
