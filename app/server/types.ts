/**
 * WebSocket message types for BETABOT Dashboard App
 */

// Market data for display
export interface MarketData {
  marketKey: string;           // e.g., "BTC-UpDown-15-1768222800"
  marketName: string;          // Full display name with time window
  category: string;            // "BTC-15m", "ETH-1h", etc.
  leadingSide: 'UP' | 'DOWN' | 'TIE' | 'UNKNOWN';
  leadingConfidence: number;   // 0-100, difference between sides in percentage points

  // Time info
  endDate: number | null;      // Unix timestamp (ms)
  timeRemaining: string;       // Formatted: "5m 30s"
  isExpired: boolean;

  // Prices
  priceUp: number | null;
  priceDown: number | null;

  // Positions
  sharesUp: number;
  sharesDown: number;
  investedUp: number;
  investedDown: number;
  totalCostUp: number;
  totalCostDown: number;

  // PnL
  currentValueUp: number;
  currentValueDown: number;
  pnlUp: number;
  pnlDown: number;
  pnlUpPercent: number;
  pnlDownPercent: number;
  totalPnL: number;
  totalPnLPercent: number;

  // Trade counts
  tradesUp: number;
  tradesDown: number;

  // Distribution
  upPercent: number;
  downPercent: number;
}

// PnL history entry
export interface PnLHistoryEntry {
  marketName: string;
  conditionId: string;
  totalPnl: number;
  pnlPercent: number;
  priceUp: number;
  priceDown: number;
  sharesUp: number;
  sharesDown: number;
  timestamp: number;
  outcome: 'UP' | 'DOWN' | 'UNKNOWN';
}

// Portfolio summary
export interface PortfolioSummary {
  totalInvested: number;
  totalCostBasis: number;
  totalValue: number;
  totalPnL: number;
  totalPnLPercent: number;
  realizedPnL?: number;
  openPnL?: number;
  realizedCostBasis?: number;

  // By market type
  invested15m: number;
  value15m: number;
  pnl15m: number;
  pnl15mPercent: number;
  trades15m: number;

  invested1h: number;
  value1h: number;
  pnl1h: number;
  pnl1hPercent: number;
  trades1h: number;

  // Paper trading specific
  balance: number;
  startingBalance: number;
  totalTrades: number;

  // Additional metrics
  currentStreak?: number;        // Positive = win streak, negative = loss streak
  maxDrawdown?: number;          // Max drawdown in dollars
  maxDrawdownPercent?: number;   // Max drawdown as percentage
  
  // Shares distribution
  totalUpShares?: number;        // Total UP shares across all markets
  totalDownShares?: number;      // Total DOWN shares across all markets
}

// Bot-specific PnL history
export interface BotPnLHistory {
  botId: string;
  botName: string;
  history: PnLHistoryEntry[];
}

// External bot market data (full details matching MarketData structure)
export interface ExternalBotMarket {
  marketKey: string;
  marketName: string;
  category?: string;           // "BTC-15m", "ETH-1h", etc.

  // Time info
  endDate?: number;            // Unix timestamp (ms)
  timeRemaining?: string;      // Formatted: "5m 30s"
  isExpired?: boolean;

  // Prices
  priceUp: number;
  priceDown: number;

  // Positions
  sharesUp: number;
  sharesDown: number;
  investedUp?: number;
  investedDown?: number;
  totalCostUp?: number;
  totalCostDown?: number;

  // PnL
  currentValueUp?: number;
  currentValueDown?: number;
  pnlUp?: number;
  pnlDown?: number;
  pnlUpPercent?: number;
  pnlDownPercent?: number;
  totalPnL: number;
  totalPnLPercent?: number;

  // Trade counts
  tradesUp?: number;
  tradesDown?: number;

  // Distribution
  upPercent?: number;
  downPercent?: number;
}

// External bot markets container
export interface ExternalBotMarketsData {
  botId: string;
  botName: string;
  markets: ExternalBotMarket[];           // Current active markets
  upcomingMarkets?: ExternalBotMarket[];  // Upcoming markets
}

// Main dashboard update message (server -> client)
export interface DashboardUpdate {
  type: 'dashboard_update';
  timestamp: number;
  data: {
    mode: 'PAPER' | 'WATCH' | 'TRADING';
    currentMarkets: MarketData[];
    upcomingMarkets: MarketData[];
    portfolio: PortfolioSummary;
    pnlHistory: PnLHistoryEntry[];           // Main bot history (backwards compat)
    allBotsHistory: BotPnLHistory[];          // Per-bot history for selector
    bots: BotSummary[];
    externalBotsMarkets: ExternalBotMarketsData[];  // External bots' market data
    quickStats: QuickStats;                   // Quick stats bar data
  };
}

