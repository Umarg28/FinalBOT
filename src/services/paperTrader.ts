import {
  TradeSignal,
  TradeExecution,
  TradeHistory,
  Position,
  PaperAccount
} from "../interfaces";
import { TradeHistoryModel } from "../models/tradeHistory";
import { ENV } from "../config/env";
import logger from "../utils/logger";
import { MarketDataService } from "./marketData";
import { getRunId } from "../utils/runId";
import { PnLCalculator, PortfolioPnL } from "../utils/pnlCalculator";
import { CSVExporter } from "../utils/csvExporter";
import * as fs from "fs";
import * as path from "path";

export class PaperTrader {
  private account: PaperAccount;
  private marketData: MarketDataService;
  private csvFilePath: string;
  private profitCsvPath: string;
  private csvInitialized: boolean = false;
  private profitCsvInitialized: boolean = false;
  private csvExporter: CSVExporter;

  constructor(marketData: MarketDataService, startingBalance?: number) {
    this.marketData = marketData;
    this.account = {
      balance: startingBalance || ENV.PAPER_BALANCE,
      positions: new Map<string, Position>(),
      tradeHistory: [],
      startingBalance: startingBalance || ENV.PAPER_BALANCE,
      createdAt: new Date(),
    };

    // Initialize CSV file for paper trades
    const logsDir = path.join(process.cwd(), "logs");
    const paperDir = path.join(logsDir, "paper");
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    if (!fs.existsSync(paperDir)) {
      fs.mkdirSync(paperDir, { recursive: true });
    }
    const runId = getRunId();
    this.csvFilePath = path.join(paperDir, `Paper Trades_${runId}.csv`);
    this.profitCsvPath = path.join(paperDir, `PROFITS_${runId}.csv`);
    this.csvExporter = new CSVExporter(paperDir);
    this.initializeCsv();
    this.initializeProfitCsv();

    logger.paper(`Paper account initialized with $${this.account.balance} USDC`);
  }

  private initializeCsv(): void {
    try {
      const headers = [
        "Timestamp",
        "Date",
        "Time",
        "Trade ID",
        "Side",
        "Market",
        "Outcome",
        "Condition ID",
        "Token ID",
        "Size",
        "Price",
        "USDC Value",
        "Balance After",
        "Strategy",
        "Status",
        // PnL Calculation Details
        "Position Size Before",
        "Position Size After",
        "Avg Price Before",
        "Avg Price After",
        "Cost Basis",
        "Current Value",
        "Realized PnL",
        "PnL Calculation",
      ].join(",");
      fs.writeFileSync(this.csvFilePath, headers + "\n", "utf8");
      this.csvInitialized = true;
      logger.info(`Paper trades CSV initialized: ${this.csvFilePath}`);
    } catch (error) {
      logger.error(`Failed to initialize paper trades CSV: ${error}`);
    }
  }

  private initializeProfitCsv(): void {
    try {
      // Enhanced headers with PnL calculation details
      const headers = [
        "Market Name",
        "Time",
        "Total PnL",
        "PnL %",
        "Shares Up",
        "Shares Down",
        "Price Up",
        "Price Down",
        "Total Cost Basis",
        "Total Current Value",
        "Realized PnL",
        "Unrealized PnL",
        "PnL Calculation",
      ].join(",");
      fs.writeFileSync(this.profitCsvPath, headers + "\n", "utf8");
      this.profitCsvInitialized = true;
      logger.info(`Profit summary CSV initialized: ${this.profitCsvPath}`);
    } catch (error) {
      logger.error(`Failed to initialize profit CSV: ${error}`);
    }
  }

  private loggedMarkets: Set<string> = new Set(); // Track markets already logged to prevent duplicates

  /**
   * Log total PNL for a market when it completes
   * This logs a single row per market with total PNL across all positions
   * Uses full market name and prevents duplicate logging
   */
  logMarketCompletionPnL(marketName: string, conditionId: string, finalPriceUp?: number, finalPriceDown?: number): void {
    if (!this.profitCsvInitialized) return;

    // Prevent duplicate logging for the same market
    if (this.loggedMarkets.has(conditionId)) {
      return;
    }

    try {
      // Find all positions in this market
      const marketPositions = this.getAllPositions().filter(
        p => p.conditionId === conditionId
      );

      if (marketPositions.length === 0) {
        return; // No positions in this market
      }

      // Calculate total PNL for all positions in this market
      let totalPnl = 0;
      for (const position of marketPositions) {
        // Determine final price based on outcome
        let finalPrice = 0;
        if (position.outcome?.toLowerCase() === 'up' && finalPriceUp !== undefined) {
          finalPrice = finalPriceUp;
        } else if (position.outcome?.toLowerCase() === 'down' && finalPriceDown !== undefined) {
          finalPrice = finalPriceDown;
        } else {
          // Fallback to current price or avg price
          finalPrice = position.currentPrice || position.avgPrice;
        }

        const invested = position.size * position.avgPrice;
        const finalValue = position.size * finalPrice;
        const profitLoss = finalValue - invested;
        totalPnl += profitLoss;
      }

      const now = new Date();
      const time = now.toLocaleTimeString("en-US", { 
        hour12: true, 
        hour: "2-digit", 
        minute: "2-digit",
        second: "2-digit"
      });

      // Use full market name (no shortening)
      const fullMarketName = marketName.trim();

      // Simple row: Market Name, Time, PnL (easy to read)
      const row = [
        `"${fullMarketName}"`,
        time,
        `${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`,
      ].join(",");

      fs.appendFileSync(this.profitCsvPath, row + "\n", "utf8");
      
      // Mark this market as logged to prevent duplicates
      this.loggedMarkets.add(conditionId);
      
      logger.info(`📊 Market completion logged: ${fullMarketName} - PnL: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`);
    } catch (error) {
      logger.error(`Failed to write market completion PNL to CSV: ${error}`);
    }
  }

