// CRITICAL: Initialize runId FIRST before any logger imports
// This ensures all CSV files use the same run ID
import { getRunId } from './utils/runId';
getRunId(); // Initialize runId immediately

import { connectDB, disconnectDB } from "./config/db";
import { ENV } from "./config/env";
import { createClobClient } from "./services/clobClient";
import { MarketDataService } from "./services/marketData";
import { EnhancedMarketDataService } from "./services/enhancedMarketData";
import { TradeExecutor } from "./services/tradeExecutor";
import { EnhancedTradeExecutor } from "./services/enhancedTradeExecutor";
import { PaperTrader } from "./services/paperTrader";
import { WalletPnLService } from "./services/walletPnLService";
import { Dashboard } from "./services/dashboard";
import { StrategyManager, BaseStrategy } from "./strategies";
import { TradeSignal } from "./interfaces";
import logger from "./utils/logger";

// Import price stream logger - starts WebSocket connection for live prices
import priceStreamLogger from "./services/priceStreamLogger";
// Import market tracker for dashboard functionality
import marketTracker, { type MarketTrackerInstance } from "./services/marketTracker";
// Import config watcher for hot-reloading
import { startConfigWatcher, stopConfigWatcher } from "./config/rebalanceConfig";

// Import web dashboard app server (optional)
let AppServer: typeof import("../app/server").AppServer | null = null;
let dashboardDataCollector: typeof import("../app/server").dashboardDataCollector | null = null;
if (ENV.ENABLE_WEB_DASHBOARD) {
  try {
    const appServer = require("../app/server");
    AppServer = appServer.AppServer;
    dashboardDataCollector = appServer.dashboardDataCollector;
  } catch (e) {
    console.warn("[APP] Web dashboard not available - app folder may be missing");
  }
}

// Main bot class
export class PolymarketBot {
  private marketData!: MarketDataService;
  private tradeExecutor!: TradeExecutor;
  private paperTrader!: PaperTrader;
  private strategyManager!: StrategyManager;
  private dashboard?: Dashboard;
  private walletPnLService?: WalletPnLService;
  private appServer?: InstanceType<typeof import("../app/server").AppServer>;
  private isRunning: boolean = false;
  private isPaperMode: boolean;
  private isWatcherMode: boolean;

  constructor() {
    this.isPaperMode = ENV.PAPER_MODE;
    this.isWatcherMode = ENV.WATCHER_MODE;
  }

