const http = require('http');

http.get('http://localhost:8787/api/health', (res) => {
    let data = '';
    res.on('data', (chunk) => data += chunk);
    res.on('end', () => {
        try {
            const json = JSON.parse(data);
            console.log('--- SERVER HEALTH REPORT ---');
            console.log('Active Symbols:', Object.keys(json.symbols).length);
            Object.keys(json.symbols).forEach(s => {
                const symbol = json.symbols[s];
                console.log(`\nSymbol: ${s}`);
                console.log(`Status (uiState): ${symbol.status}`);
                console.log(`Last Snapshot OK: ${symbol.lastSnapshotOkTs > 0 ? 'YES' : 'NO'} (${symbol.lastSnapshot})`);
                console.log(`Desync Count (10s): ${symbol.desync_count_10s}`);
                console.log(`Live Uptime (60s): ${symbol.live_uptime_pct_60s}%`);
                console.log(`Buffered Count: ${symbol.bufferedDepthCount}`);
                console.log(`Apply Count: ${symbol.applyCount}`);
                console.log(`Drop Count: ${symbol.dropCount}`);
            });
        } catch (e) {
            console.error('Error parsing JSON:', e.message);
            console.log('Raw data:', data.substring(0, 500));
        }
    });
}).on('error', (err) => {
    console.error('Error: ' + err.message);
});
