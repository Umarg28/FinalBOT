# Enhanced Features with poly-sdk

This document describes the new enhanced features added to the bot using `@catalyst-team/poly-sdk`.

## Overview

The bot now includes enhanced services that leverage the powerful `@catalyst-team/poly-sdk` library for:
- Better orderbook handling with proper mirror property support
- Built-in arbitrage detection
- Advanced order types (GTC, GTD)
- Rate limiting and caching
- K-line data aggregation

## Configuration

Enable enhanced services by setting:
```bash
USE_ENHANCED_SERVICES=true
```

Or disable them (uses basic services):
```bash
USE_ENHANCED_SERVICES=false
```

**Default:** `true` (enabled)

## Enhanced Market Data Service

### Features

1. **Unified Market Data**
   - Better structure and validation
   - Supports both condition ID and slug lookup

2. **Processed Orderbook**
   - Properly handles Polymarket's mirror orderbook property
   - Prevents double-counting when calculating arbitrage
   - Includes summary analytics

3. **Arbitrage Detection**
   - Automatic detection of long/short arbitrage opportunities
   - Configurable minimum profit threshold
   - Actionable trading instructions

4. **Real-time Spread Analysis**
   - Current spread metrics
   - Arbitrage opportunity info
   - Effective prices accounting for mirror property

5. **K-line Data**
   - OHLCV candles
   - Dual K-lines (YES + NO)
   - Historical spread analysis

### Usage Example

```typescript
import { EnhancedMarketDataService } from './services/enhancedMarketData';

const marketData = new EnhancedMarketDataService(clobClient);
await marketData.initialize();

// Get unified market
const market = await marketData.getUnifiedMarket('condition-id-or-slug');

// Get processed orderbook with arbitrage info
const orderbook = await marketData.getProcessedOrderbook(conditionId);
console.log(`Long Arb Profit: ${orderbook.summary.longArbProfit}`);
console.log(`Short Arb Profit: ${orderbook.summary.shortArbProfit}`);

// Detect arbitrage
const arb = await marketData.detectArbitrage(conditionId, 0.5); // 0.5% min
if (arb) {
  console.log(`${arb.type.toUpperCase()} ARB: ${(arb.profit * 100).toFixed(2)}%`);
  console.log(arb.action);
}

// Get real-time spread
const spread = await marketData.getRealtimeSpread(conditionId);
if (spread && spread.longArbProfit > 0.005) {
  console.log(`Long arb opportunity: ${spread.longArbProfit * 100}%`);
}

// Get K-lines
const klines = await marketData.getKLines(conditionId, '1h', { limit: 100 });
```

## Enhanced Trade Executor

### Features

1. **Advanced Order Types**
   - **GTC (Good Till Cancelled)**: Order stays active until filled or cancelled
   - **GTD (Good Till Date)**: Order expires at specified timestamp
   - **FOK (Fill Or Kill)**: Fill entirely or cancel (existing)
   - **FAK (Fill And Kill)**: Partial fill is acceptable

2. **Order Management**
   - Query open orders
   - Cancel specific orders
   - Cancel all orders

3. **Market Making Rewards**
   - Check if order is scoring
   - Get current rewards
   - Get earnings for specific date

### Usage Example

```typescript
import { EnhancedTradeExecutor } from './services/enhancedTradeExecutor';

const tradeExecutor = new EnhancedTradeExecutor(clobClient);
await tradeExecutor.initialize();

// Place GTC limit order
const signal: TradeSignal = {
  tokenId: 'token-id',
  conditionId: 'condition-id',
  side: 'BUY',
  price: 0.45,
  size: 10,
  strategyName: 'my-strategy',
  metadata: {
    orderType: 'GTC', // or 'GTD', 'FOK', 'FAK'
    expiration: Math.floor(Date.now() / 1000) + 3600, // For GTD only
  },
};

const execution = await tradeExecutor.executeOrder(signal);

// Get open orders
const openOrders = await tradeExecutor.getOpenOrders();
console.log(`Open orders: ${openOrders.length}`);

// Cancel an order
await tradeExecutor.cancelOrder(orderId);

// Cancel all orders
await tradeExecutor.cancelAllOrders();

// Check rewards
const rewards = await tradeExecutor.getCurrentRewards();
const earnings = await tradeExecutor.getEarnings('2024-12-07');
```

## Arbitrage Utilities

Helper functions for manual arbitrage detection:

```typescript
import { detectArbitrage, logArbitrageOpportunity } from './utils/arbitrageUtils';

// Detect arbitrage from raw prices
const arbInfo = detectArbitrage(
  yesAsk,  // YES token ask price
  yesBid,  // YES token bid price
  noAsk,   // NO token ask price
  noBid,   // NO token bid price
  0.1      // Minimum profit % (0.1%)
);

if (arbInfo.exists) {
  console.log(`${arbInfo.type} arbitrage: ${arbInfo.profitPercent.toFixed(2)}%`);
  console.log(`Action: ${arbInfo.action}`);
  logArbitrageOpportunity(conditionId, marketName, arbInfo);
}
```

## Strategy Integration

You can use enhanced features in your strategies:

```typescript
import { BaseStrategy } from './baseStrategy';
import { EnhancedMarketDataService } from '../services/enhancedMarketData';

export class ArbitrageStrategy extends BaseStrategy {
  async analyze(): Promise<StrategyResult> {
    const signals: TradeSignal[] = [];
    
    // Cast to enhanced service if available
    if (this.marketData instanceof EnhancedMarketDataService) {
      const arb = await this.marketData.detectArbitrage(conditionId, 0.5);
      
      if (arb && arb.profit > 0.005) {
        // Create signals based on arbitrage opportunity
        if (arb.type === 'long') {
          // Buy YES + NO, then merge
          signals.push(/* YES buy signal */);
          signals.push(/* NO buy signal */);
        } else if (arb.type === 'short') {
          // Split, then sell YES + NO
          signals.push(/* Split signal */);
        }
      }
    }
    
    return { signals };
  }
}
```

## Benefits

1. **Better Orderbook Handling**: Properly accounts for Polymarket's mirror property, preventing calculation errors
2. **Arbitrage Detection**: Built-in detection with actionable insights
3. **Advanced Orders**: Use GTC/GTD orders for better execution strategies
4. **Rate Limiting**: Built-in rate limiting prevents API throttling
5. **Caching**: Automatic caching reduces API calls
6. **Error Handling**: Better error handling with automatic retries

## Backward Compatibility

All enhanced services extend the base services, so they're fully backward compatible. Existing strategies will continue to work without modification.

To use enhanced features, simply check if the service is an enhanced instance:

```typescript
if (marketData instanceof EnhancedMarketDataService) {
  // Use enhanced features
} else {
  // Fall back to basic features
}
```

## Performance

Enhanced services include:
- Rate limiting to prevent API throttling
- TTL-based caching for frequently accessed data
- Connection pooling and reuse
- Automatic retry with exponential backoff

## References

- [poly-sdk GitHub](https://github.com/cyl19970726/poly-sdk)
- [poly-sdk Documentation](https://github.com/cyl19970726/poly-sdk#readme)
