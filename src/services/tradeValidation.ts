/**
 * Shared pre-trade validation for LIVE orders.
 *
 * Consolidates the market-start and price-staleness checks that were previously
 * duplicated (and "failed open") inside both TradeExecutor and
 * EnhancedTradeExecutor. On unexpected errors this fails CLOSED in live mode by
 * default (configurable via ENV.FAIL_CLOSED_ON_VALIDATION_ERROR).
 */

import { TradeSignal } from "../interfaces";
import { ENV } from "../config/env";
import logger from "../utils/logger";
import RiskManager from "./riskManager";

export interface ValidationResult {
  allowed: boolean;
  reason?: string;
}

// Singleton risk manager shared across the live executor + settlement path.
export const liveRiskManager = new RiskManager({
  maxOrderNotionalUsdc: ENV.MAX_ORDER_NOTIONAL_USDC,
  maxTotalExposureUsdc: ENV.MAX_TOTAL_EXPOSURE_USDC,
  maxDailyLossUsdc: ENV.MAX_DAILY_LOSS_USDC,
});

/**
 * Validate a live order: market has started, price is fresh, and risk limits
 * permit it. Returns { allowed: false, reason } to reject.
 */
export async function validateLiveOrder(
  signal: TradeSignal,
  logTag: string = "LIVE"
): Promise<ValidationResult> {
  // ── 1. Risk limits (hard pre-trade guard) ────────────────────────────────
  const notional = signal.price * signal.size;
  const riskDecision = liveRiskManager.checkOrder(notional);
  if (!riskDecision.allowed) {
    logger.warn(`[${logTag}] Trade rejected by risk manager: ${riskDecision.reason}`);
    return { allowed: false, reason: riskDecision.reason };
  }

  // ── 2. Price staleness ────────────────────────────────────────────────────
  try {
    const priceStreamLogger = (await import("./priceStreamLogger")).default;

    if (ENV.MAX_PRICE_STALENESS_MS > 0) {
      const ageMs = priceStreamLogger.getPriceAgeMs(signal.tokenId);
      if (ageMs !== null && ageMs > ENV.MAX_PRICE_STALENESS_MS) {
        const reason = `Stale price for token ${signal.tokenId}: ${ageMs}ms old (max ${ENV.MAX_PRICE_STALENESS_MS}ms)`;
        logger.warn(`[${logTag}] Trade rejected - ${reason}`);
        return { allowed: false, reason };
      }
    }

    // ── 3. Market has started ────────────────────────────────────────────────
    const currentMarkets = priceStreamLogger.getCurrentMarkets();
    const nextMarkets = priceStreamLogger.getNextMarkets();

    let marketInfo: any = null;
    for (const market of currentMarkets.values()) {
      if (market.tokens.some((t: any) => t.token_id === signal.tokenId)) {
        marketInfo = market;
        break;
      }
    }
    if (!marketInfo) {
      for (const market of nextMarkets.values()) {
        if (market.tokens.some((t: any) => t.token_id === signal.tokenId)) {
          marketInfo = market;
          break;
        }
      }
    }

    if (marketInfo) {
      const startTime = new Date(marketInfo.start_time_iso).getTime();
      const timeUntilStart = startTime - Date.now();
      if (timeUntilStart > 0) {
        const etStart = new Date(startTime).toLocaleString("en-US", { timeZone: "America/New_York" });
        const reason = `Market has not started yet. Starts in ${Math.round(timeUntilStart / 1000)}s (${etStart} ET)`;
        logger.warn(`[${logTag}] Trade rejected - future market: ${marketInfo.question} (${marketInfo.slug}) - starts ${etStart} ET`);
        return { allowed: false, reason };
      }
      logger.debug(`[${logTag}] Market validation passed: ${marketInfo.question} has started`);
    } else if (ENV.FAIL_CLOSED_ON_VALIDATION_ERROR) {
      // Can't find the market -> can't confirm it's live -> fail closed.
      const reason = `Could not find market info for token ${signal.tokenId} - rejecting (fail-closed)`;
      logger.warn(`[${logTag}] ${reason}`);
      return { allowed: false, reason };
    } else {
      logger.warn(`[${logTag}] Could not find market info for token ${signal.tokenId} - allowing (fail-open)`);
    }

    return { allowed: true };
  } catch (error) {
    logger.error(`[${logTag}] Error during pre-trade validation:`, error);
    if (ENV.FAIL_CLOSED_ON_VALIDATION_ERROR) {
      return { allowed: false, reason: `Validation error (fail-closed): ${error instanceof Error ? error.message : String(error)}` };
    }
    return { allowed: true };
  }
}
