# BETABOT Web Dashboard

Real-time web dashboard for BETABOT that mirrors the terminal dashboard.

## Features

- Real-time WebSocket updates (~1.5 second refresh)
- Mobile-friendly responsive design
- Dark theme matching terminal aesthetic
- Portfolio summary (balance, PnL, trades)
- Current and upcoming market cards with prices, positions, and PnL
- Market type breakdown (15-minute vs 1-hour markets)

## Usage

### Enable the Dashboard

Set the environment variable in your `.env` file:

```bash
ENABLE_WEB_DASHBOARD=true
WEB_DASHBOARD_PORT=3000  # Optional, defaults to 3000
```

### Start the Bot

Start the bot normally. The web dashboard will start automatically:

```bash
npm run paper
# or
npm run dev
```

### Access the Dashboard

Open your browser to:

```
http://localhost:3000
```

Or on your phone (same network):

```
http://<your-computer-ip>:3000
```

## Architecture

```
/app
├── server/
│   ├── index.ts           # HTTP + WebSocket server
│   ├── dashboardData.ts   # Data aggregator from marketTracker
│   └── types.ts           # TypeScript interfaces
└── public/
    ├── index.html         # Dashboard page
    ├── css/styles.css     # Dark theme styling
    └── js/
        ├── dashboard.js   # WebSocket client + DOM updates
        └── formatters.js  # Number/date formatting utilities
```

## Removing the Dashboard

The `/app` folder is completely self-contained. To remove:

1. Delete the `/app` folder
2. Set `ENABLE_WEB_DASHBOARD=false` in `.env`

No other code changes needed - the bot will run normally without the dashboard.

## WebSocket API

The dashboard receives updates via WebSocket in this format:

```typescript
{
  type: 'dashboard_update',
  timestamp: number,
  data: {
    mode: 'PAPER' | 'WATCH' | 'TRADING',
    currentMarkets: MarketData[],
    upcomingMarkets: MarketData[],
    portfolio: {
      balance: number,
      totalInvested: number,
      totalValue: number,
      totalPnL: number,
      totalPnLPercent: number,
      totalTrades: number,
      pnl15m: number,
      pnl15mPercent: number,
      trades15m: number,
      pnl1h: number,
      pnl1hPercent: number,
      trades1h: number
    }
  }
}
```

## Development

The dashboard auto-reconnects on disconnect (up to 50 attempts with exponential backoff). Connection status is shown in the header.

To modify styles, edit `/app/public/css/styles.css`. CSS variables are defined at the top for easy theming.
