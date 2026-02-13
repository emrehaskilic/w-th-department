import { DryRunProxyConfig } from './types';

const MAINNET_REST_HOST = 'fapi.binance.com';
const MAINNET_WS_HOST = 'fstream.binance.com';

type UpstreamGuardCode =
  | 'invalid_url'
  | 'invalid_proxy_mode'
  | 'upstream_guard_fail_rest'
  | 'upstream_guard_fail_ws';

export class UpstreamGuardError extends Error {
  readonly name = 'UpstreamGuardError';
  readonly statusCode = 400;

  constructor(
    readonly code: UpstreamGuardCode,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
  }
}

export function isUpstreamGuardError(error: unknown): error is UpstreamGuardError {
  return error instanceof UpstreamGuardError;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    throw new UpstreamGuardError('invalid_url', `invalid_url:${url}`, { url });
  }
}

export function assertMainnetProxyConfig(proxy: DryRunProxyConfig): void {
  if (proxy.mode !== 'backend-proxy') {
    throw new UpstreamGuardError('invalid_proxy_mode', `invalid_proxy_mode:${proxy.mode}`, { mode: proxy.mode });
  }

  const restHost = hostnameOf(proxy.restBaseUrl);
  const wsHost = hostnameOf(proxy.marketWsBaseUrl);

  if (restHost !== MAINNET_REST_HOST) {
    throw new UpstreamGuardError('upstream_guard_fail_rest', `upstream_guard_fail_rest:${restHost}`, {
      actual: restHost,
      expected: MAINNET_REST_HOST,
    });
  }

  if (wsHost !== MAINNET_WS_HOST) {
    throw new UpstreamGuardError('upstream_guard_fail_ws', `upstream_guard_fail_ws:${wsHost}`, {
      actual: wsHost,
      expected: MAINNET_WS_HOST,
    });
  }
}