  /**
   * Log market PnL from dashboard data (captures exactly what dashboard shows)
   * Called 5 seconds before market ends
   * Now uses enhanced PnL calculator and CSV exporter
   */
  logMarketPnLFromDashboard(
    marketName: string,
    conditionId: string,
    totalPnl: number,
    pnlPercent: number,
    sharesUp: number,
    sharesDown: number,
    priceUp: number,
    priceDown: number
  ): void {
    if (!this.profitCsvInitialized) return;

    // Prevent duplicate logging for the same market
    if (this.loggedMarkets.has(conditionId)) {
      return;
    }

    // Skip if no shares traded in this market
    if (sharesUp === 0 && sharesDown === 0) {
      return;
    }

    try {
      // Use enhanced PnL calculator for accurate calculation
      const marketPositions = this.getAllPositions().filter(p => p.conditionId === conditionId);
      if (marketPositions.length === 0) {
        return;
      }

      // Build current prices map
      const currentPrices = new Map<string, number>();
      for (const pos of marketPositions) {
        if (pos.outcome?.toLowerCase() === 'up' || pos.outcome?.toLowerCase() === 'yes') {
          currentPrices.set(pos.tokenId, priceUp);
        } else if (pos.outcome?.toLowerCase() === 'down' || pos.outcome?.toLowerCase() === 'no') {
          currentPrices.set(pos.tokenId, priceDown);
        }
      }

      // Calculate market PnL using enhanced calculator
      const marketPnL = PnLCalculator.calculateMarketPnL(
        marketPositions,
        this.account.tradeHistory.filter(t => 
          marketPositions.some(p => p.tokenId === t.tokenId)
        ),
        conditionId,
        currentPrices
      );

      if (marketPnL) {
        // Export using enhanced CSV exporter
        this.csvExporter.exportMarketPnLSnapshot(
          marketPnL,
          { priceUp, priceDown },
          `PROFITS_${getRunId()}.csv`,
          { append: true, includeHeaders: !this.loggedMarkets.has('headers_written') }
        ).catch(err => logger.error(`Failed to export market PnL: ${err}`));

        // Also write simple row to legacy format for backward compatibility
        const now = new Date();
        const time = now.toLocaleTimeString("en-US", {
          hour12: true,
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit"
        });

        // Enhanced PnL row with calculation details
        const row = [
          `"${marketName.trim()}"`,
          time,
          `${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`,
          `${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%`,
          sharesUp.toFixed(4),
          sharesDown.toFixed(4),
          priceUp.toFixed(6),
          priceDown.toFixed(6),
          marketPnL.totalCostBasis.toFixed(4),
          marketPnL.totalCurrentValue.toFixed(4),
          marketPnL.totalRealizedPnL.toFixed(4),
          marketPnL.totalUnrealizedPnL.toFixed(4),
          `"CostBasis=${marketPnL.totalCostBasis.toFixed(4)}, CurrentValue=${marketPnL.totalCurrentValue.toFixed(4)}, Realized=${marketPnL.totalRealizedPnL.toFixed(4)}, Unrealized=${marketPnL.totalUnrealizedPnL.toFixed(4)}"`,
        ].join(",");

        fs.appendFileSync(this.profitCsvPath, row + "\n", "utf8");

        // Mark this market as logged to prevent duplicates
        this.loggedMarkets.add(conditionId);
        if (!this.loggedMarkets.has('headers_written')) {
          this.loggedMarkets.add('headers_written');
        }

        logger.paper(`📊 Dashboard PnL captured: ${marketName} - ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)} (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}%)`);
      }
    } catch (error) {
      logger.error(`Failed to write dashboard PNL to CSV: ${error}`);
    }
  }

  /**
   * Settle a market - return position value to balance and remove positions
   * This should be called when a market closes to free up capital
   *
   * @param conditionId - The market condition ID to settle
   * @param finalPriceUp - Final price for UP outcome (1.0 if UP won, 0.0 if DOWN won, or mid if not resolved)
   * @param finalPriceDown - Final price for DOWN outcome
   */
  settleMarket(conditionId: string, finalPriceUp: number, finalPriceDown: number): void {
    const positionsToSettle: Position[] = [];

    // Find all positions in this market
    for (const [tokenId, position] of this.account.positions.entries()) {
      if (position.conditionId === conditionId) {
        positionsToSettle.push(position);
      }
    }

    if (positionsToSettle.length === 0) {
      return; // No positions to settle
    }

    let totalPayout = 0;

    for (const position of positionsToSettle) {
      // Determine payout based on outcome
      let finalPrice: number;
      if (position.outcome?.toLowerCase() === 'up') {
        finalPrice = finalPriceUp;
      } else if (position.outcome?.toLowerCase() === 'down') {
        finalPrice = finalPriceDown;
      } else {
        // Fallback - shouldn't happen
        finalPrice = position.avgPrice;
      }

      // Calculate payout: shares * final price
      const payout = position.size * finalPrice;
      totalPayout += payout;

      // Remove position from map
      this.account.positions.delete(position.tokenId);

      logger.paper(`Settled ${position.outcome} position: ${position.size.toFixed(2)} shares @ $${finalPrice.toFixed(4)} = $${payout.toFixed(2)} payout`);
    }

    // Add payout to balance
    this.account.balance += totalPayout;

    // Reset balance to starting balance after market settlement
    const previousBalance = this.account.balance;
    this.account.balance = this.account.startingBalance;

    logger.paper(`Market settled: ${positionsToSettle.length} positions, total payout: $${totalPayout.toFixed(2)}, previous balance: $${previousBalance.toFixed(2)}, reset to: $${this.account.balance.toFixed(2)}`);
  }

