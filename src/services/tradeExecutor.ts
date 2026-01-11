import { ClobClient, OrderType, Side } from "@polymarket/clob-client";
import { TradeSignal, TradeExecution, TradeHistory } from "../interfaces";
import { TradeHistoryModel } from "../models/tradeHistory";
import { ENV } from "../config/env";
import logger from "../utils/logger";

export class TradeExecutor {
  private clobClient: ClobClient;

  constructor(clobClient: ClobClient) {
    this.clobClient = clobClient;
  }

  async executeOrder(signal: TradeSignal): Promise<TradeExecution> {
    const execution: TradeExecution = {
      id: `exec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      signal,
      executedPrice: 0,
      executedSize: 0,
      fees: 0,
      status: "pending",
      paperTrade: ENV.PAPER_MODE,
      timestamp: new Date(),
    };

    if (ENV.PAPER_MODE) {
      logger.warn("Paper mode is enabled - use PaperTrader for paper trades");
      execution.status = "failed";
      execution.error = "Use PaperTrader for paper mode execution";
      return execution;
    }

    // CRITICAL: Validate market has started (not a future event)
    // Markets must match live ET time - do not trade on future events
    try {
      const priceStreamLogger = (await import("./priceStreamLogger")).default;
      const currentMarkets = priceStreamLogger.getCurrentMarkets();
      
      // Find the market for this token
      let marketInfo = null;
      for (const market of currentMarkets.values()) {
        if (market.tokens.some(t => t.token_id === signal.tokenId)) {
          marketInfo = market;
          break;
        }
      }

      if (marketInfo) {
        // Check if market has started (start_time_iso <= now)
        const startTime = new Date(marketInfo.start_time_iso).getTime();
        const now = Date.now();
        const timeUntilStart = startTime - now;

        if (timeUntilStart > 0) {
          // Market hasn't started yet (future event) - reject trade
          execution.status = "failed";
          execution.error = `Market has not started yet. Starts in ${Math.round(timeUntilStart / 1000)}s (${new Date(startTime).toLocaleString('en-US', { timeZone: 'America/New_York' })} ET)`;
          logger.warn(`[LIVE] Trade rejected - future market: ${marketInfo.question} (${marketInfo.slug}) - starts at ${new Date(startTime).toLocaleString('en-US', { timeZone: 'America/New_York' })} ET`);
          return execution;
        }

        logger.debug(`[LIVE] Market validation passed - market has started: ${marketInfo.question} (start: ${new Date(startTime).toLocaleString('en-US', { timeZone: 'America/New_York' })} ET)`);
      } else {
        logger.warn(`[LIVE] Could not find market info for token ${signal.tokenId} - allowing trade (market may not be in current markets list)`);
      }
    } catch (error) {
      logger.error(`[LIVE] Error validating market start time:`, error);
      // Allow trade to proceed if validation fails (fail open for safety)
    }

    try {
      const side = signal.side === "BUY" ? Side.BUY : Side.SELL;

      // Create the order
      const order = await this.clobClient.createOrder({
        tokenID: signal.tokenId,
        price: signal.price,
        size: signal.size,
        side,
        feeRateBps: 0,
      });

      // Post the order with FOK (Fill-or-Kill)
      const response = await this.clobClient.postOrder(order, OrderType.FOK);

      if (response.success) {
        execution.status = "filled";
        execution.executedPrice = signal.price;
        execution.executedSize = signal.size;
        execution.transactionHash = response.transactionHash;

        // Save to database
        await this.saveTradeHistory(signal, execution);

        logger.trade(
          signal.side,
          `${signal.size} @ $${signal.price} | Strategy: ${signal.strategyName}`
        );
      } else {
        execution.status = "failed";
        execution.error = response.errorMsg || "Order failed";
        logger.error(`Order failed: ${execution.error}`);
      }
    } catch (error) {
      execution.status = "failed";
      execution.error = error instanceof Error ? error.message : "Unknown error";
      logger.error("Trade execution error:", error);
    }

    return execution;
  }

  async executeWithRetry(
    signal: TradeSignal,
    maxRetries: number = ENV.RETRY_LIMIT
  ): Promise<TradeExecution> {
    let lastExecution: TradeExecution | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      logger.info(`Executing order (attempt ${attempt}/${maxRetries})`);
      lastExecution = await this.executeOrder(signal);

      if (lastExecution.status === "filled") {
        return lastExecution;
      }

      if (attempt < maxRetries) {
        await this.sleep(1000 * attempt); // Exponential backoff
      }
    }

    return lastExecution!;
  }

  private async saveTradeHistory(
    signal: TradeSignal,
    execution: TradeExecution
  ): Promise<void> {
    try {
      const dbModule = await import("../config/db");
      if (!dbModule.isDBConnected || !dbModule.isDBConnected()) {
        logger.debug("Database not connected - skipping trade history save");
        return;
      }

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
        paperTrade: execution.paperTrade,
        timestamp: execution.timestamp,
        transactionHash: execution.transactionHash,
      };

      await TradeHistoryModel.create(history);
    } catch (error) {
      logger.error("Failed to save trade history:", error);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export default TradeExecutor;
