import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import logger from "../utils/logger";

// File watcher for hot-reloading
let configWatcher: fs.FSWatcher | null = null;
let configFilePath: string | null = null;

export interface RebalanceConfig {
  // Bankroll & allocation
  bankroll_total: number;
  target_yes_ratio: number;
  max_skew_ratio: number;

  // Rebalance trigger
  rebalance_band: number;
  price_move_threshold: number;
  min_seconds_between_rebalances: number;

  // Rebalance strength
  rebalance_strength_k: number;
  max_rebalance_step_pct: number;
  min_trade_size: number;
  max_trade_size: number;

  // Market-specific trade sizing (5-min, 15-min, 1-hour)
  // 1-Hour markets (conservative) - legacy, may not be available
  sizing_1h_base: number;
  sizing_1h_multiplier: number;
  sizing_1h_min_trade: number;
  sizing_1h_max_trade: number;
  sizing_1h_cooldown_sec: number;
  // 15-Minute markets (moderate)
  sizing_15m_base: number;
  sizing_15m_multiplier: number;
  sizing_15m_min_trade: number;
  sizing_15m_max_trade: number;
  sizing_15m_cooldown_sec: number;
  // 5-Minute markets (aggressive - fast markets)
  sizing_5m_base?: number;
  sizing_5m_multiplier?: number;
  sizing_5m_min_trade?: number;
  sizing_5m_max_trade?: number;
  sizing_5m_cooldown_sec?: number;

  // Price / execution safety
  slippage_buffer: number;
  order_type: "limit" | "market";
  limit_price_offset: number;
  max_unfilled_time_sec: number;

  // Inventory risk controls
  max_inventory_imbalance_ratio: number;
  stop_add_threshold: number;
  reduce_only_mode: boolean;

  // Tilt trading (aggressive when winning)
  tilt_threshold: number;
  tilt_boost_multiplier: number;
  price_stop_threshold: number;

  // Late entry detection (skip markets already in progress)
  late_entry_threshold: number; // Skip if no inventory and price > this (e.g., 0.70 = 70%)

  // Regime gating (separate from tilt for independent tuning)
  edge_threshold: number;   // EDGE regime gate (blocks losing-side fallback when price >= this)
  trend_threshold: number;  // TREND regime gate (zeros loser when price >= this)

  // Bell curve sizing (maximize middle, minimize extremes)
  bell_curve_enabled: boolean;
  bell_curve_peak_multiplier: number;    // 1.50 at price 0.50
  bell_curve_extreme_multiplier: number; // 0.30 at price 0.10/0.90

  // Time-weighted sizing (match copy-bot quartile shape)
  time_weighting_enabled: boolean;
  q1_multiplier: number;   // 0–25% of market duration
  q2_multiplier: number;   // 25–50% of market duration
  q3_multiplier: number;   // 50–75% of market duration (peak)
  q4_multiplier: number;   // 75–100% of market duration (downshift)

  // Market close behavior (5-minute and 15-minute markets)
  close_reduce_activity_minutes: number;
  close_activity_multiplier: number;
  close_reduce_size_minutes: number;
  close_size_multiplier: number;
  close_stop_trading_seconds: number;

  // Reversal handling
  flip_detection_window_sec: number;
  flip_response_multiplier: number;
  post_flip_cooldown_sec: number;

  // Flip Recovery Mode settings (explicit state machine)
  flip_recovery_enabled: boolean;
  flip_recovery_rebalance_strength_k: number;      // Aggressive rebalance strength during flip (default: 1.4)
  flip_recovery_max_rebalance_step_pct: number;    // Higher step size during flip (default: 0.40)
  flip_recovery_rebalance_band: number;            // Tighter band during flip (default: 0.002)
  flip_recovery_max_trade_multiplier: number;      // Reduce max trade size (default: 0.75 = 75%)
  flip_recovery_cooldown_multiplier: number;       // Higher trade frequency (default: 0.5 = 50% cooldown)

  // Adaptive position sizing (ML-ready: adjusts based on current PnL)
  adaptive_sizing_enabled: boolean;
  recovery_multiplier: number; // When losing, increase position size by this multiplier (e.g. 1.2 = 20% increase)
  profit_lock_multiplier: number; // When winning, reduce position size by this multiplier (e.g. 0.8 = 20% reduction)
  max_recovery_multiplier: number; // Maximum recovery multiplier (e.g. 1.5 = never increase more than 50%)
  max_loss_per_market: number; // Stop trading this market if loss exceeds this $ amount (e.g. 50.0)
  max_recovery_bet_pct: number; // Maximum % of balance to use for recovery bets (e.g. 0.10 = 10% of balance max)

