# WEBAPP Bot Integration Guide

Connect any trading bot to the WEBAPP dashboard at `https://webapp-ldq8.onrender.com`

## Quick Start

Send POST requests to: `https://webapp-ldq8.onrender.com/api/update`

```javascript
// Minimal example - send every 1.5 seconds
setInterval(async () => {
  await fetch('https://webapp-ldq8.onrender.com/api/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      botId: 'my-bot-1',
      reason: 'heartbeat',
      runtimeMode: 'TRADING',
      payload: {
        botName: 'My Trading Bot',
        updatedAt: Date.now(),
        myPortfolio: {
          availableCash: 10000,
          investedValue: 500,
          currentValue: 520,
          totalPnL: 20,
          totalPnLPercent: 4.0,
          openPositions: 2,
          totalTrades: 15
        },
        marketSummaries: [],
        pnlHistory: []
      }
    })
  });
}, 1500);
```

---

## Full Payload Schema

```typescript
interface WebappUpdate {
  // REQUIRED - Unique identifier for this bot instance
  botId: string;  // e.g., "main", "bot-1", "my-edge-bot"

  // REQUIRED - Always "heartbeat" for regular updates
  reason: 'heartbeat';

  // REQUIRED - Trading mode
  runtimeMode: 'TRADING' | 'PAPER' | 'WATCHER';

  // REQUIRED - All bot data goes here
  payload: {
    // REQUIRED - Display name shown in dashboard
    botName: string;  // e.g., "BETABOT", "EdgeBot Pro"

    // REQUIRED - Timestamp of this update (milliseconds)
    updatedAt: number;  // Date.now()

    // REQUIRED - Portfolio summary
    myPortfolio: PortfolioData;

    // OPTIONAL - Current open positions/markets
    marketSummaries?: MarketSummary[];

    // OPTIONAL - Upcoming markets (not yet traded)
    upcomingMarkets?: MarketSummary[];

    // OPTIONAL - Resolved market history (for History tab)
    pnlHistory?: PnlHistoryEntry[];

    // OPTIONAL - Recent trades
    trades?: TradeEntry[];

    // OPTIONAL - Wallet addresses being tracked
    traders?: { address: string; notes?: string }[];

    // OPTIONAL - For multi-bot management
    spawnedBots?: SpawnedBot[];
    configTemplate?: string;  // YAML config template
  }
}
```

---

## Portfolio Data (REQUIRED)

```typescript
interface PortfolioData {
  // Current cash balance (not invested)
  availableCash: number;  // e.g., 9500.00

  // Total amount currently invested in positions
  investedValue: number;  // e.g., 500.00

  // Current market value of all positions
  currentValue: number;  // e.g., 520.00

  // Total profit/loss in dollars
  totalPnL: number;  // e.g., 20.00 (profit) or -15.00 (loss)

  // Total profit/loss as percentage
  totalPnLPercent: number;  // e.g., 4.0 (4% profit)

  // Number of open positions
  openPositions: number;  // e.g., 2

  // Total number of trades executed
  totalTrades: number;  // e.g., 150

  // OPTIONAL - Wallet address
  wallet?: string;  // e.g., "0x1234..."

  // OPTIONAL - Time-windowed PnL metrics
  pnl5m?: number;        // PnL in last 5 minutes
  pnl5mPercent?: number;
  trades5m?: number;     // Trades in last 5 minutes

  pnl15m?: number;       // PnL in last 15 minutes
  pnl15mPercent?: number;
  trades15m?: number;

  pnl1h?: number;        // PnL in last 1 hour
  pnl1hPercent?: number;
  trades1h?: number;
}
```

---

## Market Summaries (Current Positions)

```typescript
interface MarketSummary {
  // Unique identifier for this market
  marketKey: string;  // e.g., "BTC-UpDown-15-1768570200"

  // Human-readable market name
  marketName: string;  // e.g., "Bitcoin Up or Down - January 16, 8:30AM ET"

  // OPTIONAL - Market category
  category?: string;  // e.g., "crypto", "sports"

  // OPTIONAL - When market closes (Unix timestamp ms)
  endDate?: number;

  // OPTIONAL - Human-readable time remaining
  timeRemaining?: string;  // e.g., "5:32" or "2h 15m"

  // OPTIONAL - Is market expired/closed?
  isExpired?: boolean;

  // Current prices (0.00 to 1.00)
  priceUp: number;    // e.g., 0.65
  priceDown: number;  // e.g., 0.35

  // Number of shares held
  sharesUp: number;   // e.g., 100.5
  sharesDown: number; // e.g., 50.2

  // Amount invested in each side
  investedUp: number;   // e.g., 65.00
  investedDown: number; // e.g., 17.57

  // Current value of each side (shares × price)
  currentValueUp: number;   // e.g., 65.33
  currentValueDown: number; // e.g., 17.57

  // PnL for each side
  pnlUp: number;         // e.g., 0.33
  pnlDown: number;       // e.g., 0.00
  pnlUpPercent: number;  // e.g., 0.5
  pnlDownPercent: number;

  // Combined PnL for this market
  totalPnL: number;        // e.g., 0.33
  totalPnLPercent: number; // e.g., 0.4

  // Number of trades on each side
  tradesUp: number;   // e.g., 5
  tradesDown: number; // e.g., 3

  // OPTIONAL - Win probability display
  upPercent?: number;   // e.g., 65 (shown as 65%)
  downPercent?: number; // e.g., 35
}
```

