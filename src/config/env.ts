import dotenv from "dotenv";

dotenv.config();

// Default trader to watch if USER_ADDRESSES isn't provided
const DEFAULT_USER_ADDRESSES = '0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d';

function getEnvVar(key: string, required: boolean = true): string {
  const value = process.env[key];
  if (required && !value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value || "";
}

function getEnvVarNumber(key: string, defaultValue: number): number {
  const value = process.env[key];
  return value ? parseInt(value, 10) : defaultValue;
}

function getEnvVarFloat(key: string, defaultValue: number): number {
  const value = process.env[key];
  return value ? parseFloat(value) : defaultValue;
}

function getEnvVarBoolean(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (!value) return defaultValue;
  return value.toLowerCase() === "true";
}

/**
 * Validate Ethereum address format
 */
const isValidEthereumAddress = (address: string): boolean => {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
};

/**
 * Parse USER_ADDRESSES: supports both comma-separated string and JSON array
 */
const parseUserAddresses = (input: string): string[] => {
  if (!input || input.trim() === '') {
    console.log(`ℹ️  USER_ADDRESSES not set; defaulting to ${DEFAULT_USER_ADDRESSES}`);
    return [DEFAULT_USER_ADDRESSES.toLowerCase()];
  }

  const trimmed = input.trim();
  // Check if it's JSON array format
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed
          .map((addr) => addr.toLowerCase().trim())
          .filter((addr) => addr.length > 0 && isValidEthereumAddress(addr));
      }
    } catch (e) {
      console.error('Invalid JSON format for USER_ADDRESSES:', e);
    }
  }
  // Otherwise treat as comma-separated
  return trimmed
    .split(',')
    .map((addr) => addr.toLowerCase().trim())
    .filter((addr) => addr.length > 0 && isValidEthereumAddress(addr));
};

// Paper mode doesn't require wallet credentials
const isPaperMode = getEnvVarBoolean("PAPER_MODE", false);
const isWatcherMode = getEnvVarBoolean("WATCHER_MODE", false);
const isTrackOnlyMode = getEnvVarBoolean("TRACK_ONLY_MODE", false) || isWatcherMode;

