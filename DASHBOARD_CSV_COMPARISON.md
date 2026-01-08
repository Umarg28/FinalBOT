# Dashboard vs CSV: Average Prices and PnL Calculation Comparison

## Summary

✅ **Both Dashboard and CSV exports use the SAME source of truth for average prices: `position.avgPrice`**

✅ **Both calculate PnL using the SAME formula: `(currentPrice - avgPrice) × size`**

⚠️ **Potential timing difference**: Dashboard updates prices in real-time, CSV exports use prices at export time

---

## Average Price Calculation

### Source of Truth: `position.avgPrice`

**Where it's calculated:**
- `PaperTrader.executeOrder()` (lines 475-478)
- Weighted average when adding to existing position:
  ```typescript
  const avgPrice = (existingPosition.avgPrice * existingPosition.size + 
                    finalPrice * signal.size) / totalSize;
  ```

**Where it's used:**
1. **Dashboard** (line 244): `const invested = pos.avgPrice * pos.size;`
2. **CSV Exporter** (line 138): `posPnL.position.avgPrice.toFixed(6)`
3. **PnLCalculator** (line 73): `const costBasis = position.size * position.avgPrice;`

✅ **All three use the exact same `position.avgPrice` value from the Position object**

---

## PnL Calculation Comparison

### Dashboard Calculation

**Location:** `src/services/dashboard.ts`

**Method 1: Real-time update** (lines 121-122)
```typescript
position.cashPnl = (currentPrice - position.avgPrice) * position.size;
position.percentPnl = ((currentPrice - position.avgPrice) / position.avgPrice) * 100;
```

**Method 2: Stats aggregation** (lines 244-246)
```typescript
const invested = pos.avgPrice * pos.size;
const value = pos.currentValue || (pos.currentPrice || 0) * pos.size;
const pnl = pos.cashPnl || 0;  // Uses pre-calculated cashPnl
```

### CSV Exporter Calculation

**Location:** `src/utils/csvExporter.ts` → Uses `PnLCalculator`

**PnLCalculator** (`src/utils/pnlCalculator.ts`, lines 67-86)
```typescript
static calculatePositionPnL(position: Position, currentPrice: number, fees: number = 0): PositionPnL {
  const costBasis = position.size * position.avgPrice;  // Same as dashboard
  const currentValue = position.size * currentPrice;     // Same as dashboard
  const unrealizedPnL = currentValue - costBasis;       // Same as dashboard
  const unrealizedPnLPercent = costBasis > 0 ? (unrealizedPnL / costBasis) * 100 : 0;
  
  return { position, costBasis, currentValue, unrealizedPnL, unrealizedPnLPercent, fees };
}
```

**Mathematical Equivalence:**
```
Dashboard:  cashPnl = (currentPrice - avgPrice) × size
CSV:        unrealizedPnL = (currentPrice × size) - (avgPrice × size)
           = currentPrice × size - avgPrice × size
           = (currentPrice - avgPrice) × size
           
✅ IDENTICAL FORMULAS
```

---

## Current Price Source

### Dashboard
- **Updates prices in real-time** (line 117): `await this.marketData.getMidPrice(position.tokenId)`
- Updates every `updateInterval` (default: 1000ms = 1 second)
- Stores in `position.currentPrice` and `position.currentValue`

### CSV Exporter
- **Uses prices at export time** via `currentPrices` Map passed to `PnLCalculator`
- Prices come from:
  - `position.currentPrice` (if available)
  - Or `currentPrices.get(position.tokenId)` (from caller)
  - Or falls back to `position.avgPrice` (line 181)

**Potential Difference:**
- Dashboard shows **live prices** (updated every second)
- CSV shows **prices at the moment of export**
- If prices change between dashboard view and CSV export, they will differ

---

## Cost Basis Calculation

### Both Use Same Formula

**Dashboard:**
```typescript
const invested = pos.avgPrice * pos.size;  // Line 244
```

**CSV/PnLCalculator:**
```typescript
const costBasis = position.size * position.avgPrice;  // Line 73
```

✅ **Identical: `avgPrice × size`**

---

## Accuracy Verification

### ✅ Average Prices
- **Source:** Same `position.avgPrice` from `PaperTrader.getAllPositions()`
- **Calculation:** Weighted average in `PaperTrader.executeOrder()` (lines 475-478)
- **Usage:** Both Dashboard and CSV use this exact value

### ✅ PnL Calculation
- **Formula:** Both use `(currentPrice - avgPrice) × size`
- **Cost Basis:** Both use `avgPrice × size`
- **Current Value:** Both use `currentPrice × size`

### ⚠️ Timing Differences
- **Dashboard:** Real-time prices (updates every 1 second)
- **CSV:** Prices at export time (snapshot)
- **Result:** May show different PnL if prices change between view and export

---

## Recommendations

### To Ensure Consistency:

1. **Use same price source:**
   - Both should use `position.currentPrice` from the same update cycle
   - Or both should fetch prices at the same time

2. **Verify price updates:**
   - Dashboard updates `position.currentPrice` in `updateMarketData()` (line 119)
   - CSV should use the same `position.currentPrice` value

3. **Check for rounding:**
   - Dashboard displays: `avgPrice.toFixed(4)` (line 520, 543)
   - CSV exports: `avgPrice.toFixed(6)` (line 138)
   - **Different precision** - CSV shows more decimal places

### Current Status:

✅ **Average prices are accurate and consistent**
✅ **PnL calculations are mathematically identical**
⚠️ **Price timestamps may differ** (real-time vs snapshot)
⚠️ **Display precision differs** (4 decimals vs 6 decimals)

---

## Code Flow

### Dashboard Flow:
```
PaperTrader.getAllPositions()
  → Dashboard.updateMarketData()
    → Updates position.currentPrice (real-time)
    → Calculates position.cashPnl = (currentPrice - avgPrice) × size
    → Dashboard.render() displays avgPrice and cashPnl
```

### CSV Export Flow:
```
PaperTrader.getAllPositions()
  → PnLCalculator.calculatePortfolioPnL()
    → Uses position.avgPrice (same source)
    → Uses position.currentPrice or currentPrices Map
    → Calculates unrealizedPnL = (currentPrice × size) - (avgPrice × size)
    → CSVExporter.exportPnLReport() writes to CSV
```

**Both start from the same `PaperTrader.getAllPositions()` call!**

---

## Conclusion

✅ **Average prices are the same** - both use `position.avgPrice` from the same source

✅ **PnL calculations are identical** - both use `(currentPrice - avgPrice) × size`

✅ **Both are accurate** - they use the same formulas and data source

⚠️ **Only difference:** Timing of price updates (real-time vs snapshot) and display precision (4 vs 6 decimals)
