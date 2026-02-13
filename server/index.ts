/**
 * Binance Futures Proxy Server (Strict Architecture)
 *
 * Mandates:
 * 1. Futures ONLY (fapi/fstream).
 * 2. Strict Rate Limiting (Token Bucket / 429 Backoff).
 * 3. Independent Trade Tape (works even if Orderbook is stale).
 * 4. Observability-first (Detailed /health and JSON logs).
 */

import * as dotenv from 'dotenv';
dotenv.config();

import express, { NextFunction, Request, Response } from 'express';
import { createServer } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import cors from 'cors';


// Metrics Imports
import { TimeAndSales } from './metrics/TimeAndSales';
import { CvdCalculator } from './metrics/CvdCalculator';
import { AbsorptionDetector } from './metrics/AbsorptionDetector';
import { OpenInterestMonitor, OpenInterestMetrics } from './metrics/OpenInterestMonitor';
import { FundingMonitor, FundingMetrics } from './metrics/FundingMonitor';
import {
    OrderbookState,
    createOrderbookState,
    applyDepthUpdate,
    applySnapshot,
    bestBid,
    bestAsk,
    getLevelSize,
    getTopLevels,
} from './metrics/OrderbookManager';
import { LegacyCalculator } from './metrics/LegacyCalculator';
import { createOrchestratorFromEnv } from './orchestrator/Orchestrator';

// [PHASE 1 & 2] New Imports
import { KlineBackfill } from './backfill/KlineBackfill';
import { OICalculator } from './metrics/OICalculator';
import { SymbolEventQueue } from './utils/SymbolEventQueue';
import { SnapshotTracker } from './telemetry/Snapshot';
import { apiKeyMiddleware, validateWebSocketApiKey } from './auth/apiKey';
import { StrategyEngine } from './strategy/StrategyEngine';
import { DryRunConfig, DryRunEngine, DryRunEventInput, DryRunSessionService, isUpstreamGuardError } from './dryrun';
import { logger, requestLogger, serializeError } from './utils/logger';
import { WebSocketManager } from './ws/WebSocketManager';

// =============================================================================
// Configuration
// =============================================================================

const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = process.env.HOST || '0.0.0.0'; // Listen on all interfaces for Nginx proxy
const BINANCE_REST_BASE = 'https://fapi.binance.com';
const BINANCE_WS_BASE = 'wss://fstream.binance.com/stream';

// Dynamic CORS - allow configured origins plus common development ports
const ALLOWED_ORIGINS = [
    // Development
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:5175',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:5174',
    'http://127.0.0.1:5175',
    // Production - add your domain here or use env var
    ...(process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : []),
];

// Rate Limiting
const SNAPSHOT_MIN_INTERVAL_MS = Number(process.env.SNAPSHOT_MIN_INTERVAL_MS || 1500);
const MIN_BACKOFF_MS = 5000;
const MAX_BACKOFF_MS = 120000;
const DEPTH_QUEUE_MAX = Number(process.env.DEPTH_QUEUE_MAX || 2000);
const DEPTH_LAG_MAX_MS = Number(process.env.DEPTH_LAG_MAX_MS || 2000);
const LIVE_SNAPSHOT_FRESH_MS = Number(process.env.LIVE_SNAPSHOT_FRESH_MS || 15000);
const LIVE_DESYNC_RATE_10S_MAX = Number(process.env.LIVE_DESYNC_RATE_10S_MAX || 50);
const LIVE_QUEUE_MAX = Number(process.env.LIVE_QUEUE_MAX || 200);
const LIVE_GOOD_SEQUENCE_MIN = Number(process.env.LIVE_GOOD_SEQUENCE_MIN || 25);
const AUTO_SCALE_MIN_SYMBOLS = 1;
const AUTO_SCALE_LIVE_DOWN_PCT = 80;
const AUTO_SCALE_LIVE_UP_PCT = 95;
const AUTO_SCALE_UP_HOLD_MS = 10 * 60 * 1000;
const DEPTH_LEVELS = Number(process.env.DEPTH_LEVELS || 20);
const DEPTH_STREAM_MODE = String(process.env.DEPTH_STREAM_MODE || 'diff').toLowerCase(); // diff | partial
const WS_UPDATE_SPEED = String(process.env.WS_UPDATE_SPEED || '250ms'); // 100ms | 250ms
const BLOCKED_TELEMETRY_INTERVAL_MS = Number(process.env.BLOCKED_TELEMETRY_INTERVAL_MS || 1000);
const MIN_RESYNC_INTERVAL_MS = 15000;
const GRACE_PERIOD_MS = 5000;
const CLIENT_HEARTBEAT_INTERVAL_MS = Number(process.env.CLIENT_HEARTBEAT_INTERVAL_MS || 15000);
const CLIENT_STALE_CONNECTION_MS = Number(process.env.CLIENT_STALE_CONNECTION_MS || 60000);

