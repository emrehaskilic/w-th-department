import React, { useEffect, useMemo, useState } from 'react';
import { useTelemetrySocket } from '../services/useTelemetrySocket';
import { MetricsState, MetricsMessage } from '../types/metrics';
import SymbolRow from './SymbolRow';
import MobileSymbolCard from './MobileSymbolCard';

type ConnectionState = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'ERROR';

interface ExecutionStatus {
  connection: {
    state: ConnectionState;
    executionEnabled: boolean;
    hasCredentials: boolean;
    symbols: string[];
    lastError: string | null;
  };
  selectedSymbols: string[];
  settings: {
    leverage: number;
  };
  wallet: {
    totalWalletUsdt: number;
    availableBalanceUsdt: number;
    realizedPnl: number;
    unrealizedPnl: number;
    totalPnl: number;
    lastUpdated: number;
  };
}

const defaultExecutionStatus: ExecutionStatus = {
  connection: {
    state: 'DISCONNECTED',
    executionEnabled: false,
    hasCredentials: false,
    symbols: [],
    lastError: null,
  },
  selectedSymbols: [],
  settings: {
    leverage: 10,
  },
  wallet: {
    totalWalletUsdt: 0,
    availableBalanceUsdt: 0,
    realizedPnl: 0,
    unrealizedPnl: 0,
    totalPnl: 0,
    lastUpdated: 0,
  },
};

const formatNum = (n: number, d = 2) => n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });

