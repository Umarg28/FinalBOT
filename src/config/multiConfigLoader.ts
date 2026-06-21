/**
 * Multi-Config Loader
 * Finds and loads multiple bot configuration files for multi-bot mode
 */

import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import logger from "../utils/logger";
import { RebalanceConfig } from "./rebalanceConfig";

export interface BotConfig {
  botId: string;
  botName: string;
  configPath: string;
  config: RebalanceConfig;
}

// Default config values (same as rebalanceConfig.ts)
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
  sizing_1h_base: 0.50,
  sizing_1h_multiplier: 8.00,
  sizing_1h_min_trade: 0.01,
  sizing_1h_max_trade: 14.00,
  sizing_1h_cooldown_sec: 6,
  sizing_15m_base: 0.25,
  sizing_15m_multiplier: 12.00,
  sizing_15m_min_trade: 0.01,
  sizing_15m_max_trade: 26.00,
  sizing_15m_cooldown_sec: 2,
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
  late_entry_threshold: 0.70,
  edge_threshold: 0.58,
  trend_threshold: 0.65,
  bell_curve_enabled: true,
  bell_curve_peak_multiplier: 1.50,
  bell_curve_extreme_multiplier: 0.30,
  time_weighting_enabled: true,
  q1_multiplier: 1.00,
  q2_multiplier: 0.95,
  q3_multiplier: 1.45,
  q4_multiplier: 0.50,
  close_reduce_activity_minutes: 4,
  close_activity_multiplier: 0.25,
  close_reduce_size_minutes: 1,
  close_size_multiplier: 0.60,
  close_stop_trading_seconds: 0,
  flip_detection_window_sec: 30,
  flip_response_multiplier: 1.5,
  post_flip_cooldown_sec: 15,
  flip_recovery_enabled: true,
  flip_recovery_rebalance_strength_k: 1.4,
  flip_recovery_max_rebalance_step_pct: 0.40,
  flip_recovery_rebalance_band: 0.002,
  flip_recovery_max_trade_multiplier: 0.75,
  flip_recovery_cooldown_multiplier: 0.5,
  adaptive_sizing_enabled: false,
  recovery_multiplier: 1.2,
  profit_lock_multiplier: 0.8,
  max_recovery_multiplier: 1.5,
  max_loss_per_market: 100.0,
  max_recovery_bet_pct: 0.10,
  log_every_trade: true,
  metrics_window_trades: 100,
  market_condition_id: "",
};

/**
 * Find all bot config files matching pattern inventory-rebalance-config*.yaml
 */
export function findAllConfigFiles(): string[] {
  const cwd = process.cwd();
  const files = fs.readdirSync(cwd);

  const configFiles = files
    .filter(f => f.startsWith("inventory-rebalance-config") && f.endsWith(".yaml"))
    .map(f => path.join(cwd, f))
    .sort();

  return configFiles;
}

/**
 * Extract bot ID from config filename
 * inventory-rebalance-config.yaml -> "main"
 * inventory-rebalance-config1.yaml -> "bot1"
 * inventory-rebalance-config-aggressive.yaml -> "aggressive"
 */
function extractBotIdFromFilename(filepath: string): string {
  const filename = path.basename(filepath, ".yaml");

  // inventory-rebalance-config.yaml -> main
  if (filename === "inventory-rebalance-config") {
    return "main";
  }

  // inventory-rebalance-config1.yaml -> bot1
  // inventory-rebalance-config-aggressive.yaml -> aggressive
  const suffix = filename.replace("inventory-rebalance-config", "").replace(/^[-_]/, "");

  if (/^\d+$/.test(suffix)) {
    return `bot${suffix}`;
  }

  return suffix || "main";
}

/**
 * Load a single config file
 */
function loadSingleConfig(configPath: string): RebalanceConfig {
  try {
    const fileContents = fs.readFileSync(configPath, "utf8");
    const loadedConfig = yaml.load(fileContents) as Partial<RebalanceConfig>;

    return {
      ...DEFAULT_CONFIG,
      ...loadedConfig,
    };
  } catch (error) {
    logger.error(`Failed to load config from ${configPath}:`, error);
    return DEFAULT_CONFIG;
  }
}

/**
 * Load all bot configurations
 * Returns array of BotConfig objects
 */
export function loadAllBotConfigs(): BotConfig[] {
  const configFiles = findAllConfigFiles();

  if (configFiles.length === 0) {
    logger.warn("No config files found, using default config for main bot");
    return [{
      botId: "main",
      botName: "BETABOT",
      configPath: "",
      config: DEFAULT_CONFIG,
    }];
  }

  const botConfigs: BotConfig[] = [];

  for (const configPath of configFiles) {
    const botId = extractBotIdFromFilename(configPath);
    const config = loadSingleConfig(configPath);

    // Check if config has a custom bot_name field
    const configAny = config as any;
    const botName = configAny.bot_name || `BETABOT-${botId.toUpperCase()}`;

    botConfigs.push({
      botId,
      botName: botId === "main" ? "BETABOT" : botName,
      configPath,
      config,
    });

    logger.info(`[MULTI-BOT] Loaded config for ${botId}: ${configPath}`);
  }

  logger.info(`[MULTI-BOT] Total bots configured: ${botConfigs.length}`);

  return botConfigs;
}

/**
 * Create a sample config file for a new bot
 */
export function createSampleBotConfig(botNumber: number): string {
  const filename = `inventory-rebalance-config${botNumber}.yaml`;
  const filepath = path.join(process.cwd(), filename);

  if (fs.existsSync(filepath)) {
    logger.warn(`Config file already exists: ${filename}`);
    return filepath;
  }

  const sampleConfig = `# Bot ${botNumber} Configuration
# This bot will run with separate PnL tracking and be displayed separately in the webapp

# Custom bot name (displayed in webapp)
bot_name: "BETABOT-${botNumber}"

# Copy settings from main config and modify as needed
bankroll_total: 10000.0
target_yes_ratio: 0.5

# Different sizing for this bot (example: more aggressive)
sizing_15m_base: 0.75
sizing_15m_multiplier: 18.00
sizing_15m_max_trade: 40.00

# Different tilt settings
tilt_threshold: 0.58
tilt_boost_multiplier: 1.35
`;

  fs.writeFileSync(filepath, sampleConfig);
  logger.info(`Created sample config: ${filename}`);

  return filepath;
}
