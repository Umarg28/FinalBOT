/**
 * WebSocket message types for BETABOT Dashboard App
 */

// Market data for display
export interface MarketData {
  marketKey: string;           // e.g., "BTC-UpDown-15-1768222800"
  marketName: string;          // Full display name with time window
  category: string;            // "BTC-15m", "ETH-1h", etc.

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
    pnlHistory: PnLHistoryEntry[];
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

// Union type for all server messages
export type ServerMessage = DashboardUpdate | TradeNotification | ConnectionMessage | PongMessage;

// Union type for all client messages
export type ClientMessage = RefreshRequest | PingRequest;
