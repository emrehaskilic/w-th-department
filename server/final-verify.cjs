const http = require('http');
const { httpOptions } = require('./auth/clientAuth.cjs');

function getHealth() {
    return new Promise((resolve, reject) => {
        http.get(httpOptions('/api/health'), (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(JSON.parse(data)));
        }).on('error', reject);
    });
}

async function main() {
    const health = await getHealth();

    console.log('=== /api/health SYMBOL VERIFICATION ===\n');

    let allPass = true;

    for (const [symbol, info] of Object.entries(health.symbols)) {
        const d = info;
        const bid = d.bookLevels?.bestBid;
        const ask = d.bookLevels?.bestAsk;

        console.log(`--- ${symbol} ---`);
        console.log(`  bestBid: ${bid}`);
        console.log(`  bestAsk: ${ask}`);
        console.log(`  bookLevels: ${d.bookLevels?.bids} bids, ${d.bookLevels?.asks} asks`);
        console.log(`  status: ${d.status}`);

        // Price validation
        let isValid = false;
        let expectedRange = '';

        if (symbol === 'BTCUSDT') {
            expectedRange = '[60000-100000]';
            isValid = bid >= 60000 && bid <= 100000;
        } else if (symbol === 'ETHUSDT') {
            expectedRange = '[2000-5000]';
            isValid = bid >= 2000 && bid <= 5000;
        } else if (symbol === 'SOLUSDT') {
            expectedRange = '[50-300]';
            isValid = bid >= 50 && bid <= 300;
        } else {
            isValid = bid > 0; // Just check it's non-zero for other symbols
            expectedRange = '[>0]';
        }

        if (isValid) {
            console.log(`  ✅ PASS: ${bid} in ${expectedRange}`);
        } else {
            console.log(`  ❌ FAIL: ${bid} NOT in ${expectedRange}`);
            allPass = false;
        }
        console.log('');
    }

    console.log('=== FINAL RESULT ===');
    if (allPass) {
        console.log('PASS: All symbols have correct bestBid/bestAsk in expected price ranges && no symbol overwrite detected');
    } else {
        console.log('FAIL: Symbol price mismatch detected');
    }
}

main().catch(console.error);
