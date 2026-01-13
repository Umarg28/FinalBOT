/**
 * Dashboard Data Collector
 * Aggregates data from marketTracker and priceStreamLogger for the web dashboard
 */

import marketTracker, { MarketStats } from '../../src/services/marketTracker';
import priceStreamLogger from '../../src/services/priceStreamLogger';
import { ENV } from '../../src/config/env';
import { DashboardUpdate, MarketData, PortfolioSummary, PnLHistoryEntry, ExternalBotData, BotSummary, BotPnLHistory, ExternalBotMarketsData, ExternalBotMarket, QuickStats } from './types';

// Interface for PaperTrader (injected at runtime)
interface PaperTraderInterface {
  getBalance(): number;
  getStartingBalance(): number;
  getPnLHistory(): Array<{
    marketName: string;
    conditionId: string;
    totalPnl: number;
    pnlPercent: number;
    priceUp: number;
    priceDown: number;
    sharesUp: number;
    sharesDown: number;
    timestamp: number;
  }>;
}

// Interface for MarketDataService (injected at runtime)
interface MarketDataServiceInterface {
  getUserPositions(walletAddress: string): Promise<Array<{
    conditionId: string;
    tokenId: string;
    size: number;
    avgPrice: number;
    outcome: string;
    title: string;
    slug?: string;
    endDate?: string;
  }>>;
}

export class DashboardDataCollector {
  private paperTrader: PaperTraderInterface | null = null;
  private externalBotsGetter: (() => Map<string, { data: ExternalBotData; lastUpdate: number }>) | null = null;
  private marketData: MarketDataServiceInterface | null = null;
  private lastWatcherSync = 0;
  private watcherSyncInterval = 5000; // Sync every 5 seconds

  /**
   * Set the paper trader instance (called from main bot)
   */
  setPaperTrader(trader: PaperTraderInterface): void {
    this.paperTrader = trader;
  }

  /**
   * Set the external bots getter function
   */
  setExternalBotsGetter(getter: () => Map<string, { data: ExternalBotData; lastUpdate: number }>): void {
    this.externalBotsGetter = getter;
  }

  /**
   * Set the market data service (for watcher mode position syncing)
   */
  setMarketData(service: MarketDataServiceInterface): void {
    this.marketData = service;
  }

  /**
   * Get all bot summaries (main + external) with market type breakdown
   */
  getBotSummaries(): BotSummary[] {
    const bots: BotSummary[] = [];

    // Main bot - get full portfolio data with 15m/1h breakdown
    const mainPortfolio = this.calculateMainBotPortfolio();
    const mainHistory = this.getPnLHistory();
    const mainWins = mainHistory.filter(h => h.totalPnl > 0).length;

    bots.push({
      botId: 'main',
      botName: 'BETABOT (Main)',
      balance: mainPortfolio.balance,
      totalPnL: mainPortfolio.totalPnL,
      totalPnLPercent: mainPortfolio.totalPnLPercent,
      totalTrades: mainPortfolio.totalTrades,
      winRate: mainHistory.length > 0 ? (mainWins / mainHistory.length) * 100 : 0,
      lastUpdate: Date.now(),
      pnl15m: mainPortfolio.pnl15m,
      pnl15mPercent: mainPortfolio.pnl15mPercent,
      trades15m: mainPortfolio.trades15m,
      pnl1h: mainPortfolio.pnl1h,
      pnl1hPercent: mainPortfolio.pnl1hPercent,
      trades1h: mainPortfolio.trades1h,
    });

    // External bots
    if (this.externalBotsGetter) {
      const externalBots = this.externalBotsGetter();
      const staleThreshold = 5 * 60 * 1000;
      const now = Date.now();

      for (const [botId, entry] of externalBots.entries()) {
        if (now - entry.lastUpdate > staleThreshold) continue;

        const history = entry.data.pnlHistory || [];
        const wins = history.filter(h => h.totalPnl > 0).length;
        const portfolio = entry.data.portfolio;

        bots.push({
          botId,
          botName: entry.data.botName,
          balance: portfolio.balance,
          totalPnL: portfolio.totalPnL,
          totalPnLPercent: portfolio.totalPnLPercent,
          totalTrades: portfolio.totalTrades,
          winRate: history.length > 0 ? (wins / history.length) * 100 : 0,
          lastUpdate: entry.lastUpdate,
          pnl15m: portfolio.pnl15m ?? 0,
          pnl15mPercent: portfolio.pnl15mPercent ?? 0,
          trades15m: portfolio.trades15m ?? 0,
          pnl1h: portfolio.pnl1h ?? 0,
          pnl1hPercent: portfolio.pnl1hPercent ?? 0,
          trades1h: portfolio.trades1h ?? 0,
        });
      }
    }

    return bots;
  }

