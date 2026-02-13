try {
    require('dotenv').config();
} catch (_) {
    // dotenv is optional for one-off scripts
}

const API_KEY = String(process.env.API_KEY_SECRET || 'local-dev-api-key');
const API_HOST = String(process.env.API_HOST || 'localhost');
const API_PORT = Number(process.env.API_PORT || 8787);

function withApiKeyQuery(path) {
    const separator = path.includes('?') ? '&' : '?';
    return `${path}${separator}apiKey=${encodeURIComponent(API_KEY)}`;
}

function httpOptions(pathname) {
    return {
        host: API_HOST,
        port: API_PORT,
        path: pathname,
        headers: {
            'X-API-Key': API_KEY,
        },
    };
}

module.exports = {
    API_KEY,
    API_HOST,
    API_PORT,
    withApiKeyQuery,
    httpOptions,
};
