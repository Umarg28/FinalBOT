/**
 * Enhanced Trade Executor using @catalyst-team/poly-sdk TradingService
 * 
 * Provides:
 * - GTC (Good Till Cancelled) orders
 * - GTD (Good Till Date) orders
 * - Better error handling
 * - Rate limiting
 * - Order management (cancel, query open orders)
 * - Rewards tracking for market making
 */

import { TradeExecutor } from './tradeExecutor';
import { TradeSignal, TradeExecution } from '../interfaces';
import { ENV } from '../config/env';
import logger from '../utils/logger';
import { parseFillFromResponse, computeFee } from '../utils/orderFill';
import { validateLiveOrder, liveRiskManager } from './tradeValidation';
import type { PolySdk } from './sdkTypes';

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
      logger.warn('poly-sdk not available for trading, enhanced features will be disabled:', error instanceof Error ? error.message : error);
      return false;
    }
  })();

  return polySdkLoadPromise;
}

// Type definitions
import type { SdkOrderResult } from './sdkTypes';
type OrderResult = SdkOrderResult;

export class EnhancedTradeExecutor extends TradeExecutor {
  private sdk: PolySdk | null = null; // PolymarketSDK (loaded dynamically)
  private sdkInitialized: boolean = false;
  private privateKey: string | null = null;

  constructor(clobClient: any) {
    super(clobClient);
    
    // Only initialize if we have private key (live mode)
    if (!ENV.PAPER_MODE && ENV.PRIVATE_KEY) {
      this.privateKey = ENV.PRIVATE_KEY;
    }
  }

  /**
   * Initialize the SDK with authentication
   */
  async initialize(): Promise<void> {
    if (this.sdkInitialized || ENV.PAPER_MODE || !this.privateKey) {
      return;
    }

    // Load poly-sdk module
    const loaded = await loadPolySdk();
    if (!loaded || !polySdkModule || !polySdkModule.PolymarketSDK) {
      logger.warn('poly-sdk not available, falling back to basic executor');
      return;
    }

    try {
      // Use static factory method for easy initialization
      this.sdk = await polySdkModule.PolymarketSDK.create({
        privateKey: this.privateKey,
        chainId: 137, // Polygon
      });
      
      this.sdkInitialized = true;
      logger.success('Enhanced Trade Executor initialized with poly-sdk');
    } catch (error) {
      logger.error('Failed to initialize enhanced trade executor:', error);
      // Fallback to basic implementation
      this.sdkInitialized = false;
    }
  }

