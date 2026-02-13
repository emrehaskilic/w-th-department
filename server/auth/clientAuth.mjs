import { config as loadDotenv } from 'dotenv';

loadDotenv();

export const API_KEY = String(process.env.API_KEY_SECRET || '').trim();
export const API_HOST = String(process.env.API_HOST || 'localhost');
export const API_PORT = Number(process.env.API_PORT || 8787);

if (!API_KEY) {
  throw new Error('Missing API_KEY_SECRET. Set it before running helper scripts.');
}

export function wsProtocols() {
  return ['proxy-auth', `bearer.${Buffer.from(API_KEY, 'utf8').toString('base64url')}`];
}

export function httpOptions(pathname) {
  return {
    host: API_HOST,
    port: API_PORT,
    path: pathname,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
    },
  };
}
