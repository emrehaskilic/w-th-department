import http from 'node:http';
import { httpOptions } from './auth/clientAuth.mjs';

http.get(httpOptions('/api/health'), (res) => {
  let data = '';
  res.on('data', (chunk) => {
    data += chunk;
  });
  res.on('end', () => {
    const health = JSON.parse(data);
    console.log('Full health response:');
    console.log(JSON.stringify(health, null, 2));
  });
}).on('error', (error) => console.error(error));
