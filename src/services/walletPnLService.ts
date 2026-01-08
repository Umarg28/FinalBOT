/**
 * Wallet PnL Service using poly-sdk WalletService
 * 
 * Provides accurate PnL calculations from actual wallet positions
 * using poly-sdk's WalletService which has built-in PnL logic
 */

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
      logger.warn('poly-sdk not available for wallet PnL:', error instanceof Error ? error.message : error);
      return false;
    }
  })();

  return polySdkLoadPromise;
}

export interface WalletPnLProfile {
  address: string;
  totalPnL: number;
  winRate: number;
  totalTrades: number;
  smartScore: number;
  positions: Array<{
    conditionId: string;
    tokenId: string;
    size: number;
    avgPrice: number;
    currentPrice: number;
    cashPnl: number;
    percentPnl: number;
  }>;
}

export class WalletPnLService {
  private sdk: any = null;
  private initialized: boolean = false;

  /**
   * Initialize the service with SDK
   */
  async initialize(sdk?: any): Promise<void> {
    if (this.initialized) return;

    if (sdk) {
      this.sdk = sdk;
      this.initialized = true;
      return;
    }

    // Try to load poly-sdk
    const loaded = await loadPolySdk();
    if (!loaded || !polySdkModule) {
      logger.warn('poly-sdk not available for wallet PnL service');
      return;
    }

    try {
      this.sdk = new polySdkModule.PolymarketSDK();
      this.initialized = true;
      logger.info('Wallet PnL Service initialized with poly-sdk');
    } catch (error) {
      logger.warn('Failed to initialize wallet PnL service:', error);
    }
  }

  /**
   * Get wallet profile with PnL using poly-sdk WalletService
   * This uses poly-sdk's built-in PnL calculation logic
   */
  async getWalletProfile(address: string): Promise<WalletPnLProfile | null> {
    if (!this.initialized || !this.sdk) {
      return null;
    }

    try {
      const profile = await this.sdk.wallets.getWalletProfile(address);
      
      return {
        address,
        totalPnL: profile.totalPnL || 0,
        winRate: profile.winRate || 0,
        totalTrades: profile.totalTrades || 0,
        smartScore: profile.smartScore || 0,
        positions: profile.positions || [],
      };
    } catch (error) {
      logger.error(`Failed to get wallet profile for ${address}:`, error);
      return null;
    }
  }

  /**
   * Get positions with PnL for a wallet
   * Uses poly-sdk's position tracking which includes accurate PnL
   */
  async getPositionsWithPnL(address: string): Promise<Array<{
    conditionId: string;
    tokenId: string;
    size: number;
    avgPrice: number;
    currentPrice: number;
    cashPnl: number;
    percentPnl: number;
    currentValue: number;
  }> | null> {
    if (!this.initialized || !this.sdk) {
      return null;
    }

    try {
      // Use poly-sdk's data API to get positions
      const positions = await this.sdk.dataApi.getPositions(address);
      
      return positions.map((pos: any) => ({
        conditionId: pos.conditionId,
        tokenId: pos.tokenId,
        size: pos.size || 0,
        avgPrice: pos.avgPrice || 0,
        currentPrice: pos.curPrice || pos.currentPrice || 0,
        cashPnl: pos.cashPnl || 0,
        percentPnl: pos.percentPnl || 0,
        currentValue: pos.currentValue || 0,
      }));
    } catch (error) {
      logger.error(`Failed to get positions for ${address}:`, error);
      return null;
    }
  }

  /**
   * Calculate total portfolio PnL using poly-sdk's methods
   */
  async calculatePortfolioPnL(address: string): Promise<{
    totalPnL: number;
    totalPnLPercent: number;
    totalValue: number;
    totalCostBasis: number;
    realizedPnL: number;
    unrealizedPnL: number;
  } | null> {
    const profile = await this.getWalletProfile(address);
    if (!profile) {
      return null;
    }

    const positions = await this.getPositionsWithPnL(address);
    if (!positions) {
      return null;
    }

    let totalCostBasis = 0;
    let totalValue = 0;
    let totalUnrealizedPnL = 0;

    for (const pos of positions) {
      const costBasis = pos.size * pos.avgPrice;
      const currentValue = pos.size * pos.currentPrice;
      
      totalCostBasis += costBasis;
      totalValue += currentValue;
      totalUnrealizedPnL += pos.cashPnl;
    }

    // poly-sdk's totalPnL includes both realized and unrealized
    const totalPnL = profile.totalPnL || totalUnrealizedPnL;
    const totalPnLPercent = totalCostBasis > 0 ? (totalPnL / totalCostBasis) * 100 : 0;

    return {
      totalPnL,
      totalPnLPercent,
      totalValue,
      totalCostBasis,
      realizedPnL: totalPnL - totalUnrealizedPnL,
      unrealizedPnL: totalUnrealizedPnL,
    };
  }

  /**
   * Get smart money score (from poly-sdk)
   * This includes PnL-based scoring
   */
  async getSmartMoneyScore(address: string): Promise<number | null> {
    if (!this.initialized || !this.sdk) {
      return null;
    }

    try {
      const isSmartMoney = await this.sdk.smartMoney.isSmartMoney(address);
      if (isSmartMoney) {
        const profile = await this.getWalletProfile(address);
        return profile?.smartScore || null;
      }
      return null;
    } catch (error) {
      logger.debug(`Failed to get smart money score for ${address}:`, error);
      return null;
    }
  }
}

export default WalletPnLService;