// Trade notification (server -> client)
export interface TradeNotification {
  type: 'trade';
  timestamp: number;
  data: {
    side: 'BUY' | 'SELL';
    marketKey: string;
    marketName: string;
    outcome: 'UP' | 'DOWN';
    shares: number;
    price: number;
    usdcSize: number;
  };
}

// Connection status (server -> client)
export interface ConnectionMessage {
  type: 'connection';
  status: 'connected' | 'disconnected';
  timestamp: number;
}

// Pong response (server -> client)
export interface PongMessage {
  type: 'pong';
  timestamp: number;
}

// Client messages (client -> server)
export interface RefreshRequest {
  type: 'refresh';
}

export interface PingRequest {
  type: 'ping';
}

export interface ScheduleResetRequest {
  type: 'schedule_reset';
  target: 'main' | 'external' | 'all';
}

export interface CancelResetRequest {
  type: 'cancel_reset';
  target: 'main' | 'external' | 'all';
}

// Reset status message (server -> client)
export interface ResetStatusMessage {
  type: 'reset_status';
  pending: string[];
  timestamp: number;
}

// Union type for all server messages
export type ServerMessage = DashboardUpdate | TradeNotification | ConnectionMessage | PongMessage | ResetStatusMessage;

// Union type for all client messages
export type ClientMessage = RefreshRequest | PingRequest | ScheduleResetRequest | CancelResetRequest;

// External bot data submission
export interface ExternalBotData {
  botId: string;           // Unique identifier for the bot
  botName: string;         // Display name (e.g., "Bot 2 - Aggressive")
  apiKey: string;          // Simple API key for auth
  portfolio: {
    balance: number;
    totalInvested: number;
    totalPnL: number;
    totalPnLPercent: number;
    totalTrades: number;
    // Market type breakdown (optional for backwards compat)
    pnl15m?: number;
    pnl15mPercent?: number;
    trades15m?: number;
    pnl1h?: number;
    pnl1hPercent?: number;
    trades1h?: number;
  };
  pnlHistory: Array<{
    marketName: string;
    totalPnl: number;
    pnlPercent: number;
    outcome: 'UP' | 'DOWN' | 'WIN' | 'LOSS';
    timestamp: number;
    marketType?: '15m' | '1h';  // Optional market type tag
    // Optional fields for full tracking
    sharesUp?: number;
    sharesDown?: number;
    priceUp?: number;
    priceDown?: number;
    conditionId?: string;
  }>;
  // Current active markets with full details
  currentMarkets?: Array<{
    marketKey: string;
    marketName: string;
    category?: string;
    endDate?: number;
    timeRemaining?: string;
    isExpired?: boolean;
    priceUp: number;
    priceDown: number;
    sharesUp: number;
    sharesDown: number;
    investedUp?: number;
    investedDown?: number;
    totalCostUp?: number;
    totalCostDown?: number;
    currentValueUp?: number;
    currentValueDown?: number;
    pnlUp?: number;
    pnlDown?: number;
    pnlUpPercent?: number;
    pnlDownPercent?: number;
    totalPnL: number;
    totalPnLPercent?: number;
    tradesUp?: number;
    tradesDown?: number;
    upPercent?: number;
    downPercent?: number;
  }>;
  // Upcoming markets (optional)
  upcomingMarkets?: Array<{
    marketKey: string;
    marketName: string;
    category?: string;
    endDate?: number;
    timeRemaining?: string;
    priceUp: number;
    priceDown: number;
    sharesUp: number;
    sharesDown: number;
    investedUp?: number;
    investedDown?: number;
    totalCostUp?: number;
    totalCostDown?: number;
    totalPnL: number;
    totalPnLPercent?: number;
    tradesUp?: number;
    tradesDown?: number;
  }>;
  // Legacy format support (deprecated, use currentMarkets)
  markets?: Array<{
    marketName: string;
    priceUp?: number;
    priceDown?: number;
    sharesUp: number;
    sharesDown: number;
    totalPnL: number;
  }>;
}

// Quick stats for the stats bar
export interface QuickStats {
  winRate: number;        // % of winning trades (0-100)
  avgWin: number;         // Average profit on winning trades ($)
  avgLoss: number;        // Average loss on losing trades ($) - stored as positive
  profitFactor: number;   // Total wins / total losses
}

// Bot summary for display (with market type breakdown)
export interface BotSummary {
  botId: string;
  botName: string;
  balance: number;
  totalPnL: number;
  totalPnLPercent: number;
  totalTrades: number;
  winRate: number;
  lastUpdate: number;
  // Market type breakdown
  pnl15m: number;
  pnl15mPercent: number;
  trades15m: number;
  pnl1h: number;
  pnl1hPercent: number;
  trades1h: number;
}
