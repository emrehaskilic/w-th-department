import React, { useState } from 'react';
import { MetricsMessage } from '../types/metrics';
import { Badge } from './ui/Badge';
import LeftStatsPanel from './panels/LeftStatsPanel';
import RightStatsPanel from './panels/RightStatsPanel';
import OrderBook from './OrderBook';

export interface MobileSymbolCardProps {
  symbol: string;
  metrics?: MetricsMessage;
  showLatency?: boolean;
}

/**
 * Mobile‑friendly card representation of a symbol. It displays a compact
 * header with key metrics and allows the user to expand advanced
 * statistics. The goal is to mirror the desktop experience in a
 * space‑efficient layout.
 */
const MobileSymbolCard: React.FC<MobileSymbolCardProps> = ({ symbol, metrics, showLatency = false }) => {
  const [open, setOpen] = useState(false);
  if (!metrics || !metrics.legacyMetrics) {
    return (
      <div className="border border-zinc-800 rounded-lg p-4 text-center text-zinc-500 animate-pulse">
        <div className="flex items-center justify-center space-x-2">
          <div className="w-2 h-2 bg-zinc-600 rounded-full animate-bounce"></div>
          <span>Loading {symbol}…</span>
        </div>
      </div>
    );
  }
  const lm = metrics.legacyMetrics;
  const posNegClass = (n: number) => (n > 0 ? 'text-green-400' : n < 0 ? 'text-red-400' : 'text-zinc-300');

  return (
    <div className="bg-zinc-900/60 border border-zinc-800 rounded-lg overflow-hidden">
      {/* Header - Clickable */}
      <div
        className="flex justify-between items-center p-4 cursor-pointer active:bg-zinc-800/50 transition-colors"
        onClick={() => setOpen(!open)}
      >
        <div className="flex items-center space-x-3">
          <div>
            <div className="text-base sm:text-lg font-bold text-white">{symbol}</div>
            <div className="text-sm text-zinc-300 font-mono">${lm.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
          </div>
        </div>
        <div className="flex items-center space-x-2">
          <Badge state={metrics.state} />
          <svg
            className={`w-5 h-5 text-zinc-400 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </div>

      {/* Key metrics - Always visible */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-1 px-4 pb-3 text-xs">
        <div className="text-center p-2 bg-zinc-800/30 rounded">
          <div className="text-zinc-500 text-[10px] uppercase tracking-wider">OBI W</div>
          <div className={`font-mono font-medium ${posNegClass(lm.obiWeighted)}`}>
            {lm.obiWeighted.toFixed(2)}
          </div>
        </div>
        <div className="text-center p-2 bg-zinc-800/30 rounded">
          <div className="text-zinc-500 text-[10px] uppercase tracking-wider">OBI D</div>
          <div className={`font-mono font-medium ${posNegClass(lm.obiDeep)}`}>
            {lm.obiDeep.toFixed(2)}
          </div>
        </div>
        <div className="text-center p-2 bg-zinc-800/30 rounded">
          <div className="text-zinc-500 text-[10px] uppercase tracking-wider">OBI Div</div>
          <div className={`font-mono font-medium ${posNegClass(lm.obiDivergence)}`}>
            {lm.obiDivergence.toFixed(2)}
          </div>
        </div>
        <div className="text-center p-2 bg-zinc-800/30 rounded">
          <div className="text-zinc-500 text-[10px] uppercase tracking-wider">ΔZ</div>
          <div className={`font-mono font-medium ${posNegClass(lm.deltaZ)}`}>
            {lm.deltaZ.toFixed(2)}
          </div>
        </div>
        <div className="text-center p-2 bg-zinc-800/30 rounded">
          <div className="text-zinc-500 text-[10px] uppercase tracking-wider">CVD</div>
          <div className={`font-mono font-medium ${posNegClass(lm.cvdSlope)}`}>
            {lm.cvdSlope.toFixed(2)}
          </div>
        </div>
      </div>

      {/* Collapsible advanced section */}
      {open && (
        <div className="border-t border-zinc-800 p-4 space-y-4 animate-in">
          {/* Depth ladder for mobile - Full width */}
          <div className="bg-zinc-950/50 rounded-lg p-2">
            <OrderBook bids={metrics.bids} asks={metrics.asks} currentPrice={lm.price} />
          </div>

          {/* Stats in two columns */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="bg-zinc-800/30 rounded-lg p-3">
              <LeftStatsPanel legacyMetrics={lm} />
            </div>
            <div className="bg-zinc-800/30 rounded-lg p-3">
              <RightStatsPanel metrics={metrics} showLatency={showLatency} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default MobileSymbolCard;
