# Project Roadmap: Telemetry -> Signal -> Execution

## File Mapping
- **Backend Entrypoint:** `server/index.ts` - Orchestrates Express, WS, and per-symbol metric loops.
- **Binance Proxy:** `server/connectors/ExecutionConnector.ts` - Handles REST and WS connections to Binance.
- **Metrics Calculators:** 
  - `server/metrics/TimeAndSales.ts` - Trade aggregation.
  - `server/metrics/CvdCalculator.ts` - Cumulative Volume Delta.
  - `server/metrics/LegacyCalculator.ts` - OBI, Delta Z, and price metrics.
  - `server/metrics/OpenInterestMonitor.ts` - (To be replaced/enhanced by `OICalculator.ts`).
- **Orchestrator:** `server/orchestrator/Orchestrator.ts` - Manages global state, execution settings, and symbol lifecycle.
- **Message Schema:** `src/types/metrics.ts` - Shared TypeScript interfaces for WS communication.

## Implementation Applied
1. **[PHASE 0] Documentation & Structure:** Established this file and baseline file map.
2. **[PHASE 1] Data Pipeline Hardening:**
   - `server/backfill/KlineBackfill.ts`: Implemented startup kline fetch and ATR/High-Low initialization.
   - `server/metrics/OICalculator.ts`: REST polling + `openInterestHist` support.
   - `server/utils/SymbolEventQueue.ts`: Deterministic event ordering.
   - `server/telemetry/Snapshot.ts`: Snapshot hashing and sequence tracking.
3. **[PHASE 2] Strategy Signals (V1.1):**
   - `server/strategy/NewStrategyV11.ts`: Regime + DFS + anti-flip state machine.
   - `server/strategy/Normalization.ts`: Sliding Welford + percentile normalization.
   - `server/strategy/RegimeSelector.ts`: EV/TR/MR lock logic.
4. **[PHASE 3] Dry-Run Only:**
   - `DRY_RUN=true` default and dry-run execution guards.
   - `server/risk/RiskGovernorV11.ts`: Risk sizing (R-based) and clamps.
   - `server/telemetry/DecisionLog.ts`: Structured decision logs.

## Security & Integrity
- **Kill-Switch:** Default state is SAFE (execution disabled).
- **Execution Level:** Orders only allowed when `EXECUTION_ENABLED=true`, kill switch is off, connector has keys, and readiness is true.
- **Determinism:** Each metrics snapshot contains a `stateHash` to verify output stability.

## Current Execution/Strategy/Risk/Telemetry Paths (Discovery)
- **Order send/cancel:** Dry-run guarded in `server/orchestrator/Orchestrator.ts` and `server/execution/DryRunExecutor.ts`.
- **Execution wiring:** `server/orchestrator/Orchestrator.ts` (decision → dry-run executor) and `server/index.ts` (`broadcastMetrics` → `orchestrator.ingest`).
- **Strategy loop:** `server/index.ts` (trade/depth events → `NewStrategyV11.evaluate` → `broadcastMetrics`) and `server/strategy/NewStrategyV11.ts`.
- **Risk/cooldown:** `server/risk/RiskGovernorV11.ts` (R-based sizing, clamps).
- **Telemetry/logs:** `server/orchestrator/Logger.ts` (metrics/decision/execution JSONL), `server/orchestrator/Actor.ts` (decision/execution logging), `server/orchestrator/Orchestrator.ts` (ORDER_ATTEMPT_AUDIT stdout).

## Order Plan Architecture (Boot Probe + Ladder)
- **OrderPlan/Tags:** `server/orchestrator/OrderPlan.ts` (plan id, roles, clientOrderId tags).
- **PlanRunner:** `server/orchestrator/PlanRunner.ts` (trend state, boot probe, scale-in ladder, TP ladder, profit lock, reversal).
- **Reconciler:** `server/orchestrator/Reconciler.ts` (idempotent reconcile + churn guard).
- **Integration:** `server/orchestrator/Actor.ts` (plan tick + telemetry), `server/orchestrator/Orchestrator.ts` (plan actions → place/cancel).

## Config (Env)
- **Plan / Reconcile:** `PLAN_EPOCH_MS`, `PLAN_ORDER_PREFIX`, `PLAN_REBUILD_COOLDOWN_MS`, `PLAN_PRICE_TOL_PCT`, `PLAN_QTY_TOL_PCT`, `PLAN_REPLACE_THROTTLE_PER_SEC`, `PLAN_CANCEL_STALE`.
- **Boot Probe:** `BOOT_PROBE_MARKET_PCT`, `BOOT_WAIT_READY_MS`, `BOOT_MAX_SPREAD_PCT`, `BOOT_MIN_OBI_DEEP`, `BOOT_MIN_DELTA_Z`, `BOOT_ALLOW_MARKET`, `BOOT_RETRY_MS`.
- **Trend State:** `TREND_UP_ENTER`, `TREND_UP_EXIT`, `TREND_DOWN_ENTER`, `TREND_DOWN_EXIT`, `TREND_CONFIRM_TICKS`, `TREND_REVERSAL_CONFIRM_TICKS`, `TREND_OBI_NORM`, `TREND_DELTA_NORM`, `TREND_CVD_NORM`, `TREND_SCORE_CLAMP`.
- **Scale-In:** `SCALE_IN_LEVELS`, `SCALE_IN_STEP_PCT`, `MAX_ADDS`, `ADD_ONLY_IF_TREND_CONFIRMED`, `ADD_MIN_UPNL_USDT`, `ADD_MIN_UPNL_R`.
- **TP Ladder:** `TP_LEVELS`, `TP_STEP_PCTS` (comma), `TP_DISTRIBUTION` (comma), `TP_REDUCE_ONLY`.
- **Profit Lock:** `LOCK_TRIGGER_USDT`, `LOCK_TRIGGER_R`, `MAX_DD_FROM_PEAK_USDT`, `MAX_DD_FROM_PEAK_R`.
- **Reversal:** `REVERSAL_EXIT_MODE` (`MARKET|LIMIT`), `EXIT_LIMIT_BUFFER_BPS`, `EXIT_RETRY_MS`, `ALLOW_FLIP`.
- **Sizing/Step-Up:** `INITIAL_MARGIN_USDT`, `MAX_MARGIN_USDT`, `RISK_STEP_UP_MODE`, `STEP_UP_PCT`, `STEP_UP_TRIGGER_USDT`, `STEP_UP_TRIGGER_R`, `STEP_UP_MIN_TREND_SCORE`, `STEP_UP_COOLDOWN_MS`.

## How to Run
- `npm run dev:server` for backend, `npm run dev` for UI.
- Tests: `npm test` (runs server tests).