  /**
   * Check and reset balance if it's too low (for continuous trading)
   * This allows trading to continue even if balance is depleted before market close
   */
  checkAndResetBalanceIfLow(): void {
    const minBalanceThreshold = this.account.startingBalance * 0.01; // 1% of starting balance
    
    if (this.account.balance < minBalanceThreshold) {
      const previousBalance = this.account.balance;
      this.account.balance = this.account.startingBalance;
      logger.paper(`⚠️  Balance too low ($${previousBalance.toFixed(2)}), resetting to starting balance: $${this.account.balance.toFixed(2)}`);
      logger.info(`Balance reset: $${previousBalance.toFixed(2)} → $${this.account.balance.toFixed(2)}`);
    }
  }

  /**
   * Reset balance to starting balance when a new market window starts
   * This ensures each market window starts with a fresh balance
   * First settles all open positions at current market prices
   */
  async resetBalanceForNewMarket(): Promise<void> {
    const previousBalance = this.account.balance;
    let totalPositionValue = 0;
    const positionsToSettle: Position[] = [];

    // Collect all open positions and calculate their current value
    for (const [tokenId, position] of this.account.positions.entries()) {
      try {
        const currentPrice = await this.marketData.getMidPrice(tokenId);
        if (currentPrice !== null) {
          const positionValue = currentPrice * position.size;
          totalPositionValue += positionValue;
          positionsToSettle.push(position);
          
          logger.paper(`Settling position for new market: ${position.outcome} ${position.size.toFixed(2)} shares @ $${currentPrice.toFixed(4)} = $${positionValue.toFixed(2)}`);
        } else {
          // If we can't get current price, use average price as fallback
          const fallbackValue = position.avgPrice * position.size;
          totalPositionValue += fallbackValue;
          positionsToSettle.push(position);
          logger.paper(`Settling position (no current price): ${position.outcome} ${position.size.toFixed(2)} shares @ $${position.avgPrice.toFixed(4)} = $${fallbackValue.toFixed(2)}`);
        }
      } catch (error) {
        // If price fetch fails, use average price as fallback
        const fallbackValue = position.avgPrice * position.size;
        totalPositionValue += fallbackValue;
        positionsToSettle.push(position);
        logger.paper(`Settling position (error fetching price): ${position.outcome} ${position.size.toFixed(2)} shares @ $${position.avgPrice.toFixed(4)} = $${fallbackValue.toFixed(2)}`);
      }
    }

    // Remove all settled positions
    for (const position of positionsToSettle) {
      this.account.positions.delete(position.tokenId);
    }

    // Add position values to balance
    const balanceAfterSettlement = previousBalance + totalPositionValue;
    
    // Reset balance to starting balance
    this.account.balance = this.account.startingBalance;
    
    logger.paper(`🔄 New market window detected - settled ${positionsToSettle.length} position(s) worth $${totalPositionValue.toFixed(2)}, balance: $${previousBalance.toFixed(2)} → $${balanceAfterSettlement.toFixed(2)} → $${this.account.balance.toFixed(2)}`);
    logger.info(`Balance reset for new market: settled $${totalPositionValue.toFixed(2)} in positions, balance reset from $${balanceAfterSettlement.toFixed(2)} to $${this.account.balance.toFixed(2)}`);
  }

  /**
   * Log a realized profit/loss to the PROFITS CSV
   * Called when a position is closed or market ends
   * @deprecated Use logMarketCompletionPnL for market completion logging
   */
  logProfit(
    marketName: string,
    side: string,
    shares: number,
    avgCost: number,
    finalPrice: number
  ): void {
    if (!this.profitCsvInitialized) return;

    try {
      const now = new Date();
      const time = now.toLocaleTimeString("en-US", { hour12: true, hour: "2-digit", minute: "2-digit" });
      const invested = shares * avgCost;
      const finalValue = shares * finalPrice;
      const profitLoss = finalValue - invested;

      // Clean market name (remove dates, keep short)
      const shortMarket = marketName
        .replace(/- January \d+.*$/i, "")
        .replace(/Bitcoin Up or Down/i, "BTC")
        .replace(/Ethereum Up or Down/i, "ETH")
        .trim();

      // Simple row: Time, Market, PnL
      const row = [
        time,
        shortMarket,
        `${profitLoss >= 0 ? '+' : ''}$${profitLoss.toFixed(2)}`,
      ].join(",");

      fs.appendFileSync(this.profitCsvPath, row + "\n", "utf8");
    } catch (error) {
      logger.error(`Failed to write profit to CSV: ${error}`);
    }
  }

  /**
   * Log all current positions' unrealized P&L to the PROFITS CSV
   * Call this periodically or when you want a snapshot
   */
  async logCurrentProfits(): Promise<void> {
    for (const position of this.account.positions.values()) {
      const currentPrice = await this.marketData.getMidPrice(position.tokenId);
      if (currentPrice && position.size > 0) {
        this.logProfit(
          position.title || "Unknown",
          position.outcome || "Unknown",
          position.size,
          position.avgPrice,
          currentPrice
        );
      }
    }

    // Add summary row
    this.logProfitSummary();
  }

  /**
   * Add a summary row to the PROFITS CSV
   */
  private logProfitSummary(): void {
    if (!this.profitCsvInitialized) return;

    try {
      const stats = this.getStats();
      const now = new Date();
      const time = now.toLocaleTimeString("en-US", { hour12: true, hour: "2-digit", minute: "2-digit" });

      // Simple summary row: Time, TOTAL, PnL
      const row = [
        time,
        "TOTAL",
        `${stats.totalPnL >= 0 ? '+' : ''}$${stats.totalPnL.toFixed(2)}`,
      ].join(",");

      fs.appendFileSync(this.profitCsvPath, row + "\n", "utf8");
    } catch (error) {
      logger.error(`Failed to write profit summary: ${error}`);
    }
  }

