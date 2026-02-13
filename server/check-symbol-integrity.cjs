const http = require('http');
const { httpOptions } = require('./auth/clientAuth.cjs');

http.get(httpOptions('/api/health'), (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        const health = JSON.parse(data);
        console.log('=== SYMBOL INTEGRITY CHECK ===\n');

        for (const [symbol, info] of Object.entries(health.symbols)) {
            const d = info;
            console.log(`Symbol: ${symbol}`);
            console.log(`  Status: ${d.status}`);
            console.log(`  Best Bid: ${d.bookLevels.bestBid}`);
            console.log(`  Best Ask: ${d.bookLevels.bestAsk}`);
            console.log(`  Book Size: ${d.bookLevels.bids} bids, ${d.bookLevels.asks} asks`);
            console.log(`  Last Snapshot Update ID: ${d.snapshotLastUpdateId}`);
            console.log('');

            // Sanity check
            const bid = d.bookLevels.bestBid;
            let expectedRange = '';
            if (symbol === 'BTCUSDT') {
                expectedRange = '[60000-100000]';
                if (bid < 60000 || bid > 100000) {
                    console.log(`  ❌ FAIL: BTC price ${bid} is OUT OF RANGE ${expectedRange}`);
                } else {
                    console.log(`  ✅ PASS: BTC price ${bid} is IN RANGE ${expectedRange}`);
                }
            } else if (symbol === 'ETHUSDT') {
                expectedRange = '[2000-5000]';
                if (bid < 2000 || bid > 5000) {
                    console.log(`  ❌ FAIL: ETH price ${bid} is OUT OF RANGE ${expectedRange}`);
                } else {
                    console.log(`  ✅ PASS: ETH price ${bid} is IN RANGE ${expectedRange}`);
                }
            } else if (symbol === 'SOLUSDT') {
                expectedRange = '[50-300]';
                if (bid < 50 || bid > 300) {
                    console.log(`  ❌ FAIL: SOL price ${bid} is OUT OF RANGE ${expectedRange}`);
                } else {
                    console.log(`  ✅ PASS: SOL price ${bid} is IN RANGE ${expectedRange}`);
                }
            }
            console.log('');
        }
    });
}).on('error', (e) => console.error(e));
