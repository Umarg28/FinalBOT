# PnL Calculation Comparison: Your Bot vs poly-sdk

## Overview

This document explains how PnL is calculated in both implementations and highlights the differences.

---

## Your Current Implementation

### 1. **MarketTracker PnL Calculation** (`src/services/marketTracker.ts`)

**Formula:**
```typescript
// For UP position
finalValueUp = sharesUp * finalPriceUp
pnlUp = finalValueUp - totalCostUp

// For DOWN position  
finalValueDown = sharesDown * finalPriceDown
pnlDown = finalValueDown - totalCostDown

// Total
totalPnl = pnlUp + pnlDown
pnlPercent = (totalPnl / totalCostBasis) * 100
```

**Where:**
- `totalCostUp` = Sum of (shares × avgPrice) for all UP buys
- `totalCostDown` = Sum of (shares × avgPrice) for all DOWN buys
- `totalCostBasis` = `totalCostUp + totalCostDown`

**Example:**
```
UP: 100 shares @ $0.50 avg = $50 cost
Current price: $0.60
Final value: 100 × $0.60 = $60
PnL: $60 - $50 = +$10 (+20%)
```

---

### 2. **Enhanced PnL Calculator** (`src/utils/pnlCalculator.ts`)

#### **Unrealized PnL (Open Positions)**
```typescript
costBasis = size * avgPrice + fees
currentValue = size * currentPrice
unrealizedPnL = currentValue - costBasis
unrealizedPnLPercent = (unrealizedPnL / costBasis) * 100
```

#### **Realized PnL (Closed Trades - FIFO)**
```typescript
// For each SELL matched with BUY (FIFO)
buyCost = matchedSize * buy.price + (buy.fees * matchedSize / buy.size)
sellProceeds = matchedSize * sell.price - (sell.fees * matchedSize / sell.size)
tradePnL = sellProceeds - buyCost
realizedPnL += tradePnL
```

**Key Features:**
- ✅ Includes fees in cost basis
- ✅ FIFO matching for realized PnL
- ✅ Separates realized vs unrealized

---

### 3. **PaperTrader PnL** (`src/services/paperTrader.ts`)

**Simple Realized PnL:**
```typescript
realizedPnl = (finalPrice - existingPosition.avgPrice) * signal.size
```

**Total PnL:**
```typescript
totalPnL = balance - startingBalance + realizedPnL
```

---

## poly-sdk's PnL Calculation

### **WalletService.getWalletProfile()**

poly-sdk uses **Polymarket's Data API** which provides pre-calculated PnL:

```typescript
// From Data API (server-side calculation)
{
  totalPnL: number,        // Total profit/loss (realized + unrealized)
  winRate: number,         // Win rate percentage
  cashPnl: number,        // Unrealized PnL per position
  percentPnl: number,      // Percentage PnL per position
  currentValue: number,   // Current position value
  avgPrice: number,       // Average entry price
  realizedPnl: number     // Realized PnL (from closed positions)
}
```

### **How Polymarket Calculates It (Server-Side)**

Based on Polymarket's Data API structure:

1. **Position PnL:**
   ```
   cashPnl = (currentPrice - avgPrice) × size
   percentPnl = ((currentPrice - avgPrice) / avgPrice) × 100
   currentValue = size × currentPrice
   ```

2. **Total PnL:**
   ```
   totalPnL = Σ(realizedPnL) + Σ(cashPnl for open positions)
   ```

3. **Win Rate:**
   ```
   winRate = (winningTrades / totalTrades) × 100
   ```

---

## Key Differences

### 1. **Fee Handling**

**Your Bot:**
- ✅ Explicitly includes fees in cost basis: `costBasis = size * avgPrice + fees`
- ✅ Deducts fees from sell proceeds: `sellProceeds = size * price - fees`

**poly-sdk:**
- Uses Polymarket's API which may or may not include fees in the calculation
- Fees are typically handled by Polymarket's backend

### 2. **Realized PnL Calculation**

**Your Bot:**
- ✅ Uses FIFO (First-In-First-Out) matching
- ✅ Explicitly matches buys with sells
- ✅ Calculates per-trade PnL

