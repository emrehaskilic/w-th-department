const PROXY_API_KEY = String((import.meta as any).env?.VITE_PROXY_API_KEY || '').trim();
if (!PROXY_API_KEY) {
    throw new Error('Missing VITE_PROXY_API_KEY. Set it in your frontend environment (e.g. .env.local).');
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
    headers.set('Authorization', `Bearer ${PROXY_API_KEY}`);
    return {
        ...init,
        headers,
    };
}

export function proxyWebSocketProtocols(): string[] {
    return ['proxy-auth', `bearer.${toBase64Url(PROXY_API_KEY)}`];
}
