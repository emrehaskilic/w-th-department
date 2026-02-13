const WebSocket = require('ws');
const { API_HOST, API_PORT, withApiKeyQuery } = require('./auth/clientAuth.cjs');

console.log('Connecting...');
const wsUrl = `ws://${API_HOST}:${API_PORT}${withApiKeyQuery('/ws?symbols=BTCUSDT')}`;
const client = new WebSocket(wsUrl);

client.on('open', () => {
    console.log('Connected to WS:', wsUrl);
});

client.on('message', (data) => {
    void data;
});

client.on('error', (err) => {
    console.error('WS Error:', err);
});

setInterval(() => { }, 100000);