  /**
   * Get PnL history for all bots (for history tab selector)
   */
  getAllBotsHistory(): BotPnLHistory[] {
    const allHistory: BotPnLHistory[] = [];

    // Main bot history
    allHistory.push({
      botId: 'main',
      botName: 'BETABOT (Main)',
      history: this.getPnLHistory(),
    });

    // External bots history
    if (this.externalBotsGetter) {
      const externalBots = this.externalBotsGetter();
      const staleThreshold = 5 * 60 * 1000;
      const now = Date.now();

      for (const [botId, entry] of externalBots.entries()) {
        if (now - entry.lastUpdate > staleThreshold) continue;

        const history: PnLHistoryEntry[] = (entry.data.pnlHistory || []).map(h => ({
          marketName: h.marketName,
          conditionId: '',
          totalPnl: h.totalPnl,
          pnlPercent: h.pnlPercent,
          priceUp: 0,
          priceDown: 0,
          sharesUp: 0,
          sharesDown: 0,
          timestamp: h.timestamp,
          outcome: (h.outcome === 'WIN' || h.outcome === 'UP' ? 'UP' : 'DOWN') as 'UP' | 'DOWN' | 'UNKNOWN',
        }));

        allHistory.push({
          botId,
          botName: entry.data.botName,
          history,
        });
      }
    }

    return allHistory;
  }

