/**
 * Enhanced PnL Calculator using poly-sdk principles
 * 
 * Provides comprehensive PnL calculations including:
 * - Realized vs Unrealized PnL
 * - Cost basis (fees excluded for consistency with Polymarket API)
 * - Time-weighted returns
 * - Portfolio analytics
 */

import { Position, TradeHistory } from '../interfaces';

export interface PnLBreakdown {
  realizedPnL: number;
  unrealizedPnL: number;
  totalPnL: number;
  realizedPnLPercent: number;
  unrealizedPnLPercent: number;
  totalPnLPercent: number;
  totalCostBasis: number;
  totalCurrentValue: number;
  totalFees: number;
}

export interface PositionPnL {
  position: Position;
  costBasis: number; // Excludes fees (matches Polymarket API)
  currentValue: number;
  unrealizedPnL: number;
  unrealizedPnLPercent: number;
  fees: number; // Tracked but not used in PnL calculation
}

export interface MarketPnL {
  conditionId: string;
  marketName: string;
  positions: PositionPnL[];
  totalCostBasis: number;
  totalCurrentValue: number;
  totalRealizedPnL: number;
  totalUnrealizedPnL: number;
  totalPnL: number;
  totalPnLPercent: number;
  totalFees: number;
}

export interface PortfolioPnL {
  totalCostBasis: number;
  totalCurrentValue: number;
  totalRealizedPnL: number;
  totalUnrealizedPnL: number;
  totalPnL: number;
  totalPnLPercent: number;
  totalFees: number;
  startingBalance: number;
  currentBalance: number;
  totalReturn: number; // (currentBalance + totalCurrentValue - startingBalance) / startingBalance
  positions: PositionPnL[];
  markets: Map<string, MarketPnL>;
}

export class PnLCalculator {
  /**
   * Calculate PnL for a single position
   * Fees excluded from cost basis to match Polymarket API calculation
   */
  static calculatePositionPnL(
    position: Position,
    currentPrice: number,
    fees: number = 0
  ): PositionPnL {
    // Cost basis without fees (matches Polymarket API)
    const costBasis = position.size * position.avgPrice;
    const currentValue = position.size * currentPrice;
    const unrealizedPnL = currentValue - costBasis;
    const unrealizedPnLPercent = costBasis > 0 ? (unrealizedPnL / costBasis) * 100 : 0;

    return {
      position,
      costBasis,
      currentValue,
      unrealizedPnL,
      unrealizedPnLPercent,
      fees, // Still tracked but not used in PnL calculation
    };
  }

  /**
   * Calculate realized PnL from trade history
   */
  static calculateRealizedPnL(tradeHistory: TradeHistory[]): {
    realizedPnL: number;
    totalFees: number;
  } {
    let realizedPnL = 0;
    let totalFees = 0; // Fees removed but kept for interface compatibility

    // Track buys and sells per token (fees removed)
    const tokenBuys = new Map<string, Array<{ price: number; size: number; timestamp: Date }>>();
    const tokenSells = new Map<string, Array<{ price: number; size: number; timestamp: Date }>>();

    // Separate buys and sells
    for (const trade of tradeHistory) {
      if (trade.side === 'BUY') {
        if (!tokenBuys.has(trade.tokenId)) {
          tokenBuys.set(trade.tokenId, []);
        }
        tokenBuys.get(trade.tokenId)!.push({
          price: trade.price,
          size: trade.size,
          timestamp: trade.timestamp,
        });
      } else if (trade.side === 'SELL') {
        if (!tokenSells.has(trade.tokenId)) {
          tokenSells.set(trade.tokenId, []);
        }
        tokenSells.get(trade.tokenId)!.push({
          price: trade.price,
          size: trade.size,
          timestamp: trade.timestamp,
        });
      }
      // Fees removed - totalFees always 0
    }

    // Match sells with buys using FIFO
    for (const [tokenId, sells] of tokenSells.entries()) {
      const buys = tokenBuys.get(tokenId) || [];
      let buyIndex = 0;

      for (const sell of sells) {
        let remainingSize = sell.size;

        while (remainingSize > 0 && buyIndex < buys.length) {
          const buy = buys[buyIndex];
          const matchedSize = Math.min(remainingSize, buy.size);

          // Calculate PnL for matched portion (fees excluded to match Polymarket API)
          const buyCost = matchedSize * buy.price; // Fees excluded
          const sellProceeds = matchedSize * sell.price; // Fees excluded
          const tradePnL = sellProceeds - buyCost;

          realizedPnL += tradePnL;

          // Update remaining sizes
          remainingSize -= matchedSize;
          buy.size -= matchedSize;

          if (buy.size <= 0) {
            buyIndex++;
          }
        }
      }
    }

    return { realizedPnL, totalFees: 0 }; // Fees removed
  }