  private writeTradeToCsv(execution: TradeExecution, signal: TradeSignal): void {
    if (!this.csvInitialized) return;

    try {
      const timestamp = execution.timestamp.toISOString();
      const date = execution.timestamp.toLocaleDateString("en-US");
      const time = execution.timestamp.toLocaleTimeString("en-US");
      const market = (signal.metadata?.title as string) || "Unknown";
      const outcome = (signal.metadata?.outcome as string) || "Unknown";

      // Get position details for PnL calculation logging
      // Use positionBefore stored in execution (captured before position update)
      const positionBefore = (execution as any).positionBefore || { size: 0, avgPrice: 0 };
      const positionAfter = this.account.positions.get(signal.tokenId);
      
      // Position state
      const positionSizeBefore = positionBefore.size || 0;
      const avgPriceBefore = positionBefore.avgPrice || 0;
      const positionSizeAfter = positionAfter ? positionAfter.size : 0;
      const avgPriceAfter = positionAfter ? positionAfter.avgPrice : 0;

      // Calculate PnL details
      let realizedPnl = 0;
      let costBasis = 0;
      let currentValue = 0;
      let pnlCalculation = "";

      if (signal.side === "BUY") {
        // BUY trade details
        costBasis = execution.executedSize * execution.executedPrice;
        currentValue = costBasis; // Same as cost for new position
        pnlCalculation = `BUY: costBasis=${costBasis.toFixed(4)} (${execution.executedSize.toFixed(4)}*${execution.executedPrice.toFixed(6)})`;
        
        if (positionSizeBefore > 0) {
          const oldCostBasis = positionSizeBefore * avgPriceBefore;
          const newCostBasis = costBasis;
          const totalCostBasis = oldCostBasis + newCostBasis;
          pnlCalculation += `, weightedAvg=(${oldCostBasis.toFixed(4)}+${newCostBasis.toFixed(4)})/${positionSizeAfter.toFixed(4)}=${avgPriceAfter.toFixed(6)}`;
        } else {
          pnlCalculation += `, newPosition avgPrice=${avgPriceAfter.toFixed(6)}`;
        }
      } else {
        // SELL trade details
        costBasis = execution.executedSize * avgPriceBefore; // Cost basis of sold shares
        currentValue = execution.executedSize * execution.executedPrice; // Proceeds from sale
        realizedPnl = currentValue - costBasis;
        pnlCalculation = `SELL: costBasis=${costBasis.toFixed(4)} (${execution.executedSize.toFixed(4)}*${avgPriceBefore.toFixed(6)}), proceeds=${currentValue.toFixed(4)} (${execution.executedSize.toFixed(4)}*${execution.executedPrice.toFixed(6)}), realizedPnl=${realizedPnl.toFixed(4)} (${currentValue.toFixed(4)}-${costBasis.toFixed(4)})`;
      }

      const row = [
        timestamp,
        date,
        time,
        execution.id,
        signal.side,
        `"${market.replace(/"/g, '""')}"`,
        outcome,
        signal.conditionId,
        signal.tokenId,
        execution.executedSize.toFixed(4),
        execution.executedPrice.toFixed(6),
        (execution.executedSize * execution.executedPrice).toFixed(4),
        this.account.balance.toFixed(2),
        signal.strategyName,
        execution.status,
        // PnL Calculation Details
        positionSizeBefore.toFixed(4),
        positionSizeAfter.toFixed(4),
        avgPriceBefore.toFixed(6),
        avgPriceAfter.toFixed(6),
        costBasis.toFixed(4),
        currentValue.toFixed(4),
        realizedPnl.toFixed(4),
        `"${pnlCalculation}"`,
      ].join(",");

      fs.appendFileSync(this.csvFilePath, row + "\n", "utf8");
    } catch (error) {
      logger.error(`Failed to write paper trade to CSV: ${error}`);
    }
  }

