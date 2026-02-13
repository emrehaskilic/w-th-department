import React, { useEffect, useMemo, useState } from 'react';

interface DryRunPosition {
  side: 'LONG' | 'SHORT';
  qty: number;
  entryPrice: number;
  markPrice: number;
  liqPrice: null;
}

interface DryRunOrderResult {
  orderId: string;
  status: string;
  side: 'BUY' | 'SELL';
  type: 'MARKET' | 'LIMIT';
  requestedQty: number;
  filledQty: number;
  remainingQty: number;
  avgFillPrice: number;
  fee: number;
  realizedPnl: number;
  reason: string | null;
  tradeIds: string[];
}

interface DryRunEventLog {
  eventTimestampMs: number;
  sequence: number;
  eventId: string;
  walletBalanceBefore: number;
  walletBalanceAfter: number;
  realizedPnl: number;
  fee: number;
  fundingImpact: number;
  marginHealth: number;
  liquidationTriggered: boolean;
  orderResults: DryRunOrderResult[];
}

interface DryRunStatus {
  running: boolean;
  runId: string | null;
  symbol: string | null;
  config: {
    walletBalanceStartUsdt: number;
    initialMarginUsdt: number;
    leverage: number;
    takerFeeRate: number;
    maintenanceMarginRate: number;
    fundingRate: number;
    fundingIntervalMs: number;
  } | null;
  metrics: {
    markPrice: number;
    totalEquity: number;
    walletBalance: number;
    unrealizedPnl: number;
    realizedPnl: number;
    feePaid: number;
    fundingPnl: number;
    marginHealth: number;
  };
  position: DryRunPosition | null;
  openLimitOrders: Array<{
    orderId: string;
    side: 'BUY' | 'SELL';
    price: number;
    remainingQty: number;
    reduceOnly: boolean;
    createdTsMs: number;
  }>;
  lastEventTimestampMs: number;
  logTail: DryRunEventLog[];
}

const DEFAULT_STATUS: DryRunStatus = {
  running: false,
  runId: null,
  symbol: null,
  config: null,
  metrics: {
    markPrice: 0,
    totalEquity: 0,
    walletBalance: 0,
    unrealizedPnl: 0,
    realizedPnl: 0,
    feePaid: 0,
    fundingPnl: 0,
    marginHealth: 0,
  },
  position: null,
  openLimitOrders: [],
  lastEventTimestampMs: 0,
  logTail: [],
};

const formatNum = (n: number, d = 2): string => n.toLocaleString(undefined, {
  minimumFractionDigits: d,
  maximumFractionDigits: d,
});

const formatTs = (ts: number): string => {
  if (!(ts > 0)) return '-';
  return new Date(ts).toLocaleTimeString();
};

