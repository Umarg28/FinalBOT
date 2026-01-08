/**
 * Enhanced Market Data Service using @catalyst-team/poly-sdk
 * 
 * Provides:
 * - Better orderbook handling with proper mirror property support
 * - Built-in arbitrage detection
 * - Rate limiting and caching
 * - K-line data aggregation
 * - Real-time spread analysis
 */

import { MarketDataService } from './marketData';
import { Market, OrderBook } from '../interfaces';
import logger from '../utils/logger';

// Lazy loading for ESM module
let polySdkModule: any = null;
let polySdkLoadPromise: Promise<boolean> | null = null;

async function loadPolySdk(): Promise<boolean> {
  if (polySdkModule !== null) {
    return true;
  }

  if (polySdkLoadPromise) {
    return polySdkLoadPromise;
  }

  polySdkLoadPromise = (async () => {
    try {
      polySdkModule = await import('@catalyst-team/poly-sdk');
      return true;
    } catch (error) {
      logger.warn('poly-sdk not available, enhanced features will be disabled:', error instanceof Error ? error.message : error);
      return false;
    }
  })();

  return polySdkLoadPromise;
}

// Type definitions (for TypeScript)
type UnifiedMarket = any;
type ProcessedOrderbook = any;
type ArbitrageOpportunity = {
  type: 'long' | 'short';
  profit: number;
  action: string;
  expectedProfit: number;
};

export class EnhancedMarketDataService extends MarketDataService {
  private sdk: any; // PolymarketSDK (loaded dynamically)
  private sdkInitialized: boolean = false;

  constructor(clobClient: any) {
    super(clobClient);
    // SDK will be initialized lazily in initialize() method
  }

  /**
   * Initialize the SDK (async initialization if needed)
   */
  async initialize(): Promise<void> {
    if (this.sdkInitialized) return;

    // Load poly-sdk module
    const loaded = await loadPolySdk();
    if (!loaded || !polySdkModule) {
      logger.warn('poly-sdk not available, enhanced features disabled');
      return;
    }

    try {
      // SDK is already usable without initialization for read operations
      // But we can call start() if we want WebSocket features
      this.sdk = new polySdkModule.PolymarketSDK();
      this.sdkInitialized = true;
      logger.info('Enhanced Market Data Service initialized with poly-sdk');
    } catch (error) {
      logger.warn('Failed to fully initialize poly-sdk, falling back to basic mode:', error);
    }
  }

  /**
   * Get unified market with better structure and validation
   */
  async getUnifiedMarket(identifier: string): Promise<UnifiedMarket | null> {
    await this.initialize();
    if (!this.sdk) {
      return null;
    }
    try {
      const market = await this.sdk.getMarket(identifier);
      return market;
    } catch (error) {
      logger.debug(`Failed to get unified market for ${identifier}:`, error);
      // Fallback to basic implementation
      return null;
    }
  }

  /**
   * Get processed orderbook with arbitrage analysis
   * This properly handles Polymarket's mirror orderbook property
   */
  async getProcessedOrderbook(conditionId: string): Promise<ProcessedOrderbook | null> {
    try {
      await this.initialize();
      const orderbook = await this.sdk.getOrderbook(conditionId);
      return orderbook;
    } catch (error) {
      logger.debug(`Failed to get processed orderbook for ${conditionId}:`, error);
      return null;
    }
  }

  /**
   * Detect arbitrage opportunities in a market
   * Returns arbitrage info if profitable opportunity exists
   */
  async detectArbitrage(conditionId: string, minProfitPercent: number = 0.5): Promise<ArbitrageOpportunity | null> {
    try {
      await this.initialize();
      const arb = await this.sdk.detectArbitrage(conditionId);
      
      if (arb && arb.profit * 100 >= minProfitPercent) {
        return arb;
      }
      
      return null;
    } catch (error) {
      logger.debug(`Failed to detect arbitrage for ${conditionId}:`, error);
      return null;
    }
  }

  /**
   * Get effective prices accounting for mirror orderbook
   * Polymarket has mirror property: Buy YES @ P = Sell NO @ (1-P)
   * This prevents double-counting when calculating arbitrage
   */
  async getEffectivePrices(yesAsk: number, yesBid: number, noAsk: number, noBid: number): Promise<{
    effectiveBuyYes: number;
    effectiveBuyNo: number;
    effectiveSellYes: number;
    effectiveSellNo: number;
  }> {
    await loadPolySdk();
    if (!polySdkModule || !polySdkModule.getEffectivePrices) {
      // Fallback calculation
      return {
        effectiveBuyYes: Math.min(yesAsk, 1 - noBid),
        effectiveBuyNo: Math.min(noAsk, 1 - yesBid),
        effectiveSellYes: Math.max(yesBid, 1 - noAsk),
        effectiveSellNo: Math.max(noBid, 1 - yesAsk),
      };
    }
    return polySdkModule.getEffectivePrices(yesAsk, yesBid, noAsk, noBid);
  }