  async executeOrder(signal: TradeSignal): Promise<TradeExecution> {
    const execution: TradeExecution = {
      id: `paper_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      signal,
      executedPrice: 0,
      executedSize: 0,
      fees: 0,
      status: "pending",
      paperTrade: true,
      timestamp: new Date(),
    };

    logger.debug(`Executing paper order: ${signal.side} ${signal.size.toFixed(2)} @ $${signal.price.toFixed(4)} for ${signal.tokenId}`);

    try {
      // Get current market price for realistic execution
      const currentPrice = await this.marketData.getPrice(signal.tokenId, signal.side);
      const executePrice = currentPrice || signal.price;

      // Simulate slippage (0.1% - 0.5%)
      const slippage = 1 + (Math.random() * 0.004 + 0.001) * (signal.side === "BUY" ? 1 : -1);
      const finalPrice = executePrice * slippage;

      const cost = finalPrice * signal.size;
      // Fees removed - no fee simulation

      if (signal.side === "BUY") {
        // Check if we have enough balance
        if (this.account.balance < cost) {
          execution.status = "failed";
          execution.error = `Insufficient balance. Need $${cost.toFixed(2)}, have $${this.account.balance.toFixed(2)}`;
          logger.paper(`Order failed: ${execution.error}`);
          return execution;
        }

        // Deduct from balance (no fees)
        this.account.balance -= cost;

        // Update or create position
        const existingPosition = this.account.positions.get(signal.tokenId);
        if (existingPosition) {
          const totalSize = existingPosition.size + signal.size;
          const avgPrice =
            (existingPosition.avgPrice * existingPosition.size +
              finalPrice * signal.size) /
            totalSize;
          existingPosition.size = totalSize;
          existingPosition.avgPrice = avgPrice;
          existingPosition.timestamp = new Date();
        } else {
          const newPosition: Position = {
            conditionId: signal.conditionId,
            tokenId: signal.tokenId,
            title: signal.metadata?.title as string || "Unknown",
            outcome: signal.metadata?.outcome as string || "Unknown",
            size: signal.size,
            avgPrice: finalPrice,
            timestamp: new Date(),
          };
          this.account.positions.set(signal.tokenId, newPosition);
        }
      } else {
        // SELL
        const existingPosition = this.account.positions.get(signal.tokenId);
        if (!existingPosition || existingPosition.size < signal.size) {
          execution.status = "failed";
          execution.error = `Insufficient position. Trying to sell ${signal.size}, have ${existingPosition?.size || 0}`;
          logger.paper(`Order failed: ${execution.error}`);
          return execution;
        }

        // Add to balance (no fees)
        this.account.balance += cost;

        // Calculate realized PnL (fees excluded to match Polymarket API)
        const realizedPnl = (finalPrice - existingPosition.avgPrice) * signal.size;
        existingPosition.realizedPnl = (existingPosition.realizedPnl || 0) + realizedPnl;

        // Update position
        existingPosition.size -= signal.size;
        if (existingPosition.size <= 0) {
          this.account.positions.delete(signal.tokenId);
        }
      }

      execution.status = "filled";
      execution.executedPrice = finalPrice;
      execution.executedSize = signal.size;
      execution.fees = 0; // Fees removed

      // Capture position state BEFORE updating (for CSV logging)
      const positionBefore = signal.side === "BUY" 
        ? (this.account.positions.get(signal.tokenId) ? { ...this.account.positions.get(signal.tokenId)! } : null)
        : (this.account.positions.get(signal.tokenId) ? { ...this.account.positions.get(signal.tokenId)! } : null);
      
      // Store position before state in execution for CSV logging
      (execution as any).positionBefore = positionBefore ? {
        size: positionBefore.size,
        avgPrice: positionBefore.avgPrice,
      } : { size: 0, avgPrice: 0 };

      // Save to history
      const history: TradeHistory = {
        marketId: signal.marketId,
        conditionId: signal.conditionId,
        tokenId: signal.tokenId,
        side: signal.side,
        price: finalPrice,
        size: signal.size,
        usdcSize: cost,
        fees: 0, // Fees removed
        strategyName: signal.strategyName,
        paperTrade: true,
        timestamp: new Date(),
      };
      this.account.tradeHistory.push(history);

      // Also save to database for persistence (if connected)
      try {
        const dbModule = await import("../config/db");
        if (dbModule.isDBConnected && dbModule.isDBConnected()) {
          await TradeHistoryModel.create(history);
        }
      } catch (error) {
        // Database not available, skip persistence
      }

      logger.paper(
        `${signal.side} ${signal.size} @ $${finalPrice.toFixed(4)} | ` +
        `Balance: $${this.account.balance.toFixed(2)} | ` +
        `Strategy: ${signal.strategyName}`
      );

      // Write to CSV file (position is now updated, but we have positionBefore stored)
      this.writeTradeToCsv(execution, signal);
    } catch (error) {
      execution.status = "failed";
      execution.error = error instanceof Error ? error.message : "Unknown error";
      logger.error(`Paper trade execution error for ${signal.side} ${signal.size} @ $${signal.price}:`, error);
    }

    // Log execution result for debugging
    if (execution.status === "failed") {
      logger.warn(`Paper trade failed: ${execution.error || "Unknown error"}`);
    }

    return execution;
  }

  getBalance(): number {
    return this.account.balance;
  }

  getPosition(tokenId: string): Position | undefined {
    return this.account.positions.get(tokenId);
  }

  getAllPositions(): Position[] {
    return Array.from(this.account.positions.values());
  }

  getTradeHistory(): TradeHistory[] {
    return this.account.tradeHistory;
  }

  async getPortfolioValue(): Promise<number> {
    let positionValue = 0;

    for (const position of this.account.positions.values()) {
      const currentPrice = await this.marketData.getMidPrice(position.tokenId);
      if (currentPrice) {
        position.currentPrice = currentPrice;
        position.currentValue = currentPrice * position.size;
        // PnL calculation excludes fees to match Polymarket API
        position.cashPnl = (currentPrice - position.avgPrice) * position.size;
        position.percentPnl = ((currentPrice - position.avgPrice) / position.avgPrice) * 100;
        positionValue += position.currentValue;
      }
    }

    return this.account.balance + positionValue;
  }

  getTotalPnL(): number {
    // PnL calculation excludes fees to match Polymarket API
    return this.account.balance - this.account.startingBalance +
      this.account.tradeHistory.reduce((sum, t) => sum + (t.side === "SELL" ? t.usdcSize : 0), 0);
  }

  getStats(): {
    balance: number;
    startingBalance: number;
    positionCount: number;
    tradeCount: number;
    winRate: number;
    totalPnL: number;
    weightedPnL: number;
    totalValue: number;
    initialValue: number;
    realizedPnL: number;
    unrealizedPnL: number;
    totalReturn: number;
  } {
    const trades = this.account.tradeHistory;
    const sellTrades = trades.filter((t) => t.side === "SELL");
    const winningTrades = sellTrades.filter((t) => {
      const buyTrade = trades.find(
        (bt) => bt.tokenId === t.tokenId && bt.side === "BUY" && bt.timestamp < t.timestamp
      );
      return buyTrade && t.price > buyTrade.price;
    });

    // Use enhanced PnL calculator
    const positions = Array.from(this.account.positions.values());
    const currentPrices = new Map<string, number>();
    
    // Build current prices map (will be updated when portfolio value is calculated)
    for (const pos of positions) {
      currentPrices.set(pos.tokenId, pos.currentPrice || pos.avgPrice);
    }

    const portfolio = PnLCalculator.calculatePortfolioPnL(
      positions,
      trades,
      currentPrices,
      this.account.startingBalance,
      this.account.balance
    );

    // Calculate weighted P&L (from EDGEBOTPRO) for backward compatibility
    const { weightedPnL, totalValue, initialValue } = this.calculateWeightedPnL();

    return {
      balance: this.account.balance,
      startingBalance: this.account.startingBalance,
      positionCount: this.account.positions.size,
      tradeCount: trades.length,
      winRate: sellTrades.length > 0 ? (winningTrades.length / sellTrades.length) * 100 : 0,
      totalPnL: portfolio.totalPnL,
      weightedPnL,
      totalValue,
      initialValue,
      realizedPnL: portfolio.totalRealizedPnL,
      unrealizedPnL: portfolio.totalUnrealizedPnL,
      totalReturn: portfolio.totalReturn,
    };
  }

  /**
   * Get comprehensive PnL breakdown using enhanced calculator
   */
  async getPnLBreakdown(): Promise<PortfolioPnL | null> {
    try {
      const positions = Array.from(this.account.positions.values());
      
      // Update current prices for all positions
      const currentPrices = new Map<string, number>();
      for (const position of positions) {
        if (!currentPrices.has(position.tokenId)) {
          const price = await this.marketData.getMidPrice(position.tokenId);
          if (price !== null) {
            currentPrices.set(position.tokenId, price);
            position.currentPrice = price;
          } else {
            currentPrices.set(position.tokenId, position.avgPrice);
          }
        }
      }

      return PnLCalculator.calculatePortfolioPnL(
        positions,
        this.account.tradeHistory,
        currentPrices,
        this.account.startingBalance,
        this.account.balance
      );
    } catch (error) {
      logger.error(`Failed to calculate PnL breakdown: ${error}`);
      return null;
    }
  }

  /**
   * Export comprehensive PnL report using enhanced CSV exporter
   */
  async exportPnLReport(): Promise<string | null> {
    try {
      const portfolio = await this.getPnLBreakdown();
      if (!portfolio) {
        return null;
      }

      return await this.csvExporter.exportPnLReport(
        portfolio,
        `PnL_Report_${getRunId()}.csv`
      );
    } catch (error) {
      logger.error(`Failed to export PnL report: ${error}`);
      return null;
    }
  }

  /**
   * Export trade history using enhanced CSV exporter
   */
  async exportTradeHistory(): Promise<string | null> {
    try {
      return await this.csvExporter.exportTradeHistory(
        this.account.tradeHistory,
        `Trade_History_${getRunId()}.csv`
      );
    } catch (error) {
      logger.error(`Failed to export trade history: ${error}`);
      return null;
    }
  }

  /**
   * Calculate weighted portfolio P&L (from EDGEBOTPRO)
   * Weights each position's percentage P&L by its current value
   * This gives a more accurate overall profitability measure where
   * larger positions have proportionally more impact on the result
   */
  calculateWeightedPnL(): { weightedPnL: number; totalValue: number; initialValue: number } {
    let totalValue = 0;
    let initialValue = 0;
    let weightedPnlSum = 0;

    for (const position of this.account.positions.values()) {
      const value = position.currentValue || (position.currentPrice || position.avgPrice) * position.size;
      const initial = position.avgPrice * position.size;
      const pnlPercent = position.percentPnl || 0;

      totalValue += value;
      initialValue += initial;
      weightedPnlSum += value * pnlPercent;
    }

    // Weighted P&L = sum(value * pnl%) / totalValue
    const weightedPnL = totalValue > 0 ? weightedPnlSum / totalValue : 0;

    return { weightedPnL, totalValue, initialValue };
  }

  resetAccount(): void {
    this.account = {
      balance: this.account.startingBalance,
      positions: new Map<string, Position>(),
      tradeHistory: [],
      startingBalance: this.account.startingBalance,
      createdAt: new Date(),
    };
    logger.paper("Paper account reset");
  }

  /**
   * Generate a formatted, grouped PnL report as a TXT file
   * Groups markets by hour window (15-min markets + 1-hour market in same hour)
   */
  generateFormattedPnLReport(): void {
    try {
      const runId = getRunId();
      const logsDir = path.join(process.cwd(), "logs");
      const paperDir = path.join(logsDir, "paper");
      const pnlCsvPath = path.join(paperDir, `Paper Market PNL_${runId}.csv`);
      const reportPath = path.join(paperDir, `PnL Report_${runId}.txt`);

      if (!fs.existsSync(pnlCsvPath)) {
        logger.warn(`PNL CSV file not found: ${pnlCsvPath}`);
        return;
      }

      // Read and parse CSV
      const csvContent = fs.readFileSync(pnlCsvPath, "utf8");
      const lines = csvContent.split("\n").filter(line => line.trim());
      if (lines.length < 2) {
        logger.warn("No market data found in PNL CSV");
        return;
      }

      // Helper function to parse CSV row with quoted fields
      const parseCSVRow = (line: string): string[] => {
        const row: string[] = [];
        let current = "";
        let inQuotes = false;
        for (let j = 0; j < line.length; j++) {
          const char = line[j];
          if (char === '"') {
            inQuotes = !inQuotes;
          } else if (char === "," && !inQuotes) {
            row.push(current.trim().replace(/^"|"$/g, ""));
            current = "";
          } else {
            current += char;
          }
        }
        row.push(current.trim().replace(/^"|"$/g, ""));
        return row;
      };

      // Parse header
      const headerRow = parseCSVRow(lines[0]);
      const marketNameIdx = headerRow.findIndex(h => h.includes("Market Name"));
      const totalPnlIdx = headerRow.findIndex(h => h.includes("Total PnL"));
      const pnlPercentIdx = headerRow.findIndex(h => h.includes("PnL Percent"));
      const avgCostUpIdx = headerRow.findIndex(h => h.includes("Average Cost Per Share UP"));
      const avgCostDownIdx = headerRow.findIndex(h => h.includes("Average Cost Per Share DOWN"));
      const sharesUpIdx = headerRow.findIndex(h => h.includes("Shares Up") && !h.includes("Final Value"));
      const sharesDownIdx = headerRow.findIndex(h => h.includes("Shares Down") && !h.includes("Final Value"));
      const totalInvestedIdx = headerRow.findIndex(h => h.includes("Total Invested"));
      const outcomeIdx = headerRow.findIndex(h => h.includes("Outcome"));
      const switchReasonIdx = headerRow.findIndex(h => h.includes("Market Switch Reason"));

      if (marketNameIdx === -1 || totalPnlIdx === -1) {
        logger.error("Required columns not found in PNL CSV");
        return;
      }

      interface MarketData {
        name: string;
        pnl: number;
        pnlPercent: number;
        avgCostUp: number;
        avgCostDown: number;
        sharesUp: number;
        sharesDown: number;
        totalInvested: number;
        outcome: string;
        is15Min: boolean;
        is1Hour: boolean;
        hourWindow: string; // e.g., "12:00PM-1:00PM"
        timeSlot?: string; // For 15-min: "12:00PM-12:15PM", "12:15PM-12:30PM", etc.
      }

      const markets: MarketData[] = [];

      // Parse data rows (skip header and snapshot rows)
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        // Parse CSV line
        const row = parseCSVRow(line);

        const marketName = row[marketNameIdx] || "";
        const switchReason = row[switchReasonIdx] || "";

        // Only include market closed entries (exclude snapshots)
        if (switchReason !== "Market Closed") continue;

        const pnlStr = row[totalPnlIdx]?.replace(/[$,]/g, "") || "0";
        const pnl = parseFloat(pnlStr) || 0;
        const pnlPercent = parseFloat(row[pnlPercentIdx] || "0") || 0;
        const avgCostUp = parseFloat(row[avgCostUpIdx] || "0") || 0;
        const avgCostDown = parseFloat(row[avgCostDownIdx] || "0") || 0;
        const sharesUp = parseFloat(row[sharesUpIdx] || "0") || 0;
        const sharesDown = parseFloat(row[sharesDownIdx] || "0") || 0;
        const totalInvestedStr = row[totalInvestedIdx] || "0";
        const totalInvested = parseFloat(totalInvestedStr.replace(/[$,]/g, "")) || 0;
        const outcome = row[outcomeIdx] || "";

        // Determine market type and extract time information
        // 15-min markets have format: "Bitcoin Up or Down - January 8, 12:15PM-12:30PM ET"
        // 1-hour markets have format: "Bitcoin Up or Down - January 8, 12PM ET"
        const hasTimeRange = marketName.match(/\d{1,2}:\d{2}(AM|PM)-\d{1,2}:\d{2}(AM|PM)/i);
        const is15Min = hasTimeRange !== null;
        const is1Hour = (marketName.includes("Bitcoin Up or Down") || marketName.includes("Ethereum Up or Down")) &&
                       !is15Min && marketName.match(/\d{1,2}(AM|PM) ET/i) !== null;

        let hourWindow = "";
        let timeSlot = "";

        if (is15Min) {
          // Extract time slots like "12:15PM-12:30PM"
          const timeMatch = marketName.match(/(\d{1,2}):\d{2}(AM|PM)-(\d{1,2}):\d{2}(AM|PM)/i);
          if (timeMatch) {
            timeSlot = `${timeMatch[1]}:${timeMatch[2]}-${timeMatch[3]}:${timeMatch[4]}`;
            // Extract hour window - use the START hour for grouping
            // All 15-min markets that start in the same hour should be grouped together
            // E.g., 12:00-12:15, 12:15-12:30, 12:30-12:45, 12:45-1:00 all go in "12:00PM-1:00PM" window
            let startH = parseInt(timeMatch[1]);
            const startAmpm = timeMatch[2].toUpperCase();
            
            // Calculate the hour window (start hour to next hour)
            let endH = startH + 1;
            let endAmpm = startAmpm;
            
            // Handle hour rollover
            if (startH === 12 && startAmpm === "PM") {
              endH = 1;
              endAmpm = "PM";
            } else if (startH === 12 && startAmpm === "AM") {
              endH = 1;
              endAmpm = "AM";
            } else if (startH === 11 && startAmpm === "PM") {
              endH = 12;
              endAmpm = "AM";
            } else if (startH === 11 && startAmpm === "AM") {
              endH = 12;
              endAmpm = "PM";
            }
            
            hourWindow = `${startH}:00${startAmpm}-${endH}:00${endAmpm}`;
          }
        } else if (is1Hour) {
          // Extract hour like "12PM ET" or "1PM ET"
          const hourMatch = marketName.match(/(\d{1,2})(AM|PM) ET/i);
          if (hourMatch) {
            let hour = parseInt(hourMatch[1]);
            const ampm = hourMatch[2].toUpperCase();
            let nextHour = hour + 1;
            let nextAmpm = ampm;
            
            // Handle hour rollover
            if (hour === 12 && ampm === "PM") {
              nextHour = 1;
              nextAmpm = "PM";
            } else if (hour === 11 && ampm === "PM") {
              nextHour = 12;
              nextAmpm = "AM";
            } else if (hour === 12 && ampm === "AM") {
              nextHour = 1;
              nextAmpm = "AM";
            } else if (hour === 11 && ampm === "AM") {
              nextHour = 12;
              nextAmpm = "PM";
            }
            
            hourWindow = `${hour}:00${ampm}-${nextHour}:00${nextAmpm}`;
          }
        }

        markets.push({
          name: marketName,
          pnl,
          pnlPercent,
          avgCostUp,
          avgCostDown,
          sharesUp,
          sharesDown,
          totalInvested,
          outcome,
          is15Min,
          is1Hour,
          hourWindow,
          timeSlot,
        });
      }

      // Group markets by hour window
      const groupedByHour: Map<string, MarketData[]> = new Map();
      for (const market of markets) {
        if (!market.hourWindow) continue;
        if (!groupedByHour.has(market.hourWindow)) {
          groupedByHour.set(market.hourWindow, []);
        }
        groupedByHour.get(market.hourWindow)!.push(market);
      }

      // Generate formatted report
      let report = "";
      report += "=".repeat(100) + "\n";
      report += "                    PAPER TRADING PNL REPORT\n";
      report += "=".repeat(100) + "\n\n";

      // Sort hour windows chronologically
      const sortedWindows = Array.from(groupedByHour.keys()).sort((a, b) => {
        // Parse hour windows for sorting
        const parseHour = (str: string): number => {
          const match = str.match(/(\d{1,2}):\d{2}(AM|PM)/i);
          if (!match) return 0;
          let hour = parseInt(match[1]);
          if (match[2].toUpperCase() === "PM" && hour !== 12) hour += 12;
          if (match[2].toUpperCase() === "AM" && hour === 12) hour = 0;
          return hour;
        };
        return parseHour(a) - parseHour(b);
      });

      let totalPnL = 0;
      let totalInvested = 0;

      for (const hourWindow of sortedWindows) {
        const marketsInWindow = groupedByHour.get(hourWindow)!;
        
        // Sort: 15-min markets by time slot, then 1-hour market
        marketsInWindow.sort((a, b) => {
          if (a.is15Min && !b.is15Min) return -1;
          if (!a.is15Min && b.is15Min) return 1;
          if (a.is15Min && b.is15Min) {
            return (a.timeSlot || "").localeCompare(b.timeSlot || "");
          }
          return 0;
        });

        report += "\n" + "─".repeat(100) + "\n";
        report += `  HOUR WINDOW: ${hourWindow}\n`;
        report += "─".repeat(100) + "\n\n";

        let windowPnL = 0;
        let windowInvested = 0;

        for (const market of marketsInWindow) {
          const marketType = market.is15Min ? "15-Min" : market.is1Hour ? "1-Hour" : "Other";
          const pnlSign = market.pnl >= 0 ? "+" : "";

          report += `  ${marketType} Market: ${market.name}\n`;
          report += `  ${" ".repeat(16)}PnL: ${pnlSign}$${market.pnl.toFixed(2)} (${pnlSign}${market.pnlPercent.toFixed(2)}%)\n`;
          
          if (market.avgCostUp > 0 || market.avgCostDown > 0) {
            report += `  ${" ".repeat(16)}Average Cost - UP: $${market.avgCostUp.toFixed(4)}  |  DOWN: $${market.avgCostDown.toFixed(4)}\n`;
          }
          
          if (market.sharesUp > 0 || market.sharesDown > 0) {
            report += `  ${" ".repeat(16)}Shares - UP: ${market.sharesUp.toFixed(2)}  |  DOWN: ${market.sharesDown.toFixed(2)}\n`;
          }
          
          report += `  ${" ".repeat(16)}Total Invested: $${market.totalInvested.toFixed(2)}  |  Outcome: ${market.outcome || "N/A"}\n`;
          report += "\n";

          windowPnL += market.pnl;
          windowInvested += market.totalInvested;
        }

        // Window summary
        const windowPnLSign = windowPnL >= 0 ? "+" : "";
        const windowPnLPercent = windowInvested > 0 ? (windowPnL / windowInvested) * 100 : 0;
        report += `  ${"─".repeat(88)}\n`;
        report += `  Window Summary:  PnL: ${windowPnLSign}$${windowPnL.toFixed(2)} (${windowPnLSign}${windowPnLPercent.toFixed(2)}%)  |  Total Invested: $${windowInvested.toFixed(2)}\n`;
        report += `  ${"─".repeat(88)}\n\n`;

        totalPnL += windowPnL;
        totalInvested += windowInvested;
      }

      // Overall summary
      report += "\n" + "=".repeat(100) + "\n";
      report += "                              OVERALL SUMMARY\n";
      report += "=".repeat(100) + "\n\n";
      const totalPnLSign = totalPnL >= 0 ? "+" : "";
      const totalPnLPercent = totalInvested > 0 ? (totalPnL / totalInvested) * 100 : 0;
      report += `  Total PnL: ${totalPnLSign}$${totalPnL.toFixed(2)} (${totalPnLSign}${totalPnLPercent.toFixed(2)}%)\n`;
      report += `  Total Invested: $${totalInvested.toFixed(2)}\n`;
      report += `  Markets Traded: ${markets.length}\n`;
      report += `  Hour Windows: ${sortedWindows.length}\n`;
      report += "\n" + "=".repeat(100) + "\n";
      report += `  Generated: ${new Date().toLocaleString()}\n`;
      report += "=".repeat(100) + "\n";

      // Write report
      fs.writeFileSync(reportPath, report, "utf8");
      logger.info(`📊 Formatted PnL report generated: ${reportPath}`);
    } catch (error) {
      logger.error(`Failed to generate formatted PnL report: ${error}`);
    }
  }
}

export default PaperTrader;