  /**
   * Get external bots' market data for display
   * Supports both new full format (currentMarkets) and legacy format (markets)
   */
  getExternalBotsMarkets(): ExternalBotMarketsData[] {
    const result: ExternalBotMarketsData[] = [];

    if (this.externalBotsGetter) {
      const externalBots = this.externalBotsGetter();
      const staleThreshold = 5 * 60 * 1000;
      const now = Date.now();

      for (const [botId, entry] of externalBots.entries()) {
        if (now - entry.lastUpdate > staleThreshold) continue;

        let markets: ExternalBotMarket[] = [];

        // Prefer new full format (currentMarkets)
        if (entry.data.currentMarkets && entry.data.currentMarkets.length > 0) {
          markets = entry.data.currentMarkets.map(m => ({
            marketKey: m.marketKey,
            marketName: m.marketName,
            category: m.category,
            endDate: m.endDate,
            timeRemaining: m.timeRemaining,
            isExpired: m.isExpired,
            priceUp: m.priceUp,
            priceDown: m.priceDown,
            sharesUp: m.sharesUp,
            sharesDown: m.sharesDown,
            investedUp: m.investedUp ?? 0,
            investedDown: m.investedDown ?? 0,
            totalCostUp: m.totalCostUp ?? 0,
            totalCostDown: m.totalCostDown ?? 0,
            currentValueUp: m.currentValueUp ?? 0,
            currentValueDown: m.currentValueDown ?? 0,
            pnlUp: m.pnlUp ?? 0,
            pnlDown: m.pnlDown ?? 0,
            pnlUpPercent: m.pnlUpPercent ?? 0,
            pnlDownPercent: m.pnlDownPercent ?? 0,
            totalPnL: m.totalPnL,
            totalPnLPercent: m.totalPnLPercent ?? 0,
            tradesUp: m.tradesUp ?? 0,
            tradesDown: m.tradesDown ?? 0,
            upPercent: m.upPercent ?? 50,
            downPercent: m.downPercent ?? 50,
          }));
        }
        // Fall back to legacy format
        else if (entry.data.markets && entry.data.markets.length > 0) {
          markets = entry.data.markets.map(m => ({
            marketKey: m.marketName,
            marketName: m.marketName,
            priceUp: m.priceUp ?? 0,
            priceDown: m.priceDown ?? 0,
            sharesUp: m.sharesUp,
            sharesDown: m.sharesDown,
            totalPnL: m.totalPnL,
          }));
        }

        result.push({
          botId,
          botName: entry.data.botName,
          markets,
          // Also pass through upcoming markets if available
          upcomingMarkets: entry.data.upcomingMarkets?.map(m => ({
            marketKey: m.marketKey,
            marketName: m.marketName,
            category: m.category,
            endDate: m.endDate,
            timeRemaining: m.timeRemaining,
            priceUp: m.priceUp,
            priceDown: m.priceDown,
            sharesUp: m.sharesUp,
            sharesDown: m.sharesDown,
            investedUp: m.investedUp ?? 0,
            investedDown: m.investedDown ?? 0,
            totalCostUp: m.totalCostUp ?? 0,
            totalCostDown: m.totalCostDown ?? 0,
            totalPnL: m.totalPnL,
            totalPnLPercent: m.totalPnLPercent ?? 0,
            tradesUp: m.tradesUp ?? 0,
            tradesDown: m.tradesDown ?? 0,
          })),
        });
      }
    }

    return result;
  }

  /**
   * Calculate main bot portfolio with market type breakdown
   */
  private calculateMainBotPortfolio(): PortfolioSummary {
    const marketsMap = marketTracker.getMarkets();
    const markets = Array.from(marketsMap.values());

    let openPnL = 0;
    let openCostBasis = 0;
    let openTrades = 0;
    let pnl15m = 0, costBasis15m = 0, trades15m = 0;
    let pnl1h = 0, costBasis1h = 0, trades1h = 0;

    for (const m of markets) {
      // Use same validation as terminal's renderMarket function
      // Valid price = > 0 AND <= 1 (excludes resolved markets where price = 1.0 or 0.0)
      const hasValidPriceUp = m.currentPriceUp !== undefined &&
                              m.currentPriceUp > 0 &&
                              m.currentPriceUp <= 1;
      const hasValidPriceDown = m.currentPriceDown !== undefined &&
                                m.currentPriceDown > 0 &&
                                m.currentPriceDown <= 1;

      const costBasis = m.totalCostUp + m.totalCostDown;
      const trades = m.tradesUp + m.tradesDown;

      let pnl = 0;
      if (hasValidPriceUp && m.sharesUp > 0) {
        pnl += (m.sharesUp * m.currentPriceUp!) - m.totalCostUp;
      }
      if (hasValidPriceDown && m.sharesDown > 0) {
        pnl += (m.sharesDown * m.currentPriceDown!) - m.totalCostDown;
      }

      openPnL += pnl;
      openCostBasis += costBasis;
      openTrades += trades;

      const is15m = m.marketKey.includes('-15');
      const is1h = m.marketKey.includes('-1h');

      if (is15m) {
        pnl15m += pnl;
        costBasis15m += costBasis;
        trades15m += trades;
      } else if (is1h) {
        pnl1h += pnl;
        costBasis1h += costBasis;
        trades1h += trades;
      }
    }

    const startingBalance = this.paperTrader?.getStartingBalance() ?? 10000;
    const history = this.paperTrader ? this.paperTrader.getPnLHistory() : [];
    let realizedPnL = 0;
    let realizedCostBasis = 0;
    let realizedTrades = 0;

    if (history && history.length > 0) {
      realizedTrades = history.length;
      for (const entry of history) {
        const entryPnL = entry.totalPnl ?? 0;
        realizedPnL += entryPnL;
        const costBasis = (entry as any).marketPnL?.totalCostBasis;
        if (typeof costBasis === 'number' && isFinite(costBasis) && costBasis > 0) {
          realizedCostBasis += costBasis;
        } else {
          const approx =
            ((entry.priceUp || 0) * (entry.sharesUp || 0)) +
            ((entry.priceDown || 0) * (entry.sharesDown || 0));
          realizedCostBasis += approx;
        }
      }
    }

    const walletBalance = startingBalance + realizedPnL;
    const openValue = openCostBasis + openPnL;
    const totalPnL = realizedPnL + openPnL;
    const totalValue = walletBalance + openValue;
    const totalPnLPercent = startingBalance > 0 ? (totalPnL / startingBalance) * 100 : 0;

    return {
      totalInvested: openCostBasis,
      totalCostBasis: openCostBasis,
      totalValue,
      totalPnL,
      totalPnLPercent,
      realizedPnL,
      openPnL,
      realizedCostBasis,
      invested15m: costBasis15m,
      value15m: costBasis15m + pnl15m,
      pnl15m,
      pnl15mPercent: costBasis15m > 0 ? (pnl15m / costBasis15m) * 100 : 0,
      trades15m,
      invested1h: costBasis1h,
      value1h: costBasis1h + pnl1h,
      pnl1h,
      pnl1hPercent: costBasis1h > 0 ? (pnl1h / costBasis1h) * 100 : 0,
      trades1h,
      balance: walletBalance,
      startingBalance,
      totalTrades: openTrades + realizedTrades,
    };
  }

