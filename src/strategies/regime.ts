/**
 * Pure regime-detection logic extracted from InventoryBalancedRebalancingStrategy.
 *
 * A "regime" describes how decisively the market has picked a side and therefore
 * how aggressively the losing side should be suppressed:
 *   STOP   - price >= price_stop_threshold: zero the losing side entirely (always,
 *            even in flip recovery).
 *   TREND  - maxPrice >= trend_threshold: zero the losing side (skipped in flip recovery).
 *   EDGE   - maxPrice >= edge_threshold: reduce losing side to 25% then clamp to
 *            50% of the winner (skipped in flip recovery).
 *   NORMAL - no suppression.
 *
 * Kept side-effect free so it can be unit tested without the full strategy.
 */

export type Regime = "STOP" | "TREND" | "EDGE" | "NORMAL";

export interface RegimeThresholds {
  price_stop_threshold: number;
  trend_threshold: number;
  edge_threshold: number;
}

export interface RegimeResult {
  regime: Regime;
  upAmount: number;
  downAmount: number;
  /** Which side ("UP"/"DOWN") was suppressed, or null if none. */
  suppressedSide: "UP" | "DOWN" | null;
}

/**
 * Apply regime-based suppression to the prospective UP/DOWN trade amounts.
 * Returns the (possibly reduced) amounts plus the classified regime so the
 * caller can update counters / logs.
 */
export function applyRegimeAdjustment(
  upAmount: number,
  downAmount: number,
  yesPrice: number,
  noPrice: number,
  thresholds: RegimeThresholds,
  isInFlipRecovery: boolean
): RegimeResult {
  const maxPrice = Math.max(yesPrice, noPrice);

  // STOP: absolute gate, always applies (even during flip recovery).
  if (yesPrice >= thresholds.price_stop_threshold) {
    return { regime: "STOP", upAmount, downAmount: 0, suppressedSide: "DOWN" };
  }
  if (noPrice >= thresholds.price_stop_threshold) {
    return { regime: "STOP", upAmount: 0, downAmount, suppressedSide: "UP" };
  }

  // TREND: zero the loser (skipped during flip recovery).
  if (!isInFlipRecovery && maxPrice >= thresholds.trend_threshold) {
    if (yesPrice > noPrice) {
      return { regime: "TREND", upAmount, downAmount: 0, suppressedSide: "DOWN" };
    }
    return { regime: "TREND", upAmount: 0, downAmount, suppressedSide: "UP" };
  }

  // EDGE: reduce loser to 25%, then clamp to 50% of winner (skipped in flip recovery).
  if (!isInFlipRecovery && maxPrice >= thresholds.edge_threshold) {
    if (yesPrice > noPrice) {
      const reduced = Math.min(downAmount * 0.25, upAmount * 0.5);
      return { regime: "EDGE", upAmount, downAmount: reduced, suppressedSide: "DOWN" };
    }
    const reduced = Math.min(upAmount * 0.25, downAmount * 0.5);
    return { regime: "EDGE", upAmount: reduced, downAmount, suppressedSide: "UP" };
  }

  return { regime: "NORMAL", upAmount, downAmount, suppressedSide: null };
}
