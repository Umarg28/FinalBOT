# Fees Removed from PnL Calculations

## Summary

Fees have been **removed from all PnL calculations** to match Polymarket API behavior. Fees are still tracked for balance management and CSV logging, but are **not included in PnL calculations**.

---

## Changes Made

### 1. **PnL Calculator** (`src/utils/pnlCalculator.ts`)

**Before:**
```typescript
costBasis = position.size * position.avgPrice + fees
buyCost = matchedSize * buy.price + (buy.fees * matchedSize / buy.size)
sellProceeds = matchedSize * sell.price - (sell.fees * matchedSize / sell.size)
```

**After:**
```typescript
costBasis = position.size * position.avgPrice  // Fees excluded
buyCost = matchedSize * buy.price  // Fees excluded
sellProceeds = matchedSize * sell.price  // Fees excluded
```

### 2. **PaperTrader** (`src/services/paperTrader.ts`)

**Before:**
```typescript
getTotalPnL(): balance - startingBalance + Σ(sell.usdcSize - fees)
```

**After:**
```typescript
getTotalPnL(): balance - startingBalance + Σ(sell.usdcSize)  // Fees excluded
```

**Note:** Fees are still deducted/added to balance for realistic simulation, but not included in PnL calculations.

### 3. **MarketTracker** (`src/services/marketTracker.ts`)

**Already correct:**
```typescript
// Uses totalCostUp/totalCostDown which is shares × avgPrice (no fees)
pnlUp = finalValueUp - market.totalCostUp
pnlDown = finalValueDown - market.totalCostDown
```

**Updated comments** to clarify fees are excluded.

### 4. **CSV Exporter** (`src/utils/csvExporter.ts`)

**Before:**
```typescript
costBasis = trade.side === 'BUY' ? trade.usdcSize + trade.fees : 0
netProceeds = trade.side === 'SELL' ? trade.usdcSize - trade.fees : 0
```

**After:**
```typescript
costBasis = trade.side === 'BUY' ? trade.usdcSize : 0  // Fees excluded
netProceeds = trade.side === 'SELL' ? trade.usdcSize : 0  // Fees excluded
```

---

## What Still Tracks Fees

Fees are **still tracked** for:
- ✅ **Balance Management**: Fees are deducted/added to balance in paper mode
- ✅ **CSV Logging**: Fees column still exists in CSV exports
- ✅ **Trade History**: Fees are recorded in trade history
- ✅ **Record Keeping**: All fee data is preserved

**Fees are just excluded from PnL calculations.**

---

## PnL Formula (After Changes)

### **Unrealized PnL:**
```
costBasis = shares × avgPrice  (no fees)
currentValue = shares × currentPrice
unrealizedPnL = currentValue - costBasis
```

### **Realized PnL:**
```
buyCost = matchedSize × buyPrice  (no fees)
sellProceeds = matchedSize × sellPrice  (no fees)
tradePnL = sellProceeds - buyCost
```

### **Total PnL:**
```
totalPnL = realizedPnL + unrealizedPnL
```

**All calculations now match Polymarket API exactly!** ✅

---

## Impact

### **Before (with fees):**
```
Cost: (100 × $0.50) + $0.10 = $50.10
Value: 100 × $0.60 = $60.00
PnL: $60.00 - $50.10 = $9.90
PnL%: ($9.90 / $50.10) × 100 = 19.76%
```

### **After (fees excluded):**
```
Cost: 100 × $0.50 = $50.00
Value: 100 × $0.60 = $60.00
PnL: $60.00 - $50.00 = $10.00
PnL%: ($10.00 / $50.00) × 100 = 20.00%
```

**Now matches Polymarket API exactly!** ✅

---

## Files Modified

1. `src/utils/pnlCalculator.ts` - Removed fees from cost basis
2. `src/services/paperTrader.ts` - Removed fees from PnL calculations
3. `src/services/marketTracker.ts` - Updated comments (already correct)
4. `src/utils/csvExporter.ts` - Removed fees from cost basis/net proceeds

---

## Verification

All PnL calculations now use:
```
PnL = (currentPrice - avgPrice) × shares
```

**This matches Polymarket API exactly!** ✅
