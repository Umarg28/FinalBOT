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
      // Simple headers: Market Name, Time, PnL (easy to read format)
      const headers = ["Market Name", "Time", "PnL"].join(",");
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

        const row = [
          `"${marketName.trim()}"`,
          time,
          `${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`,
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
        execution.executedPrice.toFixed(4),
        (execution.executedSize * execution.executedPrice).toFixed(2),
        this.account.balance.toFixed(2),
        signal.strategyName,
        execution.status,
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

      // Write to CSV file
      this.writeTradeToCsv(execution, signal);
    } catch (error) {
      execution.status = "failed";
      execution.error = error instanceof Error ? error.message : "Unknown error";
      logger.error("Paper trade execution error:", error);
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
}

export default PaperTrader;
