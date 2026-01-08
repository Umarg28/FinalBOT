# PnL & CSV Enhancements Summary

## Overview

Enhanced PnL calculation and CSV export functionality to match poly-sdk standards, providing comprehensive portfolio analytics and professional-grade reporting.

## What Was Enhanced

### 1. Enhanced PnL Calculator (`src/utils/pnlCalculator.ts`)

**Features:**
- ✅ **Realized vs Unrealized PnL Separation**: Properly tracks and separates realized (from closed trades) and unrealized (from open positions) PnL
- ✅ **Fee-Adjusted Cost Basis**: All calculations include trading fees for accurate PnL
- ✅ **FIFO Trade Matching**: Uses First-In-First-Out (FIFO) accounting for matching buys and sells
- ✅ **Portfolio-Level Analytics**: Comprehensive portfolio-wide PnL calculations
- ✅ **Market-Level Analytics**: Individual market PnL breakdowns
- ✅ **Position-Level Analytics**: Detailed position-by-position PnL tracking

**Key Methods:**
- `calculatePositionPnL()` - Calculate PnL for a single position
- `calculateRealizedPnL()` - Calculate realized PnL from trade history using FIFO
- `calculatePortfolioPnL()` - Comprehensive portfolio PnL analysis
- `calculateMarketPnL()` - Market-specific PnL calculation
- `calculatePnLBreakdown()` - Detailed PnL breakdown with percentages

### 2. Enhanced CSV Exporter (`src/utils/csvExporter.ts`)

**Features:**
- ✅ **Comprehensive PnL Reports**: Full portfolio PnL export with all analytics
- ✅ **Enhanced Trade History**: Detailed trade history with cost basis and net proceeds
- ✅ **Market PnL Snapshots**: Market-level PnL exports matching poly-sdk format
- ✅ **Structured CSV Format**: Professional CSV structure with proper escaping
- ✅ **Timestamp Breakdown**: Full timestamp breakdown (year, month, day, hour, minute, second, millisecond)

**Key Methods:**
- `exportPnLReport()` - Export comprehensive PnL report
- `exportTradeHistory()` - Export detailed trade history
- `exportMarketPnLSnapshot()` - Export market-level PnL snapshot

### 3. Enhanced PaperTrader Integration

**New Methods:**
- `getPnLBreakdown()` - Get comprehensive PnL breakdown using enhanced calculator
- `exportPnLReport()` - Export full PnL report to CSV
- `exportTradeHistory()` - Export trade history to CSV

**Enhanced Methods:**
- `logMarketPnLFromDashboard()` - Now uses enhanced PnL calculator and CSV exporter
- `getStats()` - Now includes realized/unrealized PnL and total return

## CSV File Formats

### 1. PnL Report (`PnL_Report_<runId>.csv`)

**Headers:**
- Timestamp, Date, Market, Condition ID, Position Type, Shares, Avg Cost, Current Price
- Cost Basis, Current Value, Unrealized PnL, Unrealized PnL %, Realized PnL
- Total PnL, Total PnL %, Fees

**Structure:**
- Portfolio summary row
- Market-level summary rows
- Individual position rows

### 2. Trade History (`Trade_History_<runId>.csv`)

**Headers:**
- Timestamp, Date, Time, Trade ID, Condition ID, Token ID, Side, Price, Size
- Shares, USDC Value, Fees, Cost Basis, Net Proceeds, Strategy, Paper Trade, Transaction Hash

**Features:**
- Separate cost basis for buys (price * size + fees)
- Net proceeds for sells (price * size - fees)
- Full trade context

### 3. Market PnL Snapshot (`Market_PNL_<runId>.csv`)

**Headers:**
- Timestamp, Date, Year, Month, Day, Hour, Minute, Second, Millisecond
- Market Name, Condition ID, Market Slug, Outcome
- Total Invested, Cost Basis, Shares Up, Shares Down
- Avg Cost Up, Avg Cost Down, Final Price Up, Final Price Down
- Current Value, Realized PnL, Unrealized PnL, Total PnL, PnL %
- Fees, Trades Up, Trades Down, Switch Reason

