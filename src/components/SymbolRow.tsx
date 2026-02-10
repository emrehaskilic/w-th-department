import React, { useState } from 'react';
import { MetricsMessage } from '../types/metrics';
import OrderBook from './OrderBook';
import MetricValue from './ui/MetricValue';
import SlopeIcon from './ui/SlopeIcon';
import { ScoreBar } from './ui/ScoreBar';
import { Badge } from './ui/Badge';
import { MetricCard } from './ui/MetricCard';
import { OpenInterestSection } from './sections/OpenInterestSection';

interface SymbolRowProps {
  symbol: string;
  data: MetricsMessage;
  showLatency?: boolean;
}

const SymbolRow: React.FC<SymbolRowProps> = ({ symbol, data, showLatency = false }) => {
  const [expanded, setExpanded] = useState(false);
  const { state, legacyMetrics, timeAndSales, cvd, openInterest, funding, absorption, bids, asks } = data;

  // If we don't have legacy metrics yet (unseeded), render a placeholder row
  if (!legacyMetrics) {
    return (
      <div className="border-b border-zinc-800/50 p-4 grid grid-cols-12 gap-4 items-center select-none animate-pulse">
        <div className="col-span-2 flex items-center space-x-2">
          <span className="text-zinc-500 w-4"></span>
          <span className="font-bold text-zinc-500">{symbol}</span>
          <span className="text-[10px] px-1.5 py-0.5 bg-zinc-800 text-zinc-600 rounded border border-zinc-800">PERP</span>
        </div>
        <div className="col-span-10 flex items-center justify-between">
          <span className="text-zinc-600 text-xs">Waiting for metrics... ({state})</span>
          <Badge state={state} />
        </div>
      </div>
    );
  }

  // Helper: compute pressure bar segments from OBI weighted.  OBI values
  // around zero should map to a midpoint of 50%.  We clamp to [-1, 1]
  // and scale to ±50.
  const computePressureSegments = (obi: number) => {
    const clamped = Math.max(-1, Math.min(1, obi));
    const bidPct = 50 + clamped * 50;
    const askPct = 100 - bidPct;
    return [
      { width: bidPct, colour: 'bg-green-500' },
      { width: askPct, colour: 'bg-red-500' },
    ];
  };
  // Helper: compute trade size distribution segments.  Avoid divide by zero.
  const computeSizeSegments = () => {
    const total = timeAndSales.smallTrades + timeAndSales.midTrades + timeAndSales.largeTrades;
    if (total === 0) return [
      { width: 0, colour: 'bg-blue-300' },
      { width: 0, colour: 'bg-blue-400' },
      { width: 0, colour: 'bg-blue-500' },
    ];
    return [
      { width: (timeAndSales.smallTrades / total) * 100, colour: 'bg-blue-500' },
      { width: (timeAndSales.midTrades / total) * 100, colour: 'bg-blue-400' },
      { width: (timeAndSales.largeTrades / total) * 100, colour: 'bg-blue-300' },
    ];
  };
  // Helper: compute aggressive volume segments for buy vs sell
  const computeAggSegments = () => {
    const buy = timeAndSales.aggressiveBuyVolume;
    const sell = timeAndSales.aggressiveSellVolume;
    const total = buy + sell;
    if (total === 0) return [
      { width: 50, colour: 'bg-green-500' },
      { width: 50, colour: 'bg-red-500' },
    ];
    return [
      { width: (buy / total) * 100, colour: 'bg-green-500' },
      { width: (sell / total) * 100, colour: 'bg-red-500' },
    ];
  };
  // Convert ms to human friendly time for funding countdown
  const formatTimeToFunding = (ms: number | undefined) => {
    if (ms === undefined || ms <= 0) return '0m';
    const minutes = Math.floor(ms / 60000);
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
  };
  return (
    <div className="border-b border-zinc-800/50 hover:bg-zinc-900/30 transition-colors">
      {/* Main Row - Fixed Height & Width */}
      <div
        className="grid gap-0 px-5 items-center cursor-pointer select-none h-14"
        style={{ gridTemplateColumns: 'minmax(140px, 1fr) 110px 130px 100px 90px 90px 120px' }}
        onClick={() => setExpanded(!expanded)}
      >
        {/* Symbol */}
        <div className="flex items-center gap-2">
          <button className="text-zinc-500 hover:text-white transition-colors flex-shrink-0">
            <svg className={`w-3 h-3 transform transition-transform ${expanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7 7" />
            </svg>
          </button>
          <span className="font-bold text-white text-sm truncate">{symbol}</span>
          <span className="text-[8px] px-1 py-0.5 bg-zinc-800 text-zinc-500 rounded flex-shrink-0 uppercase tracking-tighter">PERP</span>
        </div>

        {/* Price */}
        <div className="text-right font-mono text-sm text-zinc-200">
          {legacyMetrics.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </div>

        {/* OI / Change */}
        <div className="flex flex-col items-end justify-center pr-2">
          {openInterest ? (
            <>
              <span className="font-mono text-xs text-white font-bold">{(openInterest.openInterest / 1_000_000).toFixed(2)}M</span>
              <div className="flex items-center gap-1 text-[9px] font-mono tracking-tighter">
                <span className={openInterest.oiChangeAbs >= 0 ? 'text-green-500' : 'text-red-500'}>
                  {openInterest.oiChangeAbs >= 0 ? '+' : ''}{(openInterest.oiChangeAbs / 1000).toFixed(1)}k
                </span>
                <span className="text-zinc-600">({openInterest.oiChangePct.toFixed(2)}%)</span>
              </div>
            </>
          ) : (
            <span className="text-zinc-600 text-xs">-</span>
          )}
        </div>

        {/* OBI (10L) */}
        <div className="text-center">
          <MetricValue value={legacyMetrics.obiWeighted} />
        </div>

        {/* Delta Z */}
        <div className="text-center">
          <MetricValue value={legacyMetrics.deltaZ} />
        </div>

        {/* CVD Slope */}
        <div className="flex items-center justify-center gap-1">
          <SlopeIcon value={legacyMetrics.cvdSlope} />
          <MetricValue value={legacyMetrics.cvdSlope} />
        </div>

        {/* Signal Column */}
        <div className="flex items-center justify-center">
          {data.signalDisplay?.signal ? (
            <div className={`px-2 py-0.5 rounded text-[10px] font-bold border flex flex-col items-center ${data.signalDisplay.signal.includes('LONG')
                ? 'bg-green-900/20 text-green-400 border-green-800/30'
                : 'bg-red-900/20 text-red-400 border-red-800/30'
              }`}>
              {data.signalDisplay.signal.split('_')[0]}
              <span className="text-[8px] opacity-70">SCR: {data.signalDisplay.score}</span>
            </div>
          ) : (
            <span className="text-[9px] text-zinc-600 uppercase tracking-tighter truncate max-w-[80px]">
              {data.signalDisplay?.vetoReason || 'MONITORING'}
            </span>
          )}
        </div>
      </div>

      {/* Expanded Content */}
      {expanded && (
        <div className="bg-zinc-950/30 border-t border-zinc-800 p-6 animate-in fade-in slide-in-from-top-2 duration-200">
          <div className="space-y-8">


            {/* 2. Trade Analysis & CVD */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

              {/* Trade Summary Panel */}
              <div className="lg:col-span-1 space-y-3">
                <h3 className="text-[10px] font-bold uppercase tracking-widest text-zinc-500 flex items-center gap-2">
                  <span className="w-1 h-1 bg-zinc-500 rounded-full"></span>
                  Volume Analysis
                </h3>
                <div className="bg-zinc-900/40 p-4 rounded-lg border border-zinc-800/50 space-y-4 h-full flex flex-col justify-center">
                  <div className="space-y-2">
                    <div className="flex justify-between items-center text-xs">
                      <span className="text-zinc-500">Aggressive Buy</span>
                      <span className="font-mono font-bold text-green-400">
                        {(data.timeAndSales.aggressiveBuyVolume / 1000).toFixed(1)}k
                      </span>
                    </div>
                    <div className="flex justify-between items-center text-xs">
                      <span className="text-zinc-500">Aggressive Sell</span>
                      <span className="font-mono font-bold text-red-400">
                        {(data.timeAndSales.aggressiveSellVolume / 1000).toFixed(1)}k
                      </span>
                    </div>
                  </div>

                  {/* Visual Bar */}
                  <div className="space-y-1">
                    <div className="w-full bg-zinc-800/50 h-1.5 rounded-full overflow-hidden flex">
                      <div
                        className="bg-green-500/80 h-full transition-all duration-500"
                        style={{ width: `${(data.timeAndSales.aggressiveBuyVolume / ((data.timeAndSales.aggressiveBuyVolume + data.timeAndSales.aggressiveSellVolume) || 1)) * 100}%` }}
                      />
                      <div
                        className="bg-red-500/80 h-full transition-all duration-500"
                        style={{ width: `${(data.timeAndSales.aggressiveSellVolume / ((data.timeAndSales.aggressiveBuyVolume + data.timeAndSales.aggressiveSellVolume) || 1)) * 100}%` }}
                      />
                    </div>
                    <div className="flex justify-between text-[9px] text-zinc-600 font-mono">
                      <span>BUY DOMINANCE</span>
                      <span>SELL DOMINANCE</span>
                    </div>
                  </div>

                  <div className="pt-3 border-t border-zinc-800/30 grid grid-cols-3 gap-2 text-center">
                    <div className="bg-zinc-900/40 rounded p-1">
                      <div className="text-[8px] text-zinc-500 uppercase">Small</div>
                      <div className="text-[10px] font-bold text-zinc-300">{data.timeAndSales.smallTrades}</div>
                    </div>
                    <div className="bg-zinc-900/40 rounded p-1">
                      <div className="text-[8px] text-zinc-500 uppercase">Mid</div>
                      <div className="text-[10px] font-bold text-blue-300">{data.timeAndSales.midTrades}</div>
                    </div>
                    <div className="bg-zinc-900/40 rounded p-1 border border-yellow-900/20">
                      <div className="text-[8px] text-yellow-700 uppercase">Large</div>
                      <div className="text-[10px] font-bold text-yellow-500">{data.timeAndSales.largeTrades}</div>
                    </div>
                  </div>
                </div>
              </div>

              {/* CVD Multi-Timeframe */}
              <div className="lg:col-span-2 space-y-3">
                <h3 className="text-[10px] font-bold uppercase tracking-widest text-zinc-500 flex items-center gap-2">
                  <span className="w-1 h-1 bg-zinc-500 rounded-full"></span>
                  Orderflow Dynamics (CVD)
                </h3>
                <div className="bg-zinc-900/40 rounded-lg border border-zinc-800/50 overflow-hidden h-full">
                  <table className="w-full text-xs h-full">
                    <thead className="bg-zinc-900/60 border-b border-zinc-800/50 text-zinc-500 uppercase font-semibold text-[10px]">
                      <tr>
                        <th className="px-4 py-2 text-left font-medium">Timeframe</th>
                        <th className="px-4 py-2 text-right font-medium">CVD Value</th>
                        <th className="px-4 py-2 text-right font-medium">Delta Change (Session)</th>
                        <th className="px-4 py-2 text-center font-medium">State</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800/30">
                      {[
                        { tf: '1m', ...data.cvd.tf1m },
                        { tf: '5m', ...data.cvd.tf5m },
                        { tf: '15m', ...data.cvd.tf15m }
                      ].map((row) => (
                        <tr key={row.tf} className="hover:bg-zinc-800/10 transition-colors">
                          <td className="px-4 py-3 font-mono text-zinc-400 font-bold">{row.tf}</td>
                          <td className="px-4 py-3 text-right font-mono text-zinc-200">
                            <MetricValue value={row.cvd} />
                          </td>
                          <td className="px-4 py-3 text-right font-mono">
                            <span className={`px-1.5 py-0.5 rounded ${row.delta > 0 ? 'bg-green-900/20 text-green-400' : 'bg-red-900/20 text-red-400'}`}>
                              {row.delta > 0 ? '+' : ''}{row.delta.toFixed(0)}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-center">
                            {row.tf === '1m' && data.advancedMetrics ? (
                              <div className="flex flex-col items-center">
                                <span className="text-[9px] text-zinc-500">ATR-based VOL</span>
                                <span className="text-[10px] text-zinc-300 font-mono">{data.advancedMetrics.volatilityIndex.toFixed(2)}</span>
                              </div>
                            ) : (
                              <span className="text-zinc-700 text-[10px]">Stable</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            {/* Strategy & Signal Card */}
            <div className="bg-zinc-900/40 p-5 rounded-lg border border-zinc-800/50">
              <div className="flex justify-between items-start mb-4">
                <h3 className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Active Strategy Signals</h3>
                <div className="text-[10px] font-mono text-zinc-500 px-2 py-1 bg-black/40 rounded border border-zinc-800">
                  HASH: {data.snapshot?.stateHash.substring(0, 8)} | EV:{data.snapshot?.eventId}
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div className="bg-black/20 p-3 rounded border border-zinc-800/50">
                  <div className="text-[9px] text-zinc-600 mb-1 uppercase">Current Signal</div>
                  <div className={`text-lg font-bold ${data.signalDisplay?.signal ? (data.signalDisplay.signal.includes('LONG') ? 'text-green-400' : 'text-red-400') : 'text-zinc-700'}`}>
                    {data.signalDisplay?.signal || 'NONE'}
                  </div>
                </div>
                <div className="bg-black/20 p-3 rounded border border-zinc-800/50">
                  <div className="text-[9px] text-zinc-600 mb-1 uppercase">Signal Score</div>
                  <div className="text-lg font-mono font-bold text-white">
                    {data.signalDisplay?.score || 0}%
                  </div>
                </div>
                <div className="bg-black/20 p-3 rounded border border-zinc-800/50">
                  <div className="text-[9px] text-zinc-600 mb-1 uppercase">Status / Veto</div>
                  <div className="text-xs font-mono text-zinc-400">
                    {data.signalDisplay?.vetoReason || 'READY'}
                  </div>
                </div>
                <div className="bg-black/20 p-3 rounded border border-zinc-800/50">
                  <div className="text-[9px] text-zinc-600 mb-1 uppercase">Candidate Entry</div>
                  {data.signalDisplay?.candidate ? (
                    <div className="text-xs font-mono text-blue-400 flex flex-col">
                      <span>ENTRY: {data.signalDisplay.candidate.entryPrice.toFixed(2)}</span>
                      <span className="text-[9px] text-zinc-500">TP: {data.signalDisplay.candidate.tpPrice.toFixed(2)}</span>
                    </div>
                  ) : <div className="text-xs text-zinc-700 italic">No entry set</div>}
                </div>
              </div>
            </div>

            {/* 3. Open Interest Section */}
            {data.openInterest && (
              <OpenInterestSection metrics={data.openInterest} />
            )}

          </div>
        </div>
      )}
    </div>
  );
};

export default SymbolRow;