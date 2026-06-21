# Parameter Tuning History — `inventory-rebalance-config.yaml`

This log tracks every parameter set that has been tested so we never reuse a
known-bad setting. Strategy intent is fixed: **buy the winning side more as the
market tilts; still trade the weaker side sometimes; avoid equal buying once
one side is clearly favoured.**

Rules:
- Append-only. Newest entries at the top.
- Mark every entry as **ACCEPTED**, **REJECTED**, or **ACTIVE**.
- Never re-enable a `REJECTED` value without new evidence and a different reason.
- Always cross-check 5m, 15m, and 1h markets before accepting a change.

---

## 2026-04-29 15:50 BST — Tighten regime gates, lift Q4 sizing

**Trigger:** Granular per-market analysis of the 2026-04-28 paper session
(326 markets, 10 hours) revealed two specific bleed patterns that the current
gate thresholds let through, plus a clear under-accumulation signal in Q4.

**Market data used:**
- `logs/paper/PnL Report_20260428-155939.txt` (326 markets, 10 hours)
- Per-market-type breakdown via `scripts/analyzeYesterday.js`
- Cross-checked against PARAMETER_HISTORY rules (no prior rejection of these
  values; both changes continue the same direction as the 2026-04-28 entry).

**Per-market-type performance from yesterday's run (paper, optimistic
slippage — real PnL is ~30% lower per the order book simulator):**
- 5m  : 230 markets, +0.39% on $263.6k → +$1,018  (effectively flat)
- 15m :  78 markets, +2.83% on  $93.6k → +$2,645  (strong)
- 1h  :  18 markets, +2.10% on $104.8k → +$2,199  (strong)
- BTC overall: $48 of $232k invested  → 0.02% (essentially zero)
- ETH overall: $5,814 of $229k invested → 2.53% (carrying the session)

**Loss attribution from yesterday's losing markets (n = 140):**
- 16% had loser-side avg cost at $0.20-0.30 (winner at 0.70-0.80)
- **37% had loser-side avg cost at $0.30-0.40 (winner at 0.60-0.70)** ← biggest bucket
- 31% had loser-side avg cost at $0.40-0.50 (winner at 0.50-0.60)
- 15% had loser-side avg cost at $0.50+ (winner at <0.50)

The 37% bucket is exactly the gap between the current EDGE threshold (0.58, where
loser is reduced but not zeroed) and the current TREND threshold (0.65, where
loser is zeroed). Loser-side buys were trickling in at reduced size in this zone
and adding up to material loss across many markets.

**Tilt comparison (winner-side share of capital):**
- Winning markets: 72.2% on winner
- Losing markets:  74.9% on winner

The bot was picking the right side even in losing markets — but under-accumulating
on the winner. Q4 sizing of 0.80 was leaving money on the table when the trend
was most confirmed.

| Parameter           | Old (REJECTED for new evidence) | New (ACTIVE) | Reason                                                                                                                                                                                                                            | Status |
| ------------------- | ------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `trend_threshold`   | 0.65                            | 0.60         | 37% of losing markets had loser-side avg cost in $0.30-0.40 (winner at 0.60-0.70). Zeroing loser at 0.60 instead of 0.65 closes the dominant bleed bucket directly. Tilt boost still kicks in separately at `tilt_threshold=0.65`. | TUNED  |
| `edge_threshold`    | 0.58                            | 0.55         | 31% of losing markets had loser-side avg cost at $0.40-0.50 (winner 0.50-0.60). Tightening EDGE engagement by 3¢ catches that zone earlier (loser → 25% size + clamped to 0.5× winner).                                            | TUNED  |
| `q4_multiplier`     | 0.80                            | 1.00         | Continuation of 2026-04-28 direction (0.50 → 0.80 was beneficial). Losing markets had higher tilt-to-winner than winning markets, so under-accumulation, not over-accumulation, was the failure mode. `close_size_multiplier=0.60` still backstops the final minute. | TUNED  |

**Best parameter set so far:** Current ACTIVE set (above changes applied on top
of the 2026-04-28 baseline).

**Worst parameter set so far:** The 2026-04-28 REJECTED set (logged below).

**Notes / "Do not reuse":**
- ❌ Do not lower `trend_threshold` below 0.55. At <0.55 the gate fires while the
  market is still genuinely contested and would zero the loser before regime is
  confirmed.
