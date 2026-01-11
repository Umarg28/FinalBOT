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
import * as os from "os";
import chalk from "chalk";

export class PaperTrader {
  private account: PaperAccount;
  private marketData: MarketDataService;
  private csvFilePath: string;
  private csvInitialized: boolean = false;
  private csvExporter: CSVExporter;
  private marketPnLData: Map<string, {
    marketName: string;
    conditionId: string;
    marketPnL: any;
    priceUp: number;
    priceDown: number;
    totalPnl: number;
    pnlPercent: number;
    sharesUp: number;
    sharesDown: number;
    timestamp: number;
  }> = new Map();

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
    // Use path.join for cross-platform compatibility (Windows/Mac/Linux)
    const logsDir = path.join(process.cwd(), "logs");
    const paperDir = path.join(logsDir, "paper");
    
    // Create directories with proper error handling for cross-platform compatibility
    try {
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true, mode: 0o755 });
      }
      if (!fs.existsSync(paperDir)) {
        fs.mkdirSync(paperDir, { recursive: true, mode: 0o755 });
      }
    } catch (error: any) {
      // On Windows, mode might not be supported, retry without it
      if (error.code === 'EINVAL' || error.message?.includes('mode')) {
        try {
          if (!fs.existsSync(logsDir)) {
            fs.mkdirSync(logsDir, { recursive: true });
          }
          if (!fs.existsSync(paperDir)) {
            fs.mkdirSync(paperDir, { recursive: true });
          }
        } catch (retryError) {
          logger.error(`Failed to create directories: ${retryError}`);
        }
      } else {
        logger.error(`Failed to create directories: ${error}`);
      }
    }
    const runId = getRunId();
    this.csvFilePath = path.join(paperDir, `Paper Trades_${runId}.csv`);
    this.csvExporter = new CSVExporter(paperDir);
    this.initializeCsv();

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
      fs.writeFileSync(this.csvFilePath, headers + os.EOL, { encoding: "utf8", flag: "w" });
      this.csvInitialized = true;
      logger.info(`Paper trades CSV initialized: ${this.csvFilePath}`);
    } catch (error) {
      logger.error(`Failed to initialize paper trades CSV: ${error}`);
    }
  }

  private loggedMarkets: Set<string> = new Set(); // Track markets already logged to prevent duplicates


  /**
   * Log market PnL from dashboard data (captures exactly what dashboard shows)
   * Called 5 seconds before market ends
   * Uses enhanced PnL calculator and CSV exporter
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
    // Prevent duplicate logging for the same market
    if (!conditionId || this.loggedMarkets.has(conditionId)) {
      return;
    }

    // Skip if no shares traded in this market
    if (sharesUp === 0 && sharesDown === 0) {
      return;
    }

    try {
      // Try to get positions for enhanced calculation, but don't require them
      // (positions may be settled/removed after market closes)
      const marketPositions = this.getAllPositions().filter(p => p.conditionId === conditionId);
      
      let marketPnL: any = null;
      
      // If we have positions, use enhanced calculator for more detailed PnL
      if (marketPositions.length > 0) {
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
        marketPnL = PnLCalculator.calculateMarketPnL(
          marketPositions,
          this.account.tradeHistory.filter(t => 
            marketPositions.some(p => p.tokenId === t.tokenId)
          ),
          conditionId,
          currentPrices
        );
      }

      // Store market PnL data in memory for report generation
      // Use the passed-in data even if positions are already settled
      if (!this.marketPnLData) {
        this.marketPnLData = new Map();
      }
      
      // Create a simplified marketPnL object if we don't have the full calculation
      const finalMarketPnL = marketPnL || {
        totalPnl,
        pnlPercent,
        positions: [],
        totalCostBasis: sharesUp > 0 || sharesDown > 0 ? totalPnl / (pnlPercent / 100) : 0
      };
      
      // Store timestamp as when PnL was captured (current time)
      // This should be ~5 seconds before market actually ends
      const captureTimestamp = Date.now();
      const captureTimeStr = new Date(captureTimestamp).toLocaleString('en-US', { timeZone: 'America/New_York' });
      
      // Log when PnL is being captured for debugging
      logger.info(`📊 Capturing PnL for ${marketName} at ${captureTimeStr} ET (timestamp: ${captureTimestamp})`);
      
      this.marketPnLData.set(conditionId, {
        marketName,
        conditionId,
        marketPnL: finalMarketPnL,
        priceUp,
        priceDown,
        totalPnl,
        pnlPercent,
        sharesUp,
        sharesDown,
        timestamp: captureTimestamp
      });

      // Mark this market as logged to prevent duplicates
      this.loggedMarkets.add(conditionId);

      logger.paper(`📊 Dashboard PnL captured: ${marketName} - ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)} (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}%)`);
      
      // Regenerate report immediately after logging new PnL data
      // This ensures the text file is updated with the latest data
      try {
        this.generateFormattedPnLReport();
      } catch (reportError) {
        logger.error(`Failed to regenerate PnL report after logging: ${reportError}`);
      }
    } catch (error) {
      logger.error(`Failed to log market PnL: ${error}`);
      // Still try to store basic data even if calculation fails
      if (conditionId && !this.loggedMarkets.has(conditionId)) {
        if (!this.marketPnLData) {
          this.marketPnLData = new Map();
        }
        this.marketPnLData.set(conditionId, {
          marketName,
          conditionId,
          marketPnL: { totalPnl, pnlPercent, positions: [], totalCostBasis: 0 },
          priceUp,
          priceDown,
          totalPnl,
          pnlPercent,
          sharesUp,
          sharesDown,
          timestamp: Date.now()
        });
        this.loggedMarkets.add(conditionId);
        
        // Regenerate report even for fallback data
        try {
          this.generateFormattedPnLReport();
        } catch (reportError) {
          logger.error(`Failed to regenerate PnL report after fallback logging: ${reportError}`);
        }
      }
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
  settleMarket(conditionId: string, rawPriceUp: number, rawPriceDown: number): void {
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

    // Determine winner: the side with the higher price wins
    // When market closes, winning side = $1.00, losing side = $0.00
    let finalPriceUp = rawPriceUp;
    let finalPriceDown = rawPriceDown;
    let outcome = 'Unknown';

    // If prices are already resolved (0.99+ or 0.01-), use them directly
    if (rawPriceUp >= 0.99 || rawPriceDown >= 0.99 || rawPriceUp <= 0.01 || rawPriceDown <= 0.01) {
      if (rawPriceUp >= 0.99) {
        outcome = 'UP Won';
        finalPriceUp = 1.0;
        finalPriceDown = 0.0;
      } else if (rawPriceDown >= 0.99) {
        outcome = 'DOWN Won';
        finalPriceUp = 0.0;
        finalPriceDown = 1.0;
      } else if (rawPriceUp <= 0.01) {
        outcome = 'DOWN Won';
        finalPriceUp = 0.0;
        finalPriceDown = 1.0;
      } else if (rawPriceDown <= 0.01) {
        outcome = 'UP Won';
        finalPriceUp = 1.0;
        finalPriceDown = 0.0;
      }
    } else if (rawPriceUp > 0 || rawPriceDown > 0) {
      // Prices not yet resolved - determine winner from which side has higher price
      if (rawPriceUp > rawPriceDown) {
        outcome = 'UP Won';
        finalPriceUp = 1.0;
        finalPriceDown = 0.0;
      } else if (rawPriceDown > rawPriceUp) {
        outcome = 'DOWN Won';
        finalPriceUp = 0.0;
        finalPriceDown = 1.0;
      }
    }

    logger.paper(`Market settlement: ${outcome} (raw prices: UP=$${rawPriceUp.toFixed(4)}, DOWN=$${rawPriceDown.toFixed(4)})`);

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

      // Calculate payout: shares * final price (winner gets $1 per share, loser gets $0)
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
        if (currentPrice !== null && Number.isFinite(currentPrice)) {
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

    // Guard against any unexpected NaN accumulation
    if (!Number.isFinite(totalPositionValue)) {
      logger.warn("Total position value for new market window is NaN; defaulting to 0");
      totalPositionValue = 0;
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

      fs.appendFileSync(this.csvFilePath, row + os.EOL, { encoding: "utf8", flag: "a" });
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
          logger.warn(`[PAPER] Trade rejected - future market: ${marketInfo.question} (${marketInfo.slug}) - starts at ${new Date(startTime).toLocaleString('en-US', { timeZone: 'America/New_York' })} ET`);
          return execution;
        }

        logger.debug(`[PAPER] Market validation passed - market has started: ${marketInfo.question} (start: ${new Date(startTime).toLocaleString('en-US', { timeZone: 'America/New_York' })} ET)`);
      } else {
        logger.warn(`[PAPER] Could not find market info for token ${signal.tokenId} - allowing trade (market may not be in current markets list)`);
      }
    } catch (error) {
      logger.error(`[PAPER] Error validating market start time:`, error);
      // Allow trade to proceed if validation fails (fail open for safety)
    }

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
   * Uses in-memory data instead of CSV files
   */
  generateFormattedPnLReport(): void {
    try {
      // Platform-specific line ending (\r\n on Windows, \n on Mac/Linux)
      const EOL = os.EOL;
      
      const runId = getRunId();
      // Use path.join for cross-platform compatibility (Windows/Mac/Linux)
      const logsDir = path.join(process.cwd(), "logs");
      const paperDir = path.join(logsDir, "paper");
      
      // Ensure directories exist with cross-platform error handling
      try {
        if (!fs.existsSync(logsDir)) {
          fs.mkdirSync(logsDir, { recursive: true, mode: 0o755 });
        }
        if (!fs.existsSync(paperDir)) {
          fs.mkdirSync(paperDir, { recursive: true, mode: 0o755 });
        }
      } catch (error: any) {
        // On Windows, mode might not be supported, retry without it
        if (error.code === 'EINVAL' || error.message?.includes('mode')) {
          try {
            if (!fs.existsSync(logsDir)) {
              fs.mkdirSync(logsDir, { recursive: true });
            }
            if (!fs.existsSync(paperDir)) {
              fs.mkdirSync(paperDir, { recursive: true });
            }
          } catch (retryError) {
            logger.error(`Failed to create directories for report: ${retryError}`);
            return;
          }
        } else {
          logger.error(`Failed to create directories for report: ${error}`);
          return;
        }
      }
      
      const reportPath = path.join(paperDir, `PnL Report_${runId}.txt`);

      // Check if we have any market data
      if (!this.marketPnLData || this.marketPnLData.size === 0) {
        // Create an empty report file to indicate the system is ready
        // Use platform-specific line endings for cross-platform compatibility
        let emptyReport = "=".repeat(100) + EOL;
        emptyReport += "                    PAPER TRADING PNL REPORT" + EOL;
        emptyReport += "=".repeat(100) + EOL + EOL;
        emptyReport += "  No market data available yet." + EOL;
        emptyReport += "  Report will be updated as markets are traded." + EOL + EOL;
        emptyReport += "=".repeat(100) + EOL;
        emptyReport += `  Generated: ${new Date().toLocaleString()}` + EOL;
        emptyReport += "=".repeat(100) + EOL;
        
        // Write with UTF-8 encoding and proper error handling
        try {
          fs.writeFileSync(reportPath, emptyReport, { encoding: "utf8", flag: "w" });
          logger.info(`📊 Empty PnL report created: ${reportPath}`);
        } catch (error: any) {
          logger.error(`Failed to write empty PnL report to ${reportPath}: ${error.message || error}`);
        }
        return;
      }

      interface MarketData {
        name: string;
        pnl: number;
        pnlPercent: number;
        avgCostUp: number;
        avgCostDown: number;
        avgPriceUp: number;
        avgPriceDown: number;
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

      // Convert in-memory data to MarketData format
      for (const [conditionId, data] of this.marketPnLData.entries()) {
        const marketPnL = data.marketPnL;
        const marketName = data.marketName;
        
        // Use stored shares values (they're passed in when logging, even if positions are settled)
        let sharesUp = data.sharesUp || 0;
        let sharesDown = data.sharesDown || 0;
        let avgCostUp = 0;
        let avgCostDown = 0;
        
        // Try to calculate averages from marketPnL positions if available
        if (marketPnL.positions && marketPnL.positions.length > 0) {
          const upPositions = marketPnL.positions.filter((p: any) => 
            p.position.outcome?.toLowerCase() === 'up' || p.position.outcome?.toLowerCase() === 'yes'
          );
          const downPositions = marketPnL.positions.filter((p: any) => 
            p.position.outcome?.toLowerCase() === 'down' || p.position.outcome?.toLowerCase() === 'no'
          );

          const calculatedSharesUp = upPositions.reduce((sum: number, p: any) => sum + p.position.size, 0);
          const calculatedSharesDown = downPositions.reduce((sum: number, p: any) => sum + p.position.size, 0);
          
          // Use calculated values if they're available, otherwise use stored values
          if (calculatedSharesUp > 0 || calculatedSharesDown > 0) {
            sharesUp = calculatedSharesUp;
            sharesDown = calculatedSharesDown;
          }
          
          const costBasisUp = upPositions.reduce((sum: number, p: any) => sum + p.costBasis, 0);
          const costBasisDown = downPositions.reduce((sum: number, p: any) => sum + p.costBasis, 0);
          avgCostUp = sharesUp > 0 ? costBasisUp / sharesUp : 0;
          avgCostDown = sharesDown > 0 ? costBasisDown / sharesDown : 0;
        } else {
          // If no positions (market already settled), calculate avg cost from stored PnL data
          // avgCost = (totalPnl / pnlPercent * 100) / shares, but we need to estimate
          // For now, use price as approximation if we have price data
          if (sharesUp > 0 && data.priceUp > 0) {
            // Estimate: if we have PnL and shares, we can back-calculate
            // But without cost basis, we'll use a simple approximation
            avgCostUp = data.priceUp; // Fallback approximation
          }
          if (sharesDown > 0 && data.priceDown > 0) {
            avgCostDown = data.priceDown; // Fallback approximation
          }
        }

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

        // Calculate total invested from stored data or calculated values
        let totalInvested = 0;
        if (marketPnL.totalCostBasis && marketPnL.totalCostBasis > 0) {
          totalInvested = marketPnL.totalCostBasis;
        } else {
          // Fallback: estimate from shares and avg costs
          totalInvested = (sharesUp * avgCostUp) + (sharesDown * avgCostDown);
          // If that's 0, try using the PnL calculation: totalInvested = totalPnl / (pnlPercent / 100)
          if (totalInvested === 0 && data.pnlPercent !== 0) {
            totalInvested = Math.abs(data.totalPnl / (data.pnlPercent / 100));
          }
        }

        // Determine outcome: the side with the higher price wins
        // When market closes, winning side = $1.00, losing side = $0.00
        let outcome = "Pending";
        const priceUp = data.priceUp || 0;
        const priceDown = data.priceDown || 0;

        // Determine winner based on which side has higher price
        let settledPriceUp = priceUp;
        let settledPriceDown = priceDown;

        // Check if market is resolved (one side near 1.0, other near 0.0)
        if (priceUp >= 0.99 || priceDown <= 0.01) {
          outcome = "UP Won";
          settledPriceUp = 1.0;
          settledPriceDown = 0.0;
        } else if (priceDown >= 0.99 || priceUp <= 0.01) {
          outcome = "DOWN Won";
          settledPriceUp = 0.0;
          settledPriceDown = 1.0;
        } else if (priceUp > 0 && priceDown > 0) {
          // Market not yet resolved - determine winner from which side has higher price
          // Higher price = more likely to win = winner
          if (priceUp > priceDown) {
            outcome = "UP Won";
            settledPriceUp = 1.0;
            settledPriceDown = 0.0;
          } else if (priceDown > priceUp) {
            outcome = "DOWN Won";
            settledPriceUp = 0.0;
            settledPriceDown = 1.0;
          } else {
            // Prices are exactly equal - this shouldn't happen in real markets
            // Skip this market from the report as we can't determine outcome
            outcome = "Unknown";
          }
        }

        // Recalculate PnL using settled binary prices (winner=$1, loser=$0)
        // This is the ACTUAL profit/loss when market resolves
        const settledValueUp = sharesUp * settledPriceUp;
        const settledValueDown = sharesDown * settledPriceDown;
        const settledTotalValue = settledValueUp + settledValueDown;
        const settledPnl = settledTotalValue - totalInvested;
        const settledPnlPercent = totalInvested > 0 ? (settledPnl / totalInvested) * 100 : 0;

        markets.push({
          name: marketName,
          pnl: settledPnl,
          pnlPercent: settledPnlPercent,
          avgCostUp,
          avgCostDown,
          avgPriceUp: priceUp,
          avgPriceDown: priceDown,
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

      // Generate formatted report (simple, clean text)
      // Use platform-specific line endings for cross-platform compatibility
      // EOL already declared at top of function
      let report = "";
      report += "=".repeat(100) + EOL;
      report += "                    PAPER TRADING PNL REPORT" + EOL;
      report += "=".repeat(100) + EOL + EOL;

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

        report += EOL + "=".repeat(100) + EOL;
        report += `  HOUR WINDOW: ${hourWindow}` + EOL;
        report += "=".repeat(100) + EOL + EOL;

        let windowPnL = 0;
        let windowInvested = 0;

        for (const market of marketsInWindow) {
          const marketType = market.is15Min ? "15-Min" : market.is1Hour ? "1-Hour" : "Other";
          const pnlSign = market.pnl >= 0 ? "+" : "";

          // Market header
          report += EOL + "-".repeat(100) + EOL;
          report += `  ${marketType} Market: ${market.name}` + EOL;
          report += "-".repeat(100) + EOL + EOL;
          
          // Outcome and PnL
          report += "  OUTCOME: " + market.outcome + EOL;
          const pnlStr = `${pnlSign}$${Math.abs(market.pnl).toFixed(2)}`;
          const pnlPercentStr = `${pnlSign}${Math.abs(market.pnlPercent).toFixed(2)}%`;
          report += "  PnL: " + `${pnlStr} (${pnlPercentStr})` + EOL + EOL;

          // Shares
          report += "  SHARES:" + EOL;
          report += "    UP:   " + market.sharesUp.toFixed(2) + EOL;
          report += "    DOWN: " + market.sharesDown.toFixed(2) + EOL + EOL;

          // Prices
          report += "  CLOSING PRICES:" + EOL;
          report += "    UP:   $" + market.avgPriceUp.toFixed(4) + EOL;
          report += "    DOWN: $" + market.avgPriceDown.toFixed(4) + EOL + EOL;

          // Average Costs
          report += "  AVERAGE COST:" + EOL;
          report += "    UP:   $" + market.avgCostUp.toFixed(4) + EOL;
          report += "    DOWN: $" + market.avgCostDown.toFixed(4) + EOL + EOL;

          // Payout
          if (market.sharesUp > 0 || market.sharesDown > 0) {
            report += "  PAYOUT:" + EOL;
            if (market.outcome === "UP Won") {
              const payout = market.sharesUp * 1.0;
              report += "    UP:   $" + payout.toFixed(2) + " (" + market.sharesUp.toFixed(2) + " shares × $1.00)" + EOL;
              report += "    DOWN: $0.00 (" + market.sharesDown.toFixed(2) + " shares × $0.00)" + EOL;
            } else if (market.outcome === "DOWN Won") {
              const payout = market.sharesDown * 1.0;
              report += "    UP:   $0.00 (" + market.sharesUp.toFixed(2) + " shares × $0.00)" + EOL;
              report += "    DOWN: $" + payout.toFixed(2) + " (" + market.sharesDown.toFixed(2) + " shares × $1.00)" + EOL;
            }
            report += EOL;
          }

          // Total Invested
          report += "  TOTAL INVESTED: $" + market.totalInvested.toFixed(2) + EOL;

          windowPnL += market.pnl;
          windowInvested += market.totalInvested;
        }

        // Window summary
        const windowPnLSign = windowPnL >= 0 ? "+" : "";
        const windowPnLPercent = windowInvested > 0 ? (windowPnL / windowInvested) * 100 : 0;
        report += EOL + "=".repeat(100) + EOL;
        const windowPnLStr = `${windowPnLSign}$${Math.abs(windowPnL).toFixed(2)}`;
        const windowPnLPercentStr = `${windowPnLSign}${Math.abs(windowPnLPercent).toFixed(2)}%`;
        report += "  WINDOW SUMMARY:" + EOL;
        report += "  PnL: " + `${windowPnLStr} (${windowPnLPercentStr})` + EOL;
        report += "  Total Invested: $" + windowInvested.toFixed(2) + EOL;
        report += "=".repeat(100) + EOL + EOL;

        totalPnL += windowPnL;
        totalInvested += windowInvested;
      }

      // Overall summary
      report += EOL + "=".repeat(100) + EOL;
      report += "                              OVERALL SUMMARY" + EOL;
      report += "=".repeat(100) + EOL + EOL;
      const totalPnLSign = totalPnL >= 0 ? "+" : "";
      const totalPnLPercent = totalInvested > 0 ? (totalPnL / totalInvested) * 100 : 0;
      const totalPnLStr = `${totalPnLSign}$${Math.abs(totalPnL).toFixed(2)}`;
      const totalPnLPercentStr = `${totalPnLSign}${Math.abs(totalPnLPercent).toFixed(2)}%`;
      report += "  Total PnL:     " + `${totalPnLStr} (${totalPnLPercentStr})` + EOL;
      report += "  Total Invested: $" + totalInvested.toFixed(2) + EOL;
      report += "  Markets Traded: " + markets.length.toString() + EOL;
      report += "  Hour Windows:   " + sortedWindows.length.toString() + EOL;
      report += EOL + "=".repeat(100) + EOL;
      report += "  Generated: " + new Date().toLocaleString() + EOL;
      report += "=".repeat(100) + EOL;

      // Write report with proper encoding and error handling for cross-platform compatibility
      try {
        fs.writeFileSync(reportPath, report, { encoding: "utf8", flag: "w" });
        logger.info(`📊 Formatted PnL report generated: ${reportPath}`);
      } catch (error: any) {
        logger.error(`Failed to write PnL report to ${reportPath}: ${error.message || error}`);
        throw error; // Re-throw to be caught by outer try-catch
      }
    } catch (error) {
      logger.error(`Failed to generate formatted PnL report: ${error}`);
    }
  }
}

export default PaperTrader;