---

## PnL History (Resolved Markets)

```typescript
interface PnlHistoryEntry {
  // Market identification
  marketName: string;     // e.g., "Bitcoin Up or Down - January 16, 8AM ET"
  conditionId?: string;   // Polymarket condition ID

  // Final PnL
  totalPnl: number;    // e.g., 5.50 or -3.20
  pnlPercent: number;  // e.g., 11.0 or -6.4

  // Final prices when market resolved
  priceUp: number;   // e.g., 1.00 (UP won) or 0.00 (DOWN won)
  priceDown: number; // e.g., 0.00 or 1.00

  // Shares held at resolution
  sharesUp: number;
  sharesDown: number;

  // When market resolved (Unix timestamp ms)
  timestamp: number;

  // Outcome
  outcome: 'WIN' | 'LOSS' | 'UNKNOWN';

  // OPTIONAL - Market type for filtering
  marketType?: '5m' | '15m' | '1h';
}
```

---

## Trade Entries (Recent Activity)

```typescript
interface TradeEntry {
  // Wallet/trader address
  trader: string;  // e.g., "0x1234..."

  // Trade details
  action: 'BUY' | 'SELL';
  side: 'UP' | 'DOWN' | 'YES' | 'NO';
  asset: string;   // Token ID or market name

  // Size and price
  amount: string;  // e.g., "$5.50"
  price: number;   // e.g., 0.55

  // Links
  market?: string;  // URL to market
  tx?: string;      // Transaction hash

  // When trade occurred
  timestamp: number;
}
```

---

## Complete Example (TypeScript)

```typescript
// webapp-client.ts - Drop this into any bot project

interface WebappConfig {
  url: string;
  botId: string;
  botName: string;
  apiKey?: string;
  updateIntervalMs?: number;
}

class WebappClient {
  private config: WebappConfig;
  private intervalId: NodeJS.Timeout | null = null;

  constructor(config: WebappConfig) {
    this.config = {
      updateIntervalMs: 1500,
      ...config
    };
  }

  async sendUpdate(data: {
    portfolio: {
      balance: number;
      invested: number;
      currentValue: number;
      pnl: number;
      pnlPercent: number;
      positions: number;
      trades: number;
    };
    markets?: any[];
    history?: any[];
  }): Promise<boolean> {
    try {
      const payload = {
        botId: this.config.botId,
        reason: 'heartbeat',
        runtimeMode: 'TRADING',
        payload: {
          botName: this.config.botName,
          updatedAt: Date.now(),
          myPortfolio: {
            availableCash: data.portfolio.balance,
            investedValue: data.portfolio.invested,
            currentValue: data.portfolio.currentValue,
            totalPnL: data.portfolio.pnl,
            totalPnLPercent: data.portfolio.pnlPercent,
            openPositions: data.portfolio.positions,
            totalTrades: data.portfolio.trades,
          },
          marketSummaries: data.markets || [],
          pnlHistory: data.history || [],
        }
      };

      const response = await fetch(this.config.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.apiKey && { 'X-API-Key': this.config.apiKey })
        },
        body: JSON.stringify(payload)
      });

      return response.ok;
    } catch (error) {
      console.error('[WEBAPP] Failed to send update:', error);
      return false;
    }
  }

  startAutoUpdates(getDataFn: () => any): void {
    if (this.intervalId) return;

    console.log(`[WEBAPP] Starting auto-updates to ${this.config.url}`);

    // Send immediately
    this.sendUpdate(getDataFn());

    // Then send periodically
    this.intervalId = setInterval(() => {
      this.sendUpdate(getDataFn());
    }, this.config.updateIntervalMs);
  }

  stopAutoUpdates(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('[WEBAPP] Stopped auto-updates');
    }
  }
}

export { WebappClient };
```

---

## Usage in Your Bot

