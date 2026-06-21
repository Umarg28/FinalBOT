/**
 * Shared types. The *raw* types mirror what the bot writes to
 * logs/paper/pnl_history*.json; the *derived* types are what the analytics layer
 * produces for the dashboard.
 */

export type Asset = "BTC" | "ETH" | "OTHER";
export type Duration = "5m" | "15m" | "1h" | "other";
export type Outcome = "UP" | "DOWN";

// ── Raw shapes (as persisted by the bot) ──────────────────────────────────────
export interface RawPosition {
  position: {
    conditionId: string;
    tokenId: string;
    title: string;
    outcome: string; // "Up" | "Down"
    size: number;
    avgPrice: number;
    timestamp: string;
  };
  costBasis: number;
  currentValue: number;
  unrealizedPnL: number;
  unrealizedPnLPercent: number;
  fees: number;
}

export interface RawMarketPnL {
  conditionId: string;
  marketName: string;
  positions: RawPosition[];
  totalCostBasis: number;
  totalCurrentValue: number;
  totalRealizedPnL: number;
  totalUnrealizedPnL: number;
  totalPnL: number;
  totalPnLPercent: number;
  totalFees: number;
}

export interface RawHistoryEntry {
  marketName: string;
  conditionId: string;
  marketPnL?: RawMarketPnL;
  priceUp: number;
  priceDown: number;
  totalPnl: number;
  pnlPercent: number;
  sharesUp: number;
  sharesDown: number;
  timestamp: number;
}

// ── Derived / normalized market record ────────────────────────────────────────
export interface MarketRecord {
  conditionId: string;
  marketName: string;
  asset: Asset;
  duration: Duration;
  marketType: string; // e.g. "BTC-5m"
  date: string; // YYYY-MM-DD (ET)
  timestamp: number;
  outcome: Outcome; // which side won
  win: boolean; // totalPnl > 0
  totalPnl: number;
  pnlPercent: number;
  sharesUp: number;
  sharesDown: number;
  costUp: number;
  costDown: number;
  avgCostUp: number;
  avgCostDown: number;
  invested: number;
  /** avg cost paid for the side that actually won (key profitability driver). */
  avgCostWinner: number;
  /** avg cost paid for the side that lost. */
  avgCostLoser: number;
  // ── Settlement clarity (mirrors the bot's PnL report) ───────────────────────
  settlePriceUp: number; // 1 or 0
  settlePriceDown: number; // 0 or 1
  winnerShares: number; // shares on the winning side (each pays $1)
  loserShares: number; // shares on the losing side (each pays $0)
  payout: number; // winnerShares * $1
}

export interface GroupStats {
  key: string;
  count: number;
  wins: number;
  losses: number;
  winRate: number; // %
  totalPnl: number;
  avgPnl: number;
  bestPnl: number;
  worstPnl: number;
  invested: number;
  roi: number; // % = totalPnl / invested
  profitFactor: number; // sum(win) / sum(|loss|)
  profitable: boolean;
}

export interface DailyStats extends GroupStats {
  date: string;
}

export interface Overview {
  totalPnl: number;
  count: number;
  winRate: number;
  profitFactor: number;
  invested: number;
  roi: number;
  bestMarketType: string | null;
  worstMarketType: string | null;
  firstDate: string | null;
  lastDate: string | null;
}
