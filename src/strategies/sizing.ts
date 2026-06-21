/**
 * Pure position-sizing helpers extracted from
 * InventoryBalancedRebalancingStrategy. All functions here are side-effect free
 * and depend only on their inputs so they can be unit tested directly.
 */

import { RebalanceConfig } from "../config/rebalanceConfig";

export type MarketCategory = "1h" | "15m" | "5m";

/**
 * Base trade size for a market category: base + price*multiplier, clamped to
 * [min, max]. 5m falls back to 15m params when 5m-specific ones are absent.
 */
export function computeBaseSize(
  price: number,
  category: MarketCategory,
  config: RebalanceConfig
): number {
  let base: number;
  let mult: number;
  let min: number;
  let max: number;

  if (category === "1h") {
    base = config.sizing_1h_base;
    mult = config.sizing_1h_multiplier;
    min = config.sizing_1h_min_trade;
    max = config.sizing_1h_max_trade;
  } else if (category === "5m") {
    base = config.sizing_5m_base ?? config.sizing_15m_base;
    mult = config.sizing_5m_multiplier ?? config.sizing_15m_multiplier;
    min = config.sizing_5m_min_trade ?? config.sizing_15m_min_trade;
    max = config.sizing_5m_max_trade ?? config.sizing_15m_max_trade;
  } else {
    base = config.sizing_15m_base;
    mult = config.sizing_15m_multiplier;
    min = config.sizing_15m_min_trade;
    max = config.sizing_15m_max_trade;
  }

  const size = base + price * mult;
  return Math.max(min, Math.min(size, max));
}

/**
 * Bell-curve multiplier: peaks at price 0.50, falls linearly to the extreme
 * multiplier at price 0.00/1.00. Returns the input size unchanged when the
 * bell curve is disabled.
 */
export function applyBellCurve(
  size: number,
  price: number,
  config: RebalanceConfig
): number {
  if (!config.bell_curve_enabled) {
    return size;
  }
  const distanceFromCenter = Math.abs(price - 0.5);
  const curveMultiplier =
    config.bell_curve_extreme_multiplier +
    (config.bell_curve_peak_multiplier - config.bell_curve_extreme_multiplier) *
      Math.max(0, 1 - distanceFromCenter * 2);
  return size * curveMultiplier;
}

/**
 * Adaptive multiplier based on current market PnL.
 *   - Returns 0 to STOP trading when loss exceeds max_loss_per_market.
 *   - When losing, scales up to recovery_multiplier (capped at max_recovery_multiplier).
 *   - When winning, applies profit_lock_multiplier.
 *   - Returns 1.0 when adaptive sizing is disabled or PnL is neutral.
 */
export function adaptiveMultiplier(
  totalPnL: number,
  costBasis: number,
  config: RebalanceConfig
): number {
  if (!config.adaptive_sizing_enabled) {
    return 1.0;
  }

  if (totalPnL < -config.max_loss_per_market) {
    return 0.0; // stop trading this market
  }

  if (totalPnL < 0) {
    const lossPercent = costBasis > 0 ? Math.abs(totalPnL / costBasis) : 0;
    const recoveryScale = Math.min(lossPercent * 10, 1.0);
    const multiplier = 1.0 + (config.recovery_multiplier - 1.0) * recoveryScale;
    return Math.min(multiplier, config.max_recovery_multiplier);
  }

  if (totalPnL > 0) {
    return config.profit_lock_multiplier;
  }

  return 1.0;
}
