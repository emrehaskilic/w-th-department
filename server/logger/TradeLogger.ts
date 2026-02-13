import * as fs from 'fs';
import * as path from 'path';

export interface TradeLog {
  tradeId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  signalType: string;
  openTime: string;
  closeTime: string;
  entry: { price: number; qty: number; notional: number; margin: number; leverage: number };
  exit: { price: number; reason: string; qty: number };
  orderflow: {
    obiWeighted: number | null;
    obiDeep: number | null;
    deltaZ: number | null;
    cvdSlope: number | null;
  };
  pnl: {
    grossUsdt: number;
    feeUsdt: number;
    netUsdt: number;
    rMultiple: number | null;
  };
  cumulative: {
    totalPnl: number;
    totalTrades: number;
    winCount: number;
    winRate: number;
  };
}

export class TradeLogger {
  private totalPnl = 0;
  private totalTrades = 0;
  private winCount = 0;
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath || path.join(process.cwd(), 'logs', 'trades.jsonl');
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  append(log: Omit<TradeLog, 'cumulative'>): TradeLog {
    this.totalTrades += 1;
    this.totalPnl += log.pnl.netUsdt;
    if (log.pnl.netUsdt > 0) {
      this.winCount += 1;
    }

    const full: TradeLog = {
      ...log,
      cumulative: {
        totalPnl: Number(this.totalPnl.toFixed(8)),
        totalTrades: this.totalTrades,
        winCount: this.winCount,
        winRate: this.totalTrades > 0 ? this.winCount / this.totalTrades : 0,
      },
    };

    fs.appendFileSync(this.filePath, JSON.stringify(full) + '\n', { encoding: 'utf8' });
    return full;
  }
}
