const fs = require('fs');
const readline = require('readline');
const path = require('path');

const EXEC_LOG = path.join(__dirname, 'server/logs/orchestrator/execution_20260209.jsonl');
const DECISION_LOG = path.join(__dirname, 'server/logs/orchestrator/decision_20260209.jsonl');

async function analyze() {
    const report = {
        equityStart: 0,
        equityEnd: 0,
        totalFees: 0,
        totalGrossPnl: 0,
        totalVolume: 0,
        tradeCount: 0,
        flips: 0,
        flipDetails: [],
        sizingSamples: [],
        equityChain: []
    };

    // 1. EXECUTION ANALIZI
    const execStream = fs.createReadStream(EXEC_LOG);
    const execRl = readline.createInterface({ input: execStream, crlfDelay: Infinity });

    let lastSide = null;
    let lastTradeTime = 0;

    for await (const line of execRl) {
        try {
            const log = JSON.parse(line);

            // Equity Tracking
            if (log.type === 'ACCOUNT_UPDATE') {
                const eq = log.walletBalance; // Total Wallet Balance
                if (report.equityStart === 0 || log.event_time_ms < report.startTime) { // İlk kayıt
                    report.equityStart = eq;
                    report.startTime = log.event_time_ms;
                }
                report.equityEnd = eq; // Son kayıt
            }

            // Trade Tracking
            if (log.type === 'TRADE_UPDATE') { // orderId, side, price, quantity, realizedPnl, commission
                report.tradeCount++;
                const notional = log.quantity * log.fillPrice;
                report.totalVolume += notional;
                report.totalGrossPnl += log.realizedPnl;
                report.totalFees += (log.commission || 0); // Commission might be in asset or USDT, assuming USDT for testnet simplifiction or explicit field

                // Flip Detection (Direction Change)
                if (lastSide && lastSide !== log.side) {
                    report.flips++;
                    report.flipDetails.push({
                        time: log.event_time_ms,
                        prev: lastSide,
                        curr: log.side,
                        gapMs: log.event_time_ms - lastTradeTime,
                        notional: notional
                    });
                }
                lastSide = log.side;
                lastTradeTime = log.event_time_ms;

                // Equity Chain Sample (Last 5 trades)
                report.equityChain.push({
                    id: log.orderId,
                    side: log.side,
                    notional: notional.toFixed(2),
                    pnl: log.realizedPnl.toFixed(2),
                    fee: (log.commission || 0).toFixed(2),
                    // Equity snapshot not strictly in trade update, inferred from Account Update
                });
            }
        } catch (e) { }
    }

    // 2. DECISION ANALIZI (Sizing & Reason)
    const decStream = fs.createReadStream(DECISION_LOG);
    const decRl = readline.createInterface({ input: decStream, crlfDelay: Infinity });

    for await (const line of decRl) {
        try {
            const log = JSON.parse(line);
            if (!log.actions || log.actions.length === 0) continue;

            const entryAction = log.actions.find(a => a.type === 'ENTRY_PROBE' || a.type === 'ADD_POSITION');

            if (entryAction) {
                // Sizing Details capture
                report.sizingSamples.push({
                    ts: log.canonical_time_ms,
                    symbol: log.symbol,
                    action: entryAction.type,
                    startMargin: log.startingMarginUsdt,
                    currBudget: log.currentMarginBudgetUsdt,
                    ramp: log.rampMult,
                    leverage: 30, // Assuming fixed or from log if available (not explicitly in root log, but implied)
                    qty: entryAction.quantity,
                    price: entryAction.expectedPrice,
                    notional: (entryAction.quantity * entryAction.expectedPrice).toFixed(2),
                    reason: entryAction.reason
                });
            }
        } catch (e) { }
    }

    // OUTPUT GENERATION
    console.log("=== FORENSIC REPORT RAW DATA ===");
    console.log(JSON.stringify(report, null, 2));
}

analyze();
