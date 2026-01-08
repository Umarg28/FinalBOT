/**
 * Arbitrage Utilities using poly-sdk
 * 
 * Helper functions for detecting and analyzing arbitrage opportunities
 */

import logger from './logger';

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
      logger.warn('poly-sdk not available for arbitrage utils:', error instanceof Error ? error.message : error);
      return false;
    }
  })();

  return polySdkLoadPromise;
}

export interface ArbitrageInfo {
  exists: boolean;
  type: 'long' | 'short' | null;
  profit: number;
  profitPercent: number;
  action: string;
  effectivePrices: {
    effectiveBuyYes: number;
    effectiveBuyNo: number;
    effectiveSellYes: number;
    effectiveSellNo: number;
  };
}

/**
 * Check for arbitrage opportunity given YES and NO prices
 * Note: This is now async due to dynamic poly-sdk loading
 */
export async function detectArbitrage(
  yesAsk: number,
  yesBid: number,
  noAsk: number,
  noBid: number,
  minProfitPercent: number = 0.1
): Promise<ArbitrageInfo> {
  // Load poly-sdk
  await loadPolySdk();
  
  // Get effective prices (accounts for mirror orderbook)
  let effective: any;
  if (polySdkModule && polySdkModule.getEffectivePrices) {
    effective = polySdkModule.getEffectivePrices(yesAsk, yesBid, noAsk, noBid);
  } else {
    // Fallback calculation
    effective = {
      effectiveBuyYes: Math.min(yesAsk, 1 - noBid),
      effectiveBuyNo: Math.min(noAsk, 1 - yesBid),
      effectiveSellYes: Math.max(yesBid, 1 - noAsk),
      effectiveSellNo: Math.max(noBid, 1 - yesAsk),
    };
  }

  // Check for arbitrage
  const arb = polySdkModule && polySdkModule.checkArbitrage
    ? polySdkModule.checkArbitrage(yesAsk, yesBid, noAsk, noBid)
    : null;

  if (!arb || arb.profit * 100 < minProfitPercent) {
    return {
      exists: false,
      type: null,
      profit: 0,
      profitPercent: 0,
      action: '',
      effectivePrices: effective,
    };
  }

  return {
    exists: true,
    type: arb.type,
    profit: arb.profit,
    profitPercent: arb.profit * 100,
    action: arb.description || '',
    effectivePrices: effective,
  };
}

/**
 * Calculate if a long arbitrage is profitable
 * Long arb: Buy YES + Buy NO, then merge to get > $1.00 back
 */
export function calculateLongArbProfit(
  yesAsk: number,
  noAsk: number
): { profitable: boolean; profit: number; profitPercent: number; cost: number; return: number } {
  const cost = yesAsk + noAsk;
  const returnAmount = 1.0; // Merging YES + NO always gives $1.00
  const profit = returnAmount - cost;
  const profitPercent = (profit / cost) * 100;

  return {
    profitable: profit > 0,
    profit,
    profitPercent,
    cost,
    return: returnAmount,
  };
}

/**
 * Calculate if a short arbitrage is profitable
 * Short arb: Sell YES + Sell NO (if you have them), get > $1.00 cost
 */
export function calculateShortArbProfit(
  yesBid: number,
  noBid: number
): { profitable: boolean; profit: number; profitPercent: number; cost: number; return: number } {
  const returnAmount = yesBid + noBid;
  const cost = 1.0; // Splitting $1.00 gives YES + NO
  const profit = returnAmount - cost;
  const profitPercent = (profit / cost) * 100;

  return {
    profitable: profit > 0,
    profit,
    profitPercent,
    cost,
    return: returnAmount,
  };
}

/**
 * Log arbitrage opportunity in a readable format
 */
export function logArbitrageOpportunity(
  conditionId: string,
  marketName: string,
  arbInfo: ArbitrageInfo
): void {
  if (!arbInfo.exists) {
    return;
  }

  logger.info(`🔍 ARBITRAGE OPPORTUNITY: ${marketName}`);
  logger.info(`   Type: ${arbInfo.type?.toUpperCase()}`);
  logger.info(`   Profit: ${arbInfo.profitPercent.toFixed(2)}% ($${arbInfo.profit.toFixed(4)})`);
  logger.info(`   Action: ${arbInfo.action}`);
  logger.info(`   Condition ID: ${conditionId}`);
}

/**
 * Check if prices are valid for arbitrage calculation
 */
export function validatePrices(yesAsk: number, yesBid: number, noAsk: number, noBid: number): boolean {
  // Basic validation
  if (
    !isFinite(yesAsk) ||
    !isFinite(yesBid) ||
    !isFinite(noAsk) ||
    !isFinite(noBid) ||
    yesAsk <= 0 ||
    yesBid <= 0 ||
    noAsk <= 0 ||
    noBid <= 0 ||
    yesAsk > 1 ||
    yesBid > 1 ||
    noAsk > 1 ||
    noBid > 1
  ) {
    return false;
  }

  // Check if ask > bid (basic sanity)
  if (yesAsk <= yesBid || noAsk <= noBid) {
    logger.debug('Invalid price spread: ask <= bid');
    return false;
  }

  return true;
}