  async initialize(): Promise<void> {
    logger.info("=".repeat(50));
    logger.info("LIGHTEDGE POLYMARKET BOT");
    logger.info("=".repeat(50));

    if (this.isWatcherMode) {
      logger.info("Running in WATCHER MODE - Dashboard only, no trades will be executed");
    } else if (this.isPaperMode) {
      logger.paper("Running in PAPER MODE - No real trades will be executed");
    } else {
      logger.warn("Running in LIVE MODE - Real trades will be executed!");
    }

    // Connect to database
    await connectDB();

    // Initialize CLOB client
    const clobClient = await createClobClient();

    // Initialize services (use enhanced services if enabled)
    if (ENV.USE_ENHANCED_SERVICES) {
      logger.info("Using enhanced services with poly-sdk");
      this.marketData = new EnhancedMarketDataService(clobClient);
      await (this.marketData as EnhancedMarketDataService).initialize();
      
      // Initialize wallet PnL service for live mode
      if (!this.isPaperMode && !this.isWatcherMode) {
        this.walletPnLService = new WalletPnLService();
        // Pass SDK if available
        if (this.marketData instanceof EnhancedMarketDataService) {
          const sdk = (this.marketData as any).sdk;
          if (sdk) {
            await this.walletPnLService.initialize(sdk);
          } else {
            await this.walletPnLService.initialize();
          }
        } else {
          await this.walletPnLService.initialize();
        }
      }
      
      if (!this.isPaperMode) {
        this.tradeExecutor = new EnhancedTradeExecutor(clobClient);
        await (this.tradeExecutor as EnhancedTradeExecutor).initialize();
      } else {
        // Paper mode still uses basic executor (paper trader handles execution)
        this.tradeExecutor = new TradeExecutor(clobClient);
      }
    } else {
      logger.info("Using basic services (poly-sdk disabled)");
      this.marketData = new MarketDataService(clobClient);
      this.tradeExecutor = new TradeExecutor(clobClient);
    }
    
    this.paperTrader = new PaperTrader(this.marketData);
    this.strategyManager = new StrategyManager(this.marketData);

    // In watcher mode, use the marketTracker from EDGEBOTPRO for dashboard display
    // This provides real-time price streaming and market tracking
    if (this.isWatcherMode) {
      logger.info("Watcher mode: Using marketTracker for live price dashboard");
      // marketTracker auto-discovers markets via priceStreamLogger WebSocket
      // No need to manually add markets - it discovers them automatically
    } else if (ENV.DASHBOARD_MARKETS) {
      // Non-watcher mode with explicit markets - use old dashboard
      this.dashboard = new Dashboard(this.marketData, this.paperTrader);
      this.dashboard.setUpdateInterval(ENV.DASHBOARD_UPDATE_INTERVAL);
      const conditionIds = ENV.DASHBOARD_MARKETS.split(",").map((id) => id.trim()).filter(Boolean);
      await this.dashboard.addMarkets(conditionIds);
      logger.info(`Dashboard configured with ${conditionIds.length} market(s)`);
    }

    logger.success("Bot initialized successfully");
    logger.info("");

    // Start config file watcher for hot-reloading (paper mode only)
    if (this.isPaperMode && !this.isWatcherMode) {
      startConfigWatcher();
    }

    // Start web dashboard server if enabled
    if (ENV.ENABLE_WEB_DASHBOARD && AppServer && dashboardDataCollector) {
      this.appServer = new AppServer(ENV.WEB_DASHBOARD_PORT);
      dashboardDataCollector.setPaperTrader(this.paperTrader);
      // Set marketData service for watcher mode position syncing
      if (this.marketData) {
        dashboardDataCollector.setMarketData(this.marketData);
      }
      this.appServer.start();

      // Wire up reset callback to clear PnL history
      this.appServer.setOnReset((target: string) => {
        if (target === 'main' || target === 'all') {
          logger.info(`[RESET] Resetting paper account (target: ${target})`);
          this.paperTrader.resetAccount();
          this.appServer?.clearPendingReset(target);
        }
      });
    }

    if (this.isWatcherMode) {
      logger.info("Watcher mode: Dashboard will display live market data");
    } else {
      logger.info("No strategies loaded - waiting for you to add strategies");
      logger.info("See src/strategies/exampleStrategy.ts for examples");
    }
    logger.info("");
  }

  /**
   * Add a strategy to the bot
   */
  addStrategy(strategy: BaseStrategy): void {
    this.strategyManager.addStrategy(strategy);
  }

  /**
   * Remove a strategy from the bot
   */
  removeStrategy(name: string): boolean {
    return this.strategyManager.removeStrategy(name);
  }

  /**
   * Get market data service for strategy use
   */
  getMarketData(): MarketDataService {
    return this.marketData;
  }

  /**
   * Get paper trader for checking paper account
   */
  getPaperTrader(): PaperTrader {
    return this.paperTrader;
  }

  /**
   * Get dashboard instance
   */
  getDashboard(): Dashboard | undefined {
    return this.dashboard;
  }

  /**
   * Get wallet PnL service (for live trading mode)
   */
  getWalletPnLService(): WalletPnLService | undefined {
    return this.walletPnLService;
  }

  /**
   * Add markets to dashboard
   */
  async addDashboardMarkets(conditionIds: string[]): Promise<void> {
    if (this.dashboard) {
      await this.dashboard.addMarkets(conditionIds);
    }
  }

  /**
   * Execute a single trade signal
   */
  async executeTrade(signal: TradeSignal): Promise<void> {
    try {
      if (this.isPaperMode) {
        const execution = await this.paperTrader.executeOrder(signal);

      // Report filled paper trades to marketTracker for dashboard display
      if (execution.status === "filled") {
        // Get market info from priceStreamLogger for slug/title
        const currentMarkets = priceStreamLogger.getCurrentMarkets();
        let marketSlug = '';
        let marketTitle = signal.metadata?.title as string || 'Unknown';

        // Find the market that contains this token
        for (const [key, marketInfo] of currentMarkets.entries()) {
          const token = marketInfo.tokens.find((t: any) => t.token_id === signal.tokenId);
          if (token) {
            marketSlug = marketInfo.slug || key;
            marketTitle = marketInfo.question || marketTitle;
            break;
          }
        }

        // Create activity object for marketTracker.processTrade
        const activity = {
          transactionHash: `paper-${execution.id}`, // Mark as paper trade
          asset: signal.tokenId,
          conditionId: signal.conditionId,
          slug: marketSlug,
          eventSlug: marketSlug,
          title: marketTitle,
          size: execution.executedSize.toString(),
          price: execution.executedPrice.toString(),
          usdcSize: (execution.executedSize * execution.executedPrice).toString(),
          side: signal.side,
          outcome: signal.metadata?.outcome as string || 'Unknown',
        };

        await marketTracker.processTrade(activity);
      }
    } else {
      await this.tradeExecutor.executeWithRetry(signal);
    }
    } catch (error) {
      logger.error(`Error executing trade signal (${signal.strategyName}):`, error);
      throw error; // Re-throw to be caught by outer handler
    }
  }

