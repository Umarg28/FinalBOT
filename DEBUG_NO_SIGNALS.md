# Debug: Bot Not Generating Signals

## Issue
Bot is analyzing markets but not generating trade signals.

## Observations from Logs
- **Balance:** $10,000.00 ✅
- **Inventory:** $0.00 (no positions)
- **Ratio:** 50.0% (exactly at target)
- **Strategy:** Running and checking prices every second
- **No signals generated:** No "Signal:" or "Strategy generated X signal(s)" messages

## Possible Causes

### 1. **Rebalance Band Check**
When ratio is exactly at target (50.0%) and `rebalance_band` is 0.005, the strategy might think it's within the acceptable range and not trade.

**Fix Applied:** Set small negative deviations when inventory is $0 to force initial inventory building.

### 2. **Trade Size Too Small**
Trade amounts might be below `min_trade_size` after applying weights/boosts.

**Check:** `calculateTradeSize()` returns base amounts, but after applying:
- Bell curve multiplier (0.30x at extremes)
- Weight multipliers (could be < 1.0)
- Close size multiplier (0.25x near close)

The final amount might be too small.

### 3. **Cooldown Period**
Cooldown might be blocking trades if `lastRebalanceTime` is recent.

**Check:** `sizing_15m_cooldown_sec: 1` (should allow trades every second)

### 4. **Near Close Behavior**
`shouldSkipTradeNearClose()` might be blocking trades.

**Check:** If market is within `close_reduce_activity_minutes` (4 minutes), activity is reduced.

## Debug Logging Added

1. **No Signals Debug:**
   - Logs when no signals generated (first time, then every 30 seconds)
   - Shows: inventory, ratio, target, balance, cooldown

2. **Trade Size Debug:**
   - Logs trade size calculations (10% chance)
   - Shows: amount, size, weight, boost

3. **Cooldown Debug:**
   - Logs when cooldown blocks trades (1% chance)

## Next Steps

1. **Restart the bot** to get fresh logs with debug messages
2. **Check the new debug logs** to see why signals aren't generated
3. **Verify trade sizes** are above `min_trade_size` after all multipliers

## Configuration to Check

```yaml
min_trade_size: 0.01  # Minimum trade size
sizing_15m_base: 0.50
sizing_15m_multiplier: 16.00
sizing_15m_min_trade: 0.50
rebalance_band: 0.005  # Very tight - might prevent trades at exact target
```

## Quick Fix to Try

If trade sizes are too small, increase `sizing_15m_base` or `sizing_15m_multiplier` in config.
