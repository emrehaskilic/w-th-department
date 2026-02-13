const http = require('http');
const fs = require('fs');
const { httpOptions } = require('./auth/clientAuth.cjs');

http.get(httpOptions('/api/health'), (res) => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
        fs.writeFileSync('health-report.json', JSON.stringify(JSON.parse(data), null, 2));
        console.log('Written to health-report.json');
    });
});
