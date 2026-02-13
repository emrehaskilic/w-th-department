const DEFAULT_PROXY_API_KEY = 'local-dev-api-key';

export const PROXY_API_KEY = String((import.meta as any).env?.VITE_PROXY_API_KEY || DEFAULT_PROXY_API_KEY);

export function withProxyApiKey(init: RequestInit = {}): RequestInit {
    const headers = new Headers(init.headers || {});
    headers.set('X-API-Key', PROXY_API_KEY);
    return {
        ...init,
        headers,
    };
}

export function withApiKeyInQuery(url: string): string {
    const parsed = new URL(url);
    parsed.searchParams.set('apiKey', PROXY_API_KEY);
    return parsed.toString();
}