  // Logging / tuning helpers
  log_every_trade: boolean;
  metrics_window_trades: number;

  // Market configuration
  market_condition_id: string;
}

const DEFAULT_CONFIG: RebalanceConfig = {
  bankroll_total: 100.0,
  target_yes_ratio: 0.5,
  max_skew_ratio: 0.15,
  rebalance_band: 0.05,
  price_move_threshold: 0.01,
  min_seconds_between_rebalances: 30,
  rebalance_strength_k: 0.5,
  max_rebalance_step_pct: 0.20,
  min_trade_size: 0.01,
  max_trade_size: 26.0,
  // 1-Hour markets (conservative) - legacy
  sizing_1h_base: 0.50,
  sizing_1h_multiplier: 8.00,
  sizing_1h_min_trade: 0.01,
  sizing_1h_max_trade: 14.00,
  sizing_1h_cooldown_sec: 6,
  // 15-Minute markets (moderate)
  sizing_15m_base: 0.25,
  sizing_15m_multiplier: 12.00,
  sizing_15m_min_trade: 0.01,
  sizing_15m_max_trade: 26.00,
  sizing_15m_cooldown_sec: 2,
  // 5-Minute markets (aggressive - fast markets)
  sizing_5m_base: 0.15,
  sizing_5m_multiplier: 15.00,
  sizing_5m_min_trade: 0.01,
  sizing_5m_max_trade: 30.00,
  sizing_5m_cooldown_sec: 1,
  slippage_buffer: 0.005,
  order_type: "limit",
  limit_price_offset: 0.003,
  max_unfilled_time_sec: 60,
  max_inventory_imbalance_ratio: 1.5,
  stop_add_threshold: 0.80,
  reduce_only_mode: false,
  tilt_threshold: 0.59,
  tilt_boost_multiplier: 1.25,
  price_stop_threshold: 0.90,
  late_entry_threshold: 0.70, // Skip if no inventory and price > 70%
  // Regime gating (separate from tilt)
  edge_threshold: 0.58,   // EDGE regime blocks losing-side fallback when price >= 0.58
  trend_threshold: 0.65,  // TREND regime zeros loser when price >= 0.65
  // Bell curve sizing (maximize middle, minimize extremes)
  bell_curve_enabled: true,
  bell_curve_peak_multiplier: 1.50,
  bell_curve_extreme_multiplier: 0.30,
  // Time-weighted sizing (match copy-bot quartile shape)
  time_weighting_enabled: true,
  q1_multiplier: 1.00,   // 0–25%
  q2_multiplier: 0.95,   // 25–50%
  q3_multiplier: 1.45,   // 50–75% (peak)
  q4_multiplier: 0.50,   // 75–100% (downshift)
  // Market close behavior (15-minute markets)
  close_reduce_activity_minutes: 4,
  close_activity_multiplier: 0.25,
  close_reduce_size_minutes: 1,
  close_size_multiplier: 0.60,
  close_stop_trading_seconds: 0,
  flip_detection_window_sec: 30,
  flip_response_multiplier: 1.5,
  post_flip_cooldown_sec: 15,
  // Flip Recovery Mode settings (explicit state machine)
  flip_recovery_enabled: true,
  flip_recovery_rebalance_strength_k: 1.4,         // More aggressive rebalancing
  flip_recovery_max_rebalance_step_pct: 0.40,      // Allow larger rebalance steps
  flip_recovery_rebalance_band: 0.002,             // Tighter trigger band
  flip_recovery_max_trade_multiplier: 0.75,        // 75% of normal max trade size
  flip_recovery_cooldown_multiplier: 0.5,          // 50% of normal cooldown (faster trades)
  // Adaptive position sizing (ML-ready: adjusts based on current PnL)
  adaptive_sizing_enabled: false,
  recovery_multiplier: 1.2, // When losing, increase position size by 20%
  profit_lock_multiplier: 0.8, // When winning, reduce position size by 20%
  max_recovery_multiplier: 1.5, // Maximum 50% increase
  max_loss_per_market: 100.0, // Stop trading if loss > $100
  max_recovery_bet_pct: 0.10, // Max 10% of balance for recovery bets
  log_every_trade: true,
  metrics_window_trades: 100,
  market_condition_id: "",
};

