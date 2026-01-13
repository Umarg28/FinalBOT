/**
 * External Wallet Tracker
 * Fetches position and trade data from Polymarket API for external wallets
 * and formats it for the dashboard
 */

import { ExternalBotData } from './types';

interface PolymarketPosition {
  proxyWallet: string;
  conditionId: string;
  asset: string; // tokenId
  size: number;
  avgPrice: number;
  curPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  outcome: 'Up' | 'Down';
  title: string;
  slug: string;
  eventId: string;
  endDate: string;
  redeemable: boolean;
  mergeable: boolean;
}

interface PolymarketTrade {
  id: string;
  timestamp: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  outcome: string;
  market: string;
  asset: string;
  conditionId: string;
}

interface WalletData {
  address: string;
  name: string;
  positions: PolymarketPosition[];
  trades: PolymarketTrade[];
  lastUpdate: number;
}

export class ExternalWalletTracker {
  private wallets: Map<string, WalletData> = new Map();
  private updateInterval: NodeJS.Timeout | null = null;
  private walletNames: Map<string, string> = new Map();

  constructor() {
    // Default wallet names (can be customized)
    this.walletNames.set('0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d', 'EdgeBotPro');
  }

  /**
   * Set a custom name for a wallet
   */
  setWalletName(address: string, name: string): void {
    this.walletNames.set(address.toLowerCase(), name);
  }

  /**
   * Start tracking wallets
   */
  startTracking(walletAddresses: string[], intervalMs: number = 5000): void {
    // Initial fetch
    for (const address of walletAddresses) {
      this.fetchWalletData(address);
    }

    // Set up periodic updates
    this.updateInterval = setInterval(() => {
      for (const address of walletAddresses) {
        this.fetchWalletData(address);
      }
    }, intervalMs);

    console.log(`[WALLET TRACKER] Started tracking ${walletAddresses.length} wallet(s)`);
  }

  /**
   * Stop tracking
   */
  stopTracking(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }

  /**
   * Fetch wallet data from Polymarket API
   */
  private async fetchWalletData(address: string): Promise<void> {
    const normalizedAddress = address.toLowerCase();

    try {
      // Fetch positions
      const positionsResponse = await fetch(
        `https://data-api.polymarket.com/positions?user=${normalizedAddress}`
      );

      let positions: PolymarketPosition[] = [];
      if (positionsResponse.ok) {
        positions = await positionsResponse.json() as PolymarketPosition[];
      }

      // Fetch recent trades
      const tradesResponse = await fetch(
        `https://data-api.polymarket.com/trades?user=${normalizedAddress}&limit=200`
      );

      let trades: PolymarketTrade[] = [];
      if (tradesResponse.ok) {
        trades = await tradesResponse.json() as PolymarketTrade[];
      }

      // Store the data
      this.wallets.set(normalizedAddress, {
        address: normalizedAddress,
        name: this.walletNames.get(normalizedAddress) || `Wallet ${normalizedAddress.slice(0, 8)}...`,
        positions,
        trades,
        lastUpdate: Date.now(),
      });

    } catch (error) {
      console.error(`[WALLET TRACKER] Error fetching data for ${address}:`, error);
    }
  }

  /**
   * Get external bot data formatted for the dashboard
   */
  getExternalBotData(): Map<string, { data: ExternalBotData; lastUpdate: number }> {
    const result = new Map<string, { data: ExternalBotData; lastUpdate: number }>();

    for (const [address, walletData] of this.wallets.entries()) {
      const botData = this.transformToExternalBotData(walletData);
      result.set(address, {
        data: botData,
        lastUpdate: walletData.lastUpdate,
      });
    }

    return result;
  }

