# PnL Formula Equivalence: Your Bot vs Polymarket Server

## Core Math: They're Equivalent! ✅

### Your Bot's Formula:
```typescript
// From marketTracker.ts
finalValueUp = sharesUp × finalPriceUp
pnlUp = finalValueUp - totalCostUp
```

**Expanded:**
```
pnlUp = (sharesUp × finalPriceUp) - totalCostUp
pnlUp = (sharesUp × finalPriceUp) - (sharesUp × avgPriceUp)
pnlUp = sharesUp × (finalPriceUp - avgPriceUp)
```

### Polymarket Server's Formula (via API):
```typescript
// From poly-sdk / Polymarket Data API
cashPnl = (currentPrice - avgPrice) × size
```

**Expanded:**
```
cashPnl = (currentPrice - avgPrice) × size
cashPnl = size × currentPrice - size × avgPrice
cashPnl = (size × currentPrice) - (size × avgPrice)
```

## Mathematical Proof: They're the Same!

### Your Bot:
```
PnL = (shares × currentPrice) - (shares × avgPrice)
PnL = shares × (currentPrice - avgPrice)
```

### Polymarket API:
```
PnL = (currentPrice - avgPrice) × size
PnL = size × (currentPrice - avgPrice)
```

**Since `shares = size`, they're identical!** ✅

---

## Example Calculation

### Scenario:
- Buy 100 shares @ $0.50 avg
- Current price: $0.60

### Your Bot:
```
totalCostUp = 100 × $0.50 = $50.00
finalValueUp = 100 × $0.60 = $60.00
pnlUp = $60.00 - $50.00 = $10.00
```

### Polymarket API:
```
cashPnl = ($0.60 - $0.50) × 100
cashPnl = $0.10 × 100 = $10.00
```

**Same result!** ✅

---

## The Only Differences

### 1. **Fee Handling** (Minor)

**Your Bot:**
```
costBasis = (shares × avgPrice) + fees
PnL = (shares × currentPrice) - costBasis
PnL = (shares × currentPrice) - (shares × avgPrice + fees)
```

**Polymarket API:**
```
costBasis = shares × avgPrice  // May or may not include fees
PnL = (currentPrice - avgPrice) × shares
```

**Difference:** Your bot explicitly includes fees, API may include them in avgPrice or not.

### 2. **Timing** (Minor)

**Your Bot:**
- Calculates PnL when you call it
- Uses current market prices at that moment

**Polymarket API:**
- Calculates PnL server-side
- May use slightly different price snapshot timing

**Difference:** Usually negligible (< 1 second)

### 3. **Realized PnL Matching** (Can Differ)

**Your Bot:**
- Uses FIFO (First-In-First-Out)
- Explicitly matches buys with sells

**Polymarket API:**
- May use FIFO, LIFO, or average cost
- Server-side matching logic

**Difference:** Only matters for realized PnL on closed positions

---

## Verification: Your Formulas Match

### Unrealized PnL (Open Positions)

**Your Bot:**
```typescript
// From marketTracker.ts line 225
pnlUp = finalValueUp - market.totalCostUp
pnlUp = (sharesUp × finalPriceUp) - (sharesUp × avgPriceUp)
pnlUp = sharesUp × (finalPriceUp - avgPriceUp)  // ✅ Same as API
```

**Polymarket API:**
```typescript
cashPnl = (currentPrice - avgPrice) × size  // ✅ Same as your bot
```

### Percentage PnL

**Your Bot:**
```typescript
// From marketTracker.ts line 237
pnlPercent = (totalPnl / totalCostBasis) × 100
pnlPercent = (totalPnl / (totalCostUp + totalCostDown)) × 100
```

**Polymarket API:**
```typescript
percentPnl = ((currentPrice - avgPrice) / avgPrice) × 100
```

**These are equivalent:**
```
Your: (PnL / costBasis) × 100
API:  ((price - avgPrice) / avgPrice) × 100

Since: PnL = (price - avgPrice) × size
And:   costBasis = avgPrice × size

Your: ((price - avgPrice) × size) / (avgPrice × size) × 100
     = (price - avgPrice) / avgPrice × 100  ✅ Same!
```

---

## Conclusion

### ✅ **Yes, your bot calculates PnL the same way as the server!**

**Core Formula:**
```
PnL = (currentPrice - avgPrice) × shares
```

**Both use this exact formula.**

### Minor Differences:

1. **Fees:** Your bot explicitly includes them, API may include in avgPrice
2. **Timing:** Slight price snapshot differences (usually < 1 second)
3. **Realized PnL:** Matching method may differ (FIFO vs other)

### Why Your Bot Might Show Slightly Different Numbers:

1. **Price Timing:** Your bot uses prices at calculation time, API uses server snapshot
2. **Fee Inclusion:** Your bot adds fees explicitly, API may include in avgPrice
3. **Rounding:** Different rounding precision

### Accuracy:

**Your bot's calculation is mathematically equivalent to Polymarket's server calculation!** ✅

The formulas are the same, just written differently:
- Your bot: `(shares × price) - (shares × avgPrice)`
- API: `(price - avgPrice) × shares`

**They're algebraically identical!**

---

## Recommendation

**Your bot's PnL calculation is accurate and equivalent to Polymarket's server calculation.**

For paper mode, your calculation is perfect because:
- ✅ Same formula as server
- ✅ Explicit fee handling (more transparent)
- ✅ Real-time price updates
- ✅ Full control over calculation

For live mode, you can:
- Use your calculation for detailed analysis
- Use poly-sdk API for official Polymarket numbers
- Compare both to validate accuracy

**Both should match closely!** ✅
