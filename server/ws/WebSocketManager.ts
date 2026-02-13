import { WebSocket } from 'ws';

type LifecycleReason = 'close' | 'error' | 'stale' | 'terminated';

type ManagerDeps = {
  onSubscriptionsChanged: () => void;
  log: (event: string, data?: Record<string, unknown>) => void;
  heartbeatIntervalMs?: number;
  staleConnectionMs?: number;
  maxSubscriptionsPerClient?: number;
};

type ConnectionContext = {
  remoteAddress?: string | null;
};

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_STALE_CONNECTION_MS = 60_000;
const DEFAULT_MAX_SUBSCRIPTIONS_PER_CLIENT = 50;

export class WebSocketManager {
  private readonly clients = new Set<WebSocket>();
  private readonly clientSubs = new Map<WebSocket, Set<string>>();
  private readonly lastPongAt = new Map<WebSocket, number>();
  private readonly heartbeatIntervalMs: number;
  private readonly staleConnectionMs: number;
  private readonly maxSubscriptionsPerClient: number;
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly deps: ManagerDeps) {
    this.heartbeatIntervalMs = Math.max(1_000, deps.heartbeatIntervalMs || DEFAULT_HEARTBEAT_INTERVAL_MS);
    this.staleConnectionMs = Math.max(this.heartbeatIntervalMs * 2, deps.staleConnectionMs || DEFAULT_STALE_CONNECTION_MS);
    this.maxSubscriptionsPerClient = Math.max(1, deps.maxSubscriptionsPerClient || DEFAULT_MAX_SUBSCRIPTIONS_PER_CLIENT);
    this.timer = setInterval(() => this.heartbeatSweep(), this.heartbeatIntervalMs);
  }

  registerClient(client: WebSocket, symbols: string[], context: ConnectionContext = {}): void {
    const normalizedSymbols = this.normalizeSymbols(symbols).slice(0, this.maxSubscriptionsPerClient);
    const subscriptions = new Set(normalizedSymbols);

    this.clients.add(client);
    this.clientSubs.set(client, subscriptions);
    this.lastPongAt.set(client, Date.now());

    client.on('pong', () => {
      this.lastPongAt.set(client, Date.now());
    });

    client.on('close', (code, reasonBuffer) => {
      this.cleanupClient(client, 'close', {
        code,
        reason: reasonBuffer?.toString() || '',
        remoteAddress: context.remoteAddress || null,
      });
    });

    client.on('error', (error) => {
      this.deps.log('WS_CLIENT_ERROR', {
        error: error?.message || 'client_error',
        remoteAddress: context.remoteAddress || null,
      });
      this.cleanupClient(client, 'error', {
        remoteAddress: context.remoteAddress || null,
      });
    });

    this.deps.log('WS_CLIENT_JOIN', {
      remoteAddress: context.remoteAddress || null,
      symbols: normalizedSymbols,
      activeClients: this.clients.size,
    });
    this.deps.onSubscriptionsChanged();
  }

  getRequiredSymbols(): string[] {
    const symbols = new Set<string>();
    for (const subs of this.clientSubs.values()) {
      for (const symbol of subs) {
        symbols.add(symbol);
      }
    }
    return [...symbols].sort();
  }

  getClientCount(): number {
    return this.clients.size;
  }

  broadcastToSymbol(symbol: string, payload: string): number {
    let sent = 0;

    for (const client of this.clients) {
      if (client.readyState !== WebSocket.OPEN) {
        continue;
      }
      if (!this.clientSubs.get(client)?.has(symbol)) {
        continue;
      }
      try {
        client.send(payload);
        sent++;
      } catch (error: any) {
        this.deps.log('WS_CLIENT_SEND_ERROR', {
          symbol,
          error: error?.message || 'send_failed',
        });
        this.cleanupClient(client, 'error', { symbol });
      }
    }

    return sent;
  }

  shutdown(): void {
    clearInterval(this.timer);
    for (const client of [...this.clients]) {
      try {
        if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
          client.terminate();
        }
      } catch {
        // ignore shutdown errors
      } finally {
        this.cleanupClient(client, 'terminated');
      }
    }
  }

  private heartbeatSweep(): void {
    const now = Date.now();

    for (const client of [...this.clients]) {
      if (client.readyState === WebSocket.CLOSED) {
        this.cleanupClient(client, 'close');
        continue;
      }

      if (client.readyState !== WebSocket.OPEN) {
        continue;
      }

      const lastSeen = this.lastPongAt.get(client) || 0;
      if (now - lastSeen > this.staleConnectionMs) {
        this.deps.log('WS_CLIENT_STALE_CLOSE', {
          staleForMs: now - lastSeen,
        });
        try {
          client.terminate();
        } finally {
          this.cleanupClient(client, 'stale');
        }
        continue;
      }

      try {
        client.ping();
      } catch {
        this.cleanupClient(client, 'error');
      }
    }
  }

  private cleanupClient(client: WebSocket, reason: LifecycleReason, detail: Record<string, unknown> = {}): void {
    if (!this.clients.has(client)) {
      return;
    }

    this.clients.delete(client);
    this.clientSubs.delete(client);
    this.lastPongAt.delete(client);

    this.deps.log('WS_CLIENT_LEAVE', {
      reason,
      activeClients: this.clients.size,
      ...detail,
    });
    this.deps.onSubscriptionsChanged();
  }

  private normalizeSymbols(symbols: string[]): string[] {
    const normalized = new Set<string>();
    for (const raw of symbols) {
      const symbol = String(raw || '').trim().toUpperCase();
      if (symbol) {
        normalized.add(symbol);
      }
    }
    return [...normalized];
  }
}