const DryRunDashboard: React.FC = () => {
  const hostname = window.location.hostname;
  const proxyUrl = (import.meta as any).env?.VITE_PROXY_API || `http://${hostname}:8787`;

  const [symbols, setSymbols] = useState<string[]>([]);
  const [symbolsLoading, setSymbolsLoading] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);
  const [status, setStatus] = useState<DryRunStatus>(DEFAULT_STATUS);

  const [symbol, setSymbol] = useState('BTCUSDT');
  const [startBalance, setStartBalance] = useState('5000');
  const [initialMargin, setInitialMargin] = useState('200');
  const [leverage, setLeverage] = useState('10');

  useEffect(() => {
    const loadSymbols = async () => {
      setSymbolsLoading(true);
      try {
        const res = await fetch(`${proxyUrl}/api/dry-run/symbols`);
        const data = await res.json();
        const next = Array.isArray(data?.symbols) ? data.symbols : [];
        setSymbols(next);
        if (next.length > 0 && !next.includes(symbol)) {
          setSymbol(next[0]);
        }
      } catch {
        setSymbols(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
      } finally {
        setSymbolsLoading(false);
      }
    };

    loadSymbols();
  }, [proxyUrl]);

  useEffect(() => {
    let active = true;

    const poll = async () => {
      try {
        const res = await fetch(`${proxyUrl}/api/dry-run/status`);
        const data = await res.json();
        if (!active) return;
        if (res.ok && data?.status) {
          setStatus(data.status as DryRunStatus);
          if (!data.status.running && data.status.config) {
            setSymbol(data.status.symbol || symbol);
            setStartBalance(String(data.status.config.walletBalanceStartUsdt));
            setInitialMargin(String(data.status.config.initialMarginUsdt));
            setLeverage(String(data.status.config.leverage));
          }
        }
      } catch {
        // keep last known status
      }
    };

    poll();
    const timer = window.setInterval(poll, 1000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [proxyUrl]);

  const startDryRun = async () => {
    setActionError(null);
    try {
      const res = await fetch(`${proxyUrl}/api/dry-run/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol,
          walletBalanceStartUsdt: Number(startBalance),
          initialMarginUsdt: Number(initialMargin),
          leverage: Number(leverage),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || 'dry_run_start_failed');
      }
      setStatus((data?.status || DEFAULT_STATUS) as DryRunStatus);
    } catch (e: any) {
      setActionError(e?.message || 'dry_run_start_failed');
    }
  };

  const stopDryRun = async () => {
    setActionError(null);
    try {
      const res = await fetch(`${proxyUrl}/api/dry-run/stop`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || 'dry_run_stop_failed');
      }
      setStatus((data?.status || DEFAULT_STATUS) as DryRunStatus);
    } catch (e: any) {
      setActionError(e?.message || 'dry_run_stop_failed');
    }
  };

  const resetDryRun = async () => {
    setActionError(null);
    try {
      const res = await fetch(`${proxyUrl}/api/dry-run/reset`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || 'dry_run_reset_failed');
      }
      setStatus((data?.status || DEFAULT_STATUS) as DryRunStatus);
    } catch (e: any) {
      setActionError(e?.message || 'dry_run_reset_failed');
    }
  };

  const marginHealthPct = useMemo(() => status.metrics.marginHealth * 100, [status.metrics.marginHealth]);

  const logLines = useMemo(() => {
    return status.logTail.slice(-80).flatMap((event) => {
      const base = `${formatTs(event.eventTimestampMs)} #${event.sequence} ${event.eventId}`;
      const lines: string[] = [
        `${base} | wallet=${formatNum(event.walletBalanceAfter, 4)} | pnl=${formatNum(event.realizedPnl, 4)} | fee=${formatNum(event.fee, 4)} | funding=${formatNum(event.fundingImpact, 4)}`,
      ];
      if (event.liquidationTriggered) {
        lines.push(`${base} | LIQUIDATION_TRIGGERED`);
      }
      event.orderResults.forEach((order) => {
        lines.push(
          `${base} | ORDER ${order.type}/${order.side} ${order.status} fill=${formatNum(order.filledQty, 6)}/${formatNum(order.requestedQty, 6)} avg=${formatNum(order.avgFillPrice, 4)} reason=${order.reason || '-'}`
        );
      });
      return lines;
    });
  }, [status.logTail]);

  return (
    <div className="min-h-screen bg-[#09090b] text-zinc-200 p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white tracking-tight">Dry Run Simulation</h1>
            <p className="text-zinc-500 text-sm mt-1">DATA: MAINNET | MODE: PAPER EXECUTION</p>
          </div>
          <div className="text-xs rounded border border-zinc-700 px-3 py-2 bg-zinc-900">
            <span className={status.running ? 'text-emerald-400' : 'text-zinc-400'}>
              {status.running ? 'RUNNING' : 'STOPPED'}
            </span>
            {status.runId && <span className="text-zinc-500 ml-2">{status.runId}</span>}
          </div>
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-4">
          <h2 className="text-sm font-semibold text-zinc-300">Control Panel</h2>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <label className="text-xs text-zinc-500">
              Pair
              <select
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
                disabled={status.running || symbolsLoading}
                className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-2 text-sm"
              >
                {(symbols.length > 0 ? symbols : ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']).map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </label>

            <label className="text-xs text-zinc-500">
              Start Balance (USDT)
              <input
                type="number"
                min={1}
                value={startBalance}
                disabled={status.running}
                onChange={(e) => setStartBalance(e.target.value)}
                className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-2 text-sm font-mono"
              />
            </label>

            <label className="text-xs text-zinc-500">
              Initial Margin (USDT)
              <input
                type="number"
                min={1}
                value={initialMargin}
                disabled={status.running}
                onChange={(e) => setInitialMargin(e.target.value)}
                className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-2 text-sm font-mono"
              />
            </label>

            <label className="text-xs text-zinc-500">
              Leverage
              <input
                type="number"
                min={1}
                max={125}
                value={leverage}
                disabled={status.running}
                onChange={(e) => setLeverage(e.target.value)}
                className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-2 text-sm font-mono"
              />
            </label>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            <button
              onClick={startDryRun}
              disabled={status.running}
              className="px-3 py-2 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed rounded text-xs font-bold text-white"
            >
              START DRY RUN
            </button>
            <button
              onClick={stopDryRun}
              disabled={!status.running}
              className="px-3 py-2 bg-amber-700 hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed rounded text-xs font-bold text-white"
            >
              STOP
            </button>
            <button
              onClick={resetDryRun}
              className="px-3 py-2 bg-zinc-800 hover:bg-zinc-700 rounded text-xs font-bold text-zinc-200 border border-zinc-700"
            >
              RESET
            </button>
          </div>

          {actionError && <div className="text-xs text-red-500">{actionError}</div>}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-3">
          <div className="lg:col-span-2 bg-zinc-950 border border-zinc-800 rounded-lg p-4">
            <div className="text-xs text-zinc-500 uppercase tracking-wider">Total Equity</div>
            <div className="text-3xl font-bold text-white mt-2 font-mono">{formatNum(status.metrics.totalEquity, 4)} USDT</div>
            <div className="text-[11px] text-zinc-500 mt-2">Last Event: {formatTs(status.lastEventTimestampMs)}</div>
          </div>

          <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-4">
            <div className="text-xs text-zinc-500">Wallet Balance</div>
            <div className="text-lg font-mono text-white mt-1">{formatNum(status.metrics.walletBalance, 4)}</div>
          </div>

          <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-4">
            <div className="text-xs text-zinc-500">Unrealized PnL</div>
            <div className={`text-lg font-mono mt-1 ${status.metrics.unrealizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {status.metrics.unrealizedPnl >= 0 ? '+' : ''}{formatNum(status.metrics.unrealizedPnl, 4)}
            </div>
          </div>

          <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-4">
            <div className="text-xs text-zinc-500">Realized PnL</div>
            <div className={`text-lg font-mono mt-1 ${status.metrics.realizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {status.metrics.realizedPnl >= 0 ? '+' : ''}{formatNum(status.metrics.realizedPnl, 4)}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
            <h2 className="text-sm font-semibold text-zinc-300 mb-3">Margin Health</h2>
            <div className={`text-2xl font-bold font-mono ${marginHealthPct >= 20 ? 'text-emerald-400' : marginHealthPct >= 5 ? 'text-amber-400' : 'text-red-400'}`}>
              {formatNum(marginHealthPct, 2)}%
            </div>
            <div className="mt-3 h-2 w-full rounded bg-zinc-800 overflow-hidden">
              <div
                className={`h-full ${marginHealthPct >= 20 ? 'bg-emerald-500' : marginHealthPct >= 5 ? 'bg-amber-500' : 'bg-red-500'}`}
                style={{ width: `${Math.max(0, Math.min(100, marginHealthPct))}%` }}
              />
            </div>
            <div className="mt-4 text-[11px] text-zinc-500 space-y-1">
              <div>Fees Paid: {formatNum(status.metrics.feePaid, 4)} USDT</div>
              <div>Funding PnL: {formatNum(status.metrics.fundingPnl, 4)} USDT</div>
              <div>Mark Price: {formatNum(status.metrics.markPrice, 4)}</div>
            </div>
          </div>

          <div className="lg:col-span-2 bg-zinc-900 border border-zinc-800 rounded-lg p-4 overflow-x-auto">
            <h2 className="text-sm font-semibold text-zinc-300 mb-3">Open Position</h2>
            <table className="w-full text-xs min-w-[640px]">
              <thead>
                <tr className="text-zinc-500 border-b border-zinc-800">
                  <th className="text-left py-2">Side</th>
                  <th className="text-right py-2">Entry</th>
                  <th className="text-right py-2">Qty</th>
                  <th className="text-right py-2">Mark</th>
                  <th className="text-right py-2">Liq Price</th>
                </tr>
              </thead>
              <tbody>
                {status.position ? (
                  <tr className="border-b border-zinc-900">
                    <td className={`py-2 ${status.position.side === 'LONG' ? 'text-emerald-400' : 'text-red-400'}`}>{status.position.side}</td>
                    <td className="py-2 text-right font-mono">{formatNum(status.position.entryPrice, 4)}</td>
                    <td className="py-2 text-right font-mono">{formatNum(status.position.qty, 6)}</td>
                    <td className="py-2 text-right font-mono">{formatNum(status.position.markPrice, 4)}</td>
                    <td className="py-2 text-right text-zinc-500">N/A</td>
                  </tr>
                ) : (
                  <tr>
                    <td colSpan={5} className="py-4 text-center text-zinc-600 italic">No open position</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
          <h2 className="text-sm font-semibold text-zinc-300 mb-3">Event Console</h2>
          <div className="bg-black border border-zinc-800 rounded p-3 h-[320px] overflow-auto font-mono text-[11px] text-zinc-300 whitespace-pre-wrap">
            {logLines.length === 0 ? 'No events yet.' : logLines.join('\n')}
          </div>
        </div>
      </div>
    </div>
  );
};

export default DryRunDashboard;
