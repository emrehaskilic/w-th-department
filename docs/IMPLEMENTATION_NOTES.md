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
3. **[PHASE 2] Strategy Signals:**
   - `server/strategy/StrategyEngine.ts`: Sweep-Fade and Imbalance-Breakout logic.
   - Updated `MetricsMessage` to include `signalDisplay` and `advancedMetrics`.
4. **[PHASE 3] Optional Execution:**
   - `EXECUTION_ENABLED` flag logic.
   - `server/risk/RiskManager.ts`: Notional caps and cooldowns.
   - `server/execution/BinanceExecutor.ts`: Execution logic for LIMIT orders.
   - `POST /api/kill-switch` implementation.

## Security & Integrity
- **Kill-Switch:** Default state is SAFE (execution disabled).
- **Execution Level:** Orders only allowed when `EXECUTION_ENABLED=true`, kill switch is off, connector has keys, and readiness is true.
- **Determinism:** Each metrics snapshot contains a `stateHash` to verify output stability.

## Current Execution/Strategy/Risk/Telemetry Paths (Discovery)
- **Order send/cancel:** `server/connectors/ExecutionConnector.ts` (`placeOrder`, `cancelOrder`, `syncState`) and `server/execution/BinanceExecutor.ts` (`execute`).
- **Execution wiring:** `server/orchestrator/Orchestrator.ts` (`handleActions` → `BinanceExecutor.execute`) and `server/index.ts` (`broadcastMetrics` → `orchestrator.ingest`).
- **Strategy loop:** `server/index.ts` (trade/depth events → `StrategyEngine.compute` → `broadcastMetrics`) and `server/strategy/StrategyEngine.ts`.
- **Risk/cooldown:** `server/risk/RiskManager.ts` (cooldown/notional), `server/orchestrator/SizingRamp.ts` (budget ramp).
- **Telemetry/logs:** `server/orchestrator/Logger.ts` (metrics/decision/execution JSONL), `server/orchestrator/Actor.ts` (decision/execution logging), `server/orchestrator/Orchestrator.ts` (ORDER_ATTEMPT_AUDIT stdout).