  /**
   * Get the current dashboard state as a WebSocket message
   */
  async getDashboardUpdate(): Promise<DashboardUpdate> {
    const now = Date.now();

    // In watcher mode, sync positions from getUserPositions to marketTracker
    if ((ENV.WATCHER_MODE || ENV.TRACK_ONLY_MODE) && this.marketData && ENV.USER_ADDRESSES && ENV.USER_ADDRESSES.length > 0) {
      const timeSinceLastSync = now - this.lastWatcherSync;
      if (timeSinceLastSync >= this.watcherSyncInterval) {
        try {
          // Fetch positions from all watched addresses
          const allPositions: Array<{
            conditionId: string;
            tokenId: string;
            size: number;
            avgPrice: number;
            outcome: string;
            title: string;
            slug?: string;
            endDate?: string;
          }> = [];

          for (const address of ENV.USER_ADDRESSES) {
            const positions = await this.marketData.getUserPositions(address);
            allPositions.push(...positions);
          }

          // Build market data map for sync
          const marketDataMap = new Map<string, {
            conditionId: string;
            priceUp: number;
            priceDown: number;
            assetUp?: string;
            assetDown?: string;
            endDate?: number;
            marketKey?: string;
            marketName?: string;
          }>();

          // Get current markets to build the map
          const currentMarkets = priceStreamLogger.getCurrentMarkets();
          const nextMarkets = priceStreamLogger.getNextMarkets();

          // Build market data from stream info
          for (const [marketType, info] of [...currentMarkets.entries(), ...nextMarkets.entries()]) {
            if (info.condition_id) {
              const upToken = info.tokens?.find((t: any) => t.outcome === 'Yes' || t.outcome === 'Up' || t.token_id?.endsWith(':0'));
              const downToken = info.tokens?.find((t: any) => t.outcome === 'No' || t.outcome === 'Down' || t.token_id?.endsWith(':1'));

              // Get prices from marketTracker if available
              const marketsMap = marketTracker.getMarkets();
              let priceUp = 0;
              let priceDown = 0;
              let assetUp: string | undefined;
              let assetDown: string | undefined;

              // Try to find market by conditionId
              for (const market of marketsMap.values()) {
                if (market.conditionId === info.condition_id) {
                  priceUp = market.currentPriceUp || 0;
                  priceDown = market.currentPriceDown || 0;
                  assetUp = market.assetUp;
                  assetDown = market.assetDown;
                  break;
                }
              }

              // Fallback to token prices if available
              if (priceUp === 0 && upToken?.token_id) {
                assetUp = upToken.token_id;
              }
              if (priceDown === 0 && downToken?.token_id) {
                assetDown = downToken.token_id;
              }

              marketDataMap.set(info.condition_id, {
                conditionId: info.condition_id,
                priceUp,
                priceDown,
                assetUp,
                assetDown,
                endDate: info.end_date_iso ? new Date(info.end_date_iso).getTime() : undefined,
                marketName: info.question,
              });
            }
          }

          // Sync positions to marketTracker
          if (allPositions.length > 0) {
            marketTracker.syncWatcherPositions(allPositions, marketDataMap);
            this.lastWatcherSync = now;
          }
        } catch (error) {
          console.error('[DASHBOARD] Error syncing watcher positions:', error);
        }
      }
    }

    // Get all markets from tracker
    const marketsMap = marketTracker.getMarkets();
    const markets = Array.from(marketsMap.values());

    // Get stream info to determine current vs upcoming
    const currentMarketsFromStream = priceStreamLogger.getCurrentMarkets();
    const nextMarketsFromStream = priceStreamLogger.getNextMarkets();

    // Build set of next market condition IDs for classification
    const nextConditionIds = new Set<string>();
    const nextAssetIds = new Set<string>();
    for (const info of nextMarketsFromStream.values()) {
      if (info.condition_id) nextConditionIds.add(info.condition_id);
      for (const token of info.tokens || []) {
        if (token.token_id) nextAssetIds.add(token.token_id);
      }
    }

    // Transform and classify markets
    const allMarketData: MarketData[] = markets.map(m => this.transformMarket(m, now));

    // Separate current vs upcoming
    const currentMarkets: MarketData[] = [];
    const upcomingMarkets: MarketData[] = [];

    for (let i = 0; i < markets.length; i++) {
      const market = markets[i];
      const marketData = allMarketData[i];

      const isUpcoming = this.isMarketUpcoming(market, nextConditionIds, nextAssetIds, now);

      if (isUpcoming) {
        upcomingMarkets.push(marketData);
      } else {
        currentMarkets.push(marketData);
      }
    }

    // Sort current by invested amount (descending)
    currentMarkets.sort((a, b) => (b.investedUp + b.investedDown) - (a.investedUp + a.investedDown));

    // Sort upcoming by end date (soonest first), selecting one per category
    const upcomingByCategory = new Map<string, MarketData>();
    upcomingMarkets.sort((a, b) => (a.endDate || Infinity) - (b.endDate || Infinity));
    for (const m of upcomingMarkets) {
      if (!upcomingByCategory.has(m.category)) {
        upcomingByCategory.set(m.category, m);
      }
    }

    // Calculate portfolio summary
    const portfolio = this.calculatePortfolio(currentMarkets, Array.from(upcomingByCategory.values()));

    // Determine mode
    let mode: 'PAPER' | 'WATCH' | 'TRADING' = 'TRADING';
    if (ENV.PAPER_MODE) mode = 'PAPER';
    else if (ENV.TRACK_ONLY_MODE || ENV.WATCHER_MODE) mode = 'WATCH';

    // Get PnL history (main bot only for backwards compat)
    const pnlHistory = this.getPnLHistory();

    // Get all bots' history for the history tab selector
    const allBotsHistory = this.getAllBotsHistory();

    // Get bot summaries
    const bots = this.getBotSummaries();

    // Get external bots' market data
    const externalBotsMarkets = this.getExternalBotsMarkets();

    // Calculate quick stats from PnL history
    const quickStats = this.calculateQuickStats(pnlHistory);

    return {
      type: 'dashboard_update',
      timestamp: now,
      data: {
        mode,
        currentMarkets: currentMarkets.slice(0, 4),
        upcomingMarkets: Array.from(upcomingByCategory.values()).slice(0, 4),
        portfolio,
        pnlHistory,
        allBotsHistory,
        bots,
        externalBotsMarkets,
        quickStats,
      },
    };
  }