```typescript
import { WebappClient } from './webapp-client';

// Initialize client
const webapp = new WebappClient({
  url: 'https://webapp-ldq8.onrender.com/api/update',
  botId: 'my-unique-bot-id',  // MUST be unique per bot instance
  botName: 'My Trading Bot',
  updateIntervalMs: 1500  // Send updates every 1.5 seconds
});

// Start sending updates
webapp.startAutoUpdates(() => ({
  portfolio: {
    balance: myBot.getBalance(),
    invested: myBot.getTotalInvested(),
    currentValue: myBot.getCurrentValue(),
    pnl: myBot.getTotalPnL(),
    pnlPercent: myBot.getPnLPercent(),
    positions: myBot.getOpenPositions().length,
    trades: myBot.getTradeCount()
  },
  markets: myBot.getOpenPositions().map(pos => ({
    marketKey: pos.id,
    marketName: pos.name,
    priceUp: pos.priceUp,
    priceDown: pos.priceDown,
    sharesUp: pos.sharesUp,
    sharesDown: pos.sharesDown,
    investedUp: pos.investedUp,
    investedDown: pos.investedDown,
    currentValueUp: pos.sharesUp * pos.priceUp,
    currentValueDown: pos.sharesDown * pos.priceDown,
    pnlUp: (pos.sharesUp * pos.priceUp) - pos.investedUp,
    pnlDown: (pos.sharesDown * pos.priceDown) - pos.investedDown,
    totalPnL: pos.totalPnL,
    totalPnLPercent: pos.pnlPercent,
    tradesUp: pos.tradesUp || 0,
    tradesDown: pos.tradesDown || 0
  })),
  history: myBot.getResolvedMarkets()
}));

// Stop when bot shuts down
process.on('SIGINT', () => {
  webapp.stopAutoUpdates();
  process.exit(0);
});
```

---

## Environment Variables

For Render or any deployment, set these:

```bash
# Required
EXTERNAL_WEBAPP_ENABLED=true
EXTERNAL_WEBAPP_URL=https://webapp-ldq8.onrender.com/api/update

# Required - must be unique per bot
BOT_ID=my-bot-1
BOT_NAME=My Trading Bot

# Optional
EXTERNAL_WEBAPP_API_KEY=your-api-key
```

---

## Polling for Commands (Bot Management)

If you want the WEBAPP to send commands to your bot (create, stop, delete), poll this endpoint:

```typescript
// Poll every 5 seconds
setInterval(async () => {
  try {
    const res = await fetch('https://webapp-ldq8.onrender.com/api/bot-commands');
    const { commands } = await res.json();

    for (const cmd of commands) {
      console.log(`Received command: ${cmd.type} for bot ${cmd.botId}`);

      switch (cmd.type) {
        case 'create':
          // cmd.config contains YAML config
          // cmd.name contains bot name
          break;
        case 'stop':
          // Stop bot with cmd.botId
          break;
        case 'delete':
          // Delete bot with cmd.botId (stop + remove files)
          break;
        case 'restart':
          // Restart bot with cmd.botId
          break;
      }

      // Report result back
      await fetch('https://webapp-ldq8.onrender.com/api/bot-command-result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commandId: cmd.id,
          result: { success: true },
          timestamp: Date.now()
        })
      });
    }
  } catch (error) {
    // Polling failed, try again next interval
  }
}, 5000);
```

---

## Testing Your Integration

```bash
# Test sending an update
curl -X POST https://webapp-ldq8.onrender.com/api/update \
  -H "Content-Type: application/json" \
  -d '{
    "botId": "test-bot",
    "reason": "heartbeat",
    "runtimeMode": "TRADING",
    "payload": {
      "botName": "Test Bot",
      "updatedAt": 1768580000000,
      "myPortfolio": {
        "availableCash": 10000,
        "investedValue": 500,
        "currentValue": 520,
        "totalPnL": 20,
        "totalPnLPercent": 4.0,
        "openPositions": 2,
        "totalTrades": 15
      },
      "marketSummaries": [],
      "pnlHistory": []
    }
  }'

# Check if your bot appears on the dashboard
# Visit: https://webapp-ldq8.onrender.com
```

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Bot not appearing | Check `botId` is unique and updates are being sent |
| Data not updating | Verify `updatedAt` timestamp changes each request |
| Connection refused | Check WEBAPP URL is correct and service is running |
| Bot disappears | Send updates every 1.5s; bots timeout after ~30s of no updates |

---

## Summary Checklist

- [ ] Set unique `botId` for each bot instance
- [ ] Set human-readable `botName` for dashboard display
- [ ] Send updates every 1.5 seconds (or faster for real-time)
- [ ] Include `myPortfolio` with at least: `availableCash`, `investedValue`, `currentValue`, `totalPnL`, `totalPnLPercent`
- [ ] Include `marketSummaries` for current positions
- [ ] Include `pnlHistory` for resolved markets (History tab)
- [ ] Set environment variables for deployment
