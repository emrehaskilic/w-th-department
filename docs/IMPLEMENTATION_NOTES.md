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
- **Execution Level:** DRY-RUN by default unless `EXECUTION_MODE=live` and `EXECUTION_ENABLED=true`.
- **Determinism:** Each metrics snapshot contains a `stateHash` to verify output stability.
