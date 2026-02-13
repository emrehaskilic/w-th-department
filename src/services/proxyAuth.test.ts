import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadModule() {
  return import(`./proxyAuth?t=${Date.now()}-${Math.random()}`);
}

describe('proxyAuth', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('marks configuration as ready when API key exists', async () => {
    vi.stubEnv('VITE_PROXY_API_KEY', 'secret-key');
    const mod = await loadModule();

    expect(mod.isProxyApiKeyConfigured()).toBe(true);

    const withAuth = mod.withProxyApiKey();
    const headers = new Headers(withAuth.headers);
    expect(headers.get('Authorization')).toBe('Bearer secret-key');
    expect(mod.proxyWebSocketProtocols()[0]).toBe('proxy-auth');
  });

  it('keeps request unauthed when API key is missing', async () => {
    vi.stubEnv('VITE_PROXY_API_KEY', '');
    const mod = await loadModule();

    expect(mod.isProxyApiKeyConfigured()).toBe(false);

    const withAuth = mod.withProxyApiKey();
    const headers = new Headers(withAuth.headers);
    expect(headers.get('Authorization')).toBeNull();
    expect(mod.proxyWebSocketProtocols()).toEqual(['proxy-auth']);
  });
});