  /**
   * Execute order with enhanced order types
   * Supports GTC, GTD, FOK, FAK order types
   */
  async executeOrder(signal: TradeSignal): Promise<TradeExecution> {
    // In paper mode, use basic executor
    if (ENV.PAPER_MODE) {
      return super.executeOrder(signal);
    }

    // If SDK not initialized, try to initialize
    if (!this.sdkInitialized) {
      try {
        await this.initialize();
      } catch (error) {
        // Fallback to basic executor if SDK init fails
        logger.warn('Falling back to basic trade executor');
        return super.executeOrder(signal);
      }
    }

    if (!this.sdk) {
      return super.executeOrder(signal);
    }

    const execution: TradeExecution = {
      id: `exec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      signal,
      executedPrice: 0,
      executedSize: 0,
      fees: 0,
      status: 'pending',
      paperTrade: false,
      timestamp: new Date(),
    };

    // Shared pre-trade validation: risk limits, price staleness, market-start.
    // Fails CLOSED on errors in live mode (see ENV.FAIL_CLOSED_ON_VALIDATION_ERROR).
    const validation = await validateLiveOrder(signal, "ENHANCED-LIVE");
    if (!validation.allowed) {
      execution.status = "failed";
      execution.error = validation.reason || "Rejected by pre-trade validation";
      execution.rejectedPreTrade = true;
      return execution;
    }

    try {
      // Get order type from signal metadata or default to FOK
      const orderType = (signal.metadata?.orderType as 'GTC' | 'GTD' | 'FOK' | 'FAK') || 'FOK';
      const expiration = signal.metadata?.expiration as number | undefined;

      let orderResult: OrderResult;

      if (orderType === 'GTC' || orderType === 'GTD') {
        // Limit order
        if (orderType === 'GTD' && !expiration) {
          throw new Error('GTD order requires expiration timestamp');
        }

        orderResult = await this.sdk.tradingService.createLimitOrder({
          tokenId: signal.tokenId,
          side: signal.side === 'BUY' ? 'BUY' : 'SELL',
          price: signal.price,
          size: signal.size,
          orderType,
          expiration: orderType === 'GTD' ? expiration : undefined,
        });
      } else {
        // Market order (FOK or FAK)
        orderResult = await this.sdk.tradingService.createMarketOrder({
          tokenId: signal.tokenId,
          side: signal.side === 'BUY' ? 'BUY' : 'SELL',
          amount: signal.side === 'BUY' ? signal.size * signal.price : signal.size,
          orderType,
        });
      }

      if (orderResult.success) {
        // Read back the ACTUAL fill - market orders can fill at a better price.
        const fill = parseFillFromResponse(orderResult, signal.side, signal.price, signal.size);
        if (!fill.fromResponse) {
          logger.warn(
            `[ENHANCED-LIVE] Could not parse actual fill from response; booking at signal price $${signal.price}. Live PnL may be approximate.`
          );
        }
        execution.status = 'filled';
        execution.executedPrice = fill.price;
        execution.executedSize = fill.size;
        execution.fees = computeFee(fill.price * fill.size, ENV.FEE_RATE_BPS);
        execution.transactionHash = (orderResult.transactionHashes && orderResult.transactionHashes[0]) || '';

        // Track exposure for the risk manager.
        liveRiskManager.recordFill(
          (signal.side === 'BUY' ? 1 : -1) * fill.price * fill.size
        );

        // Save to database (access protected method via super or duplicate logic)
        try {
          const dbModule = await import("../config/db");
          if (dbModule.isDBConnected && dbModule.isDBConnected()) {
            const { TradeHistoryModel } = await import("../models/tradeHistory");
            type TradeHistory = import("../interfaces").TradeHistory;
            
            const history: TradeHistory = {
              marketId: signal.marketId,
              conditionId: signal.conditionId,
              tokenId: signal.tokenId,
              side: signal.side,
              price: execution.executedPrice,
              size: execution.executedSize,
              usdcSize: execution.executedPrice * execution.executedSize,
              fees: execution.fees,
              strategyName: signal.strategyName,
              paperTrade: false,
              timestamp: execution.timestamp,
              transactionHash: execution.transactionHash,
            };

            await TradeHistoryModel.create(history);
          }
        } catch (dbError) {
          logger.error("Failed to save trade history:", dbError);
        }

        logger.trade(
          signal.side,
          `${execution.executedSize.toFixed(2)} @ $${execution.executedPrice.toFixed(4)} | Type: ${orderType} | Strategy: ${signal.strategyName}`
        );
      } else {
        execution.status = 'failed';
        execution.error = (orderResult as any).error || orderResult.errorMsg || 'Order failed';
        logger.error(`Order failed: ${execution.error}`);
      }
    } catch (error) {
      execution.status = 'failed';
      execution.error = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Enhanced trade execution error:', error);
      
      // Try fallback to basic executor
      logger.info('Attempting fallback to basic executor...');
      return super.executeOrder(signal);
    }

    return execution;
  }

  /**
   * Get all open orders
   */
  async getOpenOrders() {
    if (!this.sdkInitialized || !this.sdk) {
      logger.warn('Enhanced executor not initialized, cannot get open orders');
      return [];
    }

    try {
      const orders = await this.sdk.tradingService.getOpenOrders();
      return orders;
    } catch (error) {
      logger.error('Failed to get open orders:', error);
      return [];
    }
  }

  /**
   * Cancel a specific order
   */
  async cancelOrder(orderId: string): Promise<boolean> {
    if (!this.sdkInitialized || !this.sdk) {
      logger.warn('Enhanced executor not initialized, cannot cancel order');
      return false;
    }

    try {
      await this.sdk.tradingService.cancelOrder(orderId);
      logger.info(`Order ${orderId} cancelled successfully`);
      return true;
    } catch (error) {
      logger.error(`Failed to cancel order ${orderId}:`, error);
      return false;
    }
  }

  /**
   * Cancel all open orders
   */
  async cancelAllOrders(): Promise<number> {
    if (!this.sdkInitialized || !this.sdk) {
      logger.warn('Enhanced executor not initialized, cannot cancel orders');
      return 0;
    }

    try {
      await this.sdk.tradingService.cancelAllOrders();
      const orders = await this.getOpenOrders();
      logger.info(`Cancelled all orders`);
      return orders.length;
    } catch (error) {
      logger.error('Failed to cancel all orders:', error);
      return 0;
    }
  }

  /**
   * Check if an order is scoring (market making rewards)
   */
  async isOrderScoring(orderId: string): Promise<boolean> {
    if (!this.sdkInitialized || !this.sdk) {
      return false;
    }

    try {
      return await this.sdk.tradingService.isOrderScoring(orderId);
    } catch (error) {
      logger.debug(`Failed to check order scoring for ${orderId}:`, error);
      return false;
    }
  }

  /**
   * Get current rewards (market making incentives)
   */
  async getCurrentRewards() {
    if (!this.sdkInitialized || !this.sdk) {
      return null;
    }

    try {
      return await this.sdk.tradingService.getCurrentRewards();
    } catch (error) {
      logger.debug('Failed to get current rewards:', error);
      return null;
    }
  }

  /**
   * Get earnings for a specific date
   * Note: This method may not be available in all SDK versions
   */
  async getEarnings(date: string) {
    if (!this.sdkInitialized || !this.sdk) {
      return null;
    }

    try {
      // Check if method exists
      if (typeof (this.sdk.tradingService as any).getEarnings === 'function') {
        return await (this.sdk.tradingService as any).getEarnings(date);
      }
      return null;
    } catch (error) {
      logger.debug(`Failed to get earnings for ${date}:`, error);
      return null;
    }
  }

  /**
   * Cleanup SDK resources
   */
  async stop(): Promise<void> {
    if (this.sdkInitialized && this.sdk) {
      try {
        this.sdk.stop();
        this.sdkInitialized = false;
        logger.info('Enhanced Trade Executor stopped');
      } catch (error) {
        logger.warn('Error stopping enhanced trade executor:', error);
      }
    }
  }
}

export default EnhancedTradeExecutor;
