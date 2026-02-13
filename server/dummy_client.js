const WebSocket = require('ws');
const { API_HOST, API_PORT, withApiKeyQuery } = require('./auth/clientAuth.cjs');

const wsUrl = `ws://${API_HOST}:${API_PORT}${withApiKeyQuery('/ws?symbols=BNBUSDT')}`;
const ws = new WebSocket(wsUrl);

ws.on('open', () => {
    console.log('OPEN', wsUrl);
});

ws.on('error', (err) => {
    console.error('WS error:', err);
});

setInterval(() => {
    // keep process alive for quick manual checks
}, 10000);