- ❌ Do not push `q4_multiplier` above 1.00 without first proving 1.00 holds up.
  The `close_size_multiplier=0.60` backstop only protects the final minute; if
  Q4 sizing keeps creeping up the bot will over-commit at 13-14 minutes.
- ⚠️ This change set has NOT been validated against 5m/15m/1h independently
  yet. Need at least 8 windows on a fresh paper session with the order book
  simulator (`USE_ORDER_BOOK_FILL=true`) before promoting from TUNED → ACCEPTED.
- ⚠️ Caveat on the source data: yesterday's PnL was paper with optimistic
  top-of-book slippage. Realistic order book fills would lower the absolute PnL
  by ~20-30%, but the *relative* patterns (loser-side bleed buckets, tilt
  comparison, Q4 under-accumulation) are slippage-invariant — they describe
  buy-decision behaviour, not fill quality.

**Open questions (deferred):**
- BTC vs ETH split: BTC was breakeven (+$48 on $232k) while ETH carried the
  whole session (+$5,814 on $229k). Same parameters, very different outcomes.
  Likely a regime issue (BTC moves faster / gets noisier?). No fix attempted
  here because it would require per-asset parameters (a new config key).
- 5m sizing: 230 markets, +0.39%. After realistic slippage probably negative.
  Defered until we have one paper session with order-book fills to confirm
  whether 5m has real edge.

---

## 2026-04-28 15:20 BST — Rollback of "tighten + boost flip" tuning attempt

**Trigger:** The previous (uncommitted) parameter set was producing materially
worse PnL on 15-minute markets (multiple windows at -5% to -11%, e.g. ETH
7:15-7:30PM at -11.42%, BTC 8:00-8:15PM at -9.70%, BTC 9:30-9:45PM at -8.34%).
5-minute market PnL was mixed. The pattern matched "winner under-accumulated
during peak tilt" rather than random variance.

**Market data used:**
- `logs/paper/PnL Report_20260427-205749.txt` (Apr 27, 8 hour-windows, 219 markets)
- `logs/paper/pnl_history_2026-04-28.json` (per-market unrealized + final PnL,
  5m + 15m + 1h variants)
- `logs/paper/pnl_history.json` (aggregate)

| Parameter                            | Old (REJECTED) | New (ACTIVE) | Reason                                                                                                                                                                  | Status     |
| ------------------------------------ | -------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `max_inventory_imbalance_ratio`      | 1.4            | 1.5          | 1.4 capped the winning-side lean too tight (effective 1.05:1 with stop_add=0.75). Strategy says "buy winner more as market tilts" — 1.5 restores the room to lean.       | ROLLED BACK |
| `stop_add_threshold`                 | 0.75           | 0.80         | At 0.75 × 1.4 = 1.05:1 the bot stopped adding to the winning side almost immediately. Restored to 0.80 × 1.5 = 1.2:1 effective lean ceiling.                              | ROLLED BACK |
| `flip_response_multiplier`           | 1.8            | 1.5          | 1.8 caused over-reaction on noisy flips → whipsaw losses. 1.5 (HEAD/default) was previously stable.                                                                       | ROLLED BACK |
| `flip_recovery_rebalance_strength_k` | 1.6            | 1.4          | Same family of issue as `flip_response_multiplier`. 1.6 dumped winning-side inventory on unconfirmed flips.                                                              | ROLLED BACK |
| `bell_curve_peak_multiplier`         | 1.35           | 1.50         | 1.35 reduced central trade size by ~10%. Combined with the cap tightening, this further starved winning-side accumulation. 1.50 (HEAD/default) reinstated.                | ROLLED BACK |
| `q3_multiplier`                      | 1.25           | 1.45         | Q3 (50–75% of market duration) is when the market is typically tilting decisively. 1.25 down-sized exactly when the bot should lean in. 1.45 (default) restored.          | ROLLED BACK |
| `q4_multiplier`                      | 0.50           | 0.80         | EDGE/TREND/STOP already zero the loser in Q4. Halving the winner's size in Q4 leaves money on the table when the trend is clearest. 0.80 keeps modest risk-off + winner accumulation. `close_size_multiplier=0.60` still kicks in for the final minute as a hard backstop. | TUNED       |

**Performance under the REJECTED set (snapshot):**
- 8 hour-windows: net positive (+~$5.7k per-window cumulative) but heavy
  drawdowns inside windows.
- 15-minute markets: large negative outliers (-9% to -11% repeatedly).
- 5-minute markets: mixed; smaller losses overall due to shorter duration.
- 1-hour markets: thin sample, but two clear positives early then mixed.
- Pattern: losses concentrated in **15-minute markets where price tilted then
  the bot couldn't lean enough on winner before close**.