**poly-sdk:**
- Uses Polymarket's Data API which handles realized PnL server-side
- May use different matching method (FIFO/LIFO/average cost)

### 3. **Cost Basis**

**Your Bot:**
```typescript
// Uses actual cost basis (includes fees)
costBasis = size * avgPrice + fees
```

**poly-sdk:**
```typescript
// Uses avgPrice from API (may or may not include fees)
costBasis = size * avgPrice  // From Polymarket API
```

### 4. **Data Source**

**Your Bot:**
- ✅ Client-side calculation
- ✅ Full control over calculation logic
- ✅ Can customize fee handling

**poly-sdk:**
- Uses Polymarket's Data API
- Server-side calculation
- Consistent with Polymarket's official numbers
- May have slight differences due to API timing

---

## Mathematical Formulas Comparison

### **Unrealized PnL**

**Your Bot:**
```
PnL = (currentPrice × size) - (avgPrice × size + fees)
PnL% = (PnL / (avgPrice × size + fees)) × 100
```

**poly-sdk (via API):**
```
PnL = (currentPrice - avgPrice) × size
PnL% = ((currentPrice - avgPrice) / avgPrice) × 100
```

**Difference:** Your bot includes fees in denominator, poly-sdk may not.

### **Realized PnL**

**Your Bot (FIFO):**
```
For each SELL:
  Match with oldest BUY
  buyCost = matchedSize × buyPrice + (buyFees × matchedSize / buySize)
  sellProceeds = matchedSize × sellPrice - (sellFees × matchedSize / sellSize)
  tradePnL = sellProceeds - buyCost
```

**poly-sdk (via API):**
```
realizedPnL = API value (calculated server-side)
```

---

## Which is More Accurate?

### **Your Bot Advantages:**
1. ✅ **Fee-Inclusive**: Explicitly accounts for trading fees
2. ✅ **Transparent**: You see exactly how PnL is calculated
3. ✅ **Customizable**: Can adjust calculation logic
4. ✅ **FIFO Matching**: Clear trade matching logic

### **poly-sdk Advantages:**
1. ✅ **Official**: Uses Polymarket's official calculations
2. ✅ **Consistent**: Matches what Polymarket shows
3. ✅ **Efficient**: No need to calculate client-side
4. ✅ **Complete**: Includes all Polymarket-specific adjustments

---

## Recommendation

**For Paper Trading:**
- Use your current implementation (fee-inclusive, transparent)

**For Live Trading:**
- Use poly-sdk's WalletService for official PnL
- Compare with your calculation for validation
- Your calculation can serve as a cross-check

**Best Approach:**
- Use both methods and compare
- Your bot for detailed analysis
- poly-sdk for official Polymarket numbers

---

## Example Calculation

### Scenario:
- Buy 100 shares UP @ $0.50
- Fee: $0.10 (0.1%)
- Current price: $0.60

### Your Bot:
```
Cost basis: (100 × $0.50) + $0.10 = $50.10
Current value: 100 × $0.60 = $60.00
PnL: $60.00 - $50.10 = $9.90
PnL%: ($9.90 / $50.10) × 100 = 19.76%
```

### poly-sdk (via API):
```
Cost basis: 100 × $0.50 = $50.00 (may not include fees)
Current value: 100 × $0.60 = $60.00
PnL: $60.00 - $50.00 = $10.00
PnL%: ($10.00 / $50.00) × 100 = 20.00%
```

**Difference:** $0.10 (the fee amount)

---

## Summary

| Aspect | Your Bot | poly-sdk |
|--------|----------|----------|
| **Fee Handling** | ✅ Explicit | ⚠️ API-dependent |
| **Calculation** | ✅ Client-side | ✅ Server-side |
| **Transparency** | ✅ Full control | ⚠️ Opaque |
| **Accuracy** | ✅ Fee-inclusive | ✅ Official |
| **Realized PnL** | ✅ FIFO explicit | ⚠️ API-dependent |
| **Customization** | ✅ Yes | ❌ No |

**Your implementation is more detailed and fee-accurate, while poly-sdk provides official Polymarket numbers.**
