# poly-sdk Integration Summary

## What Was Added

Your bot has been enhanced with powerful features from `@catalyst-team/poly-sdk`. This integration provides:

### ✅ Enhanced Services

1. **EnhancedMarketDataService** - Better orderbook handling, arbitrage detection, K-lines
2. **EnhancedTradeExecutor** - Advanced order types (GTC, GTD), order management, rewards tracking
3. **Arbitrage Utilities** - Helper functions for manual arbitrage detection and analysis

### ✅ Key Improvements

1. **Proper Orderbook Handling**
   - Accounts for Polymarket's mirror property: `Buy YES @ P = Sell NO @ (1-P)`
   - Prevents double-counting when calculating arbitrage
   - Uses effective prices for accurate calculations

2. **Built-in Arbitrage Detection**
   - Automatic detection of long/short arbitrage opportunities
   - Configurable minimum profit thresholds
   - Actionable trading instructions

3. **Advanced Order Types**
   - **GTC (Good Till Cancelled)**: Orders that stay active until filled or cancelled
   - **GTD (Good Till Date)**: Orders that expire at a specified timestamp
   - **FOK/FAK**: Existing fill-or-kill / fill-and-kill support

4. **Better Error Handling**
   - Rate limiting prevents API throttling
   - Automatic retries with exponential backoff
   - Graceful fallback to basic services if SDK init fails

## Configuration

Enhanced services are **enabled by default**. To disable them:

```bash
USE_ENHANCED_SERVICES=false
```

## Quick Start

### Using Enhanced Market Data

```typescript
import { EnhancedMarketDataService } from './services/enhancedMarketData';

// Get unified market
const market = await marketData.getUnifiedMarket('condition-id');

// Detect arbitrage (0.5% minimum profit)
const arb = await marketData.detectArbitrage(conditionId, 0.5);
if (arb) {
  console.log(`${arb.type} ARB: ${(arb.profit * 100).toFixed(2)}% profit`);
}

// Get processed orderbook with analytics
const orderbook = await marketData.getProcessedOrderbook(conditionId);
console.log(`Long Arb Profit: ${orderbook.summary.longArbProfit}`);
```

### Using Enhanced Trade Executor

```typescript
import { EnhancedTradeExecutor } from './services/enhancedTradeExecutor';

// Place GTC limit order
const signal = {
  tokenId: 'token-id',
  conditionId: 'condition-id',
  side: 'BUY',
  price: 0.45,
  size: 10,
  strategyName: 'my-strategy',
  metadata: {
    orderType: 'GTC', // or 'GTD', 'FOK', 'FAK'
  },
};

await tradeExecutor.executeOrder(signal);

// Get open orders
const orders = await tradeExecutor.getOpenOrders();
```

### Using Arbitrage Utilities

```typescript
import { detectArbitrage, logArbitrageOpportunity } from './utils/arbitrageUtils';

const arbInfo = detectArbitrage(yesAsk, yesBid, noAsk, noBid, 0.5);
if (arbInfo.exists) {
  logArbitrageOpportunity(conditionId, marketName, arbInfo);
}
```

## Example Strategy

See `src/strategies/arbitrageStrategy.ts` for a complete example of how to:
- Use enhanced market data service
- Detect arbitrage opportunities
- Generate trade signals based on arbitrage

## Backward Compatibility

All enhanced services extend the base services, so they're fully backward compatible. Your existing strategies will continue to work without modification.

To use enhanced features in your strategies:

```typescript
if (this.marketData instanceof EnhancedMarketDataService) {
  // Use enhanced features
  const arb = await this.marketData.detectArbitrage(conditionId);
} else {
  // Fall back to basic features
  const orderbook = await this.marketData.getOrderBook(tokenId);
}
```

## Files Added

- `src/services/enhancedMarketData.ts` - Enhanced market data service
- `src/services/enhancedTradeExecutor.ts` - Enhanced trade executor
- `src/utils/arbitrageUtils.ts` - Arbitrage utility functions
- `src/strategies/arbitrageStrategy.ts` - Example arbitrage strategy
- `ENHANCED_FEATURES.md` - Detailed documentation

## Files Modified

- `src/index.ts` - Updated to use enhanced services when enabled
- `src/config/env.ts` - Added `USE_ENHANCED_SERVICES` config option
- `package.json` - Added `@catalyst-team/poly-sdk` dependency

## Benefits

1. **Better Accuracy**: Proper orderbook handling prevents calculation errors
2. **More Opportunities**: Built-in arbitrage detection finds profitable trades
3. **Flexibility**: Advanced order types enable better execution strategies
4. **Reliability**: Rate limiting and caching prevent API issues
5. **Performance**: Optimized with built-in caching and connection reuse

## Next Steps

1. **Test in Paper Mode**: Run with `npm run paper` to test enhanced features
2. **Review Strategies**: Check if your strategies can benefit from arbitrage detection
3. **Monitor Performance**: Enhanced services include better logging
4. **Adjust Configuration**: Fine-tune arbitrage thresholds and order types

## Troubleshooting

If you encounter issues:

1. **SDK initialization fails**: Check your `.env` file has correct credentials
2. **Type errors**: Run `npm run build` to check for TypeScript errors
3. **API rate limits**: Enhanced services include rate limiting, but monitor usage
4. **Fallback mode**: If SDK fails, bot automatically falls back to basic services

## References

- [poly-sdk GitHub](https://github.com/cyl19970726/poly-sdk)
- [poly-sdk Documentation](https://github.com/cyl19970726/poly-sdk#readme)
- [Enhanced Features Documentation](./ENHANCED_FEATURES.md)