  /**
   * Calculate quick stats from PnL history
   */
  private calculateQuickStats(history: PnLHistoryEntry[]): QuickStats {
    if (history.length === 0) {
      return {
        winRate: 0,
        avgWin: 0,
        avgLoss: 0,
        profitFactor: 0,
      };
    }

    const wins = history.filter(h => h.totalPnl > 0);
    const losses = history.filter(h => h.totalPnl < 0);

    const winRate = (wins.length / history.length) * 100;

    const totalWinAmount = wins.reduce((sum, h) => sum + h.totalPnl, 0);
    const totalLossAmount = Math.abs(losses.reduce((sum, h) => sum + h.totalPnl, 0));

    const avgWin = wins.length > 0 ? totalWinAmount / wins.length : 0;
    const avgLoss = losses.length > 0 ? totalLossAmount / losses.length : 0;

    // Profit factor = total wins / total losses (avoid division by zero)
    const profitFactor = totalLossAmount > 0 ? totalWinAmount / totalLossAmount : totalWinAmount > 0 ? Infinity : 0;

    return {
      winRate,
      avgWin,
      avgLoss,
      profitFactor: isFinite(profitFactor) ? profitFactor : 99.99, // Cap display at 99.99
    };
  }

  /**
   * Get PnL history from paper trader
   */
  private getPnLHistory(): PnLHistoryEntry[] {
    if (!this.paperTrader) return [];

    try {
      const history = this.paperTrader.getPnLHistory();
      return history.map(entry => ({
        ...entry,
        outcome: entry.priceUp > entry.priceDown ? 'UP' :
                 entry.priceDown > entry.priceUp ? 'DOWN' : 'UNKNOWN'
      }));
    } catch (e) {
      return [];
    }
  }

