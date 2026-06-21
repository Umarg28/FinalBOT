# Polymarket SDK / Realtime / Wallet Readiness Upgrade Notes

Date: 2026-06-21

Purpose: record the exact changes made for Claude/Codex follow-up work, including why each change exists and the upstream source used for the design.

## User Intent

The bot only runs the inventory rebalancing strategy. The requested scope was:

1. Upgrade Polymarket SDK / CLOB client.
2. Add official real-time user/market stream support.
3. Add lightweight live wallet readiness checks:
   - USDC.e balance check.
   - MATIC gas check.
   - Approval/readiness check.
4. Add a redeem helper for resolved markets.

Full CTF split/merge automation was intentionally not added because inventory rebalancing does not need to mint or merge complete YES/NO sets.

## Source Used

External comparison source:

- GitHub repo: `https://github.com/MrFadiAi/Polymarket-bot.git`
- Inspected commit: `82647014e0c355a5684e09666d8a0a522234640d`
- Local clone path during implementation: `/tmp/MrFadiAi-Polymarket-bot`

Specific upstream files inspected:

- `/tmp/MrFadiAi-Polymarket-bot/package.json`
  - Used for dependency target versions:
    - `@catalyst-team/poly-sdk` `^0.4.7`
    - `@polymarket/clob-client` `^5.8.1`
    - `@polymarket/real-time-data-client` `^1.4.0`
    - `bottleneck` `^2.19.5`
- `/tmp/MrFadiAi-Polymarket-bot/src/services/realtime-service-v2.ts`
  - Used for official real-time topic shape:
    - `clob_market`: `agg_orderbook`, `price_change`, `last_trade_price`, `tick_size_change`
    - `clob_user`: authenticated `*` subscription with CLOB API credentials
- `/tmp/MrFadiAi-Polymarket-bot/src/services/authorization-service.ts`
  - Used for approval/readiness contract address set:
    - CTF Exchange
    - Neg Risk CTF Exchange
    - Neg Risk Adapter
    - Conditional Tokens
- `/tmp/MrFadiAi-Polymarket-bot/src/clients/ctf-client.ts`
  - Used for USDC.e/native USDC distinction and redeem flow:
    - USDC.e: `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`
    - Native Polygon USDC: `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359`
    - Conditional Tokens: `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045`
    - `redeemPositions(collateralToken, parentCollectionId, conditionId, indexSets)`

Also inspected installed package typings after upgrade:

- `node_modules/@polymarket/clob-client/dist/client.d.ts`
- `node_modules/@polymarket/real-time-data-client/dist/*.d.ts`

## Dependency Changes

Changed in `package.json` and `package-lock.json`:

- Upgraded `@catalyst-team/poly-sdk` from `^0.3.0` to `^0.4.7`.
- Upgraded `@polymarket/clob-client` from `^4.4.3` to `^5.8.1`.
- Added direct dependency `@polymarket/real-time-data-client` `^1.4.0`.
- Added direct dependency `bottleneck` `^2.19.5`.

Reason:

- The official real-time stream support requires `@polymarket/real-time-data-client`.
- CLOB v5 has the current API credential and order-client surface used by the upstream SDK.

## New Runtime Configuration

Added to `src/config/env.ts` and `.env.example`:

- `ENABLE_OFFICIAL_REALTIME=true`
  - Enables the new official stream wrapper.
- `OFFICIAL_REALTIME_DEBUG=false`
  - Optional stream status debug logging.
- `OFFICIAL_REALTIME_REFRESH_MS=30000`
  - How often to refresh token subscriptions from discovered current/next markets.
- `MIN_MATIC_BALANCE=0.05`
  - Warns if live wallet has insufficient gas balance.
- `MIN_USDCE_BALANCE=1`
  - Warns if live wallet has insufficient bridged USDC.e.
- `REQUIRE_TRADING_APPROVALS=false`
  - If set to true, live startup fails when readiness issues exist.

Reason:

- Default behavior is additive and low-risk.
- The legacy price stream remains active for existing dashboards.
- Readiness checks warn by default instead of blocking live mode until the user explicitly opts into strict failure.

## Files Added

### `src/services/officialRealtimeStream.ts`

Adds `OfficialRealtimeStreamService`, a small wrapper around `@polymarket/real-time-data-client`.

Capabilities:

- Connects with auto-reconnect and ping.
- Subscribes to official `clob_market` topics:
  - `agg_orderbook`
  - `price_change`
  - `last_trade_price`
  - `tick_size_change`
- Subscribes to authenticated `clob_user` events when CLOB API credentials are available.
- Emits:
  - `price`
  - `marketEvent`
  - `userOrder`
  - `userTrade`
