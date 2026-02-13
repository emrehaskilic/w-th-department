const WebSocket = require('ws');
const { API_HOST, API_PORT, withApiKeyQuery } = require('./auth/clientAuth.cjs');

// Connect to multiple symbols and verify each has correct price
const wsPath = withApiKeyQuery('/ws?symbols=BTCUSDT,ETHUSDT,SOLUSDT');
const client = new WebSocket(`ws://${API_HOST}:${API_PORT}${wsPath}`);

const prices = {};

client.on('open', () => {
    console.log('Connected to WS');
});

client.on('message', (data) => {
    try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'metrics' && msg.symbol) {
            const mid = msg.midPrice || msg.legacyMetrics?.price;
            if (mid && !prices[msg.symbol]) {
                prices[msg.symbol] = mid;
                console.log(`${msg.symbol}: midPrice = ${mid}`);

                // Check if all 3 symbols received
                if (Object.keys(prices).length >= 3) {
                    console.log('\n=== SYMBOL INTEGRITY VERIFICATION ===');

                    const btc = prices['BTCUSDT'];
                    const eth = prices['ETHUSDT'];
                    const sol = prices['SOLUSDT'];

                    let allPass = true;

                    if (btc >= 60000 && btc <= 100000) {
                        console.log(`✅ BTCUSDT: ${btc} is in BTC range [60000-100000]`);
                    } else {
                        console.log(`❌ BTCUSDT: ${btc} is OUT OF BTC range [60000-100000]`);
                        allPass = false;
                    }

                    if (eth >= 2000 && eth <= 5000) {
                        console.log(`✅ ETHUSDT: ${eth} is in ETH range [2000-5000]`);
                    } else {
                        console.log(`❌ ETHUSDT: ${eth} is OUT OF ETH range [2000-5000]`);
                        allPass = false;
                    }

                    if (sol >= 50 && sol <= 300) {
                        console.log(`✅ SOLUSDT: ${sol} is in SOL range [50-300]`);
                    } else {
                        console.log(`❌ SOLUSDT: ${sol} is OUT OF SOL range [50-300]`);
                        allPass = false;
                    }

                    console.log('\n' + (allPass ? 'PASS: All symbol prices are correct' : 'FAIL: Symbol price mismatch detected'));
                    process.exit(allPass ? 0 : 1);
                }
            }
        }
    } catch (e) { }
});

client.on('error', (err) => {
    console.error('WS Error:', err);
    process.exit(1);
});

setTimeout(() => {
    console.error('Timeout waiting for all symbols');
    console.log('Received prices:', prices);
    process.exit(1);
}, 10000);