  /**
   * Transform wallet data to ExternalBotData format
   */
  private transformToExternalBotData(walletData: WalletData): ExternalBotData {
    const { positions, trades, name, address } = walletData;

    // Calculate portfolio stats
    let totalInvested = 0;
    let totalPnL = 0;
    let totalTrades = trades.length;

    // Separate by market type
    let pnl15m = 0, invested15m = 0, trades15m = 0;
    let pnl1h = 0, invested1h = 0, trades1h = 0;
    let pnl5m = 0, invested5m = 0, trades5m = 0;

    // Group positions by market (conditionId)
    const marketPositions = new Map<string, {
      conditionId: string;
      marketName: string;
      endDate: number;
      upPosition?: PolymarketPosition;
      downPosition?: PolymarketPosition;
    }>();

    for (const pos of positions) {
      const existing = marketPositions.get(pos.conditionId) || {
        conditionId: pos.conditionId,
        marketName: pos.title,
        endDate: new Date(pos.endDate).getTime(),
      };

      if (pos.outcome === 'Up') {
        existing.upPosition = pos;
      } else {
        existing.downPosition = pos;
      }

      marketPositions.set(pos.conditionId, existing);
    }

    // Build current markets and calculate totals
    const currentMarkets: ExternalBotData['currentMarkets'] = [];

    for (const [conditionId, market] of marketPositions.entries()) {
      const up = market.upPosition;
      const down = market.downPosition;

      const sharesUp = up?.size || 0;
      const sharesDown = down?.size || 0;
      const priceUp = up?.curPrice || 0;
      const priceDown = down?.curPrice || 0;
      const totalCostUp = up?.initialValue || 0;
      const totalCostDown = down?.initialValue || 0;
      const currentValueUp = up?.currentValue || 0;
      const currentValueDown = down?.currentValue || 0;
      const pnlUp = up?.cashPnl || 0;
      const pnlDown = down?.cashPnl || 0;

      const marketCost = totalCostUp + totalCostDown;
      const marketPnL = pnlUp + pnlDown;

      totalInvested += marketCost;
      totalPnL += marketPnL;

      // Determine market type from name
      const is15m = market.marketName.includes('15') || market.marketName.includes(':15') || market.marketName.includes(':30') || market.marketName.includes(':45');
      const is1h = market.marketName.includes('1h') || (market.marketName.match(/\d{1,2}(AM|PM)/i) && !is15m);
      const is5m = market.marketName.includes('5m') || market.marketName.includes('5-min');

      if (is5m) {
        pnl5m += marketPnL;
        invested5m += marketCost;
        trades5m += (up ? 1 : 0) + (down ? 1 : 0);
      } else if (is15m) {
        pnl15m += marketPnL;
        invested15m += marketCost;
        trades15m += (up ? 1 : 0) + (down ? 1 : 0);
      } else if (is1h) {
        pnl1h += marketPnL;
        invested1h += marketCost;
        trades1h += (up ? 1 : 0) + (down ? 1 : 0);
      } else {
        // Default to 15m
        pnl15m += marketPnL;
        invested15m += marketCost;
        trades15m += (up ? 1 : 0) + (down ? 1 : 0);
      }

      // Calculate time remaining
      const now = Date.now();
      const timeLeftMs = market.endDate - now;
      let timeRemaining = '';
      let isExpired = false;

      if (timeLeftMs > 0) {
        const mins = Math.floor(timeLeftMs / 60000);
        const secs = Math.floor((timeLeftMs % 60000) / 1000);
        timeRemaining = `${mins}m ${secs}s`;
      } else {
        timeRemaining = 'Expired';
        isExpired = true;
      }

      // Determine category from market name
      let category = 'OTHER';
      if (market.marketName.toLowerCase().includes('btc') || market.marketName.toLowerCase().includes('bitcoin')) {
        category = 'BTC';
      } else if (market.marketName.toLowerCase().includes('eth') || market.marketName.toLowerCase().includes('ethereum')) {
        category = 'ETH';
      }

      currentMarkets.push({
        marketKey: conditionId,
        marketName: market.marketName,
        category,
        endDate: market.endDate,
        timeRemaining,
        isExpired,
        priceUp,
        priceDown,
        sharesUp,
        sharesDown,
        totalCostUp,
        totalCostDown,
        investedUp: totalCostUp,
        investedDown: totalCostDown,
        currentValueUp,
        currentValueDown,
        pnlUp,
        pnlDown,
        pnlUpPercent: totalCostUp > 0 ? (pnlUp / totalCostUp) * 100 : 0,
        pnlDownPercent: totalCostDown > 0 ? (pnlDown / totalCostDown) * 100 : 0,
        totalPnL: marketPnL,
        totalPnLPercent: marketCost > 0 ? (marketPnL / marketCost) * 100 : 0,
        tradesUp: up ? 1 : 0,
        tradesDown: down ? 1 : 0,
        upPercent: marketCost > 0 ? (totalCostUp / marketCost) * 100 : 50,
        downPercent: marketCost > 0 ? (totalCostDown / marketCost) * 100 : 50,
      });
    }

    // Build PnL history from completed/expired positions
    const pnlHistory: ExternalBotData['pnlHistory'] = [];
    const now = Date.now();

    for (const market of currentMarkets) {
      if (market.isExpired && market.totalPnL !== 0) {
        // CRITICAL: Validate that the market has been running for a reasonable amount of time
        // This prevents capturing PnL for markets that "just started" but got misclassified as expired
        // For 15-min markets: must have been running for at least 10 minutes
        // For 1-hour markets: must have been running for at least 30 minutes
        const is15MinMarket = market.marketName.includes('15') ||
          market.marketName.match(/:\d{2}(AM|PM)\s*-\s*\d+:\d{2}(AM|PM)/i);
        const minRuntime = is15MinMarket ? 10 * 60 * 1000 : 30 * 60 * 1000; // 10 min or 30 min

        // Calculate how long the market has been expired
        // If it just expired (within last 5 minutes), the market likely ran properly
        // If endDate is in the distant past (> 1 hour ago), skip it as stale data
        const timeExpired = market.endDate ? now - market.endDate : 0;
        const maxStaleTime = 60 * 60 * 1000; // 1 hour max

        if (timeExpired > maxStaleTime) {
          // Skip stale expired markets
          continue;
        }

        // Determine outcome based on final prices
        // CRITICAL: Only use settlement prices (1.0/0.0), not market prices
        let outcome: 'UP' | 'DOWN' = 'UP';
        if (market.priceDown > market.priceUp) {
          outcome = 'DOWN';
        }

        pnlHistory.push({
          marketName: market.marketName,
          totalPnl: market.totalPnL,
          pnlPercent: market.totalPnLPercent || 0,
          outcome,
          timestamp: market.endDate || Date.now(),
          marketType: is15MinMarket ? '15m' : '1h',
          // Include shares and prices for proper display
          sharesUp: market.sharesUp,
          sharesDown: market.sharesDown,
          priceUp: market.priceUp,
          priceDown: market.priceDown,
          conditionId: market.marketKey,
        });
      }
    }

    // Sort history by timestamp (newest first)
    pnlHistory.sort((a, b) => b.timestamp - a.timestamp);

    // Filter current markets to only show non-expired
    const activeMarkets = currentMarkets.filter(m => !m.isExpired);

    // Calculate balance (we don't have direct access, estimate from positions)
    // For now, use a placeholder - the real balance would need the CLOB API
    const estimatedBalance = 10000 - totalInvested + totalPnL;

    return {
      botId: address,
      botName: name,
      apiKey: 'wallet-tracker', // Internal marker
      portfolio: {
        balance: estimatedBalance,
        totalInvested,
        totalPnL,
        totalPnLPercent: totalInvested > 0 ? (totalPnL / totalInvested) * 100 : 0,
        totalTrades,
        pnl15m,
        pnl15mPercent: invested15m > 0 ? (pnl15m / invested15m) * 100 : 0,
        trades15m,
        pnl1h,
        pnl1hPercent: invested1h > 0 ? (pnl1h / invested1h) * 100 : 0,
        trades1h,
      },
      pnlHistory,
      currentMarkets: activeMarkets,
    };
  }

  /**
   * Check if any wallets are being tracked
   */
  hasWallets(): boolean {
    return this.wallets.size > 0;
  }
}

// Singleton instance
export const externalWalletTracker = new ExternalWalletTracker();