let cachedConfig: RebalanceConfig | null = null;

/**
 * Validate a config for sane bounds. Returns a list of human-readable errors
 * (empty = valid). Guards against a bad hot-reload edit pushing garbage
 * parameters into the live strategy.
 */
export function validateRebalanceConfig(config: RebalanceConfig): string[] {
  const errors: string[] = [];

  const inRange = (key: keyof RebalanceConfig, min: number, max: number) => {
    const v = config[key] as unknown as number;
    if (typeof v !== "number" || Number.isNaN(v) || v < min || v > max) {
      errors.push(`${String(key)}=${v} out of range [${min}, ${max}]`);
    }
  };
  const positive = (key: keyof RebalanceConfig) => {
    const v = config[key] as unknown as number;
    if (typeof v !== "number" || Number.isNaN(v) || v < 0) {
      errors.push(`${String(key)}=${v} must be a non-negative number`);
    }
  };

  // Probabilities / price thresholds must live in [0, 1].
  inRange("target_yes_ratio", 0, 1);
  inRange("edge_threshold", 0, 1);
  inRange("trend_threshold", 0, 1);
  inRange("tilt_threshold", 0, 1);
  inRange("price_stop_threshold", 0, 1);
  inRange("stop_add_threshold", 0, 1);
  inRange("late_entry_threshold", 0, 1);
  inRange("slippage_buffer", 0, 1);
  inRange("limit_price_offset", 0, 1);

  // Sizes / bankroll must be non-negative.
  positive("bankroll_total");
  positive("min_trade_size");
  positive("max_trade_size");
  positive("sizing_1h_max_trade");
  positive("sizing_15m_max_trade");

  // Ordering sanity: regime gates should be monotonic (edge <= trend <= stop).
  if (config.edge_threshold > config.trend_threshold) {
    errors.push(`edge_threshold (${config.edge_threshold}) must be <= trend_threshold (${config.trend_threshold})`);
  }
  if (config.trend_threshold > config.price_stop_threshold) {
    errors.push(`trend_threshold (${config.trend_threshold}) must be <= price_stop_threshold (${config.price_stop_threshold})`);
  }
  if (config.min_trade_size > config.max_trade_size) {
    errors.push(`min_trade_size (${config.min_trade_size}) must be <= max_trade_size (${config.max_trade_size})`);
  }
  if (config.order_type !== "limit" && config.order_type !== "market") {
    errors.push(`order_type "${config.order_type}" must be "limit" or "market"`);
  }

  return errors;
}

/**
 * Load configuration from YAML file
 */
export function loadRebalanceConfig(configPath?: string): RebalanceConfig {
  // Return cached config if available (for performance)
  if (cachedConfig) {
    return cachedConfig;
  }

  // Use CONFIG_FILE env var if set, otherwise default
  const configFileName = process.env.CONFIG_FILE || "inventory-rebalance-config.yaml";
  const configFilePath =
    configPath || path.join(process.cwd(), configFileName);

  try {
    if (!fs.existsSync(configFilePath)) {
      logger.warn(
        `Config file not found at ${configFilePath}, using default values`
      );
      cachedConfig = DEFAULT_CONFIG;
      return cachedConfig;
    }

    const fileContents = fs.readFileSync(configFilePath, "utf8");
    const loadedConfig = yaml.load(fileContents) as Partial<RebalanceConfig>;

    // Merge with defaults to ensure all fields are present
    const merged: RebalanceConfig = {
      ...DEFAULT_CONFIG,
      ...loadedConfig,
    };

    // Validate before accepting. On the initial load, an invalid file falls back
    // to safe defaults; hot-reload rejection (keeping the prior config) is handled
    // in reloadRebalanceConfig().
    const errors = validateRebalanceConfig(merged);
    if (errors.length > 0) {
      logger.error(`Invalid config in ${configFilePath}:\n  - ${errors.join("\n  - ")}`);
      if (!cachedConfig) {
        logger.warn("Falling back to default configuration values");
        cachedConfig = DEFAULT_CONFIG;
      }
      return cachedConfig;
    }

    cachedConfig = merged;
    logger.info(`Loaded rebalance config from ${configFilePath}`);
    return cachedConfig;
  } catch (error) {
    logger.error(`Failed to load config from ${configFilePath}:`, error);
    logger.warn("Using default configuration values");
    cachedConfig = DEFAULT_CONFIG;
    return cachedConfig;
  }
}