  /**
   * Calculate PnL breakdown for a portfolio
   */
  static calculatePortfolioPnL(
    positions: Position[],
    tradeHistory: TradeHistory[],
    currentPrices: Map<string, number>, // tokenId -> currentPrice
    startingBalance: number,
    currentBalance: number
  ): PortfolioPnL {
    const { realizedPnL, totalFees } = this.calculateRealizedPnL(tradeHistory);

    // Calculate unrealized PnL for all positions
    const positionPnLs: PositionPnL[] = [];
    let totalCostBasis = 0;
    let totalCurrentValue = 0;
    let totalUnrealizedPnL = 0;

    // Group positions by market (conditionId)
    const markets = new Map<string, MarketPnL>();

    for (const position of positions) {
      const currentPrice = currentPrices.get(position.tokenId) || position.currentPrice || position.avgPrice;
      const posPnL = this.calculatePositionPnL(position, currentPrice, 0); // Fees excluded from PnL calculation

      positionPnLs.push(posPnL);
      totalCostBasis += posPnL.costBasis;
      totalCurrentValue += posPnL.currentValue;
      totalUnrealizedPnL += posPnL.unrealizedPnL;

      // Group by market
      if (!markets.has(position.conditionId)) {
        markets.set(position.conditionId, {
          conditionId: position.conditionId,
          marketName: position.title || 'Unknown Market',
          positions: [],
          totalCostBasis: 0,
          totalCurrentValue: 0,
          totalRealizedPnL: 0,
          totalUnrealizedPnL: 0,
          totalPnL: 0,
          totalPnLPercent: 0,
          totalFees: 0, // Fees removed
        });
      }

      const marketPnL = markets.get(position.conditionId)!;
      marketPnL.positions.push(posPnL);
      marketPnL.totalCostBasis += posPnL.costBasis;
      marketPnL.totalCurrentValue += posPnL.currentValue;
      marketPnL.totalUnrealizedPnL += posPnL.unrealizedPnL;
    }

    // Calculate market-level PnL
    for (const marketPnL of markets.values()) {
      marketPnL.totalPnL = marketPnL.totalUnrealizedPnL;
      marketPnL.totalPnLPercent = marketPnL.totalCostBasis > 0 
        ? (marketPnL.totalPnL / marketPnL.totalCostBasis) * 100 
        : 0;
    }

    const totalPnL = realizedPnL + totalUnrealizedPnL;
    const totalPnLPercent = totalCostBasis > 0 ? (totalPnL / totalCostBasis) * 100 : 0;
    const totalReturn = startingBalance > 0 
      ? ((currentBalance + totalCurrentValue - startingBalance) / startingBalance) * 100 
      : 0;

    return {
      totalCostBasis,
      totalCurrentValue,
      totalRealizedPnL: realizedPnL,
      totalUnrealizedPnL,
      totalPnL,
      totalPnLPercent,
      totalFees,
      startingBalance,
      currentBalance,
      totalReturn,
      positions: positionPnLs,
      markets,
    };
  }

  /**
   * Calculate PnL breakdown with separate realized/unrealized
   */
  static calculatePnLBreakdown(
    positions: Position[],
    tradeHistory: TradeHistory[],
    currentPrices: Map<string, number>,
    startingBalance: number,
    currentBalance: number
  ): PnLBreakdown {
    const portfolio = this.calculatePortfolioPnL(
      positions,
      tradeHistory,
      currentPrices,
      startingBalance,
      currentBalance
    );

    return {
      realizedPnL: portfolio.totalRealizedPnL,
      unrealizedPnL: portfolio.totalUnrealizedPnL,
      totalPnL: portfolio.totalPnL,
      realizedPnLPercent: portfolio.totalCostBasis > 0 
        ? (portfolio.totalRealizedPnL / portfolio.totalCostBasis) * 100 
        : 0,
      unrealizedPnLPercent: portfolio.totalCostBasis > 0 
        ? (portfolio.totalUnrealizedPnL / portfolio.totalCostBasis) * 100 
        : 0,
      totalPnLPercent: portfolio.totalPnLPercent,
      totalCostBasis: portfolio.totalCostBasis,
      totalCurrentValue: portfolio.totalCurrentValue,
      totalFees: portfolio.totalFees,
    };
  }

  /**
   * Calculate market-level PnL (for a specific conditionId)
   */
  static calculateMarketPnL(
    positions: Position[],
    tradeHistory: TradeHistory[],
    conditionId: string,
    currentPrices: Map<string, number>
  ): MarketPnL | null {
    const marketPositions = positions.filter(p => p.conditionId === conditionId);
    if (marketPositions.length === 0) {
      return null;
    }

    const marketTrades = tradeHistory.filter(t => 
      positions.some(p => p.tokenId === t.tokenId && p.conditionId === conditionId)
    );

    const { realizedPnL } = this.calculateRealizedPnL(marketTrades);

    const positionPnLs: PositionPnL[] = [];
    let totalCostBasis = 0;
    let totalCurrentValue = 0;

    for (const position of marketPositions) {
      const currentPrice = currentPrices.get(position.tokenId) || position.currentPrice || position.avgPrice;
      const posPnL = this.calculatePositionPnL(position, currentPrice);
      positionPnLs.push(posPnL);
      totalCostBasis += posPnL.costBasis;
      totalCurrentValue += posPnL.currentValue;
    }

    const totalUnrealizedPnL = totalCurrentValue - totalCostBasis;
    const totalPnL = realizedPnL + totalUnrealizedPnL;
    const totalPnLPercent = totalCostBasis > 0 ? (totalPnL / totalCostBasis) * 100 : 0;

    return {
      conditionId,
      marketName: marketPositions[0]?.title || 'Unknown Market',
      positions: positionPnLs,
      totalCostBasis,
      totalCurrentValue,
      totalRealizedPnL: realizedPnL,
      totalUnrealizedPnL,
      totalPnL,
      totalPnLPercent,
      totalFees: 0, // Fees removed
    };
  }
}

export default PnLCalculator;