export const ENV = {
  // Trading mode
  PAPER_MODE: isPaperMode,
  WATCHER_MODE: isWatcherMode,
  TRACK_ONLY_MODE: isTrackOnlyMode,

  // Wallet config (not required in paper mode)
  USER_ADDRESS: getEnvVar("USER_ADDRESS", !isPaperMode && !isTrackOnlyMode),
  USER_ADDRESSES: parseUserAddresses(getEnvVar("USER_ADDRESSES", false)), // Array of trader addresses to track
  PROXY_WALLET: getEnvVar("PROXY_WALLET", !isPaperMode && !isTrackOnlyMode),
  PRIVATE_KEY: getEnvVar("PRIVATE_KEY", !isPaperMode && !isTrackOnlyMode),

  // API endpoints
  CLOB_HTTP_URL: getEnvVar("CLOB_HTTP_URL", false) || "https://clob.polymarket.com",
  CLOB_WS_URL: getEnvVar("CLOB_WS_URL", false) || "wss://ws-subscriptions-clob.polymarket.com/ws/market",

  // Blockchain
  RPC_URL: getEnvVar("RPC_URL", false) || "https://polygon-rpc.com",
  USDC_CONTRACT_ADDRESS: getEnvVar("USDC_CONTRACT_ADDRESS", false) || "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",

  // Database
  MONGO_URI: getEnvVar("MONGO_URI", false) || "mongodb://localhost:27017/lightedge_polymarket",

  // Bot settings
  FETCH_INTERVAL: getEnvVarFloat("FETCH_INTERVAL", 1),
  TOO_OLD_TIMESTAMP: getEnvVarNumber("TOO_OLD_TIMESTAMP", 24),
  RETRY_LIMIT: getEnvVarNumber("RETRY_LIMIT", 3),
  REQUEST_TIMEOUT_MS: getEnvVarNumber("REQUEST_TIMEOUT_MS", 10000),
  NETWORK_RETRY_LIMIT: getEnvVarNumber("NETWORK_RETRY_LIMIT", 3),

  // Paper trading settings
  PAPER_BALANCE: getEnvVarNumber("PAPER_BALANCE", 10000),
  PAPER_STARTING_CAPITAL: getEnvVarNumber("PAPER_STARTING_CAPITAL", 10000),

  // Dashboard settings
  DASHBOARD_UPDATE_INTERVAL: getEnvVarNumber("DASHBOARD_UPDATE_INTERVAL", 500), // 500ms for responsive updates
  DASHBOARD_MARKETS: getEnvVar("DASHBOARD_MARKETS", false), // Comma-separated condition IDs
  DISPLAY_MAX_AGE_MINUTES: process.env.DISPLAY_MAX_AGE_MINUTES
    ? parseFloat(process.env.DISPLAY_MAX_AGE_MINUTES)
    : undefined,

  // Enhanced services (poly-sdk)
  USE_ENHANCED_SERVICES: getEnvVarBoolean("USE_ENHANCED_SERVICES", true), // Enable poly-sdk enhanced services

  // Official Polymarket real-time data client. This runs alongside the legacy
  // price stream logger so existing dashboards keep working while newer
  // clob_market/clob_user events are available for live accuracy.
  ENABLE_OFFICIAL_REALTIME: getEnvVarBoolean("ENABLE_OFFICIAL_REALTIME", true),
  OFFICIAL_REALTIME_DEBUG: getEnvVarBoolean("OFFICIAL_REALTIME_DEBUG", false),
  OFFICIAL_REALTIME_REFRESH_MS: getEnvVarNumber("OFFICIAL_REALTIME_REFRESH_MS", 30000),

  // Wallet readiness checks for live mode.
  MIN_MATIC_BALANCE: getEnvVarFloat("MIN_MATIC_BALANCE", 0.05),
  MIN_USDCE_BALANCE: getEnvVarFloat("MIN_USDCE_BALANCE", 1),
  REQUIRE_TRADING_APPROVALS: getEnvVarBoolean("REQUIRE_TRADING_APPROVALS", false),

  // Web Dashboard settings
  ENABLE_WEB_DASHBOARD: getEnvVarBoolean("ENABLE_WEB_DASHBOARD", true), // Enable web dashboard server
  WEB_DASHBOARD_PORT: getEnvVarNumber("WEB_DASHBOARD_PORT", 3000), // Port for web dashboard

  // External webapp forwarding (send data to another webapp)
  EXTERNAL_WEBAPP_URL: getEnvVar("EXTERNAL_WEBAPP_URL", false), // e.g., "http://localhost:4000/api/data"
  EXTERNAL_WEBAPP_API_KEY: getEnvVar("EXTERNAL_WEBAPP_API_KEY", false), // API key for external webapp
  EXTERNAL_WEBAPP_ENABLED: getEnvVarBoolean("EXTERNAL_WEBAPP_ENABLED", false), // Enable forwarding to external webapp

  // Multi-bot configuration
  BOT_ID: getEnvVar("BOT_ID", false) || "main", // Unique bot ID for multi-bot setups
  BOT_NAME: getEnvVar("BOT_NAME", false) || "BETABOT", // Display name for this bot
  CONFIG_FILE: getEnvVar("CONFIG_FILE", false) || "inventory-rebalance-config.yaml", // Config file to use

  // External wallet tracking (comma-separated list of wallet addresses)
  EXTERNAL_WALLETS: getEnvVar("EXTERNAL_WALLETS", false), // e.g., "0x123...,0x456..."

  // Quiet mode - suppress terminal output (for multi-bot dashboard)
  QUIET_MODE: getEnvVarBoolean("QUIET_MODE", false),

  // When the live terminal dashboard (marketTracker) is active, suppress noisy
  // INFO/TRADE console output so the dashboard doesn't flicker. File logging is
  // unaffected - everything is still written to logs/. Set to false to see all
  // logs in the terminal again. (Warnings and errors are always shown.)
  DASHBOARD_QUIET: getEnvVarBoolean("DASHBOARD_QUIET", true),

  // ─── Live execution: fees & risk controls ──────────────────────────────────
  // Polymarket fee rate in basis points. Currently 0 for these markets, but
  // centralized here so live PnL doesn't silently drift if fees are introduced.
  FEE_RATE_BPS: getEnvVarNumber("FEE_RATE_BPS", 0),

  // When a pre-trade safety check (e.g. market-start validation) throws in LIVE
  // mode, reject the trade ("fail closed") instead of letting it through.
  // Set to false only if you understand the risk of trading on unvalidated markets.
  FAIL_CLOSED_ON_VALIDATION_ERROR: getEnvVarBoolean("FAIL_CLOSED_ON_VALIDATION_ERROR", true),

  // Hard pre-trade risk limits (live mode only). 0 = disabled.
  // Max USDC notional (price * size) allowed for a single order.
  MAX_ORDER_NOTIONAL_USDC: getEnvVarFloat("MAX_ORDER_NOTIONAL_USDC", 50),
  // Max total open notional exposure across all live positions.
  MAX_TOTAL_EXPOSURE_USDC: getEnvVarFloat("MAX_TOTAL_EXPOSURE_USDC", 500),
  // Cumulative realized loss (USDC) in a UTC day that trips the kill-switch.
  MAX_DAILY_LOSS_USDC: getEnvVarFloat("MAX_DAILY_LOSS_USDC", 200),

  // Reject a live order if the latest price update for its token is older than
  // this (ms). Protects against trading on stale WebSocket data, especially on
  // retries for fast-moving short-window markets. 0 = disabled.
  MAX_PRICE_STALENESS_MS: getEnvVarNumber("MAX_PRICE_STALENESS_MS", 5000),
};

export default ENV;
