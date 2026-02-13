import WebSocket from 'ws';
import { API_HOST, API_PORT, wsProtocols } from './auth/clientAuth.mjs';

console.log('Connecting...');
const wsUrl = `ws://${API_HOST}:${API_PORT}/ws?symbols=BTCUSDT`;
const client = new WebSocket(wsUrl, wsProtocols());

client.on('open', () => {
  console.log('Connected to WS:', wsUrl);
});

client.on('message', (data) => {
  void data;
});

client.on('error', (err) => {
  console.error('WS Error:', err);
});

setInterval(() => {}, 100_000);
