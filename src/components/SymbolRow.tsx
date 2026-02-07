import React, { useState } from 'react';
import { MetricsMessage } from '../types/metrics';
import OrderBook from './OrderBook';
import MetricValue from './ui/MetricValue';
import SlopeIcon from './ui/SlopeIcon';
import { ScoreBar } from './ui/ScoreBar';
import { Badge } from './ui/Badge';

interface SymbolRowProps {
  symbol: string;
  data: MetricsMessage;
  showLatency?: boolean;
}

/**
 * SymbolRow renders a single row in the desktop table.  Clicking
 * toggles an expanded view with detailed orderflow stats, the depth
 * ladder and additional telemetry panels.  All values are rendered
 * directly from the server‑provided metrics; no computations are
 * performed on the client.
 */
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
    <div className="border-b border-zinc-800/50 hover:bg-zinc-900/50 transition-colors">
      {/* Main Row Header */}
      <div
        className="grid grid-cols-12 gap-4 p-4 items-center cursor-pointer select-none"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="col-span-2 flex items-center space-x-2">
          <button className="text-zinc-500 hover:text-white transition-colors">
            <svg className={`w-4 h-4 transform transition-transform ${expanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          <span className="font-bold text-white">{symbol}</span>
          <span className="text-[10px] px-1.5 py-0.5 bg-zinc-800 text-zinc-400 rounded border border-zinc-700">PERP</span>
        </div>
        <div className="col-span-2 font-mono text-zinc-200">{legacyMetrics.price.toFixed(2)}</div>
        <div className="col-span-2 flex items-center space-x-2">
          <MetricValue value={legacyMetrics.obiWeighted} />
        </div>
        <div className="col-span-2">
          <MetricValue value={legacyMetrics.deltaZ} />
        </div>
        <div className="col-span-2 flex items-center space-x-2">
          <SlopeIcon value={legacyMetrics.cvdSlope} />
          <MetricValue value={legacyMetrics.cvdSlope} />
        </div>
        <div className="col-span-1 flex items-center justify-center">
          {legacyMetrics.tradeSignal === 1 ? (
            <span className="text-green-400 font-bold text-xs bg-green-900/40 px-2 py-0.5 rounded border border-green-800">LONG</span>
          ) : legacyMetrics.tradeSignal === -1 ? (
            <span className="text-red-400 font-bold text-xs bg-red-900/40 px-2 py-0.5 rounded border border-red-800">SHORT</span>
          ) : (
            <span className="text-zinc-600 text-xs">-</span>
          )}
        </div>
        <div className="col-span-1 text-right">
          <Badge state={state} />
        </div>
      </div>
      {/* Expanded Content */}
      {expanded && (
        <div className="bg-zinc-900/30 border-t border-zinc-800 p-4 grid grid-cols-12 gap-6 animate-in fade-in slide-in-from-top-2 duration-200">
          {/* Left Stats Column */}
          <div className="col-span-3 space-y-4">
            <div className="bg-zinc-950 p-3 rounded border border-zinc-800">
              <p className="text-zinc-500 text-xs mb-1">Session VWAP</p>
              <p className="font-mono text-blue-300">{legacyMetrics.vwap.toFixed(2)}</p>
            </div>
            <div className="space-y-2 pt-2">
              <div className="flex justify-between text-sm">
                <span className="text-zinc-500">OBI (Weighted)</span>
                <MetricValue value={legacyMetrics.obiWeighted} />
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-zinc-500">OBI (Deep Book)</span>
                <MetricValue value={legacyMetrics.obiDeep} />
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-zinc-500">OBI Divergence</span>
                <span className="font-mono text-zinc-300">{Math.abs(legacyMetrics.obiDivergence) * 100 < 0.01 ? '0.0%' : `${(Math.abs(legacyMetrics.obiDivergence) * 100).toFixed(1)}%`}</span>
              </div>
            </div>
          </div>
          {/* Middle OrderBook Column */}
          <div className="col-span-5">
            <div className="mb-2 flex justify-between items-end">
              <h4 className="text-zinc-400 text-sm font-semibold">Live Orderbook</h4>
              <span className="text-xs text-zinc-600">Depth 20 Sync</span>
            </div>
            <OrderBook bids={bids} asks={asks} currentPrice={legacyMetrics.price} />
          </div>
          {/* Right Stats Column */}
          <div className="col-span-4 space-y-4">
            {/* Rolling Metrics */}
            <div className="space-y-2 pt-2">
              <div className="flex justify-between text-sm">
                <span className="text-zinc-500">Delta 1s (Rolling)</span>
                <MetricValue value={legacyMetrics.delta1s} />
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-zinc-500">Delta 5s (Rolling)</span>
                <MetricValue value={legacyMetrics.delta5s} />
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-zinc-500">CVD (Session)</span>
                <MetricValue value={legacyMetrics.cvdSession} />
              </div>
              {/* Pressure bar */}
              <div className="pt-4 border-t border-zinc-800/50 mt-4">
                <div className="flex justify-between text-xs text-zinc-500 mb-1">
                  <span>Bid Pressure</span>
                  <span>Ask Pressure</span>
                </div>
                <ScoreBar segments={computePressureSegments(legacyMetrics.obiWeighted)} height={4} />
                {/* Advanced scores */}
                <div className="grid grid-cols-2 gap-4 mt-4 pt-2 border-t border-zinc-800 border-dashed">
                  <div>
                    <ScoreBar segments={[{ width: Math.min(100, Math.abs(legacyMetrics.sweepFadeScore) * 100), colour: 'bg-purple-500' }]} height={4} />
                    <div className="flex justify-between text-[10px] text-zinc-500 mt-1">
                      <span>Sweep Strength</span>
                      <span className="text-zinc-300 font-mono">{legacyMetrics.sweepFadeScore.toFixed(1)}</span>
                    </div>
                  </div>
                  <div>
                    <ScoreBar segments={[{ width: Math.min(100, Math.abs(legacyMetrics.breakoutScore) * 100), colour: 'bg-orange-500' }]} height={4} />
                    <div className="flex justify-between text-[10px] text-zinc-500 mt-1">
                      <span>Breakout Mom.</span>
                      <span className="text-zinc-300 font-mono">{legacyMetrics.breakoutScore.toFixed(1)}</span>
                    </div>
                  </div>
                  <div>
                    <ScoreBar segments={[{ width: Math.min(100, Math.abs(legacyMetrics.regimeWeight) * 100), colour: 'bg-cyan-500' }]} height={4} />
                    <div className="flex justify-between text-[10px] text-zinc-500 mt-1">
                      <span>Regime Vol</span>
                      <span className="text-zinc-300 font-mono">{legacyMetrics.regimeWeight.toFixed(1)}</span>
                    </div>
                  </div>
                  <div>
                    <ScoreBar segments={[{ width: Math.min(100, Math.abs(legacyMetrics.absorptionScore) * 100), colour: 'bg-yellow-400' }]} height={4} />
                    <div className="flex justify-between text-[10px] text-zinc-500 mt-1">
                      <span>Absorption</span>
                      <span className="text-zinc-300 font-mono">{legacyMetrics.absorptionScore.toFixed(1)}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            {/* Trade Summary */}
            <div className="border-t border-zinc-800 pt-4 mt-4 space-y-2">
              <h4 className="text-zinc-400 text-xs font-semibold uppercase tracking-wider">Trade Summary</h4>
              {/* Aggressive volume bar */}
              <div className="space-y-1">
                <div className="flex justify-between text-[10px] text-zinc-500">
                  <span>Agg Buy</span>
                  <span>Agg Sell</span>
                </div>
                <ScoreBar segments={computeAggSegments()} height={4} />
                <div className="flex justify-between text-[10px] text-zinc-500 mt-1">
                  <span className="text-green-400">{timeAndSales.aggressiveBuyVolume.toFixed(2)}</span>
                  <span className="text-red-400">{timeAndSales.aggressiveSellVolume.toFixed(2)}</span>
                </div>
              </div>
              {/* Trade count & PPS */}
              <div className="flex justify-between text-[10px] text-zinc-500">
                <span>Trades: {timeAndSales.tradeCount}</span>
                <span>PPS: {timeAndSales.printsPerSecond.toFixed(2)}</span>
              </div>
              {/* Size distribution bar */}
              <div className="space-y-1">
                <div className="flex justify-between text-[10px] text-zinc-500">
                  <span>Size Dist.</span>
                  <span className="flex space-x-1">
                    <span className="text-blue-500">S</span>
                    <span className="text-blue-400">M</span>
                    <span className="text-blue-300">L</span>
                  </span>
                </div>
                <ScoreBar segments={computeSizeSegments()} height={4} />
                <div className="flex justify-between text-[10px] text-zinc-500 mt-1">
                  <span className="text-blue-500">{timeAndSales.smallTrades}</span>
                  <span className="text-blue-400">{timeAndSales.midTrades}</span>
                  <span className="text-blue-300">{timeAndSales.largeTrades}</span>
                </div>
              </div>
              {/* Bid/Ask ratio & Burst */}
              <div className="flex justify-between text-[10px] text-zinc-500">
                <span>Bid/Ask Ratio: <span className={timeAndSales.bidHitAskLiftRatio > 1 ? 'text-green-400' : timeAndSales.bidHitAskLiftRatio < 1 ? 'text-red-400' : 'text-zinc-300'}>{timeAndSales.bidHitAskLiftRatio.toFixed(2)}</span></span>
                {timeAndSales.consecutiveBurst.count > 1 ? (
                  <span>Burst: <span className={timeAndSales.consecutiveBurst.side === 'buy' ? 'text-green-400' : 'text-red-400'}>{timeAndSales.consecutiveBurst.side} ×{timeAndSales.consecutiveBurst.count}</span></span>
                ) : (
                  <span>Burst: <span className="text-zinc-300">None</span></span>
                )}
              </div>
              {/* Latency (optional) */}
              {showLatency && typeof timeAndSales.avgLatencyMs === 'number' && (
                <div className="text-[10px] text-zinc-500">Avg Latency: {Math.max(0, timeAndSales.avgLatencyMs).toFixed(1)} ms</div>
              )}
            </div>
            {/* Multi‑TF CVD */}
            <div className="border-t border-zinc-800 pt-4 mt-4 space-y-1">
              <h4 className="text-zinc-400 text-xs font-semibold uppercase tracking-wider">Multi‑TF CVD</h4>
              {/* 1m */}
              <div className="flex justify-between text-[10px]">
                <span className="text-zinc-500">1m</span>
                <span className={cvd.tf1m.delta > 0 ? 'text-green-400 font-mono' : cvd.tf1m.delta < 0 ? 'text-red-400 font-mono' : 'text-zinc-300 font-mono'}>{cvd.tf1m.cvd.toFixed(2)}</span>
                <span className={cvd.tf1m.delta > 0 ? 'text-green-400 font-mono' : cvd.tf1m.delta < 0 ? 'text-red-400 font-mono' : 'text-zinc-300 font-mono'}>{cvd.tf1m.delta.toFixed(2)}</span>
                {cvd.tf1m.exhaustion && <span className="text-yellow-400 font-mono">EXH</span>}
              </div>
              {/* 5m */}
              <div className="flex justify-between text-[10px]">
                <span className="text-zinc-500">5m</span>
                <span className={cvd.tf5m.delta > 0 ? 'text-green-400 font-mono' : cvd.tf5m.delta < 0 ? 'text-red-400 font-mono' : 'text-zinc-300 font-mono'}>{cvd.tf5m.cvd.toFixed(2)}</span>
                <span className={cvd.tf5m.delta > 0 ? 'text-green-400 font-mono' : cvd.tf5m.delta < 0 ? 'text-red-400 font-mono' : 'text-zinc-300 font-mono'}>{cvd.tf5m.delta.toFixed(2)}</span>
                {cvd.tf5m.exhaustion && <span className="text-yellow-400 font-mono">EXH</span>}
              </div>
              {/* 15m */}
              <div className="flex justify-between text-[10px]">
                <span className="text-zinc-500">15m</span>
                <span className={cvd.tf15m.delta > 0 ? 'text-green-400 font-mono' : cvd.tf15m.delta < 0 ? 'text-red-400 font-mono' : 'text-zinc-300 font-mono'}>{cvd.tf15m.cvd.toFixed(2)}</span>
                <span className={cvd.tf15m.delta > 0 ? 'text-green-400 font-mono' : cvd.tf15m.delta < 0 ? 'text-red-400 font-mono' : 'text-zinc-300 font-mono'}>{cvd.tf15m.delta.toFixed(2)}</span>
                {cvd.tf15m.exhaustion && <span className="text-yellow-400 font-mono">EXH</span>}
              </div>
            </div>
            {/* Futures Context */}
            <div className="border-t border-zinc-800 pt-4 mt-4 space-y-1">
              <h4 className="text-zinc-400 text-xs font-semibold uppercase tracking-wider">Futures Context</h4>
              {openInterest && (
                <div className="flex justify-between text-[10px]">
                  <span className="text-zinc-500">Open Interest</span>
                  <span className="font-mono text-zinc-300">{openInterest.openInterest.toFixed(0)}</span>
                  <span className={openInterest.delta > 0 ? 'text-green-400 font-mono' : openInterest.delta < 0 ? 'text-red-400 font-mono' : 'text-zinc-300 font-mono'}>{openInterest.delta.toFixed(0)}</span>
                </div>
              )}
              {funding && (
                <div className="flex justify-between text-[10px]">
                  <span className="text-zinc-500">Funding Rate</span>
                  <span className={funding.rate > 0 ? 'text-green-400 font-mono' : funding.rate < 0 ? 'text-red-400 font-mono' : 'text-zinc-300 font-mono'}>{(funding.rate * 100).toFixed(4)}%</span>
                  <span className={funding.trend === 'up' ? 'text-green-400 font-mono' : funding.trend === 'down' ? 'text-red-400 font-mono' : 'text-yellow-400 font-mono'}>{funding.trend === 'up' ? '↑' : funding.trend === 'down' ? '↓' : '→'}</span>
                </div>
              )}
              {funding && (
                <div className="flex justify-between text-[10px]">
                  <span className="text-zinc-500">Time to Funding</span>
                  <span className="text-zinc-300 font-mono">{formatTimeToFunding(funding.timeToFundingMs)}</span>
                  <span className="text-zinc-500 font-mono"></span>
                </div>
              )}
            </div>
            {/* Absorption flag (simple indicator) */}
            <div className="border-t border-zinc-800 pt-4 mt-4">
              <div className="flex justify-between items-center text-[10px]">
                <span className="text-zinc-500">Absorption Detected</span>
                {absorption && absorption > 0 ? (
                  <span className="bg-yellow-900/40 text-yellow-400 px-2 py-0.5 rounded-full font-mono">YES</span>
                ) : (
                  <span className="bg-zinc-800 text-zinc-400 px-2 py-0.5 rounded-full font-mono">NO</span>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SymbolRow;