  /**
   * Transform a MarketStats to MarketData for the frontend
   */
  private transformMarket(market: MarketStats, now: number): MarketData {
    const totalInvested = market.investedUp + market.investedDown;
    const totalCostBasis = market.totalCostUp + market.totalCostDown;

    // Calculate current values
    let currentValueUp = 0;
    let currentValueDown = 0;
    let pnlUp = 0;
    let pnlDown = 0;

    if (market.currentPriceUp && market.currentPriceUp > 0 && market.sharesUp > 0) {
      currentValueUp = market.sharesUp * market.currentPriceUp;
      pnlUp = currentValueUp - market.totalCostUp;
    }

    if (market.currentPriceDown && market.currentPriceDown > 0 && market.sharesDown > 0) {
      currentValueDown = market.sharesDown * market.currentPriceDown;
      pnlDown = currentValueDown - market.totalCostDown;
    }

    const totalPnL = pnlUp + pnlDown;
    const totalPnLPercent = totalCostBasis > 0 ? (totalPnL / totalCostBasis) * 100 : 0;
    const pnlUpPercent = market.totalCostUp > 0 ? (pnlUp / market.totalCostUp) * 100 : 0;
    const pnlDownPercent = market.totalCostDown > 0 ? (pnlDown / market.totalCostDown) * 100 : 0;

    // Calculate distribution
    const upPercent = totalInvested > 0 ? (market.investedUp / totalInvested) * 100 : 50;
    const downPercent = totalInvested > 0 ? (market.investedDown / totalInvested) * 100 : 50;

    // Calculate time remaining
    let timeRemaining = '';
    let isExpired = false;

    // Use same validation as terminal - valid price = > 0 AND <= 1
    const hasValidPriceUp = market.currentPriceUp !== undefined &&
                            market.currentPriceUp > 0 &&
                            market.currentPriceUp <= 1;
    const hasValidPriceDown = market.currentPriceDown !== undefined &&
                              market.currentPriceDown > 0 &&
                              market.currentPriceDown <= 1;
    const hasAnyValidPrice = hasValidPriceUp || hasValidPriceDown;

    if (market.endDate) {
      const timeLeftMs = market.endDate - now;
      if (timeLeftMs > 0 && hasAnyValidPrice) {
        const mins = Math.floor(timeLeftMs / 60000);
        const secs = Math.floor((timeLeftMs % 60000) / 1000);
        timeRemaining = `${mins}m ${secs}s`;
      } else {
        timeRemaining = 'Expired';
        isExpired = true;
      }
    } else if (!hasAnyValidPrice) {
      // Market has no endDate and no valid prices - mark as expired
      timeRemaining = 'Resolved';
      isExpired = true;
    }

    // Determine leading side based on current prices
    let leadingSide: 'UP' | 'DOWN' | 'TIE' | 'UNKNOWN' = 'UNKNOWN';
    let leadingConfidence = 0;

    if (hasValidPriceUp && hasValidPriceDown) {
      const priceUp = market.currentPriceUp ?? 0;
      const priceDown = market.currentPriceDown ?? 0;
      const diff = Math.abs(priceUp - priceDown);
      if (diff < 0.005) {
        leadingSide = 'TIE';
      } else {
        leadingSide = priceUp > priceDown ? 'UP' : 'DOWN';
      }
      leadingConfidence = diff * 100;
    } else if (hasValidPriceUp) {
      const priceUp = market.currentPriceUp ?? 0.5;
      leadingSide = priceUp >= 0.5 ? 'UP' : 'DOWN';
      leadingConfidence = Math.abs(priceUp - 0.5) * 200;
    } else if (hasValidPriceDown) {
      const priceDown = market.currentPriceDown ?? 0.5;
      leadingSide = priceDown >= 0.5 ? 'DOWN' : 'UP';
      leadingConfidence = Math.abs(priceDown - 0.5) * 200;
    }

    if (!isFinite(leadingConfidence) || leadingConfidence < 0) {
      leadingConfidence = 0;
    }
    leadingConfidence = Math.min(leadingConfidence, 100);

    // Determine category
    let category = 'Unknown';
    if (market.marketKey.includes('BTC') && market.marketKey.includes('-15')) {
      category = 'BTC-15m';
    } else if (market.marketKey.includes('ETH') && market.marketKey.includes('-15')) {
      category = 'ETH-15m';
    } else if (market.marketKey.includes('BTC') && market.marketKey.includes('-1h')) {
      category = 'BTC-1h';
    } else if (market.marketKey.includes('ETH') && market.marketKey.includes('-1h')) {
      category = 'ETH-1h';
    }

    return {
      marketKey: market.marketKey,
      marketName: market.marketName,
      category,
      endDate: market.endDate || null,
      timeRemaining,
      isExpired,
      leadingSide,
      leadingConfidence,
      priceUp: market.currentPriceUp || null,
      priceDown: market.currentPriceDown || null,
      sharesUp: market.sharesUp,
      sharesDown: market.sharesDown,
      investedUp: market.investedUp,
      investedDown: market.investedDown,
      totalCostUp: market.totalCostUp,
      totalCostDown: market.totalCostDown,
      currentValueUp,
      currentValueDown,
      pnlUp,
      pnlDown,
      pnlUpPercent,
      pnlDownPercent,
      totalPnL,
      totalPnLPercent,
      tradesUp: market.tradesUp,
      tradesDown: market.tradesDown,
      upPercent,
      downPercent,
    };
  }