  /**
   * Check arbitrage opportunity manually with raw prices
   */
  async checkArbitrageManually(
    yesAsk: number,
    yesBid: number,
    noAsk: number,
    noBid: number
  ): Promise<ArbitrageOpportunity | null> {
    await loadPolySdk();
    if (!polySdkModule || !polySdkModule.checkArbitrage) {
      return null;
    }
    const result = polySdkModule.checkArbitrage(yesAsk, yesBid, noAsk, noBid);
    // Convert to ArbitrageOpportunity format if needed
    if (!result) return null;
    return {
      type: result.type,
      profit: result.profit,
      action: result.description || '',
      expectedProfit: result.profit,
    };
  }

  /**
   * Get real-time spread analysis
   * Returns current spread and arbitrage opportunity info
   */
  async getRealtimeSpread(conditionId: string): Promise<{
    yesAsk: number;
    yesBid: number;
    noAsk: number;
    noBid: number;
    spread: number;
    longArbProfit: number;
    shortArbProfit: number;
    arbitrage: ArbitrageOpportunity | null;
  } | null> {
    try {
      await this.initialize();
      const spread = await this.sdk.markets.getRealtimeSpread(conditionId);
      if (!spread) return null;
      
      // Check for arbitrage manually from spread prices
      await loadPolySdk();
      const arb = polySdkModule && polySdkModule.checkArbitrage
        ? polySdkModule.checkArbitrage(
            spread.yesAsk,
            spread.yesBid,
            spread.noAsk,
            spread.noBid
          )
        : null;
      
      const arbResult = arb ? {
        type: arb.type,
        profit: arb.profit,
        action: arb.description || '',
        expectedProfit: arb.profit,
      } : null;
      
      return {
        yesAsk: spread.yesAsk,
        yesBid: spread.yesBid,
        noAsk: spread.noAsk,
        noBid: spread.noBid,
        spread: spread.yesAsk - spread.yesBid + spread.noAsk - spread.noBid,
        longArbProfit: spread.longArbProfit,
        shortArbProfit: spread.shortArbProfit,
        arbitrage: arbResult,
      };
    } catch (error) {
      logger.debug(`Failed to get realtime spread for ${conditionId}:`, error);
      return null;
    }
  }

  /**
   * Get K-line data (OHLCV candles) for a market
   */
  async getKLines(
    conditionId: string,
    interval: '1m' | '5m' | '15m' | '1h' | '4h' | '1d' = '1h',
    options?: { limit?: number; startTime?: number; endTime?: number }
  ) {
    try {
      await this.initialize();
      const klines = await this.sdk.markets.getKLines(conditionId, interval, options);
      return klines;
    } catch (error) {
      logger.debug(`Failed to get K-lines for ${conditionId}:`, error);
      return null;
    }
  }

  /**
   * Get dual K-lines (YES + NO) with spread analysis
   */
  async getDualKLines(
    conditionId: string,
    interval: '1m' | '5m' | '15m' | '1h' | '4h' | '1d' = '1h'
  ) {
    try {
      await this.initialize();
      const dual = await this.sdk.markets.getDualKLines(conditionId, interval);
      return dual;
    } catch (error) {
      logger.debug(`Failed to get dual K-lines for ${conditionId}:`, error);
      return null;
    }
  }

  /**
   * Get market signals (trending, volume changes, etc.)
   */
  async getMarketSignals(conditionId: string) {
    try {
      await this.initialize();
      const signals = await this.sdk.markets.detectMarketSignals(conditionId);
      return signals;
    } catch (error) {
      logger.debug(`Failed to get market signals for ${conditionId}:`, error);
      return null;
    }
  }

  /**
   * Cleanup SDK resources
   */
  async stop(): Promise<void> {
    if (this.sdkInitialized) {
      try {
        this.sdk.stop();
        this.sdkInitialized = false;
        logger.info('Enhanced Market Data Service stopped');
      } catch (error) {
        logger.warn('Error stopping enhanced market data service:', error);
      }
    }
  }
}

export default EnhancedMarketDataService;
