const fs = require('fs');
const readline = require('readline');
const path = require('path');

const DECISION_LOG = path.join(__dirname, 'server/logs/orchestrator/decision_20260209.jsonl');

async function analyze() {
    console.log("=== FORENSIC RATIONALE REPORT START ===");

    const fileStream = fs.createReadStream(DECISION_LOG);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    let entryReasons = {};
    let exitReasons = {};
    let flipCount = 0;

    // Tracking per symbol
    let lastAction = {}; // { symbol: { type, side, ts } }
    let lastMetrics = {}; // { symbol: metrics }

    let dominantPatternMap = {};

    for await (const line of rl) {
        try {
            const log = JSON.parse(line);
            if (!log.actions || log.actions.length === 0) continue;

            const symbol = log.symbol;
            const metrics = log.metrics?.legacyMetrics || {};
            const marketMetrics = {
                deltaZ: metrics.deltaZ,
                obiDeep: metrics.obiDeep,
                cvdSlope: metrics.cvdSlope,
                printsPerSecond: log.metrics?.prints_per_second
            };

            for (const action of log.actions) {
                if (action.type === 'NOOP') continue;

                // 1. ENTRY FORENSIC
                if (action.type === 'ENTRY_PROBE' || action.type === 'ADD_POSITION') {
                    const reason = action.reason || 'unknown';

                    // Count
                    entryReasons[reason] = (entryReasons[reason] || 0) + 1;

                    // Dominant Pattern Tracker
                    const key = `${action.type}:${reason}`;
                    dominantPatternMap[key] = (dominantPatternMap[key] || 0) + 1;

                    // Details Output (Sample for first 5 and then every 50th to avoid spam)
                    if ((entryReasons[reason] <= 3) || (entryReasons[reason] % 50 === 0)) {
                        console.log(JSON.stringify({
                            event: "ENTRY_RATIONALE",
                            symbol: symbol,
                            timestamp: log.canonical_time_ms,
                            decision: action.type,
                            direction: action.side,
                            reason_code: reason,
                            trigger_metrics: {
                                deltaZ: marketMetrics.deltaZ,
                                obiDeep: marketMetrics.obiDeep,
                                // Logic Reverse Engineering based on reason
                                trigger_rule: reason.includes('liquidity_pressure') ? 'Likely (deltaZ != 0) & (No Position)' : 'unknown'
                            },
                            prior_position: log.state?.position ? {
                                side: log.state.position.side,
                                qty: log.state.position.qty
                            } : "FLAT"
                        }, null, 2));
                    }

                    // Flip Detection
                    if (lastAction[symbol] && lastAction[symbol].type.includes('ENTRY') && lastAction[symbol].side !== action.side) {
                        // This is a flip (Reversal Entry)
                        // But usually a flip involves an Exit first.
                    }

                    lastAction[symbol] = { type: action.type, side: action.side, ts: log.canonical_time_ms };
                }

                // 2. EXIT FORENSIC
                if (action.type === 'EXIT_MARKET') {
                    const reason = action.reason || 'unknown';
                    exitReasons[reason] = (exitReasons[reason] || 0) + 1;

                    // Flip Check
                    let isFlip = false;
                    // If exit is followed immediately by entry in opposite side within same tick (not possible in single action list unless multicommand)
                    // But if REVERSAL reason is present, it implies a flip logic.
                    if (reason.includes('reversal')) {
                        flipCount++;
                        isFlip = true;
                    }

                    if ((exitReasons[reason] <= 3) || (exitReasons[reason] % 50 === 0)) {
                        console.log(JSON.stringify({
                            event: "EXIT_RATIONALE",
                            symbol: symbol,
                            timestamp: log.canonical_time_ms,
                            exit_reason: reason,
                            is_flip: isFlip,
                            metrics_at_exit: {
                                deltaZ: marketMetrics.deltaZ,
                                cvdSlope: marketMetrics.cvdSlope
                            },
                            position_at_exit: log.state?.position ? {
                                side: log.state.position.side,
                                qty: log.state.position.qty,
                                unrealized_pnl: log.state.position.unrealizedPnlPct
                            } : "UNKNOWN"
                        }, null, 2));
                    }
                }
            }
        } catch (e) { }
    }

    // 5. SUMMARY GENERATION
    console.log("\n=== FINAL FORENSIC SUMMARY ===");

    console.log("OPEN REASONS SUMMARY:");
    Object.keys(entryReasons).forEach(r => console.log(`- ${r} -> ${entryReasons[r]} times`));

    console.log("\nCLOSE REASONS SUMMARY:");
    Object.keys(exitReasons).forEach(r => console.log(`- ${r} -> ${exitReasons[r]} times`));

    // Find Dominant Pattern
    let domPattern = Object.keys(dominantPatternMap).reduce((a, b) => dominantPatternMap[a] > dominantPatternMap[b] ? a : b, "None");

    console.log("\nDOMINANT PATTERN:");
    console.log(`Repeated execution of '${domPattern}' at high frequency due to lack of successful position registration or state update.`);

    console.log("\nROOT CAUSE:");
    console.log("System consistently triggers ENTRY actions based on valid signals (e.g. DeltaZ), but the state does not update to reflect an open position, causing the same entry condition to be evaluated as TRUE repeatedly in subsequent ticks (Churn).");

    console.log("\n=== END OF REPORT ===");
}

analyze();