  /**
   * Run one cycle of strategy analysis and execution
   */
  async runCycle(): Promise<void> {
    try {
      logger.debug("=== Bot cycle start ===");

      // Update strategy context
      const positions = this.isPaperMode
        ? this.paperTrader.getAllPositions()
        : []; // In live mode, fetch from API

      const balance = this.isPaperMode
        ? this.paperTrader.getBalance()
        : 0; // In live mode, fetch from chain

      this.strategyManager.updateContext(positions, balance);

      // Run all strategies
      const results = await this.strategyManager.runStrategies();

      // Log cycle summary for debugging
      const totalSignals = results.reduce((sum, r) => sum + r.signals.length, 0);
      if (totalSignals > 0) {
        logger.debug(`Cycle: ${results.length} strategy(s) generated ${totalSignals} signal(s)`);
      }

      // Execute signals
      for (const result of results) {
        for (const signal of result.signals) {
          try {
            await this.executeTrade(signal);
          } catch (error) {
            logger.error(`Error executing trade signal from ${result.strategy}:`, error);
          }
        }
      }
    } catch (error) {
      logger.error("Error in runCycle:", error);
      throw error; // Re-throw to be caught by outer handler
    }
  }

  /**
   * Start the bot main loop
   */
  async start(): Promise<void> {
    // Generate initial PnL report after a delay to let markets initialize
    if (this.isPaperMode && this.paperTrader) {
      setTimeout(() => {
        try {
          logger.info("Generating initial formatted PnL report...");
          this.paperTrader.generateFormattedPnLReport();
        } catch (error) {
          logger.error(`Failed to generate initial PnL report: ${error}`);
        }
      }, 10000); // Wait 10 seconds for markets to initialize
      
      // Also generate report periodically (every 5 minutes)
      setInterval(() => {
        try {
          logger.info("Generating periodic formatted PnL report...");
          this.paperTrader.generateFormattedPnLReport();
        } catch (error) {
          logger.error(`Failed to generate periodic PnL report: ${error}`);
        }
      }, 5 * 60 * 1000); // Every 5 minutes
    }
    if (this.isRunning) {
      logger.warn("Bot is already running");
      return;
    }

    this.isRunning = true;

    // In watcher mode, use marketTracker for live dashboard display
    if (this.isWatcherMode) {
      logger.info("Starting live price dashboard in watcher mode...");
      logger.info("Markets will be auto-discovered from WebSocket price stream");

      // Set display mode to WATCH
      marketTracker.setDisplayMode('WATCH');

      // Run the marketTracker display loop
      while (this.isRunning) {
        try {
          await marketTracker.displayStats();
        } catch (error) {
          logger.error("MarketTracker display error:", error);
        }
        await this.sleep(ENV.DASHBOARD_UPDATE_INTERVAL);
      }
      return;
    }

    // Normal trading mode
    const enabledStrategies = this.strategyManager.getEnabledStrategies();
    if (enabledStrategies.length === 0) {
      logger.warn("No strategies enabled - bot will run but won't trade");
      logger.info("Add strategies using bot.addStrategy(yourStrategy)");
    }

    logger.info(`Starting bot with ${enabledStrategies.length} enabled strategy(s)`);
    logger.info(`Fetch interval: ${ENV.FETCH_INTERVAL} seconds`);

    // Start dashboard if configured (but not in watcher mode - it's already started)
    if (this.dashboard && !this.isWatcherMode) {
      this.dashboard.start();
    }

    // In paper mode, also show the marketTracker dashboard
    if (this.isPaperMode) {
      marketTracker.setDisplayMode('PAPER');
      logger.info("Paper mode: Dashboard will display live market data and paper trades");

      // Set up market close callback to settle positions and return capital
      marketTracker.setMarketCloseCallback(async (closedMarket) => {
        logger.info(`Market closed: ${closedMarket.marketName}`);

        // Settle the market - return position value to balance
        // Use closing prices if available, otherwise use current prices
        // CRITICAL: Do NOT default to 0.5 - this creates wrong "Tie" outcomes
        let finalPriceUp = closedMarket.closingPriceUp ?? closedMarket.currentPriceUp;
        let finalPriceDown = closedMarket.closingPriceDown ?? closedMarket.currentPriceDown;

        // If prices are still not available or look like defaults (both ~0.5), skip PnL logging
        const pricesLookLikeDefaults = (!finalPriceUp || !finalPriceDown) ||
          (Math.abs(finalPriceUp - 0.5) < 0.01 && Math.abs(finalPriceDown - 0.5) < 0.01);

        if (pricesLookLikeDefaults) {
          logger.warn(`⚠️ Market ${closedMarket.marketName} has no valid closing prices (UP: ${finalPriceUp}, DOWN: ${finalPriceDown}) - skipping PnL log to avoid wrong outcome`);
          // Still settle the market but don't log PnL
          finalPriceUp = finalPriceUp ?? 0.5;
          finalPriceDown = finalPriceDown ?? 0.5;
        }

        // CRITICAL: Do NOT log PnL in close callback - only in pre-close callback
        // The pre-close callback (5 seconds before end) is the ONLY place PnL should be logged
        // This prevents duplicate PnL logging and ensures correct market data
        // The close callback is only for settling positions, not logging PnL

        // Settle the market with whatever prices we have (default to 0.5 if needed for settlement only)
        this.paperTrader.settleMarket(
          closedMarket.conditionId || "",
          finalPriceUp ?? 0.5,
          finalPriceDown ?? 0.5
        );
      });

      // Set up pre-close callback to log PNL 5 seconds before market ends
      // CRITICAL: This captures the FINAL PnL with settlement prices (1.0 winner, 0.0 loser)
      marketTracker.setPreCloseCallback(async (market) => {
        // CRITICAL: Capture all data IMMEDIATELY to prevent race conditions with market switch
        const capturedData = {
          marketName: market.marketName,
          conditionId: market.conditionId,
          marketKey: market.marketKey,
          sharesUp: market.sharesUp,
          sharesDown: market.sharesDown,
          totalCostUp: market.totalCostUp,
          totalCostDown: market.totalCostDown,
          currentPriceUp: market.currentPriceUp,
          currentPriceDown: market.currentPriceDown,
          assetUp: market.assetUp,
          assetDown: market.assetDown,
        };

        // Skip if no conditionId (can't track without it)
        if (!capturedData.conditionId) {
          logger.warn(`⚠️ Skipping pre-close PnL for ${capturedData.marketName} - no conditionId`);
          return;
        }

        // Skip if no shares traded
        if (capturedData.sharesUp === 0 && capturedData.sharesDown === 0) {
          return;
        }

        // CRITICAL: If prices are missing, try to fetch them NOW before logging PnL
        // This handles cases where WebSocket switched to new market before prices were captured
        if (!capturedData.currentPriceUp || !capturedData.currentPriceDown) {
          logger.warn(`⚠️ Prices missing for ${capturedData.marketName} - attempting to fetch from API...`);
          
          // Try to fetch prices from order book API as last resort
          if (capturedData.assetUp && capturedData.assetDown) {
            try {
              const fetchData = (await import('./utils/fetchData')).default;
              const [upBookData, downBookData] = await Promise.all([
                fetchData(`https://clob.polymarket.com/book?token_id=${capturedData.assetUp}`).catch(() => null),
                fetchData(`https://clob.polymarket.com/book?token_id=${capturedData.assetDown}`).catch(() => null),
              ]);

              if (upBookData && downBookData) {
                const getMidPrice = (bookData: any) => {
                  if (bookData?.bids?.length > 0 && bookData?.asks?.length > 0) {
                    const bestBid = Math.max(...bookData.bids.map((b: any) => parseFloat(b.price || 0)));
                    const bestAsk = Math.min(...bookData.asks.map((a: any) => parseFloat(a.price || 1)));
                    if (bestBid > 0 && bestAsk > 0 && bestBid <= 1 && bestAsk <= 1) {
                      return (bestBid + bestAsk) / 2;
                    }
                  }
                  return null;
                };

                const apiPriceUp = getMidPrice(upBookData);
                const apiPriceDown = getMidPrice(downBookData);

                if (apiPriceUp !== null && apiPriceDown !== null) {
                  capturedData.currentPriceUp = apiPriceUp;
                  capturedData.currentPriceDown = apiPriceDown;
                  logger.info(`✓ Successfully fetched prices from API for ${capturedData.marketName}: UP=$${apiPriceUp.toFixed(4)}, DOWN=$${apiPriceDown.toFixed(4)}`);
                }
              }
            } catch (error) {
              logger.warn(`Failed to fetch prices from API for ${capturedData.marketName}:`, error);
            }
          }

          // If still no prices after API fetch, skip PnL logging
          if (!capturedData.currentPriceUp || !capturedData.currentPriceDown) {
            logger.warn(`⚠️ Skipping pre-close PnL for ${capturedData.marketName} - prices not available after API fetch (UP: ${capturedData.currentPriceUp}, DOWN: ${capturedData.currentPriceDown})`);
            return;
          }
        }

        const normalizeClosingPrice = (price?: number | null): number => {
          if (price === undefined || price === null) return 0;
          if (price >= 0.995) return 1.0;
          if (price <= 0.005) return 0.0;
          return Number(price.toFixed(4));
        };

        capturedData.currentPriceUp = normalizeClosingPrice(capturedData.currentPriceUp);
        capturedData.currentPriceDown = normalizeClosingPrice(capturedData.currentPriceDown);

        // Determine winner based on current prices and set SETTLEMENT prices (1.0/0.0)
        let settledPriceUp: number;
        let settledPriceDown: number;
        let outcome: string;

        if (capturedData.currentPriceUp > capturedData.currentPriceDown) {
          // UP wins - UP shares pay $1, DOWN shares pay $0
          settledPriceUp = 1.0;
          settledPriceDown = 0.0;
          outcome = "UP Won";
        } else {
          // DOWN wins - DOWN shares pay $1, UP shares pay $0
          settledPriceUp = 0.0;
          settledPriceDown = 1.0;
          outcome = "DOWN Won";
        }

        // Calculate SETTLED PnL (what you actually get when market resolves)
        const settledValueUp = capturedData.sharesUp * settledPriceUp;
        const settledValueDown = capturedData.sharesDown * settledPriceDown;
        const totalPayout = settledValueUp + settledValueDown;
        const totalInvested = capturedData.totalCostUp + capturedData.totalCostDown;
        const settledPnl = totalPayout - totalInvested;
        const settledPnlPercent = totalInvested > 0 ? (settledPnl / totalInvested) * 100 : 0;

        // Calculate time until market actually ends for logging
        const now = Date.now();
        const timeUntilEnd = market.endDate ? market.endDate - now : 0;
        const timeUntilEndStr = timeUntilEnd > 0 ? `${(timeUntilEnd/1000).toFixed(1)}s` : 'ended';
        
        logger.info(`📊 Market ending in ${timeUntilEndStr}: ${capturedData.marketName} - ${outcome} - Settled PnL: ${settledPnl >= 0 ? '+' : ''}$${settledPnl.toFixed(2)} (${settledPnlPercent >= 0 ? '+' : ''}${settledPnlPercent.toFixed(1)}%) [UP: ${capturedData.currentPriceUp.toFixed(4)}, DOWN: ${capturedData.currentPriceDown.toFixed(4)}]`);

        // CRITICAL: Only log PnL if market is actually ending (within 10 seconds)
        // This prevents logging PnL for markets that are in the future
        if (timeUntilEnd > 10 * 1000) {
          logger.warn(`⚠️ Skipping PnL log for ${capturedData.marketName}: market ends in ${(timeUntilEnd/1000).toFixed(1)}s (too early, should be <10s)`);
          return;
        }

        // Log market PnL data with SETTLEMENT prices (1.0/0.0)
        // This ensures the report shows accurate settled PnL, not unrealized PnL
        this.paperTrader.logMarketPnLFromDashboard(
          capturedData.marketName || "Unknown",
          capturedData.conditionId,
          settledPnl,
          settledPnlPercent,
          capturedData.sharesUp,
          capturedData.sharesDown,
          settledPriceUp,  // Use settlement price (1.0 or 0.0)
          settledPriceDown // Use settlement price (0.0 or 1.0)
        );
      });
    }

    // Track last dashboard update time
    let lastDashboardUpdate = 0;
    const dashboardInterval = ENV.DASHBOARD_UPDATE_INTERVAL || 5000;

    while (this.isRunning) {
      try {
        // In paper mode, check and reset balance if too low (before running cycle)
        if (this.isPaperMode && this.paperTrader) {
          this.paperTrader.checkAndResetBalanceIfLow();
        }

        await this.runCycle();

        // In paper mode, periodically display the dashboard
        if (this.isPaperMode) {
          const now = Date.now();
          if (now - lastDashboardUpdate >= dashboardInterval) {
            try {
              await marketTracker.displayStats();
              lastDashboardUpdate = now;
            } catch (error) {
              logger.error("Dashboard display error:", error);
            }
          }
        }
      } catch (error) {
        logger.error("Error in bot cycle:", error);
      }

      // Wait for next cycle
      await this.sleep(ENV.FETCH_INTERVAL * 1000);
    }
  }

