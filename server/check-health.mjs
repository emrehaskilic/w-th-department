import fs from 'node:fs';
import http from 'node:http';
import { httpOptions } from './auth/clientAuth.mjs';

http.get(httpOptions('/api/health'), (res) => {
  let data = '';
  res.on('data', (chunk) => {
    data += chunk;
  });
  res.on('end', () => {
    fs.writeFileSync('health-report.json', JSON.stringify(JSON.parse(data), null, 2));
    console.log('Written to health-report.json');
  });
});
