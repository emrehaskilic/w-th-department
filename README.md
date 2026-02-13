# Orderflow Telemetry Dashboard & Backend

This project consists of a React frontend and a Node.js/Express backend that calculates and streams real-time orderflow metrics.

## 🏗 Architecture

- **Frontend (`src/`)**: React + Vite + TailwindCSS. Visualizes data only. **Does NOT calculate metrics.**
- **Backend (`server/`)**: Node.js + WebSocket. Connects to Binance, processes trades/depth, and **calculates all metrics.**

## 📊 Metrics Source of Truth

Contrary to appearances, the dashboard does **not** fabricate metrics on the client side. All advanced metrics are calculated on the backend to ensure consistency and performance.

### 1. Advanced Metrics (`server/metrics/LegacyCalculator.ts`)
The following metrics are computed in real-time on the server for each symbol:

| Metric | Source Logic | Code Location |
|--------|-------------|---------------|
| **Session VWAP** | `totalNotional / totalVolume` | `LegacyCalculator.ts` (L160) |
| **OBI (Weighted)** | Orderbook imbalance (top 10 levels) | `LegacyCalculator.ts` (L94) |
| **OBI (Deep)** | Orderbook imbalance (top 50 levels) | `LegacyCalculator.ts` (L104) |
| **OBI Divergence** | `Weighted - Deep` | `LegacyCalculator.ts` (L117) |
| **Delta Z-Score** | Statistical Z-score of 1s Delta | `LegacyCalculator.ts` (L134) |
| **CVD Slope** | Linear regression of CVD history | `LegacyCalculator.ts` (L142) |
| **Sweep Strength** | Aggressive buyer/seller momentum | `LegacyCalculator.ts` (L168) |
| **Breakout Mom.** | Price trend momentum vs spread | `LegacyCalculator.ts` (L185) |
| **Regime Vol** | Price range volatility | `LegacyCalculator.ts` (L204) |
| **Absorption** | High volume + Low price change | `LegacyCalculator.ts` (L221) |
| **Trade Signal** | Composite of OBI + DeltaZ + Slope | `LegacyCalculator.ts` (L265) **(NEW)** |

### 2. Time & Sales Metrics (`server/metrics/TimeAndSales.ts`)
Derived from the trade tape (`@aggTrade`):

- **Aggressive Buy/Sell Volume**
- **Trade Counts**
- **Size Distribution (Small/Mid/Large)**
- **Bid/Ask Pressure Ratio**
- **Burst Detection**
- **Prints Per Second**

### 3. Payload Structure
The backend sends a `MetricsMessage` to the frontend containing:
```typescript
{
  type: 'metrics',
  symbol: 'BTCUSDT',
  legacyMetrics: {
    // Contains ALL the advanced metrics listed above
    obiWeighted: 0.45,
    deltaZ: 1.2,
    cvdSlope: 50.5,
    // ...
  },
  timeAndSales: { ... },
  cvd: { ... }
}
```

## 🚀 Deployment

### Prerequisites
- Node.js 18+
- Nginx (for production proxy)

### Quick Start
1. `npm run install:all`
2. Create `server/.env` from `server/.env.example` and set `API_KEY_SECRET`.
3. Set `VITE_PROXY_API_KEY` in frontend env to the same value (required).
4. `npm run dev:all` (Frontend: 5174, Backend: 8787)
