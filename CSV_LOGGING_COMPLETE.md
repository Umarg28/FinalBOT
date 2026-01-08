# Complete CSV Logging with PnL Calculations

## Summary

✅ **All PnL calculations are now logged to CSV** - Everything you need to debug is in the CSV files!

---

## Enhanced CSV Columns

### **Paper Trades CSV** (`Paper Trades_{runId}.csv`)

**New Headers:**
```
Timestamp, Date, Time, Trade ID, Side, Market, Outcome, Condition ID, Token ID, 
Size, Price, USDC Value, Balance After, Strategy, Status,
Position Size Before, Position Size After, Avg Price Before, Avg Price After,
Cost Basis, Current Value, Realized PnL, PnL Calculation
```

**What Each Column Shows:**

1. **Position Size Before** - Position size before this trade
2. **Position Size After** - Position size after this trade
3. **Avg Price Before** - Average price before this trade
4. **Avg Price After** - Average price after this trade (weighted average for BUY)
5. **Cost Basis** - Cost basis for this trade
   - BUY: `size × price`
   - SELL: `size × avgPriceBefore`
6. **Current Value** - Current value of this trade
   - BUY: Same as cost basis
   - SELL: Proceeds from sale (`size × price`)
7. **Realized PnL** - Realized profit/loss (only for SELL)
   - Formula: `currentValue - costBasis`
8. **PnL Calculation** - Step-by-step calculation explanation

---

## PnL Calculation Examples

### **BUY Trade (New Position)**
```
PnL Calculation: "BUY: costBasis=0.3700 (2.3600*0.154900), newPosition avgPrice=0.154900"
```

### **BUY Trade (Adding to Existing Position)**
```
PnL Calculation: "BUY: costBasis=0.3700 (2.3600*0.154900), weightedAvg=(10.6400+0.3700)/13.0000=0.846923"
```
- Shows old cost basis + new cost basis
- Shows weighted average calculation
- Shows final average price

### **SELL Trade**
```
PnL Calculation: "SELL: costBasis=2.0400 (2.0000*1.020000), proceeds=2.1000 (2.0000*1.050000), realizedPnl=0.0600 (2.1000-2.0400)"
```
- Shows cost basis calculation
- Shows proceeds calculation
- Shows realized PnL formula

---

## Enhanced PROFITS CSV

**New Headers:**
```
Market Name, Time, Total PnL, PnL %, Shares Up, Shares Down, 
Price Up, Price Down, Total Cost Basis, Total Current Value, 
Realized PnL, Unrealized PnL, PnL Calculation
```

**What Each Column Shows:**

1. **Total PnL** - Total profit/loss for the market
2. **PnL %** - Percentage return
3. **Shares Up/Down** - Position sizes
4. **Price Up/Down** - Final prices used
5. **Total Cost Basis** - Total invested
6. **Total Current Value** - Current portfolio value
7. **Realized PnL** - Realized profit/loss
8. **Unrealized PnL** - Unrealized profit/loss
9. **PnL Calculation** - Full calculation breakdown

---

## What You Can Debug

### ✅ **Position Tracking**
- See position size before/after each trade
- See average price changes
- Track how positions build up

### ✅ **PnL Calculations**
- See exact cost basis for each trade
- See realized PnL on sells
- See how average prices are calculated
- Verify weighted average calculations

### ✅ **Trade Flow**
- See every trade with full details
- See balance changes
- See position updates
- Track calculation steps

### ✅ **Bug Detection**
- Compare position sizes before/after
- Verify average price calculations
- Check PnL formulas
- Spot calculation errors

---

## Example CSV Row

**BUY Trade:**
```csv
2026-01-08T13:39:18.730Z,1/8/2026,1:39:18 PM,paper_xxx,BUY,"Bitcoin Up or Down",Up,0x...,0x...,2.3600,0.154900,0.3700,9999.63,inventory-rebalancing,filled,0.0000,2.3600,0.000000,0.154900,0.3700,0.3700,0.0000,"BUY: costBasis=0.3700 (2.3600*0.154900), newPosition avgPrice=0.154900"
```

**SELL Trade:**
```csv
2026-01-08T13:42:44.092Z,1/8/2026,1:42:44 PM,paper_xxx,SELL,"Ethereum Up or Down",Down,0x...,0x...,8.9500,0.369900,3.3100,9083.85,inventory-rebalancing,filled,17.9000,8.9500,0.412500,0.412500,3.6919,3.3100,-0.3819,"SELL: costBasis=3.6919 (8.9500*0.412500), proceeds=3.3100 (8.9500*0.369900), realizedPnl=-0.3819 (3.3100-3.6919)"
```

---

## Files Modified

1. **`src/services/paperTrader.ts`**
   - Enhanced `writeTradeToCsv()` with PnL details
   - Added position state capture before updates
   - Enhanced PROFITS CSV with calculation details
   - Added PnL calculation explanations

---

## Result

**Everything is now logged to CSV!** You can:
- See exactly how PnL was calculated
- Debug position tracking issues
- Verify average price calculations
- Track every step of the calculation
- Find bugs easily by comparing values

All PnL calculations, position states, and formulas are now in the CSV files for easy debugging!
