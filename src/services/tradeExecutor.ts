import { ClobClient, OrderType, Side } from "@polymarket/clob-client";
import { TradeSignal, TradeExecution, TradeHistory } from "../interfaces";
import { TradeHistoryModel } from "../models/tradeHistory";
import { ENV } from "../config/env";
import logger from "../utils/logger";
import { parseFillFromResponse, computeFee } from "../utils/orderFill";
import { validateLiveOrder, liveRiskManager } from "./tradeValidation";

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

    // Shared pre-trade validation: risk limits, price staleness, market-start.
    // Fails CLOSED on errors in live mode (see ENV.FAIL_CLOSED_ON_VALIDATION_ERROR).
    const validation = await validateLiveOrder(signal, "LIVE");
    if (!validation.allowed) {
      execution.status = "failed";
      execution.error = validation.reason || "Rejected by pre-trade validation";
      execution.rejectedPreTrade = true;
      return execution;
    }

    try {
      const side = signal.side === "BUY" ? Side.BUY : Side.SELL;

      // Create the order (fee rate centralized in ENV.FEE_RATE_BPS).
      const order = await this.clobClient.createOrder({
        tokenID: signal.tokenId,
        price: signal.price,
        size: signal.size,
        side,
        feeRateBps: ENV.FEE_RATE_BPS,
      });

      // Post the order with FOK (Fill-or-Kill)
      const response = await this.clobClient.postOrder(order, OrderType.FOK);

      if (response.success) {
        // Read back the ACTUAL fill - FOK can fill at a better price than requested.
        const fill = parseFillFromResponse(response, signal.side, signal.price, signal.size);
        if (!fill.fromResponse) {
          logger.warn(
            `[LIVE] Could not parse actual fill from response; booking at signal price $${signal.price}. Live PnL may be approximate.`
          );
        }
        execution.status = "filled";
        execution.executedPrice = fill.price;
        execution.executedSize = fill.size;
        execution.fees = computeFee(fill.price * fill.size, ENV.FEE_RATE_BPS);
        execution.transactionHash = response.transactionHash;

        // Track exposure for the risk manager.
        liveRiskManager.recordFill(
          (signal.side === "BUY" ? 1 : -1) * fill.price * fill.size
        );

        // Save to database
        await this.saveTradeHistory(signal, execution);

        logger.trade(
          signal.side,
          `${fill.size} @ $${fill.price.toFixed(4)} | Strategy: ${signal.strategyName}`
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

      // Don't retry orders blocked by a pre-trade check - re-sending won't help
      // and, for fast short-window markets, a delayed retry risks a much worse fill.
      // executeOrder re-runs validation (incl. price-staleness) on every attempt,
      // so a stale-price retry will be rejected here.
      if (lastExecution.rejectedPreTrade) {
        logger.warn(`Aborting retries - pre-trade rejection: ${lastExecution.error}`);
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