  /**
   * Stop the bot
   */
  async stop(): Promise<void> {
    logger.info("Stopping bot...");
    logger.closeLogFile();
    this.isRunning = false;

    // Stop config file watcher
    stopConfigWatcher();

    // Stop web dashboard server
    if (this.appServer) {
      this.appServer.stop();
    }

    // Stop dashboard
    if (this.dashboard) {
      this.dashboard.stop();
    }

    // Stop enhanced services if used
    if (ENV.USE_ENHANCED_SERVICES) {
      if (this.marketData instanceof EnhancedMarketDataService) {
        await this.marketData.stop();
      }
      if (this.tradeExecutor instanceof EnhancedTradeExecutor) {
        await this.tradeExecutor.stop();
      }
    }

    // Print final stats and generate formatted PnL report if in paper mode
    if (this.isPaperMode && !this.isWatcherMode) {
      const stats = this.paperTrader.getStats();
      logger.info("");
      logger.info("=".repeat(50));
      logger.info("PAPER TRADING SUMMARY");
      logger.info("=".repeat(50));
      logger.info(`Starting Balance: $${stats.startingBalance.toFixed(2)}`);
      logger.info(`Final Balance:    $${stats.balance.toFixed(2)}`);
      logger.info(`Total PnL:        $${stats.totalPnL.toFixed(2)}`);
      logger.info(`Total Trades:     ${stats.tradeCount}`);
      logger.info(`Win Rate:         ${stats.winRate.toFixed(1)}%`);
      logger.info(`Open Positions:   ${stats.positionCount}`);
      logger.info("=".repeat(50));
      
      // Generate formatted PnL report
      try {
        logger.info("Generating formatted PnL report...");
        this.paperTrader.generateFormattedPnLReport();
      } catch (error) {
        logger.error(`Failed to generate PnL report: ${error}`);
      }
    }

    await disconnectDB();
    logger.success("Bot stopped");
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Main entry point
async function main(): Promise<void> {
  const bot = new PolymarketBot();

  // Handle graceful shutdown
  process.on("SIGINT", async () => {
    await bot.stop();
    logger.closeLogFile();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await bot.stop();
    logger.closeLogFile();
    process.exit(0);
  });

  try {
    await bot.initialize();

    // ============================================
    // ADD YOUR STRATEGIES HERE
    // ============================================

    // Only add trading strategies if NOT in watcher mode
    if (!ENV.WATCHER_MODE) {
      // Use Inventory-Balanced Rebalancing Strategy (reads from inventory-rebalance-config.yaml)
      const { InventoryBalancedRebalancingStrategy } = await import("./strategies/inventoryRebalancing");
      const inventoryRebalancingStrategy = new InventoryBalancedRebalancingStrategy(
        {
          name: "inventory-rebalancing",
          enabled: true,
          parameters: {}, // Config loaded from inventory-rebalance-config.yaml
        },
        bot.getMarketData(),
        bot.getPaperTrader() // Pass paperTrader for balance reset on new market windows
      );
      bot.addStrategy(inventoryRebalancingStrategy);
      logger.info("Loaded Inventory-Balanced Rebalancing Strategy (config: inventory-rebalance-config.yaml)");
    }

    // ============================================

    await bot.start();
  } catch (error) {
    logger.error("Fatal error:", error);
    process.exit(1);
  }
}

// Export for programmatic use
export * from "./interfaces";
export * from "./strategies";
export { MarketDataService } from "./services/marketData";
export { EnhancedMarketDataService } from "./services/enhancedMarketData";
export { PaperTrader } from "./services/paperTrader";
export { TradeExecutor } from "./services/tradeExecutor";
export { EnhancedTradeExecutor } from "./services/enhancedTradeExecutor";
export { Dashboard } from "./services/dashboard";
export { default as priceStreamLogger } from "./services/priceStreamLogger";
export { default as marketTracker } from "./services/marketTracker";
export * from "./utils/arbitrageUtils";

// Run if called directly
main();