// [PHASE 3] Execution Flags
let KILL_SWITCH = false;
function parseEnvFlag(value: string | undefined): boolean {
    if (!value) return false;
    const normalized = value.trim().replace(/^['"]|['"]$/g, '').toLowerCase();
    return normalized === 'true';
}

const EXECUTION_ENABLED_ENV = parseEnvFlag(process.env.EXECUTION_ENABLED);
let EXECUTION_ENABLED = EXECUTION_ENABLED_ENV;
const EXECUTION_ENV = 'testnet';

// =============================================================================
// Logging
// =============================================================================

function log(event: string, data: any = {}) {
    logger.info(event, data);
}

process.on('unhandledRejection', (reason) => {
    logger.error('PROCESS_UNHANDLED_REJECTION', { reason: serializeError(reason) });
});

process.on('uncaughtException', (error) => {
    logger.error('PROCESS_UNCAUGHT_EXCEPTION', { error: serializeError(error) });
});

function getExecutionGateState() {
    const status = orchestrator.getExecutionStatus();
    const connection = status.connection;
    const hasCredentials = Boolean(connection.hasCredentials);
    const ready = Boolean(connection.ready);
    const executionAllowed = EXECUTION_ENABLED && !KILL_SWITCH && hasCredentials && ready;
    return {
        executionAllowed,
        hasCredentials,
        ready,
        readyReason: connection.readyReason,
        connectionState: connection.state,
    };
}

// =============================================================================
// State
// =============================================================================

interface SymbolMeta {
    lastSnapshotAttempt: number;
    lastSnapshotOk: number;
    backoffMs: number;
    consecutiveErrors: number;
    isResyncing: boolean;
    lastResyncTs: number; // New throttle
    // Counters
    depthMsgCount: number;
    depthMsgCount10s: number;
    lastDepthMsgTs: number;
    tradeMsgCount: number;
    desyncCount: number;
    snapshotCount: number;
    lastSnapshotHttpStatus: number;
    snapshotLastUpdateId: number;
    // Broadcast tracking
    lastBroadcastTs: number;
    metricsBroadcastCount10s: number;
    metricsBroadcastDepthCount10s: number;
    metricsBroadcastTradeCount10s: number;
    lastMetricsBroadcastReason: 'depth' | 'trade' | 'none';
    applyCount10s: number;
    // Reliability
    depthQueue: Array<{
        U: number;
        u: number;
        b: [string, string][];
        a: [string, string][];
        eventTimeMs: number;
        receiptTimeMs: number;
    }>;
    isProcessingDepthQueue: boolean;
    goodSequenceStreak: number;
    lastStateTransitionTs: number;
    lastLiveTs: number;
    lastBlockedTelemetryTs: number;
    // Rolling windows
    desyncEvents: number[];
    snapshotOkEvents: number[];
    snapshotSkipEvents: number[];
    liveSamples: Array<{ ts: number; live: boolean }>;
    // [PHASE 1] Deterministic Queue
    eventQueue: SymbolEventQueue;
    // [PHASE 1] Snapshot tracker
    snapshotTracker: SnapshotTracker;
}

const symbolMeta = new Map<string, SymbolMeta>();
const orderbookMap = new Map<string, OrderbookState>();

// Metrics
const timeAndSalesMap = new Map<string, TimeAndSales>();
const cvdMap = new Map<string, CvdCalculator>();
const absorptionMap = new Map<string, AbsorptionDetector>();
const absorptionResult = new Map<string, number>();
const legacyMap = new Map<string, LegacyCalculator>();

// Monitor Caches
const lastOpenInterest = new Map<string, OpenInterestMetrics>();
const lastFunding = new Map<string, FundingMetrics>();
const oiMonitors = new Map<string, OpenInterestMonitor>();
const fundingMonitors = new Map<string, FundingMonitor>();

// [PHASE 1 & 2] New Maps
const backfillMap = new Map<string, KlineBackfill>();
const oiCalculatorMap = new Map<string, OICalculator>();
const strategyMap = new Map<string, StrategyEngine>();
const backfillInFlight = new Set<string>();
const backfillLastAttemptMs = new Map<string, number>();
const BACKFILL_RETRY_INTERVAL_MS = 30_000;
const orchestrator = createOrchestratorFromEnv();
const dryRunSession = new DryRunSessionService();
orchestrator.setKillSwitch(KILL_SWITCH);
if (typeof process.env.EXECUTION_MODE !== 'undefined') {
    log('CONFIG_WARNING', { message: 'EXECUTION_MODE is deprecated and ignored' });
}

const hasEnvApiKey = Boolean(process.env.BINANCE_TESTNET_API_KEY);
const hasEnvApiSecret = Boolean(process.env.BINANCE_TESTNET_API_SECRET);
const initialGate = getExecutionGateState();
log('EXECUTION_CONFIG', {
    execEnabled: EXECUTION_ENABLED,
    killSwitch: KILL_SWITCH,
    env: EXECUTION_ENV,
    hasApiKey: hasEnvApiKey,
    hasApiSecret: hasEnvApiSecret,
    executionAllowed: initialGate.executionAllowed,
});
// Cached Exchange Info
let exchangeInfoCache: { data: any; timestamp: number } | null = null;
const EXCHANGE_INFO_TTL_MS = 1000 * 60 * 60; // 1 hr

// Global Rate Limit
let globalBackoffUntil = 0; // Starts at 0 to allow fresh attempts on restart
let symbolConcurrencyLimit = Math.max(AUTO_SCALE_MIN_SYMBOLS, Number(process.env.SYMBOL_CONCURRENCY || 10));
let autoScaleLastUpTs = 0;

// =============================================================================
// Helpers
// =============================================================================

function getMeta(symbol: string): SymbolMeta {
    let meta = symbolMeta.get(symbol);
    if (!meta) {
        meta = {
            lastSnapshotAttempt: 0,
            lastSnapshotOk: 0,
            backoffMs: MIN_BACKOFF_MS,
            consecutiveErrors: 0,
            isResyncing: false,
            lastResyncTs: 0,
            depthMsgCount: 0,
            depthMsgCount10s: 0,
            lastDepthMsgTs: Date.now(), // Avoid immediate stale check
            tradeMsgCount: 0,
            desyncCount: 0,
            snapshotCount: 0,
            lastSnapshotHttpStatus: 0,
            snapshotLastUpdateId: 0,
            // Broadcast tracking
            lastBroadcastTs: 0,
            metricsBroadcastCount10s: 0,
            metricsBroadcastDepthCount10s: 0,
            metricsBroadcastTradeCount10s: 0,
            lastMetricsBroadcastReason: 'none',
            applyCount10s: 0,
            depthQueue: [],
            isProcessingDepthQueue: false,
            goodSequenceStreak: 0,
            lastStateTransitionTs: Date.now(),
            lastLiveTs: 0,
            lastBlockedTelemetryTs: 0,
            desyncEvents: [],
            snapshotOkEvents: [],
            snapshotSkipEvents: [],
            liveSamples: [],
            // [PHASE 1] Deterministic Queue
            eventQueue: new SymbolEventQueue(symbol, async (ev) => {
                await processSymbolEvent(symbol, ev);
            }),
            // [PHASE 1] Snapshot tracker
            snapshotTracker: new SnapshotTracker(),
        };
        symbolMeta.set(symbol, meta);
    }
    return meta;
}

function getOrderbook(symbol: string): OrderbookState {
    let state = orderbookMap.get(symbol);
    if (!state) {
        state = createOrderbookState();
        orderbookMap.set(symbol, state);
    }
    return state;
}

function pruneWindow(values: number[], windowMs: number, now: number): void {
    while (values.length > 0 && now - values[0] > windowMs) {
        values.shift();
    }
}

function countWindow(values: number[], windowMs: number, now: number): number {
    pruneWindow(values, windowMs, now);
    return values.length;
}

function recordLiveSample(symbol: string, live: boolean): void {
    const meta = getMeta(symbol);
    const now = Date.now();
    meta.liveSamples.push({ ts: now, live });
    while (meta.liveSamples.length > 0 && now - meta.liveSamples[0].ts > 60000) {
        meta.liveSamples.shift();
    }
}

function liveUptimePct60s(symbol: string): number {
    const meta = getMeta(symbol);
    const now = Date.now();
    while (meta.liveSamples.length > 0 && now - meta.liveSamples[0].ts > 60000) {
        meta.liveSamples.shift();
    }
    if (meta.liveSamples.length === 0) {
        return 0;
    }
    const liveCount = meta.liveSamples.reduce((acc, sample) => acc + (sample.live ? 1 : 0), 0);
    return (liveCount / meta.liveSamples.length) * 100;
}

function transitionOrderbookState(symbol: string, to: OrderbookState['uiState'], trigger: string, detail: any = {}) {
    const ob = getOrderbook(symbol);
    const from = ob.uiState;
    if (from === to) {
        return;
    }
    ob.uiState = to;
    const meta = getMeta(symbol);
    meta.lastStateTransitionTs = Date.now();
    if (to === 'LIVE') {
        meta.lastLiveTs = meta.lastStateTransitionTs;
    }
    log('ORDERBOOK_STATE_TRANSITION', { symbol, from, to, trigger, ...detail });
}

// Lazy Metric Getters
const getTaS = (s: string) => { if (!timeAndSalesMap.has(s)) timeAndSalesMap.set(s, new TimeAndSales()); return timeAndSalesMap.get(s)!; };
const getCvd = (s: string) => { if (!cvdMap.has(s)) cvdMap.set(s, new CvdCalculator()); return cvdMap.get(s)!; };
const getAbs = (s: string) => { if (!absorptionMap.has(s)) absorptionMap.set(s, new AbsorptionDetector()); return absorptionMap.get(s)!; };
const getLegacy = (s: string) => { if (!legacyMap.has(s)) legacyMap.set(s, new LegacyCalculator(s)); return legacyMap.get(s)!; };

// [PHASE 1 & 2] New Getters
const getBackfill = (s: string) => { if (!backfillMap.has(s)) backfillMap.set(s, new KlineBackfill(s, BINANCE_REST_BASE)); return backfillMap.get(s)!; };
const getOICalc = (s: string) => { if (!oiCalculatorMap.has(s)) oiCalculatorMap.set(s, new OICalculator(s, BINANCE_REST_BASE)); return oiCalculatorMap.get(s)!; };
const getStrategy = (s: string) => { if (!strategyMap.has(s)) strategyMap.set(s, new StrategyEngine()); return strategyMap.get(s)!; };

function ensureMonitors(symbol: string) {
    const backfill = getBackfill(symbol);
    const backfillState = backfill.getState();
    const lastBackfillAttempt = backfillLastAttemptMs.get(symbol) || 0;
    const shouldRetryBackfill =
        !backfillState.ready &&
        !backfillInFlight.has(symbol) &&
        (
            backfillState.vetoReason === 'INITIALIZING' ||
            Date.now() - lastBackfillAttempt >= BACKFILL_RETRY_INTERVAL_MS
        );

    if (shouldRetryBackfill) {
        backfillInFlight.add(symbol);
        backfillLastAttemptMs.set(symbol, Date.now());
        backfill.performBackfill()
            .catch(e => log('BACKFILL_ERROR', { symbol, error: e.message }))
            .finally(() => {
                backfillInFlight.delete(symbol);
            });
    }

    if (!oiCalculatorMap.has(symbol)) {
        const oi = getOICalc(symbol);
        oi.update().catch(e => log('OI_INIT_ERROR', { symbol, error: e.message }));
    }

    if (!fundingMonitors.has(symbol)) {
        const m = new FundingMonitor(symbol);
        m.onUpdate(d => lastFunding.set(symbol, d));
        m.start();
        fundingMonitors.set(symbol, m);
    }
}

// =============================================================================
// Binance Interactions
// =============================================================================

async function fetchExchangeInfo() {
    if (exchangeInfoCache && (Date.now() - exchangeInfoCache.timestamp < EXCHANGE_INFO_TTL_MS)) {
        return exchangeInfoCache.data;
    }
    try {
        log('EXCHANGE_INFO_REQ', { url: `${BINANCE_REST_BASE}/fapi/v1/exchangeInfo` });
        const res = await fetch(`${BINANCE_REST_BASE}/fapi/v1/exchangeInfo`);
        if (!res.ok) throw new Error(`Status ${res.status}`);
        const data: any = await res.json();
        const symbols = data.symbols
            .filter((s: any) => s.status === 'TRADING' && s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT')
            .map((s: any) => s.symbol).sort();
        exchangeInfoCache = { data: { symbols }, timestamp: Date.now() };
        return exchangeInfoCache.data;
    } catch (e: any) {
        log('EXCHANGE_INFO_ERROR', { error: e.message });
        return exchangeInfoCache?.data || { symbols: [] };
    }
}

async function fetchSnapshot(symbol: string, trigger: string, force = false) {
    const meta = getMeta(symbol);
    const ob = getOrderbook(symbol);
    const now = Date.now();

    if (now < globalBackoffUntil) {
        log('SNAPSHOT_SKIP_GLOBAL', { symbol, wait: globalBackoffUntil - now });
        return;
    }

    const waitMs = Math.max(SNAPSHOT_MIN_INTERVAL_MS, meta.backoffMs);
    if (now - meta.lastSnapshotAttempt < waitMs) {
        meta.snapshotSkipEvents.push(now);
        log('SNAPSHOT_SKIP_LOCAL', { symbol, trigger, force, wait: waitMs - (now - meta.lastSnapshotAttempt) });
        return;
    }

    meta.lastSnapshotAttempt = now;
    meta.isResyncing = true;
    transitionOrderbookState(symbol, 'SNAPSHOT_PENDING', trigger);

    try {
        log('SNAPSHOT_REQ', { symbol, trigger });
        const res = await fetch(`${BINANCE_REST_BASE}/fapi/v1/depth?symbol=${symbol}&limit=1000`);

        meta.lastSnapshotHttpStatus = res.status;

        if (res.status === 429 || res.status === 418) {
            const retryAfter = parseInt(res.headers.get('Retry-After') || '60', 10) * 1000;
            const weight = res.headers.get('x-mbx-used-weight-1m');
            globalBackoffUntil = Date.now() + retryAfter;
            meta.backoffMs = Math.min(meta.backoffMs * 2, MAX_BACKOFF_MS);
            log('SNAPSHOT_429', { symbol, retryAfter, backoff: meta.backoffMs, weight });
            transitionOrderbookState(symbol, 'HALTED', 'snapshot_429', { retryAfter });
            return;
        }

        if (!res.ok) {
            log('SNAPSHOT_FAIL', { symbol, trigger, status: res.status });
            meta.backoffMs = Math.min(meta.backoffMs * 2, MAX_BACKOFF_MS);
            meta.consecutiveErrors++;
            transitionOrderbookState(symbol, 'RESYNCING', 'snapshot_http_fail', { status: res.status });
            return;
        }

        const data: any = await res.json();
        transitionOrderbookState(symbol, 'APPLYING_SNAPSHOT', 'snapshot_received', { lastUpdateId: data.lastUpdateId });

        const snapshotResult = applySnapshot(ob, data);
        meta.lastSnapshotOk = now;
        meta.snapshotOkEvents.push(now);
        meta.snapshotLastUpdateId = data.lastUpdateId;
        meta.backoffMs = MIN_BACKOFF_MS;
        meta.consecutiveErrors = 0;
        meta.isResyncing = false;
        meta.snapshotCount++;
        meta.goodSequenceStreak = snapshotResult.ok ? Math.max(meta.goodSequenceStreak, snapshotResult.appliedCount) : 0;

        log('SNAPSHOT_TOP', {
            symbol,
            snapshotLastUpdateId: data.lastUpdateId,
            bestBid: bestBid(ob),
            bestAsk: bestAsk(ob),
            bidsCount: ob.bids.size,
            asksCount: ob.asks.size,
            bufferedApplied: snapshotResult.appliedCount,
            bufferedDropped: snapshotResult.droppedCount,
            gapDetected: snapshotResult.gapDetected
        });

        if (snapshotResult.ok) {
            // Directly transition to LIVE as per c4c8a70 logic
            transitionOrderbookState(symbol, 'LIVE', 'snapshot_applied_success');
            log('SNAPSHOT_OK', { symbol, trigger, lastUpdateId: data.lastUpdateId });
            // Ensure live sample is recorded immediately
            recordLiveSample(symbol, true);
        } else {
            // Only go to RESYNCING if buffer gap detected
            transitionOrderbookState(symbol, 'RESYNCING', 'snapshot_buffer_gap_detected');
            log('SNAPSHOT_BUFFER_GAP', { symbol, trigger, lastUpdateId: data.lastUpdateId });
        }

    } catch (e: any) {
        log('SNAPSHOT_ERR', { symbol, err: e.message });
        meta.backoffMs = Math.min(meta.backoffMs * 2, MAX_BACKOFF_MS);
        transitionOrderbookState(symbol, 'RESYNCING', 'snapshot_exception', { error: e.message });
    } finally {
        meta.isResyncing = false;
    }
}

// =============================================================================
// WebSocket Multiplexer
// =============================================================================

let ws: WebSocket | null = null;
let wsState = 'disconnected';
let activeSymbols = new Set<string>();
const dryRunForcedSymbols = new Set<string>();
const wsManager = new WebSocketManager({
    onSubscriptionsChanged: () => {
        updateStreams();
    },
    log: (event, data = {}) => {
        log(event, data);
    },
    heartbeatIntervalMs: CLIENT_HEARTBEAT_INTERVAL_MS,
    staleConnectionMs: CLIENT_STALE_CONNECTION_MS,
});
let autoScaleForcedSingle = false;

function buildDepthStream(symbolLower: string): string {
    if (DEPTH_STREAM_MODE === 'partial') {
        return `${symbolLower}@depth${DEPTH_LEVELS}@${WS_UPDATE_SPEED}`;
    }
    return `${symbolLower}@depth@${WS_UPDATE_SPEED}`;
}

function updateStreams() {
    const forcedSorted = [...dryRunForcedSymbols].sort();
    const requiredSorted = wsManager.getRequiredSymbols();
    const limitedSymbols = requiredSorted.slice(0, Math.max(AUTO_SCALE_MIN_SYMBOLS, symbolConcurrencyLimit));
    const effective = new Set<string>([...forcedSorted, ...limitedSymbols]);

    // Debug Log
    if (requiredSorted.length > 0 || forcedSorted.length > 0) {
        log('AUTO_SCALE_DEBUG', {
            forced: forcedSorted,
            requestedCount: requiredSorted.length,
            requested: requiredSorted,
            activeLimit: symbolConcurrencyLimit,
            limitCalculated: Math.max(AUTO_SCALE_MIN_SYMBOLS, symbolConcurrencyLimit),
            kept: limitedSymbols,
            dropped: requiredSorted.slice(limitedSymbols.length),
        });
    }

    if (requiredSorted.length > limitedSymbols.length) {
        log('AUTO_SCALE_APPLIED', {
            requested: requiredSorted.length,
            activeLimit: symbolConcurrencyLimit,
            kept: limitedSymbols,
            dropped: requiredSorted.slice(limitedSymbols.length),
        });
    }

    // Simple diff check
    if (effective.size === activeSymbols.size && [...effective].every(s => activeSymbols.has(s))) {
        if (ws && ws.readyState === WebSocket.OPEN) return;
    }

    if (effective.size === 0) {
        if (ws) ws.close();
        ws = null;
        wsState = 'disconnected';
        activeSymbols.clear();
        return;
    }

    if (ws) ws.close();

    activeSymbols = new Set(effective);
    const streams = [...activeSymbols].flatMap(s => {
        const l = s.toLowerCase();
        return [buildDepthStream(l), `${l}@trade`];
    });

    const url = `${BINANCE_WS_BASE}?streams=${streams.join('/')}`;
    log('WS_CONNECT', { count: activeSymbols.size, url });

    wsState = 'connecting';
    ws = new WebSocket(url);

    ws.on('open', () => {
        wsState = 'connected';
        log('WS_OPEN', {});

        let delay = 0;
        activeSymbols.forEach((symbol) => {
            const ob = getOrderbook(symbol);
            if (ob.uiState === 'INIT' || ob.lastUpdateId === 0) {
                transitionOrderbookState(symbol, 'SNAPSHOT_PENDING', 'ws_open_seed');
                setTimeout(() => {
                    fetchSnapshot(symbol, 'ws_open_seed', true).catch(() => { });
                }, delay);
                delay += 2000;
            }
        });
    });

    ws.on('message', (raw: any) => handleMsg(raw));

    ws.on('close', () => {
        wsState = 'disconnected';
        log('WS_CLOSE', {});
        setTimeout(updateStreams, 5000);
    });

    ws.on('error', (e) => log('WS_ERROR', { msg: e.message }));
}




function enqueueDepthUpdate(symbol: string, update: { U: number; u: number; b: [string, string][]; a: [string, string][]; eventTimeMs: number; receiptTimeMs: number }) {
    const meta = getMeta(symbol);
    meta.depthQueue.push(update);
    if (meta.depthQueue.length > DEPTH_QUEUE_MAX) {
        meta.depthQueue = [];
        meta.desyncCount++;
        meta.desyncEvents.push(Date.now());
        meta.goodSequenceStreak = 0;
        transitionOrderbookState(symbol, 'RESYNCING', 'queue_overflow', { max: DEPTH_QUEUE_MAX });
        fetchSnapshot(symbol, 'queue_overflow', true).catch(() => { });
        return;
    }
    processDepthQueue(symbol).catch((e) => {
        log('DEPTH_QUEUE_PROCESS_ERR', { symbol, error: e.message });
    });
}

async function processDepthQueue(symbol: string) {
    const meta = getMeta(symbol);
    if (meta.isProcessingDepthQueue) {
        return;
    }
    meta.isProcessingDepthQueue = true;
    try {
        while (meta.depthQueue.length > 0) {
            const update = meta.depthQueue.shift()!;
            const now = Date.now();
            const lagMs = now - update.receiptTimeMs;
            if (lagMs > DEPTH_LAG_MAX_MS) {
                meta.desyncCount++;
                meta.desyncEvents.push(now);
                meta.goodSequenceStreak = 0;
                meta.depthQueue = [];
                transitionOrderbookState(symbol, 'RESYNCING', 'lag_too_high', { lagMs, max: DEPTH_LAG_MAX_MS });
                await fetchSnapshot(symbol, 'lag_too_high', true);
                break;
            }

            const ob = getOrderbook(symbol);
            ob.lastSeenU_u = `${update.U}-${update.u}`;
            ob.lastDepthTime = now;

            const applied = applyDepthUpdate(ob, update);
            if (!applied.ok && applied.gapDetected) {
                meta.desyncCount++;
                meta.desyncEvents.push(now);
                meta.goodSequenceStreak = 0;
                log('DEPTH_DESYNC', { symbol, U: update.U, u: update.u, lastUpdateId: ob.lastUpdateId });
                transitionOrderbookState(symbol, 'RESYNCING', 'sequence_gap', { U: update.U, u: update.u, lastUpdateId: ob.lastUpdateId });
                await fetchSnapshot(symbol, 'sequence_gap', true);
                break;
            }

            if (applied.applied) {
                meta.applyCount10s++;
                meta.goodSequenceStreak++;
            }

            evaluateLiveReadiness(symbol);

            const tas = getTaS(symbol);
            const cvd = getCvd(symbol);
            const abs = getAbs(symbol);
            const leg = getLegacy(symbol);
            const absVal = absorptionResult.get(symbol) ?? 0;
            broadcastMetrics(symbol, ob, tas, cvd, absVal, leg, update.eventTimeMs || 0, null, 'depth');

            if (dryRunSession.isTrackingSymbol(symbol)) {
                const top = getTopLevels(ob, Number(process.env.DRY_RUN_ORDERBOOK_DEPTH || 20));
                const bestBidPx = bestBid(ob);
                const bestAskPx = bestAsk(ob);
                const markPrice = (bestBidPx && bestAskPx)
                    ? (bestBidPx + bestAskPx) / 2
                    : (bestBidPx || bestAskPx || 0);
                try {
                    dryRunSession.ingestDepthEvent({
                        symbol,
                        eventTimestampMs: Number(update.eventTimeMs || 0),
                        markPrice,
                        orderBook: {
                            bids: top.bids.map(([price, qty]) => ({ price, qty })),
                            asks: top.asks.map(([price, qty]) => ({ price, qty })),
                        },
                    });
                } catch (e: any) {
                    log('DRY_RUN_EVENT_ERROR', { symbol, error: e?.message || 'dry_run_event_failed' });
                }
            }
        }
    } finally {
        meta.isProcessingDepthQueue = false;
    }
}

function evaluateLiveReadiness(symbol: string) {
    const meta = getMeta(symbol);
    const ob = getOrderbook(symbol);
    const now = Date.now();

    const snapshotFresh = meta.lastSnapshotOk > 0 && (now - meta.lastSnapshotOk) <= LIVE_SNAPSHOT_FRESH_MS;
    const hasBook = ob.bids.size > 0 && ob.asks.size > 0;

    // Data Liveness: Check if depth messages are flowing within GRACE_PERIOD
    // If we just resynced, give it time (MIN_RESYNC_INTERVAL check handles throttle)
    const dataFlowing = (now - meta.lastDepthMsgTs) < GRACE_PERIOD_MS;

    // Primary Condition: Fresh Snapshot + Populated Book
    // Secondary Condition: Data is flowing OR we are within throttle window (just restarted)
    const isLiveCondition = snapshotFresh && hasBook;

    if (isLiveCondition) {
        // We look good foundationally. Check data flow.
        if (ob.uiState !== 'LIVE') {
            transitionOrderbookState(symbol, 'LIVE', 'live_criteria_met', {
                fresh: snapshotFresh,
                dataLag: now - meta.lastDepthMsgTs
            });
        }
        recordLiveSample(symbol, true);
    } else {
        recordLiveSample(symbol, false);

        // Trigger Resync only if allowed by throttle
        const timeSinceResync = now - meta.lastResyncTs;
        const canResync = timeSinceResync > MIN_RESYNC_INTERVAL_MS;

        if (canResync && !meta.isResyncing) {
            meta.lastResyncTs = now;
            // Only transition if we are actually going to fetch
            transitionOrderbookState(symbol, 'RESYNCING', 'live_criteria_failed_throttled', {
                fresh: snapshotFresh,
                dataLag: now - meta.lastDepthMsgTs,
                hasBook,
                timeSinceResync
            });
            fetchSnapshot(symbol, 'watchdog_resync', true).catch(() => { });
        }
    }
}

function runAutoScaler() {
    const symbols = Array.from(activeSymbols);
    if (symbols.length === 0) {
        return;
    }

    const avgLive = symbols.reduce((acc, s) => acc + liveUptimePct60s(s), 0) / symbols.length;
    const now = Date.now();

    if (avgLive < AUTO_SCALE_LIVE_DOWN_PCT && symbolConcurrencyLimit > AUTO_SCALE_MIN_SYMBOLS) {
        symbolConcurrencyLimit = AUTO_SCALE_MIN_SYMBOLS;
        autoScaleForcedSingle = true;
        log('AUTO_SCALE_DOWN', { avgLiveUptimePct60s: Number(avgLive.toFixed(2)), symbolConcurrencyLimit });
        updateStreams();
        return;
    }

    if (avgLive > AUTO_SCALE_LIVE_UP_PCT) {
        if (autoScaleLastUpTs === 0) {
            autoScaleLastUpTs = now;
        }
        const heldLongEnough = now - autoScaleLastUpTs >= AUTO_SCALE_UP_HOLD_MS;
        if (heldLongEnough && autoScaleForcedSingle) {
            symbolConcurrencyLimit = Math.max(symbolConcurrencyLimit + 1, AUTO_SCALE_MIN_SYMBOLS + 1);
            autoScaleForcedSingle = false;
            autoScaleLastUpTs = now;
            log('AUTO_SCALE_UP', { avgLiveUptimePct60s: Number(avgLive.toFixed(2)), symbolConcurrencyLimit });
            updateStreams();
        }
        return;
    }

    autoScaleLastUpTs = 0;
}

async function processSymbolEvent(s: string, d: any) {
    const e = d.e;
    const ob = getOrderbook(s);
    const meta = getMeta(s);
    const now = Date.now();

    if (e === 'depthUpdate') {
        meta.depthMsgCount++;
        meta.depthMsgCount10s++;
        meta.lastDepthMsgTs = now;

        ensureMonitors(s);
        enqueueDepthUpdate(s, {
            U: Number(d.U || 0),
            u: Number(d.u || 0),
            b: Array.isArray(d.b) ? d.b : [],
            a: Array.isArray(d.a) ? d.a : [],
            eventTimeMs: Number(d.E || d.T || now),
            receiptTimeMs: now,
        });
    } else if (e === 'trade') {
        ensureMonitors(s);
        meta.tradeMsgCount++;
        const p = parseFloat(d.p);
        const q = parseFloat(d.q);
        const t = d.T;
        const side = d.m ? 'sell' : 'buy';

        const tas = getTaS(s);
        const cvd = getCvd(s);
        const abs = getAbs(s);
        const leg = getLegacy(s);

        tas.addTrade({ price: p, quantity: q, side, timestamp: t });
        cvd.addTrade({ price: p, quantity: q, side, timestamp: t });
        leg.addTrade({ price: p, quantity: q, side, timestamp: t });

        const levelSize = getLevelSize(ob, p) || 0;
        const absVal = abs.addTrade(s, p, side, t, levelSize);
        absorptionResult.set(s, absVal);

        // [PHASE 2] Strategy Check
        const strategy = getStrategy(s);
        const backfill = getBackfill(s);
        const legMetrics = leg.computeMetrics(ob);
        const signal = strategy.compute({
            price: p,
            atr: backfill.getState().atr,
            avgAtr: backfill.getState().avgAtr,
            recentHigh: backfill.getState().recentHigh,
            recentLow: backfill.getState().recentLow,
            obi: legMetrics?.obiDeep || 0,
            deltaZ: legMetrics?.deltaZ || 0,
            cvdSlope: legMetrics?.cvdSlope || 0,
            ready: backfill.getState().ready,
            vetoReason: backfill.getState().vetoReason
        });

        // [PHASE 3] Execution Check
        // Execution now flows through the orchestrator (gate + decision + executor).

        // [DRY RUN INTEGRATION]
        // If a valid signal is generated, feed it into the Dry Run engine
        const isDryRunTracked = dryRunSession.isTrackingSymbol(s);
        if (isDryRunTracked) {
            // Debug log to trace why signals might be missing
            if (Math.random() < 0.05) { // Sample 5% of ticks to avoid spam
                log('DRY_RUN_STRATEGY_CHECK', {
                    symbol: s,
                    signal: signal?.signal,
                    score: signal?.score,
                    ready: backfill.getState().ready,
                    veto: signal?.vetoReason
                });
            }
        }

        if (signal.signal && isDryRunTracked) {
            log('DRY_RUN_SIGNAL_SUBMIT', { symbol: s, signal: signal.signal });
            dryRunSession.submitStrategySignal(s, signal);
        }

        // Broadcast
        broadcastMetrics(s, ob, tas, cvd, absVal, leg, t, signal);
    }
}

function classifyCVDState(delta: number): 'Normal' | 'High Vol' | 'Extreme' {
    const absD = Math.abs(delta);
    if (absD > 1000000) return 'Extreme';
    if (absD > 250000) return 'High Vol';
    return 'Normal';
}

function handleMsg(raw: any) {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg.data) return;

    const s = msg.data.s;
    if (!s) return;

    const meta = getMeta(s);
    meta.eventQueue.enqueue(msg.data);
}

function broadcastMetrics(
    s: string,
    ob: OrderbookState,
    tas: TimeAndSales,
    cvd: CvdCalculator,
    absVal: number,
    leg: LegacyCalculator,
    eventTimeMs: number,
    signal: any = null,
    reason: 'depth' | 'trade' = 'trade'
) {
    const THROTTLE_MS = 250; // 4Hz max per symbol
    const meta = getMeta(s);
    if (leg) leg.updateOpenInterest();
    const now = Date.now();

    // Throttle check - skip if last broadcast was too recent
    const intervalMs = now - meta.lastBroadcastTs;
    if (intervalMs < THROTTLE_MS) {
        // Throttled - skip but log occasionally
        return;
    }

    const cvdM = cvd.computeMetrics();
    const tasMetrics = tas.computeMetrics();
    // Calculate OBI/Legacy if Orderbook has data (bids and asks exist)
    // This allows metrics to continue displaying during brief resyncs
    const hasBookData = ob.bids.size > 0 && ob.asks.size > 0;
    const legacyM = hasBookData ? leg.computeMetrics(ob) : null;

    // Top of book
    const { bids, asks } = getTopLevels(ob, 20);
    const bestBidPx = bestBid(ob);
    const bestAskPx = bestAsk(ob);
    const mid = (bestBidPx && bestAskPx) ? (bestBidPx + bestAskPx) / 2 : null;
    const spreadPct = (bestBidPx && bestAskPx && mid && mid > 0)
        ? ((bestAskPx - bestBidPx) / mid) * 100
        : null;

    const oiM = getOICalc(s).getMetrics();
    const oiLegacy = leg.getOpenInterestMetrics();
    const bf = getBackfill(s).getState();

    const payload: any = {
        type: 'metrics',
        symbol: s,
        state: ob.uiState,
        event_time_ms: eventTimeMs,
        snapshot: meta.snapshotTracker.next({ s, mid }),
        timeAndSales: tasMetrics,
        cvd: {
            tf1m: cvdM.find(x => x.timeframe === '1m') ? { ...cvdM.find(x => x.timeframe === '1m')!, state: classifyCVDState(cvdM.find(x => x.timeframe === '1m')!.delta) } : { cvd: 0, delta: 0, state: 'Normal' },
            tf5m: cvdM.find(x => x.timeframe === '5m') ? { ...cvdM.find(x => x.timeframe === '5m')!, state: classifyCVDState(cvdM.find(x => x.timeframe === '5m')!.delta) } : { cvd: 0, delta: 0, state: 'Normal' },
            tf15m: cvdM.find(x => x.timeframe === '15m') ? { ...cvdM.find(x => x.timeframe === '15m')!, state: classifyCVDState(cvdM.find(x => x.timeframe === '15m')!.delta) } : { cvd: 0, delta: 0, state: 'Normal' },
            tradeCounts: cvd.getTradeCounts()
        },
        absorption: absVal,
        openInterest: oiLegacy ? {
            openInterest: oiLegacy.openInterest,
            oiChangeAbs: oiLegacy.oiChangeAbs,
            oiChangePct: oiLegacy.oiChangePct,
            oiDeltaWindow: oiLegacy.oiDeltaWindow,
            lastUpdated: oiLegacy.lastUpdated,
            source: oiLegacy.source,
            stabilityMsg: oiM.stabilityMsg
        } : {
            openInterest: oiM.currentOI,
            oiChangeAbs: oiM.oiChangeAbs,
            oiChangePct: oiM.oiChangePct,
            oiDeltaWindow: oiM.oiChangeAbs,
            lastUpdated: oiM.lastUpdated,
            source: 'real',
            stabilityMsg: oiM.stabilityMsg
        },
        funding: lastFunding.get(s) || null,
        legacyMetrics: legacyM,
        signalDisplay: signal || { signal: null, score: 0, vetoReason: bf.vetoReason || 'NO_SIGNAL', candidate: null },
        advancedMetrics: {
            sweepFadeScore: signal?.score || 0,
            breakoutScore: signal?.score || 0,
            volatilityIndex: bf.atr
        },
        bids, asks,
        bestBid: bestBidPx,
        bestAsk: bestAskPx,
        spreadPct,
        midPrice: mid,
        lastUpdateId: ob.lastUpdateId
    };

    const str = JSON.stringify(payload);
    const sentCount = wsManager.broadcastToSymbol(s, str);

    // Update counters
    meta.lastBroadcastTs = now;
    meta.metricsBroadcastCount10s++;
    meta.lastMetricsBroadcastReason = reason;
    if (reason === 'depth') {
        meta.metricsBroadcastDepthCount10s++;
    } else {
        meta.metricsBroadcastTradeCount10s++;
    }

    // Log broadcast event (every 20th to avoid spam)
    if (meta.metricsBroadcastCount10s % 20 === 1) {
        log(reason === 'depth' ? 'METRICS_BROADCAST_DEPTH' : 'METRICS_BROADCAST_TRADE', {
            symbol: s,
            reason,
            throttled: false,
            intervalMs,
            sentTo: sentCount,
            obiWeighted: legacyM?.obiWeighted ?? null,
            obiDeep: legacyM?.obiDeep ?? null,
            obiDivergence: legacyM?.obiDivergence ?? null
        });

        // Debug: METRICS_SYMBOL_BIND for integrity check
        log('METRICS_SYMBOL_BIND', {
            symbol: s,
            bestBid: bestBid(ob),
            bestAsk: bestAsk(ob),
            obiWeighted: legacyM?.obiWeighted ?? null,
            obiDeep: legacyM?.obiDeep ?? null,
            bookLevels: { bids: ob.bids.size, asks: ob.asks.size }
        });
    }

    if (eventTimeMs > 0) {
        const canonicalTimeMs = Date.now();
        // Mainnet market data is ingested here only for signal/intent generation.
        // Execution state remains testnet-only via execution events in orchestrator.
        orchestrator.ingest({
            symbol: s,
            canonical_time_ms: canonicalTimeMs,
            exchange_event_time_ms: eventTimeMs,
            spread_pct: spreadPct,
            prints_per_second: tasMetrics.printsPerSecond,
            best_bid: bestBidPx,
            best_ask: bestAskPx,
            funding: lastFunding.get(s)
                ? {
                    rate: lastFunding.get(s)?.rate ?? null,
                    timeToFundingMs: lastFunding.get(s)?.timeToFundingMs ?? null,
                    trend: lastFunding.get(s)?.trend ?? null,
                }
                : null,
            legacyMetrics: legacyM ? {
                obiDeep: legacyM.obiDeep,
                deltaZ: legacyM.deltaZ,
                cvdSlope: legacyM.cvdSlope
            } : null
        });
    }
}


// =============================================================================
// Server
// =============================================================================

const app = express();
app.use(express.json());
app.use(requestLogger);

// CORS configuration - more permissive for development, restrictive for production
const corsOptions = {
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
        // Allow requests with no origin (mobile apps, curl, etc.)
        if (!origin) {
            callback(null, true);
            return;
        }
        // Check against allowed origins
        if (ALLOWED_ORIGINS.includes(origin)) {
            callback(null, true);
            return;
        }
        // In development, allow any origin
        if (process.env.NODE_ENV !== 'production') {
            callback(null, true);
            return;
        }
        // Reject in production if not in list
        callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
};
app.use(cors(corsOptions));
app.use('/api', apiKeyMiddleware);

app.get('/api/health', (req, res) => {
    res.json({
        ok: true,
        executionEnabled: EXECUTION_ENABLED,
        killSwitch: KILL_SWITCH,
        activeSymbols: Array.from(activeSymbols),
        wsClients: wsManager.getClientCount(),
        wsState
    });
});

app.post('/api/kill-switch', (req, res) => {
    KILL_SWITCH = Boolean(req.body?.enabled);
    orchestrator.setKillSwitch(KILL_SWITCH);
    log('KILL_SWITCH_TOGGLED', { enabled: KILL_SWITCH });
    res.json({ ok: true, killSwitch: KILL_SWITCH });
});

app.get('/api/status', (req, res) => {
    const now = Date.now();
    const result: any = {
        ok: true,
        uptime: Math.floor(process.uptime()),
        ws: { state: wsState, count: activeSymbols.size },
        globalBackoff: Math.max(0, globalBackoffUntil - now),
        summary: {
            desync_count_10s: 0,
            desync_count_60s: 0,
            snapshot_ok_count_60s: 0,
            snapshot_skip_count_60s: 0,
            live_uptime_pct_60s: 0,
        },
        symbols: {}
    };

    activeSymbols.forEach(s => {
        const meta = getMeta(s);
        const ob = getOrderbook(s);
        const desync10s = countWindow(meta.desyncEvents, 10000, now);
        const desync60s = countWindow(meta.desyncEvents, 60000, now);
        const snapshotOk60s = countWindow(meta.snapshotOkEvents, 60000, now);
        const snapshotSkip60s = countWindow(meta.snapshotSkipEvents, 60000, now);
        const livePct60s = liveUptimePct60s(s);
        result.symbols[s] = {
            status: ob.uiState,
            lastSnapshot: meta.lastSnapshotOk ? Math.floor((now - meta.lastSnapshotOk) / 1000) + 's ago' : 'never',
            lastSnapshotOkTs: meta.lastSnapshotOk,
            snapshotLastUpdateId: meta.snapshotLastUpdateId,
            lastSnapshotHttpStatus: meta.lastSnapshotHttpStatus,
            desync_count_10s: desync10s,
            desync_count_60s: desync60s,
            snapshot_ok_count_60s: snapshotOk60s,
            snapshot_skip_count_60s: snapshotSkip60s,
            live_uptime_pct_60s: Number(livePct60s.toFixed(2)),
            last_live_ts: meta.lastLiveTs,
            last_snapshot_ok_ts: meta.lastSnapshotOk,
            depthMsgCount10s: meta.depthMsgCount10s,
            lastDepthMsgTs: meta.lastDepthMsgTs,
            bufferedDepthCount: ob.buffer.length,
            applyCount: ob.stats.applied,
            applyCount10s: meta.applyCount10s,
            dropCount: ob.stats.dropped,
            desyncCount: meta.desyncCount,
            lastSeenU_u: ob.lastSeenU_u,
            bookLevels: {
                bids: ob.bids.size,
                asks: ob.asks.size,
                bestBid: bestBid(ob),
                bestAsk: bestAsk(ob)
            },
            // Broadcast tracking
            metricsBroadcastCount10s: meta.metricsBroadcastCount10s,
            metricsBroadcastDepthCount10s: meta.metricsBroadcastDepthCount10s,
            metricsBroadcastTradeCount10s: meta.metricsBroadcastTradeCount10s,
            lastMetricsBroadcastTs: meta.lastBroadcastTs,
            lastMetricsBroadcastReason: meta.lastMetricsBroadcastReason,
            backoff: meta.backoffMs,
            trades: meta.tradeMsgCount
        };
        result.summary.desync_count_10s += desync10s;
        result.summary.desync_count_60s += desync60s;
        result.summary.snapshot_ok_count_60s += snapshotOk60s;
        result.summary.snapshot_skip_count_60s += snapshotSkip60s;
        result.summary.live_uptime_pct_60s += livePct60s;
    });
    if (activeSymbols.size > 0) {
        result.summary.live_uptime_pct_60s = Number((result.summary.live_uptime_pct_60s / activeSymbols.size).toFixed(2));
    }
    res.json(result);
});

app.get('/api/status', (req, res) => {
    res.redirect(307, '/api/health');
});

app.get('/api/exchange-info', async (req, res) => {
    // Disable caching to prevent 304 responses
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.json(await fetchExchangeInfo());
});

app.get('/api/testnet/exchange-info', async (req, res) => {
    try {
        const symbols = await orchestrator.listTestnetFuturesPairs();
        res.json({ symbols });
    } catch (e: any) {
        res.status(500).json({ error: e.message || 'testnet_exchange_info_failed' });
    }
});

app.get('/api/execution/status', (req, res) => {
    res.json(orchestrator.getExecutionStatus());
});

app.post('/api/execution/connect', async (req, res) => {
    try {
        const apiKey = String(req.body?.apiKey || '');
        const apiSecret = String(req.body?.apiSecret || '');
        if (!apiKey || !apiSecret) {
            res.status(400).json({ error: 'apiKey and apiSecret are required' });
            return;
        }
        await orchestrator.connectExecution(apiKey, apiSecret);
        res.json({ ok: true, status: orchestrator.getExecutionStatus() });
    } catch (e: any) {
        res.status(500).json({ ok: false, error: e.message || 'execution_connect_failed' });
    }
});

app.post('/api/execution/disconnect', async (req, res) => {
    try {
        await orchestrator.disconnectExecution();
        res.json({ ok: true, status: orchestrator.getExecutionStatus() });
    } catch (e: any) {
        res.status(500).json({ ok: false, error: e.message || 'execution_disconnect_failed' });
    }
});

app.post('/api/execution/enabled', async (req, res) => {
    const enabled = Boolean(req.body?.enabled);
    if (enabled && !EXECUTION_ENABLED_ENV) {
        res.status(409).json({
            ok: false,
            error: 'execution_env_disabled',
            message: 'Set EXECUTION_ENABLED=true in the server environment and restart to enable execution.',
        });
        return;
    }
    EXECUTION_ENABLED = enabled && EXECUTION_ENABLED_ENV;
    await orchestrator.setExecutionEnabled(EXECUTION_ENABLED);
    res.json({ ok: true, status: orchestrator.getExecutionStatus(), executionEnabled: EXECUTION_ENABLED });
});

app.post('/api/execution/symbol', async (req, res) => {
    try {
        const symbol = String(req.body?.symbol || '').toUpperCase();
        let symbols = Array.isArray(req.body?.symbols) ? req.body.symbols.map((s: any) => String(s).toUpperCase()) : null;

        if (!symbols && symbol) {
            symbols = [symbol];
        }

        if (!symbols || symbols.length === 0) {
            res.status(400).json({ error: 'symbol or symbols required' });
            return;
        }

        await orchestrator.setExecutionSymbols(symbols);
        res.json({ ok: true, status: orchestrator.getExecutionStatus() });
    } catch (e: any) {
        res.status(500).json({ ok: false, error: e.message || 'execution_symbol_set_failed' });
    }
});

app.post('/api/execution/settings', async (req, res) => {
    const rawPairMargins = (req.body && typeof req.body.pairInitialMargins === 'object' && req.body.pairInitialMargins !== null)
        ? req.body.pairInitialMargins
        : {};
    const pairInitialMargins: Record<string, number> = {};
    Object.entries(rawPairMargins).forEach(([symbol, raw]) => {
        const margin = Number(raw);
        if (Number.isFinite(margin) && margin > 0) {
            pairInitialMargins[String(symbol).toUpperCase()] = margin;
        }
    });

    const settings = await orchestrator.updateCapitalSettings({
        leverage: Number(req.body?.leverage),
        pairInitialMargins,
    });
    res.json({ ok: true, settings, status: orchestrator.getExecutionStatus() });
});

app.post('/api/execution/refresh', async (req, res) => {
    try {
        const status = await orchestrator.refreshExecutionState();
        res.json({ ok: true, status });
    } catch (e: any) {
        res.status(500).json({ ok: false, error: e.message || 'execution_refresh_failed' });
    }
});

app.get('/api/dry-run/symbols', async (req, res) => {
    try {
        const info = await fetchExchangeInfo();
        const symbols = Array.isArray(info?.symbols) ? info.symbols : [];
        res.json({ ok: true, symbols });
    } catch (e: any) {
        res.status(500).json({ ok: false, error: e?.message || 'dry_run_symbols_failed', symbols: [] });
    }
});

app.get('/api/dry-run/status', (req, res) => {
    res.json({ ok: true, status: dryRunSession.getStatus() });
});

app.post('/api/dry-run/start', async (req, res) => {
    try {
        const rawSymbols = Array.isArray(req.body?.symbols)
            ? req.body.symbols.map((s: any) => String(s || '').toUpperCase())
            : [];
        const fallbackSymbol = String(req.body?.symbol || '').toUpperCase();
        const symbolsRequested = rawSymbols.length > 0
            ? rawSymbols.filter((s: string, idx: number, arr: string[]) => Boolean(s) && arr.indexOf(s) === idx)
            : (fallbackSymbol ? [fallbackSymbol] : []);

        if (symbolsRequested.length === 0) {
            res.status(400).json({ ok: false, error: 'symbols_required' });
            return;
        }

        const info = await fetchExchangeInfo();
        const symbols = Array.isArray(info?.symbols) ? info.symbols : [];
        const unsupported = symbolsRequested.filter((s: string) => !symbols.includes(s));
        if (unsupported.length > 0) {
            res.status(400).json({ ok: false, error: 'symbol_not_supported', unsupported });
            return;
        }

        const fundingRates: Record<string, number> = {};
        for (const symbol of symbolsRequested) {
            fundingRates[symbol] = lastFunding.get(symbol)?.rate ?? Number(req.body?.fundingRate ?? 0);
        }

        const status = dryRunSession.start({
            symbols: symbolsRequested,
            runId: req.body?.runId ? String(req.body.runId) : undefined,
            walletBalanceStartUsdt: Number(req.body?.walletBalanceStartUsdt ?? 5000),
            initialMarginUsdt: Number(req.body?.initialMarginUsdt ?? 200),
            leverage: Number(req.body?.leverage ?? 10),
            takerFeeRate: Number(req.body?.takerFeeRate ?? 0.0004),
            maintenanceMarginRate: Number(req.body?.maintenanceMarginRate ?? 0.005),
            fundingRates,
            fundingIntervalMs: Number(req.body?.fundingIntervalMs ?? (8 * 60 * 60 * 1000)),
            heartbeatIntervalMs: Number(req.body?.heartbeatIntervalMs ?? 10_000),
            debugAggressiveEntry: Boolean(req.body?.debugAggressiveEntry),
        });

        dryRunForcedSymbols.clear();
        for (const symbol of symbolsRequested) {
            dryRunForcedSymbols.add(symbol);
        }
        updateStreams();

        for (const symbol of symbolsRequested) {
            const ob = getOrderbook(symbol);
            if (ob.lastUpdateId === 0 || ob.uiState === 'INIT') {
                transitionOrderbookState(symbol, 'SNAPSHOT_PENDING', 'dry_run_start');
                fetchSnapshot(symbol, 'dry_run_start', true).catch((e) => {
                    log('DRY_RUN_SNAPSHOT_ERROR', { symbol, error: e?.message || 'dry_run_snapshot_failed' });
                });
            }
        }

        res.json({ ok: true, status });
    } catch (e: any) {
        res.status(500).json({ ok: false, error: e?.message || 'dry_run_start_failed' });
    }
});

app.post('/api/dry-run/stop', (req, res) => {
    try {
        const status = dryRunSession.stop();
        dryRunForcedSymbols.clear();
        updateStreams();
        res.json({ ok: true, status });
    } catch (e: any) {
        res.status(500).json({ ok: false, error: e?.message || 'dry_run_stop_failed' });
    }
});

app.post('/api/dry-run/reset', (req, res) => {
    try {
        const status = dryRunSession.reset();
        dryRunForcedSymbols.clear();
        updateStreams();
        res.json({ ok: true, status });
    } catch (e: any) {
        res.status(500).json({ ok: false, error: e?.message || 'dry_run_reset_failed' });
    }
});

app.post('/api/dry-run/test-order', (req, res) => {
    try {
        const symbol = String(req.body?.symbol || '').toUpperCase();
        const sideRaw = String(req.body?.side || 'BUY').toUpperCase();
        const side = sideRaw === 'SELL' ? 'SELL' : 'BUY';
        if (!symbol) {
            res.status(400).json({ ok: false, error: 'symbol_required' });
            return;
        }
        const status = dryRunSession.submitManualTestOrder(symbol, side);
        res.json({ ok: true, status });
    } catch (e: any) {
        res.status(500).json({ ok: false, error: e?.message || 'dry_run_test_order_failed' });
    }
});

app.post('/api/dry-run/run', (req, res) => {
    try {
        const body = req.body || {};
        const runId = String(body.runId || '');
        if (!runId) {
            res.status(400).json({ ok: false, error: 'runId is required' });
            return;
        }

        if (!Array.isArray(body.events)) {
            res.status(400).json({ ok: false, error: 'events array is required' });
            return;
        }

        const events: DryRunEventInput[] = body.events;
        const config: DryRunConfig = {
            runId,
            walletBalanceStartUsdt: Number(body.walletBalanceStartUsdt ?? 5000),
            initialMarginUsdt: Number(body.initialMarginUsdt ?? 200),
            leverage: Number(body.leverage ?? 1),
            takerFeeRate: Number(body.takerFeeRate ?? 0.0004),
            maintenanceMarginRate: Number(body.maintenanceMarginRate ?? 0.005),
            fundingRate: Number(body.fundingRate ?? 0),
            fundingIntervalMs: Number(body.fundingIntervalMs ?? (8 * 60 * 60 * 1000)),
            fundingBoundaryStartTsUTC: body.fundingBoundaryStartTsUTC != null
                ? Number(body.fundingBoundaryStartTsUTC)
                : undefined,
            proxy: {
                mode: 'backend-proxy',
                restBaseUrl: String(body.restBaseUrl || 'https://fapi.binance.com'),
                marketWsBaseUrl: String(body.marketWsBaseUrl || 'wss://fstream.binance.com/stream'),
            },
        };

        const engine = new DryRunEngine(config);
        const result = engine.run(events);
        res.json({ ok: true, logs: result.logs, finalState: result.finalState });
    } catch (e: any) {
        if (isUpstreamGuardError(e)) {
            log('DRY_RUN_UPSTREAM_GUARD_REJECT', { code: e.code, details: e.details || {} });
            res.status(e.statusCode).json({ ok: false, error: e.code, message: e.message, details: e.details || {} });
            return;
        }
        log('DRY_RUN_RUN_ERROR', { error: serializeError(e) });
        res.status(500).json({ ok: false, error: e.message || 'dry_run_failed' });
    }
});

app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    const statusCode = Number.isFinite(err?.statusCode) ? Number(err.statusCode) : 500;
    const errorCode = typeof err?.code === 'string' ? err.code : 'internal_server_error';
    logger.error('HTTP_UNHANDLED_ERROR', {
        method: req.method,
        path: req.originalUrl || req.url,
        statusCode,
        errorCode,
        error: serializeError(err),
    });

    if (res.headersSent) {
        next(err);
        return;
    }

    const message = statusCode >= 500
        ? 'Internal server error'
        : String(err?.message || 'request_failed');

    res.status(statusCode).json({
        ok: false,
        error: errorCode,
        message,
    });
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function shutdown(): void {
    wsManager.shutdown();
    if (ws) {
        ws.close();
        ws = null;
    }
    wss.close();
    server.close(() => {
        process.exit(0);
    });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

wss.on('connection', (wc, req) => {
    const authResult = validateWebSocketApiKey(req);
    if (!authResult.ok) {
        log('WS_AUTH_REJECT', {
            reason: authResult.reason || 'unauthorized',
            remoteAddress: req.socket.remoteAddress || null,
        });
        wc.close(1008, 'Unauthorized');
        return;
    }

    const p = new URL(req.url || '', 'http://l').searchParams.get('symbols') || '';
    const syms = p.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    wsManager.registerClient(wc, syms, {
        remoteAddress: req.socket.remoteAddress || null,
    });

    syms.forEach(s => {
        // Trigger initial seed if needed
        const ob = getOrderbook(s);
        if (ob.uiState === 'INIT') {
            transitionOrderbookState(s, 'SNAPSHOT_PENDING', 'client_subscribe_init');
            fetchSnapshot(s, 'client_subscribe_init', true);
        }
    });
});

// Reset 10s counters
setInterval(() => {
    const now = Date.now();
    symbolMeta.forEach((meta, symbol) => {
        meta.depthMsgCount10s = 0;
        meta.metricsBroadcastCount10s = 0;
        meta.metricsBroadcastDepthCount10s = 0;
        meta.metricsBroadcastTradeCount10s = 0;
        meta.applyCount10s = 0;
        const desyncRate10s = countWindow(meta.desyncEvents, 10000, now);
        if (desyncRate10s > LIVE_DESYNC_RATE_10S_MAX) {
            transitionOrderbookState(symbol, 'RESYNCING', 'desync_rate_high', { desyncRate10s });
            fetchSnapshot(symbol, 'desync_rate_high', true).catch(() => { });
        }
    });
}, 10000);

setInterval(() => {
    activeSymbols.forEach((symbol) => {
        evaluateLiveReadiness(symbol);
    });
}, 1000);

// [PHASE 1] Rate-limit aware staggered OI Updates
let oiTick = 0;
function scheduleNextOIPoll() {
    const symbols = Array.from(activeSymbols);
    if (symbols.length > 0) {
        const symbolToUpdate = symbols[oiTick % symbols.length];
        getOICalc(symbolToUpdate).update().catch(() => { });
        oiTick++;
    }

    // Target cycle: Each symbol updated every 30 seconds.
    const symbolCount = Math.max(1, symbols.length);
    const targetCycleSeconds = 30;
    let delay = (targetCycleSeconds * 1000) / symbolCount;
    delay = Math.max(1000, Math.min(delay, 15000)); // Clamp between 1s and 15s

    // Add jitter (±10%)
    const jitter = delay * 0.1 * (Math.random() - 0.5);
    setTimeout(scheduleNextOIPoll, delay + jitter);
}
scheduleNextOIPoll();

server.listen(PORT, HOST, () => log('SERVER_UP', { port: PORT, host: HOST }));
orchestrator.start().catch((e) => {
    log('ORCHESTRATOR_START_ERROR', { error: e.message });
});