  /**
   * Check if a market is upcoming (vs current)
   */
  private isMarketUpcoming(
    market: MarketStats,
    nextConditionIds: Set<string>,
    nextAssetIds: Set<string>,
    now: number
  ): boolean {
    // Match by condition ID
    if (market.conditionId && nextConditionIds.has(market.conditionId)) {
      return true;
    }

    // Match by asset ID
    if (market.assetUp && nextAssetIds.has(market.assetUp)) {
      return true;
    }
    if (market.assetDown && nextAssetIds.has(market.assetDown)) {
      return true;
    }

    // Fallback: use time-based logic
    if (market.endDate) {
      const timeLeft = market.endDate - now;
      const is15Min = market.marketKey.includes('-15');
      const is1Hour = market.marketKey.includes('-1h');

      // If time remaining is more than window duration, it's upcoming
      if (is15Min && timeLeft > 15 * 60 * 1000) return true;
      if (is1Hour && timeLeft > 60 * 60 * 1000) return true;
    }

    return false;
  }

  /**
   * Calculate portfolio summary from all markets
   */
  private calculatePortfolio(currentMarkets: MarketData[], upcomingMarkets: MarketData[]): PortfolioSummary {
    // Filter out expired markets to prevent accumulating PnL from resolved/past markets
    const activeCurrentMarkets = currentMarkets.filter(m => !m.isExpired);
    const allMarkets = [...activeCurrentMarkets, ...upcomingMarkets];

    let totalInvested = 0;
    let totalCostBasis = 0;
    let totalValue = 0;
    let totalPnL = 0;
    let totalTrades = 0;

    let invested15m = 0;
    let value15m = 0;
    let pnl15m = 0;
    let costBasis15m = 0;
    let trades15m = 0;

    let invested1h = 0;
    let value1h = 0;
    let pnl1h = 0;
    let costBasis1h = 0;
    let trades1h = 0;
    
    let totalUpShares = 0;
    let totalDownShares = 0;

    for (const m of allMarkets) {
      const invested = m.investedUp + m.investedDown;
      const costBasis = m.totalCostUp + m.totalCostDown;
      const value = m.currentValueUp + m.currentValueDown;
      const trades = m.tradesUp + m.tradesDown;

      totalInvested += invested;
      totalCostBasis += costBasis;
      totalValue += value;
      totalPnL += m.totalPnL;
      totalTrades += trades;
      totalUpShares += m.sharesUp;
      totalDownShares += m.sharesDown;

      if (m.category.includes('15m')) {
        invested15m += invested;
        costBasis15m += costBasis;
        value15m += value;
        pnl15m += m.totalPnL;
        trades15m += trades;
      } else if (m.category.includes('1h')) {
        invested1h += invested;
        costBasis1h += costBasis;
        value1h += value;
        pnl1h += m.totalPnL;
        trades1h += trades;
      }
    }

    const totalPnLPercent = totalCostBasis > 0 ? (totalPnL / totalCostBasis) * 100 : 0;
    const pnl15mPercent = costBasis15m > 0 ? (pnl15m / costBasis15m) * 100 : 0;
    const pnl1hPercent = costBasis1h > 0 ? (pnl1h / costBasis1h) * 100 : 0;

    // Get balance from paper trader if available
    const balance = this.paperTrader?.getBalance() ?? 10000;
    const startingBalance = this.paperTrader?.getStartingBalance() ?? 10000;

    return {
      totalInvested,
      totalCostBasis,
      totalValue,
      totalPnL,
      totalPnLPercent,
      invested15m,
      value15m,
      pnl15m,
      pnl15mPercent,
      trades15m,
      invested1h,
      value1h,
      pnl1h,
      pnl1hPercent,
      trades1h,
      balance,
      startingBalance,
      totalTrades,
      totalUpShares,
      totalDownShares,
    };
  }
}

// Singleton instance
export const dashboardDataCollector = new DashboardDataCollector();
export default dashboardDataCollector;