**Features:**
- Full timestamp breakdown for time-series analysis
- Comprehensive market analytics
- Outcome determination (UP Won, UP Lost, DOWN Won, DOWN Lost, Profit, Loss)

## PnL Calculation Improvements

### Before
- Simple total PnL calculation
- Fees sometimes not included in cost basis
- No separation of realized vs unrealized
- Basic percentage calculations

### After
- ✅ **Realized PnL**: Calculated from closed trades using FIFO matching
- ✅ **Unrealized PnL**: Calculated from open positions with current prices
- ✅ **Fee-Inclusive**: All calculations include fees in cost basis
- ✅ **Accurate Percentages**: PnL percentages calculated against actual cost basis
- ✅ **Total Return**: Portfolio return calculation including balance changes

## Usage Examples

### Get Comprehensive PnL Breakdown

```typescript
const paperTrader = bot.getPaperTrader();
const portfolio = await paperTrader.getPnLBreakdown();

console.log(`Total PnL: $${portfolio.totalPnL.toFixed(2)}`);
console.log(`Realized: $${portfolio.totalRealizedPnL.toFixed(2)}`);
console.log(`Unrealized: $${portfolio.totalUnrealizedPnL.toFixed(2)}`);
console.log(`Total Return: ${portfolio.totalReturn.toFixed(2)}%`);
```

### Export PnL Report

```typescript
const paperTrader = bot.getPaperTrader();
const filepath = await paperTrader.exportPnLReport();
console.log(`Report exported to: ${filepath}`);
```

### Export Trade History

```typescript
const paperTrader = bot.getPaperTrader();
const filepath = await paperTrader.exportTradeHistory();
console.log(`Trade history exported to: ${filepath}`);
```

### Calculate Market PnL

```typescript
import { PnLCalculator } from './utils/pnlCalculator';

const marketPnL = PnLCalculator.calculateMarketPnL(
  positions,
  tradeHistory,
  conditionId,
  currentPrices
);

if (marketPnL) {
  console.log(`Market PnL: $${marketPnL.totalPnL.toFixed(2)}`);
  console.log(`PnL %: ${marketPnL.totalPnLPercent.toFixed(2)}%`);
}
```

## Benefits

1. **Accuracy**: Fee-inclusive calculations and proper FIFO matching
2. **Transparency**: Clear separation of realized vs unrealized PnL
3. **Professional Reports**: CSV exports match professional trading software standards
4. **Analytics**: Comprehensive portfolio and market-level analytics
5. **Compatibility**: Enhanced exports match poly-sdk format for consistency

## Backward Compatibility

- ✅ Existing CSV files continue to work
- ✅ Legacy methods still function
- ✅ Enhanced features are additive, not breaking changes
- ✅ Simple PnL logging still works for backward compatibility

## Files Created

- `src/utils/pnlCalculator.ts` - Enhanced PnL calculator
- `src/utils/csvExporter.ts` - Enhanced CSV exporter

## Files Modified

- `src/services/paperTrader.ts` - Integrated enhanced PnL calculator and CSV exporter

## Next Steps

1. **Test in Paper Mode**: Run the bot and verify CSV exports
2. **Review Reports**: Check generated PnL reports for accuracy
3. **Analyze Data**: Use enhanced CSV data for portfolio analysis
4. **Integrate MarketTracker**: Update marketTracker to use enhanced CSV exporter (optional)

## Integration with poly-sdk

The enhanced PnL calculation follows poly-sdk principles:
- Proper fee accounting
- FIFO trade matching
- Realized vs unrealized separation
- Professional CSV format
- Comprehensive analytics

This ensures consistency with poly-sdk's WalletService and SmartMoneyService PnL calculations.
