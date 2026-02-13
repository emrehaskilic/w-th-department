import WebSocket from 'ws';
import { API_HOST, API_PORT, wsProtocols } from './auth/clientAuth.mjs';

const ws = new WebSocket(`ws://${API_HOST}:${API_PORT}/ws?symbols=BTCUSDT`, wsProtocols());

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
  } catch (error) {
    console.error('Error parsing message:', error);
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
