# PnL Calculation in Paper Mode

## Quick Answer

**poly-sdk's API-provided PnL does NOT work in paper mode** because:
- Paper mode has no real wallet addresses
- poly-sdk's WalletService needs real addresses to query Polymarket's API
- Paper trades are simulated, not on-chain

**Your enhanced PnL calculator DOES work in paper mode** ✅

---

## What Works in Paper Mode

### ✅ Your Enhanced PnL Calculator (`src/utils/pnlCalculator.ts`)

**Works perfectly in paper mode** because it calculates from:
- Simulated positions (from `PaperTrader`)
- Trade history (from `PaperTrader.account.tradeHistory`)
- Current prices (from market data)

**Usage:**
```typescript
const paperTrader = bot.getPaperTrader();
const portfolio = await paperTrader.getPnLBreakdown();

// This uses your enhanced calculator, NOT poly-sdk API
console.log(`Total PnL: $${portfolio.totalPnL.toFixed(2)}`);
console.log(`Realized: $${portfolio.totalRealizedPnL.toFixed(2)}`);
console.log(`Unrealized: $${portfolio.totalUnrealizedPnL.toFixed(2)}`);
```

### ✅ MarketTracker PnL (`src/services/marketTracker.ts`)

**Works in paper mode** - calculates from tracked positions:
```typescript
pnlUp = (sharesUp × currentPriceUp) - totalCostUp
pnlDown = (sharesDown × currentPriceDown) - totalCostDown
totalPnl = pnlUp + pnlDown
```

### ✅ PaperTrader PnL (`src/services/paperTrader.ts`)

**Works in paper mode** - simple calculation:
```typescript
totalPnL = balance - startingBalance + realizedPnL
```

---

## What Doesn't Work in Paper Mode

### ❌ poly-sdk WalletService (`src/services/walletPnLService.ts`)

**Does NOT work in paper mode** because:
1. Requires real wallet address
2. Queries Polymarket's Data API
3. Needs actual on-chain positions

**Code check:**
```typescript
// In index.ts line 70
if (!this.isPaperMode && !this.isWatcherMode) {
  // Only initialized in LIVE mode
  this.walletPnLService = new WalletPnLService();
}
```

---

## PnL Calculation Methods by Mode

| Method | Paper Mode | Live Mode | Notes |
|--------|-----------|-----------|-------|
| **PaperTrader.getStats()** | ✅ Yes | ❌ No | Simple PnL from balance |
| **PnLCalculator** | ✅ Yes | ✅ Yes | Enhanced calculator with fees |
| **MarketTracker** | ✅ Yes | ✅ Yes | Real-time position tracking |
| **poly-sdk WalletService** | ❌ No | ✅ Yes | Requires real wallet address |

---

## Paper Mode PnL Flow

```
Paper Trade Executed
    ↓
PaperTrader.executeOrder()
    ↓
Position Updated (simulated)
    ↓
Trade History Recorded
    ↓
PnL Calculated Using:
    - PnLCalculator (enhanced)
    - MarketTracker (real-time)
    - PaperTrader.getStats() (simple)
```

**All calculations are client-side from simulated data.**

---

## Live Mode PnL Flow

```
Real Trade Executed
    ↓
On-chain Position Created
    ↓
poly-sdk WalletService.getWalletProfile(address)
    ↓
Polymarket Data API Returns:
    - totalPnL (server-calculated)
    - cashPnl (per position)
    - realizedPnl (from closed trades)
```

**Uses Polymarket's official server-side calculations.**

---

## Summary

### Paper Mode:
- ✅ Uses your enhanced `PnLCalculator` (client-side)
- ✅ Uses `MarketTracker` (real-time tracking)
- ✅ Uses `PaperTrader.getStats()` (simple)
- ❌ Cannot use poly-sdk WalletService (no real wallet)

### Live Mode:
- ✅ Can use poly-sdk WalletService (real wallet address)
- ✅ Can use your enhanced PnLCalculator (for comparison)
- ✅ Uses MarketTracker (real-time tracking)

---

## Recommendation

**For Paper Mode:**
- Use `PaperTrader.getPnLBreakdown()` - uses enhanced calculator
- Use `MarketTracker` for real-time dashboard PnL
- Both are accurate and fee-inclusive

**For Live Mode:**
- Use `WalletPnLService` for official Polymarket numbers
- Use `PnLCalculator` for detailed analysis
- Compare both for validation

---

## Example: Paper Mode PnL

```typescript
// In paper mode
const paperTrader = bot.getPaperTrader();

// Get comprehensive PnL breakdown
const portfolio = await paperTrader.getPnLBreakdown();

// This uses PnLCalculator, NOT poly-sdk API
console.log(`Total PnL: $${portfolio.totalPnL.toFixed(2)}`);
console.log(`Realized: $${portfolio.totalRealizedPnL.toFixed(2)}`);
console.log(`Unrealized: $${portfolio.totalUnrealizedPnL.toFixed(2)}`);
console.log(`Total Return: ${portfolio.totalReturn.toFixed(2)}%`);

// Export comprehensive report
await paperTrader.exportPnLReport();
```

**All of this works in paper mode!** ✅
