import WebSocket from 'ws';
import { API_HOST, API_PORT, wsProtocols } from './auth/clientAuth.mjs';

const wsUrl = `ws://${API_HOST}:${API_PORT}/ws?symbols=BNBUSDT`;
const ws = new WebSocket(wsUrl, wsProtocols());

ws.on('open', () => {
  console.log('OPEN', wsUrl);
});

ws.on('error', (err) => {
  console.error('WS error:', err);
});

setInterval(() => {
  // keep process alive for quick manual checks
}, 10_000);