**Loss attribution (which failure modes were dominant):**
- ✅ Not buying the winning side enough (the dominant cause). Cap ratios + Q3
  reduction + bell-curve reduction all converged on this.
- ✅ Reversals after tilt (flip multipliers too aggressive). Secondary cause.
- ❌ Overbuying the winning side — not observed; bot was under-leaning, not over-leaning.
- ❌ Buying the weaker side too often — EDGE/TREND/STOP gates were doing their job.
- ❌ Entering too early — late_entry_threshold=0.70 and primary regime gates intact.
- ❌ Entering too late — first-touch trades fine; balance build-up was the bottleneck.
- ❌ Oversizing — opposite was true.

**Best parameter set so far:** HEAD-effective values (current ACTIVE set after
this rollback). Specifically:
- `max_inventory_imbalance_ratio=1.5`, `stop_add_threshold=0.80`
- `tilt_threshold=0.65`, `tilt_boost_multiplier=1.10`
- `edge_threshold=0.58`, `trend_threshold=0.65`, `price_stop_threshold=0.85`
- `bell_curve_peak_multiplier=1.50`, `bell_curve_extreme_multiplier=0.25`
- `q1=1.00, q2=0.95, q3=1.45, q4=0.80` (q4 newly tuned up from default 0.50)
- `flip_response_multiplier=1.5`, `flip_recovery_rebalance_strength_k=1.4`

**Worst parameter set so far:** the REJECTED set above (the uncommitted tuning
attempt from before this session).

**Notes / "Do not reuse":**
- ❌ Never combine `max_inventory_imbalance_ratio<=1.4` with
  `stop_add_threshold<=0.75`. The product (effective lean cap) drops to ~1.05:1
  which neutralises the whole tilt strategy.
- ❌ Never set `q3_multiplier<1.30` while `bell_curve_peak_multiplier<1.40`
  simultaneously. They compound and gut peak-window winner accumulation.
- ❌ Avoid `flip_response_multiplier>=1.7` until we have a confirmed-flip filter
  (currently flip detection is purely 30s direction reversal — too noisy for
  aggressive multipliers).

---

## Pre-2026-04-28 — HEAD baseline (committed)

This is the parameter set that was committed in `25fea6a chore: update config
and cleanup old log files`. Used as the rollback target.

Key values (HEAD):
- `bell_curve_peak_multiplier: 1.50`
- `max_inventory_imbalance_ratio: 1.5`
- `stop_add_threshold: 0.80`
- `flip_response_multiplier: 1.5`
- `flip_recovery_rebalance_strength_k: 1.4`
- (No explicit `q1..q4` block → fell back to defaults: q1=1.00, q2=0.95, q3=1.45, q4=0.50)

Status: **ACCEPTED (baseline)**. Performance was acceptable; rollback target
when newer experiments fail.

---

## How to test a new parameter set

1. **Stop the running bot** (do not have two instances tuning at once):
   - Find the watcher: `Get-Process -Name node | Where-Object { $_.MainWindowTitle -match 'watcher|paper' }`
   - Stop with `Stop-Process -Id <pid>` if needed.
2. **Edit `inventory-rebalance-config.yaml`** — the bot hot-reloads the file on save.
3. **Restart paper mode:**
   ```powershell
   npm run watcher
   ```
4. **Restart the profit reporter (read-only, separate window):**
   ```powershell
   Start-Process powershell -ArgumentList "-NoExit","-Command","npm run profits"
   ```
5. **Let it run for at least 8 windows** (≈ 8 hours for 1h markets, ≈ 2 hours
   to fill a 15-minute sample, ≈ 30 minutes for a 5-minute sample). Always
   validate against 5m AND 15m AND 1h markets before accepting.
6. **Read the new PnL report** in `logs/paper/PnL Report_*.txt`. Capture:
   - Per-window summary (already in the report).
   - Per-market-type breakdown (5m vs 15m vs 1h).
   - Number of windows with PnL < -3% (drawdown count).
7. **Append a new entry to this file** with:
   - Date/time, exact parameter changes, market data used,
   - Per-market-type performance,
   - ACCEPTED / REJECTED / ACTIVE status,
   - Notes for "do not reuse" if rejected.
8. **Hard rule:** if a change improves 5m but damages 1h or 15m, REJECT it.
   We don't optimize for the fastest market in isolation.