export const Dashboard: React.FC = () => {
  const [selectedPairs, setSelectedPairs] = useState<string[]>(['BTCUSDT']);
  const [availablePairs, setAvailablePairs] = useState<string[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [isDropdownOpen, setDropdownOpen] = useState(false);
  const [isLoadingPairs, setIsLoadingPairs] = useState(true);

  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [connectionError, setConnectionError] = useState<string | null>(null);

  const [executionStatus, setExecutionStatus] = useState<ExecutionStatus>(defaultExecutionStatus);

  const activeSymbols = useMemo(() => selectedPairs, [selectedPairs]);
  const marketData: MetricsState = useTelemetrySocket(activeSymbols);

  const hostname = window.location.hostname;
  const proxyUrl = (import.meta as any).env?.VITE_PROXY_API || `http://${hostname}:8787`;

  useEffect(() => {
    const fetchPairs = async () => {
      try {
        const res = await fetch(`${proxyUrl}/api/testnet/exchange-info`);
        const data = await res.json();
        const pairs = Array.isArray(data?.symbols) ? data.symbols : [];
        setAvailablePairs(pairs);
        if (pairs.length > 0 && selectedPairs.length === 0) {
          setSelectedPairs([pairs[0]]);
        }
      } catch {
        setAvailablePairs(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
      } finally {
        setIsLoadingPairs(false);
      }
    };

    fetchPairs();
  }, [proxyUrl]);

  useEffect(() => {
    const pollStatus = async () => {
      try {
        const res = await fetch(`${proxyUrl}/api/execution/status`);
        const data = (await res.json()) as ExecutionStatus;
        setExecutionStatus(data);

        // Sync selected symbols if server has them
        if (data.selectedSymbols && data.selectedSymbols.length > 0) {
          const serverSyms = data.selectedSymbols.filter(s => s && s.length > 0);
          if (serverSyms.length > 0) {
            // Only update if current list is empty to prevent feedback loops?
            // Actually, usually server should follow UI here.
          }
        }
      } catch {
        // no-op: keep last known state
      }
    };

    pollStatus();
    const timer = window.setInterval(pollStatus, 2000);
    return () => window.clearInterval(timer);
  }, [proxyUrl]);

  useEffect(() => {
    const syncSelectedSymbols = async () => {
      try {
        await fetch(`${proxyUrl}/api/execution/symbol`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbols: selectedPairs }),
        });
      } catch {
        // ignore and retry on next change
      }
    };
    const timer = setTimeout(syncSelectedSymbols, 500);
    return () => clearTimeout(timer);
  }, [proxyUrl, selectedPairs]);

  const filteredPairs = availablePairs.filter((p) => p.includes(searchTerm.toUpperCase()));

  const togglePair = (pair: string) => {
    if (selectedPairs.includes(pair)) {
      setSelectedPairs(selectedPairs.filter(p => p !== pair));
    } else {
      setSelectedPairs([...selectedPairs, pair]);
    }
  };

  const connectTestnet = async () => {
    setConnectionError(null);
    try {
      const res = await fetch(`${proxyUrl}/api/execution/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey, apiSecret }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || 'connect_failed');
      }
      setExecutionStatus(data.status as ExecutionStatus);
    } catch (e: any) {
      setConnectionError(e.message || 'connect_failed');
    }
  };

  const disconnectTestnet = async () => {
    setConnectionError(null);
    try {
      const res = await fetch(`${proxyUrl}/api/execution/disconnect`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || 'disconnect_failed');
      }
      setExecutionStatus(data.status as ExecutionStatus);
    } catch (e: any) {
      setConnectionError(e.message || 'disconnect_failed');
    }
  };

  const refreshWalletPnl = async () => {
    const res = await fetch(`${proxyUrl}/api/execution/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await res.json();
    if (res.ok) {
      setExecutionStatus(data.status as ExecutionStatus);
    }
  };

  const statusColor = executionStatus.connection.state === 'CONNECTED'
    ? 'text-green-400'
    : executionStatus.connection.state === 'ERROR'
      ? 'text-red-400'
      : 'text-zinc-400';

  return (
    <div className="min-h-screen bg-[#09090b] text-zinc-200 font-sans p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white tracking-tight">Orderflow Telemetry</h1>
            <p className="text-zinc-500 text-sm mt-1">DATA: MAINNET | EXCHANGE: TESTNET</p>
          </div>
          <div className="text-xs rounded border border-zinc-700 px-3 py-2 bg-zinc-900">
            <span className={statusColor}>{executionStatus.connection.state}</span>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-3">
            <h2 className="text-sm font-semibold text-zinc-300 text-center border-b border-zinc-800 pb-2">WALLET & PNL</h2>
            <div className="grid grid-cols-2 gap-y-3 text-sm py-2">
              <div className="text-zinc-500">Total Wallet</div>
              <div className="text-right font-mono text-white text-lg">{formatNum(executionStatus.wallet.totalWalletUsdt)} USDT</div>

              <div className="text-zinc-500">Available</div>
              <div className="text-right font-mono">{formatNum(executionStatus.wallet.availableBalanceUsdt)} USDT</div>

              <div className="text-zinc-500">Realized PnL</div>
              <div className={`text-right font-mono ${executionStatus.wallet.realizedPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                {executionStatus.wallet.realizedPnl >= 0 ? '+' : ''}{formatNum(executionStatus.wallet.realizedPnl)}
              </div>

              <div className="text-zinc-500">Unrealized PnL</div>
              <div className={`text-right font-mono ${executionStatus.wallet.unrealizedPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                {executionStatus.wallet.unrealizedPnl >= 0 ? '+' : ''}{formatNum(executionStatus.wallet.unrealizedPnl)}
              </div>

              <div className="text-zinc-500 font-bold border-t border-zinc-800 pt-2">Total PnL</div>
              <div className={`text-right font-mono font-bold border-t border-zinc-800 pt-2 ${executionStatus.wallet.totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                {executionStatus.wallet.totalPnl >= 0 ? '+' : ''}{formatNum(executionStatus.wallet.totalPnl)}
              </div>
            </div>

            <button
              onClick={refreshWalletPnl}
              className="w-full mt-2 px-3 py-2 bg-zinc-800 hover:bg-zinc-700 rounded text-xs font-semibold text-zinc-300 border border-zinc-700 transition-colors"
            >
              REFRESH WALLET
            </button>
            {executionStatus.wallet.lastUpdated > 0 && (
              <p className="text-[10px] text-zinc-600 text-center">Last synced: {new Date(executionStatus.wallet.lastUpdated).toLocaleTimeString()}</p>
            )}
          </div>

          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-3">
            <h2 className="text-sm font-semibold text-zinc-300">Credentials & Symbols</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <input
                type="password"
                placeholder="Testnet API Key"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-2 text-sm"
              />
              <input
                type="password"
                placeholder="Testnet API Secret"
                value={apiSecret}
                onChange={(e) => setApiSecret(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-2 text-sm"
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button onClick={connectTestnet} className="px-3 py-2 bg-blue-700 hover:bg-blue-600 rounded text-xs font-bold text-white shadow-lg transition-all active:scale-95">CONNECT EXCHANGE</button>
              <button onClick={disconnectTestnet} className="px-3 py-2 bg-zinc-700 hover:bg-zinc-600 rounded text-xs font-bold text-white transition-all active:scale-95">DISCONNECT</button>
            </div>
            {connectionError && <div className="text-xs text-red-500 font-medium italic">{connectionError}</div>}

            <div className="pt-2 border-t border-zinc-800">
              <button
                onClick={() => setDropdownOpen((v) => !v)}
                className="w-full flex items-center justify-between bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm"
              >
                <span>{isLoadingPairs ? 'Loading Symbols...' : `${selectedPairs.length} symbols active`}</span>
                <span>▾</span>
              </button>
              <div className="flex flex-wrap gap-1 mt-2">
                {selectedPairs.map(p => (
                  <span key={p} className="text-[10px] px-2 py-1 bg-zinc-800 text-zinc-400 rounded-full border border-zinc-700 flex items-center gap-1">
                    {p}
                    <button onClick={() => togglePair(p)} className="hover:text-white transition-colors">×</button>
                  </span>
                ))}
              </div>
              {isDropdownOpen && !isLoadingPairs && (
                <div className="absolute z-10 mt-1 w-[300px] border border-zinc-700 rounded bg-[#18181b] p-2 shadow-2xl">
                  <input
                    type="text"
                    placeholder="Filter symbols..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="w-full bg-black border border-zinc-800 rounded px-2 py-1 text-xs mb-2"
                  />
                  <div className="max-h-56 overflow-y-auto space-y-1">
                    {filteredPairs.map((pair) => (
                      <button
                        key={pair}
                        onClick={() => togglePair(pair)}
                        className={`w-full text-left px-2 py-1 rounded text-xs flex justify-between ${selectedPairs.includes(pair) ? 'bg-zinc-700 text-white' : 'hover:bg-zinc-800 text-zinc-500'}`}
                      >
                        <span>{pair}</span>
                        {selectedPairs.includes(pair) && <span>✓</span>}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="border border-zinc-800 rounded-xl overflow-hidden bg-zinc-900/80 shadow-2xl">
          <div className="overflow-x-auto">
            <div className="min-w-[900px]">
              <div className="grid gap-0 px-5 py-4 text-[11px] font-bold text-zinc-500 uppercase tracking-widest bg-zinc-900 border-b border-zinc-800" style={{ gridTemplateColumns: 'minmax(140px, 1fr) 110px 130px 100px 90px 90px 120px' }}>
                <div>Symbol</div>
                <div className="text-right">Price</div>
                <div className="text-right">OI / Change</div>
                <div className="text-center">OBI (10L)</div>
                <div className="text-center">Delta Z</div>
                <div className="text-center">CVD Slope</div>
                <div className="text-center">Signal</div>
              </div>
              <div className="bg-black/20 divide-y divide-zinc-900">
                {activeSymbols.map((symbol) => {
                  const msg: MetricsMessage | undefined = marketData[symbol];
                  if (!msg) return (
                    <div key={symbol} className="px-5 py-4 text-xs text-zinc-600 italic">
                      Initializing {symbol}...
                    </div>
                  );
                  return <SymbolRow key={symbol} symbol={symbol} data={msg} showLatency={false} />;
                })}
              </div>
            </div>
          </div>
        </div>

        <div className="text-[10px] text-zinc-700 text-center uppercase tracking-tighter">
          Orderflow Matrix Protocol • Mainnet Telemetry Hub • Testnet Bridge Active
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
