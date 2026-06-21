/**
 * RiskManager - hard pre-trade safety limits for LIVE trading.
 *
 * Enforces (all configurable, 0 = disabled):
 *   - Max notional per single order
 *   - Max total open notional exposure across all live positions
 *   - Daily realized-loss kill-switch (resets at UTC midnight)
 *
 * The core decision logic ({@link RiskManager.evaluate}) is pure and side-effect
 * free so it can be unit tested without a live wallet. The executor calls
 * {@link RiskManager.checkOrder} before sending and {@link RiskManager.recordFill}
 * / {@link RiskManager.recordRealizedPnL} to keep running state accurate.
 */

export interface RiskLimits {
  maxOrderNotionalUsdc: number;
  maxTotalExposureUsdc: number;
  maxDailyLossUsdc: number;
}

export interface RiskState {
  /** Sum of open notional currently deployed (USDC). */
  openExposureUsdc: number;
  /** Cumulative realized loss for the current UTC day (positive number). */
  dailyRealizedLossUsdc: number;
  /** Whether the kill-switch has been tripped. */
  killSwitchTripped: boolean;
}

export interface RiskDecision {
  allowed: boolean;
  reason?: string;
}

/**
 * Pure evaluation of a prospective order against limits + current state.
 * Exported separately so it can be tested in isolation.
 */
export function evaluateOrderRisk(
  orderNotionalUsdc: number,
  limits: RiskLimits,
  state: RiskState
): RiskDecision {
  if (state.killSwitchTripped) {
    return { allowed: false, reason: "Kill-switch tripped (daily loss limit reached)" };
  }

  if (!Number.isFinite(orderNotionalUsdc) || orderNotionalUsdc <= 0) {
    return { allowed: false, reason: `Invalid order notional: ${orderNotionalUsdc}` };
  }

  if (limits.maxOrderNotionalUsdc > 0 && orderNotionalUsdc > limits.maxOrderNotionalUsdc) {
    return {
      allowed: false,
      reason: `Order notional $${orderNotionalUsdc.toFixed(2)} exceeds per-order limit $${limits.maxOrderNotionalUsdc.toFixed(2)}`,
    };
  }

  if (
    limits.maxTotalExposureUsdc > 0 &&
    state.openExposureUsdc + orderNotionalUsdc > limits.maxTotalExposureUsdc
  ) {
    return {
      allowed: false,
      reason: `Order would push exposure to $${(state.openExposureUsdc + orderNotionalUsdc).toFixed(2)}, over limit $${limits.maxTotalExposureUsdc.toFixed(2)}`,
    };
  }

  return { allowed: true };
}

/** Returns the UTC day key (YYYY-MM-DD) for a timestamp. */
function utcDayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export class RiskManager {
  private limits: RiskLimits;
  private state: RiskState = {
    openExposureUsdc: 0,
    dailyRealizedLossUsdc: 0,
    killSwitchTripped: false,
  };
  private currentDay: string;

  constructor(limits: RiskLimits, now: number = Date.now()) {
    this.limits = limits;
    this.currentDay = utcDayKey(now);
  }

  /** Roll daily counters over at UTC midnight. */
  private maybeRollDay(now: number): void {
    const day = utcDayKey(now);
    if (day !== this.currentDay) {
      this.currentDay = day;
      this.state.dailyRealizedLossUsdc = 0;
      this.state.killSwitchTripped = false;
    }
  }

  /** Decide whether an order may be sent. */
  checkOrder(orderNotionalUsdc: number, now: number = Date.now()): RiskDecision {
    this.maybeRollDay(now);
    return evaluateOrderRisk(orderNotionalUsdc, this.limits, this.state);
  }

  /** Record a fill so open exposure stays accurate. Positive notional = opened, negative = closed. */
  recordFill(notionalDeltaUsdc: number): void {
    this.state.openExposureUsdc = Math.max(0, this.state.openExposureUsdc + notionalDeltaUsdc);
  }

  /**
   * Record realized PnL for a settled/closed position. A loss (negative pnl)
   * accumulates toward the daily loss limit and may trip the kill-switch.
   */
  recordRealizedPnL(pnlUsdc: number, now: number = Date.now()): void {
    this.maybeRollDay(now);
    if (pnlUsdc < 0) {
      this.state.dailyRealizedLossUsdc += -pnlUsdc;
      if (
        this.limits.maxDailyLossUsdc > 0 &&
        this.state.dailyRealizedLossUsdc >= this.limits.maxDailyLossUsdc
      ) {
        this.state.killSwitchTripped = true;
      }
    }
  }

  isKillSwitchTripped(): boolean {
    return this.state.killSwitchTripped;
  }

  getState(): Readonly<RiskState> {
    return { ...this.state };
  }
}

export default RiskManager;
