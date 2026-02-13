const WebSocket = require('ws');
const { API_HOST, API_PORT, withApiKeyQuery } = require('./auth/clientAuth.cjs');

const ws = new WebSocket(`ws://${API_HOST}:${API_PORT}${withApiKeyQuery('/ws?symbols=BTCUSDT')}`);

ws.on('open', () => {
    console.log('Connected to WS');
});

ws.on('message', (data) => {
    try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'metrics' && msg.symbol === 'BTCUSDT') {
            const bids = msg.bids || [];
            const asks = msg.asks || [];
            if (bids.length > 0 && asks.length > 0) {
                console.log('SUCCESS: Orderbook data received.');
                console.log(`Bids: ${bids.length}, Asks: ${asks.length}`);
                console.log(`Sample Bid: ${JSON.stringify(bids[0])}`);
                console.log(`Sample Ask: ${JSON.stringify(asks[0])}`);
                process.exit(0);
            }
        }
    } catch (e) {
        console.error('Error parsing message:', e);
    }
});

ws.on('error', (err) => {
    console.error('WS Error:', err);
    process.exit(1);
});

setTimeout(() => {
    console.error('Timeout waiting for orderbook data');
    process.exit(1);
}, 5000);