- Maintains a small latest-price cache by token ID.

Design choice:

- This does not replace `src/services/priceStreamLogger.ts`. It runs alongside it to avoid breaking the existing dashboard and inventory strategy behavior.

### `src/services/walletReadiness.ts`

Adds live wallet checks:

- MATIC balance.
- USDC.e balance.
- Native Polygon USDC balance for troubleshooting wrong-token funding.
- ERC20 USDC.e allowances for:
  - CTF Exchange
  - Neg Risk CTF Exchange
  - Neg Risk Adapter
  - Conditional Tokens
- ERC1155 operator approvals for:
  - CTF Exchange
  - Neg Risk CTF Exchange
  - Neg Risk Adapter

Design choice:

- This is read-only. It does not auto-approve because automatic approval transactions are higher-risk and outside the user’s inventory-rebalancing requirement.

### `src/services/redeemHelper.ts`

Adds a focused redeem helper for resolved Polymarket markets.

Capabilities:

- Previews market resolution using CTF payout numerators/denominator.
- Checks wallet balances for provided Polymarket CLOB YES/NO token IDs.
- Redeems the winning side with `redeemPositions`.
- Supports `YES/NO` or `UP/DOWN` outcome override.

Design choice:

- No split/merge helpers were added. Redeem is useful for inventory rebalancing recovery/accounting; split/merge is mainly for arbitrage.

### `src/scripts/checkWalletReadiness.ts`

CLI wrapper for readiness checks.

Command:

```bash
npm run wallet:check
```

Optional:

```bash
WALLET_ADDRESS=0x... npm run wallet:check
```

Exit behavior:

- Prints JSON readiness.
- Exits with code `2` if readiness has issues.

### `src/scripts/redeemResolvedMarket.ts`

Safe redeem CLI.

Dry run:

```bash
npm run redeem -- --condition-id <conditionId>
```

Explicit token IDs:

```bash
npm run redeem -- --condition-id <conditionId> --yes-token-id <id> --no-token-id <id>
```

Execute transaction:

```bash
npm run redeem -- --condition-id <conditionId> --execute
```

Outcome override:

```bash
npm run redeem -- --condition-id <conditionId> --outcome UP --execute
```

Safety:

- The script defaults to dry run.
- It sends a transaction only when `--execute` is passed.

## Files Modified

### `src/services/clobClient.ts`

Changes:

- Stores derived/created CLOB API credentials in memory.
- Exposes `getClobApiCreds()`.
- Re-initializes `ClobClient` with L2 API credentials after deriving/creating them.

Reason:

- Authenticated official `clob_user` real-time subscriptions require CLOB API credentials.

### `src/index.ts`

Changes:

- Imports and starts `officialRealtimeStream` when `ENABLE_OFFICIAL_REALTIME=true`.
- Periodically refreshes official market stream token subscriptions from:
  - `priceStreamLogger.getCurrentMarkets()`
  - `priceStreamLogger.getNextMarkets()`
- Subscribes to live user order/trade events when not in paper/watcher mode.
- Runs wallet readiness checks during live startup.
- Stops official stream and clears refresh timer during shutdown.

Reason:

- Keeps official real-time support integrated without destabilizing the existing dashboard/strategy loop.

### `.env.example`

Changes:

- Documents official real-time config.
- Clarifies `USDC_CONTRACT_ADDRESS` is USDC.e.
- Documents readiness thresholds and strict approval toggle.

### `package.json`

Changes:

- Adds:
  - `wallet:check`
  - `redeem`
- Updates Polymarket dependencies.

## What Was Intentionally Not Added

- No auto split.
- No auto merge.
- No auto approvals.
- No strategy changes to `src/strategies/inventoryRebalancing.ts`.
- No replacement of `priceStreamLogger`.

Reason:

- User confirmed they only do inventory rebalancing.
- Split/merge and auto-approval increase live transaction risk and complexity.
- The safest useful CTF subset for this bot is readiness + manual/scheduled redeem.

## Validation Performed

Ran:

```bash
npm run typecheck
```

Result:

- Passed.

Also ran after all changes:

```bash
npm test
```

Result:

- Passed: 43 tests.

## Follow-Up Recommendations

1. Run in paper mode with `ENABLE_OFFICIAL_REALTIME=true` and confirm no dashboard regressions.
2. Run `npm run wallet:check` before live trading.
3. Keep `REQUIRE_TRADING_APPROVALS=false` until readiness output is understood.
4. Use `npm run redeem -- --condition-id <id>` dry-run first for any resolved market.
5. Only add split/merge later if the strategy changes from inventory rebalancing to true arbitrage.
