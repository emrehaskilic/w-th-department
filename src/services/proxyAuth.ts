export const PROXY_API_KEY = String(import.meta.env.VITE_PROXY_API_KEY || '').trim();

export function isProxyApiKeyConfigured(): boolean {
    return PROXY_API_KEY.length > 0;
}

function toBase64Url(value: string): string {
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    for (const b of bytes) {
        binary += String.fromCharCode(b);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function withProxyApiKey(init: RequestInit = {}): RequestInit {
    const headers = new Headers(init.headers || {});
    if (isProxyApiKeyConfigured()) {
        headers.set('Authorization', `Bearer ${PROXY_API_KEY}`);
    }
    return {
        ...init,
        headers,
    };
}

export function proxyWebSocketProtocols(): string[] {
    if (!isProxyApiKeyConfigured()) {
        return ['proxy-auth'];
    }
    return ['proxy-auth', `bearer.${toBase64Url(PROXY_API_KEY)}`];
}
