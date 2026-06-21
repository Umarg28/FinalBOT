# BetaBot Analytics Dashboard

An **isolated**, read-only PnL analytics dashboard for the Polymarket rebalancing
bot. It reads the bot's `logs/paper/pnl_history*.json` files and renders a web
dashboard with per-market and daily PnL, profitability breakdowns, and a
"why did this work / not work" analysis with concrete parameter suggestions.

> ⚠️ This module **never imports or modifies the bot's code**. It only reads log
> files. Deleting the `analytics/` folder has zero effect on trading.

## What it shows

- **Overview** — net PnL, win rate, profit factor, ROI, go-live readiness verdict,
  and a per-market-type table (what's profitable vs what's bleeding).
- **Daily PnL** — PnL per day, click a day for the per-type breakdown and every
  market settled that day.
- **Markets** — every settled market with outcome, PnL, and the avg cost paid on
  the winning vs losing side. Click for a per-market "why" analysis + adjustment.
- **Analysis** — deterministic heuristic findings + suggested parameter changes
  (referencing the real `inventory-rebalance-config.yaml` keys), plus an optional
  **🤖 Analyze with AI** button (Claude) for a richer narrative.

## Cloudflare tunnel + Telegram

On start it launches a Cloudflare quick tunnel and (if configured) sends the
public link to Telegram only after the public HTTPS URL passes a reachability
probe. Quick tunnels rotate/expire; the dashboard has a **♻️ New tunnel** button
to rotate manually, and the new verified link is auto-sent to Telegram. If
`cloudflared` isn't installed: `brew install cloudflared`.

## Setup

```bash
cd analytics
npm install
cp .env.example .env   # edit as needed (all optional)
npm run dev            # or: npm run build && npm start
```

Then open http://localhost:4100 (or the Cloudflare link).

## Configuration (`analytics/.env`)

| Variable | Default | Purpose |
|---|---|---|
| `ANALYTICS_PORT` | `4100` | Local dashboard port |
| `PAPER_LOG_DIR` | `../logs/paper` | Where the bot writes PnL history |
| `DISABLE_CLOUDFLARE_TUNNEL` | `false` | Run local-only |
| `TUNNEL_ROTATE_MINUTES` | `0` | Proactively rotate the tunnel (0 = only on crash) |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | — | Auto-send the link to Telegram |
| `ANTHROPIC_API_KEY` | — | Enables the AI analysis button (uses `claude-opus-4-8`) |

## Design

```
analytics/
├── src/
│   ├── config.ts       # env + tiny .env loader
│   ├── types.ts        # raw (bot) + derived (dashboard) types
│   ├── dataSource.ts   # read & normalize pnl_history*.json  (read-only)
│   ├── analytics.ts    # pure aggregations (overview/daily/per-type)
│   ├── heuristics.ts   # rules-based "why" + parameter suggestions
│   ├── aiAnalysis.ts   # optional Claude hook
│   ├── tunnel.ts       # cloudflared quick-tunnel manager
│   ├── telegram.ts     # send rotating link
│   └── server.ts       # http API + static dashboard
└── public/             # vanilla-JS frontend (no build step)
```