/**
 * Reload configuration from file (useful for hot-reloading)
 */
export function reloadRebalanceConfig(configPath?: string): RebalanceConfig {
  const configFileName = process.env.CONFIG_FILE || "inventory-rebalance-config.yaml";
  const filePath = configPath || path.join(process.cwd(), configFileName);
  const previous = cachedConfig ?? DEFAULT_CONFIG;

  try {
    if (!fs.existsSync(filePath)) {
      logger.warn(`Config file not found at ${filePath} during reload - keeping current config`);
      return previous;
    }

    const merged: RebalanceConfig = {
      ...DEFAULT_CONFIG,
      ...(yaml.load(fs.readFileSync(filePath, "utf8")) as Partial<RebalanceConfig>),
    };

    const errors = validateRebalanceConfig(merged);
    if (errors.length > 0) {
      logger.error(`⚠️ Config reload rejected - invalid values:\n  - ${errors.join("\n  - ")}`);
      logger.warn("Keeping previous valid configuration");
      return previous;
    }

    cachedConfig = merged;
    return merged;
  } catch (error) {
    logger.error(`⚠️ Config reload failed for ${filePath}:`, error);
    logger.warn("Keeping previous valid configuration");
    return previous;
  }
}

/**
 * Get current cached config without reloading
 */
export function getRebalanceConfig(): RebalanceConfig {
  if (!cachedConfig) {
    return loadRebalanceConfig();
  }
  return cachedConfig;
}

/**
 * Start watching config file for changes (hot-reload)
 */
export function startConfigWatcher(onConfigChange?: (config: RebalanceConfig) => void): void {
  if (configWatcher) {
    return; // Already watching
  }

  const configFileName = process.env.CONFIG_FILE || "inventory-rebalance-config.yaml";
  const filePath = configFilePath || path.join(process.cwd(), configFileName);

  try {
    let debounceTimer: NodeJS.Timeout | null = null;

    configWatcher = fs.watch(filePath, (eventType) => {
      if (eventType === "change") {
        // Debounce to avoid multiple reloads for a single save
        if (debounceTimer) {
          clearTimeout(debounceTimer);
        }

        debounceTimer = setTimeout(() => {
          logger.info("🔄 Config file changed - hot-reloading...");
          const newConfig = reloadRebalanceConfig();

          // Log key changes
          logger.info(`📊 Hot-reload complete:`);
          logger.info(`   bankroll_total: $${newConfig.bankroll_total}`);
          logger.info(`   target_yes_ratio: ${(newConfig.target_yes_ratio * 100).toFixed(0)}%`);
          logger.info(`   tilt_threshold: ${newConfig.tilt_threshold}`);
          logger.info(`   tilt_boost: ${newConfig.tilt_boost_multiplier}x`);
          logger.info(`   price_stop: ${newConfig.price_stop_threshold}`);
          logger.info(`   1h sizing: $${newConfig.sizing_1h_base} + (price × ${newConfig.sizing_1h_multiplier}), cooldown ${newConfig.sizing_1h_cooldown_sec}s`);
          logger.info(`   15m sizing: $${newConfig.sizing_15m_base} + (price × ${newConfig.sizing_15m_multiplier}), cooldown ${newConfig.sizing_15m_cooldown_sec}s`);
          logger.info(`   bell curve: ${newConfig.bell_curve_enabled ? `ON (peak ${newConfig.bell_curve_peak_multiplier}x @ 0.50, extreme ${newConfig.bell_curve_extreme_multiplier}x @ edges)` : 'OFF'}`);
          logger.info(`   close behavior: reduce freq at ${newConfig.close_reduce_activity_minutes}min (${newConfig.close_activity_multiplier * 100}%), reduce size at ${newConfig.close_reduce_size_minutes}min (${newConfig.close_size_multiplier * 100}%)`);

          if (onConfigChange) {
            onConfigChange(newConfig);
          }
        }, 100); // 100ms debounce
      }
    });

    logger.info(`👁️ Watching config file for changes: ${filePath}`);
    logger.info("   Edit and save the config file - changes apply immediately!");
  } catch (error) {
    logger.error(`Failed to start config watcher: ${error}`);
  }
}

/**
 * Stop watching config file
 */
export function stopConfigWatcher(): void {
  if (configWatcher) {
    configWatcher.close();
    configWatcher = null;
    logger.info("Config file watcher stopped");
  }
}
