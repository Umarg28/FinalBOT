/**
 * Trade Logger - Creates separate CSV files per market
 * Each 15-min and 1-hour market gets its own CSV file for detailed trade tracking
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getRunId } from '../utils/runId';
import { ENV } from '../config/env';
import logger from '../utils/logger';

// CSV headers for trade logging
const CSV_HEADERS = [
  'Timestamp',
  'Date',
  'Year',
  'Month',
  'Day',
  'Hour',
  'Minute',
  'Second',
  'Millisecond',
  'Trader Address',
  'Trader Name',
  'Transaction Hash',
  'Condition ID',
  'Market Name',
  'Market Slug',
  'Market Key',
  'Side',
  'Outcome',
  'Outcome Index',
  'Asset',
  'Size (Shares)',
  'Price per Share ($)',
  'Total Value ($)',
  'Market Price UP ($)',
  'Market Price DOWN ($)',
  'Price Difference UP',
  'Price Difference DOWN',
  'Entry Type',
  'Average Cost Per Share UP ($)',
  'Average Cost Per Share DOWN ($)',
  'Skew Magnitude',
  'Dominant Side',
  'Target Allocation',
  'Reason',
].join(',');

export interface TradeLogEntry {
  // Activity data
  transactionHash?: string;
  conditionId?: string;
  asset?: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
  usdcSize: number;

  // Market info
  marketName: string;
  marketSlug?: string;
  marketKey: string;
  outcome: 'Up' | 'Down';
  outcomeIndex: number;

  // Prices
  priceUp?: number;
  priceDown?: number;

  // Position info
  avgCostUp?: number;
  avgCostDown?: number;

  // Strategy info
  skewMagnitude?: number;
  dominantSide?: 'UP' | 'DOWN' | 'NEUTRAL';
  targetAllocation?: number;
  reason?: string;
  entryType?: string;

  // Trader info
  traderAddress?: string;
  traderName?: string;
}

export class TradeLogger {
  private marketCsvFiles: Map<string, string> = new Map();
  private marketsDir: string;
  private runId: string;
  private initialized: boolean = false;

  constructor() {
    this.runId = getRunId();

    // Determine directory based on mode
    const logsDir = path.join(process.cwd(), 'logs');
    const mode = ENV.PAPER_MODE ? 'paper' : 'watcher';
    this.marketsDir = path.join(logsDir, mode, 'markets');

    this.initialize();
  }

  private initialize(): void {
    try {
      // Create directories
      if (!fs.existsSync(this.marketsDir)) {
        fs.mkdirSync(this.marketsDir, { recursive: true });
      }
      this.initialized = true;
      logger.info(`[TRADE-LOGGER] Initialized - markets directory: ${this.marketsDir}`);
    } catch (error) {
      logger.error(`[TRADE-LOGGER] Failed to initialize: ${error}`);
    }
  }

  /**
   * Sanitize market name for use as filename
   * Removes invalid characters, replaces spaces, limits length
   */
  private sanitizeMarketName(marketName: string): string {
    let sanitized = marketName
      // Remove invalid filename characters
      .replace(/[<>:"/\\|?*]/g, '')
      // Replace spaces with underscores
      .replace(/\s+/g, '_')
      // Clean up _-_ patterns
      .replace(/_-_/g, '-')
      // Remove commas
      .replace(/,/g, '')
      // Replace multiple underscores with single
      .replace(/__+/g, '_')
      // Remove leading/trailing underscores
      .replace(/^_|_$/g, '')
      .trim();

    // Limit to 100 characters
    if (sanitized.length > 100) {
      sanitized = sanitized.substring(0, 100);
    }

    return sanitized || 'Unknown_Market';
  }

  /**
   * Get or create CSV file path for a market
   */
  private getMarketCsvPath(marketName: string): string {
    // Check if we already have a path for this market
    if (this.marketCsvFiles.has(marketName)) {
      return this.marketCsvFiles.get(marketName)!;
    }

    // Create new CSV file for this market
    const sanitizedName = this.sanitizeMarketName(marketName);
    const fileName = `${sanitizedName}_${this.runId}.csv`;
    const filePath = path.join(this.marketsDir, fileName);

    // Initialize the file with headers
    this.initializeMarketCsvFile(filePath);

    // Cache the path
    this.marketCsvFiles.set(marketName, filePath);

    logger.debug(`[TRADE-LOGGER] Created CSV file for market: ${marketName} -> ${fileName}`);

    return filePath;
  }

  /**
   * Initialize a market CSV file with headers
   */
  private initializeMarketCsvFile(filePath: string): void {
    try {
      // Only write headers if file doesn't exist
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, CSV_HEADERS + os.EOL, { encoding: 'utf8', flag: 'w' });
      }
    } catch (error) {
      logger.error(`[TRADE-LOGGER] Failed to initialize CSV file ${filePath}: ${error}`);
    }
  }

  /**
   * Get timestamp breakdown for CSV
   */
  private getTimestampBreakdown(timestamp: number): {
    isoString: string;
    dateString: string;
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
    millisecond: number;
  } {
    const date = new Date(timestamp);
    return {
      isoString: date.toISOString(),
      dateString: date.toLocaleDateString('en-US'),
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      hour: date.getUTCHours(),
      minute: date.getUTCMinutes(),
      second: date.getUTCSeconds(),
      millisecond: date.getUTCMilliseconds(),
    };
  }

  /**
   * Escape a value for CSV (handle commas, quotes, newlines)
   */
  private escapeCSV(value: string | number | undefined | null): string {
    if (value === undefined || value === null) return '';
    const str = String(value);
    // If contains comma, quote, or newline, wrap in quotes and escape internal quotes
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  /**
   * Log a trade to the appropriate market CSV file
   */
  logTrade(entry: TradeLogEntry): void {
    if (!this.initialized) {
      logger.warn('[TRADE-LOGGER] Not initialized, skipping trade log');
      return;
    }

    try {
      const timestamp = Date.now();
      const tb = this.getTimestampBreakdown(timestamp);

      // Get the CSV file for this market
      const csvPath = this.getMarketCsvPath(entry.marketName);

      // Calculate price differences if prices available
      const priceDiffUp = entry.priceUp !== undefined && entry.avgCostUp !== undefined
        ? entry.priceUp - entry.avgCostUp
        : '';
      const priceDiffDown = entry.priceDown !== undefined && entry.avgCostDown !== undefined
        ? entry.priceDown - entry.avgCostDown
        : '';

      // Build CSV row
      const row = [
        tb.isoString,                                          // Timestamp
        tb.dateString,                                         // Date
        tb.year,                                               // Year
        tb.month,                                              // Month
        tb.day,                                                // Day
        tb.hour,                                               // Hour
        tb.minute,                                             // Minute
        tb.second,                                             // Second
        tb.millisecond,                                        // Millisecond
        this.escapeCSV(entry.traderAddress || ''),             // Trader Address
        this.escapeCSV(entry.traderName || ''),                // Trader Name
        this.escapeCSV(entry.transactionHash || ''),           // Transaction Hash
        this.escapeCSV(entry.conditionId || ''),               // Condition ID
        this.escapeCSV(entry.marketName),                      // Market Name
        this.escapeCSV(entry.marketSlug || ''),                // Market Slug
        this.escapeCSV(entry.marketKey),                       // Market Key
        entry.side,                                            // Side
        entry.outcome,                                         // Outcome
        entry.outcomeIndex,                                    // Outcome Index
        this.escapeCSV(entry.asset || ''),                     // Asset
        entry.size.toFixed(4),                                 // Size (Shares)
        entry.price.toFixed(6),                                // Price per Share ($)
        entry.usdcSize.toFixed(4),                             // Total Value ($)
        entry.priceUp?.toFixed(6) || '',                       // Market Price UP ($)
        entry.priceDown?.toFixed(6) || '',                     // Market Price DOWN ($)
        typeof priceDiffUp === 'number' ? priceDiffUp.toFixed(6) : '', // Price Difference UP
        typeof priceDiffDown === 'number' ? priceDiffDown.toFixed(6) : '', // Price Difference DOWN
        this.escapeCSV(entry.entryType || ''),                 // Entry Type
        entry.avgCostUp?.toFixed(6) || '',                     // Average Cost Per Share UP ($)
        entry.avgCostDown?.toFixed(6) || '',                   // Average Cost Per Share DOWN ($)
        entry.skewMagnitude?.toFixed(4) || '',                 // Skew Magnitude
        entry.dominantSide || '',                              // Dominant Side
        entry.targetAllocation?.toFixed(4) || '',              // Target Allocation
        this.escapeCSV(entry.reason || ''),                    // Reason
      ].join(',');

      // Append to file
      fs.appendFileSync(csvPath, row + os.EOL, { encoding: 'utf8', flag: 'a' });

    } catch (error) {
      logger.error(`[TRADE-LOGGER] Failed to log trade: ${error}`);
    }
  }

  /**
   * Log a trade from raw activity data (convenience method for marketTracker integration)
   */
  logTradeFromActivity(
    activity: any,
    marketKey: string,
    marketStats?: {
      currentPriceUp?: number;
      currentPriceDown?: number;
      totalCostUp?: number;
      totalCostDown?: number;
      sharesUp?: number;
      sharesDown?: number;
    },
    strategyInfo?: {
      skewMagnitude?: number;
      dominantSide?: 'UP' | 'DOWN' | 'NEUTRAL';
      targetAllocation?: number;
      reason?: string;
      entryType?: string;
    }
  ): void {
    const marketName = activity.title || activity.slug || activity.eventSlug || 'Unknown Market';
    const side = (activity.side?.toUpperCase() || 'BUY') as 'BUY' | 'SELL';
    const size = parseFloat(activity.size || '0');
    const price = parseFloat(activity.price || '0');
    const usdcSize = parseFloat(activity.usdcSize || '0');

    // Determine outcome
    const outcomeName = activity.outcome || 'Unknown';
    const isUp = /up|yes/i.test(outcomeName) ||
                 (activity.asset && activity.asset.endsWith(':0'));
    const outcome: 'Up' | 'Down' = isUp ? 'Up' : 'Down';
    const outcomeIndex = isUp ? 0 : 1;

    // Calculate average costs from market stats
    let avgCostUp: number | undefined;
    let avgCostDown: number | undefined;

    if (marketStats) {
      if (marketStats.sharesUp && marketStats.sharesUp > 0 && marketStats.totalCostUp !== undefined) {
        avgCostUp = marketStats.totalCostUp / marketStats.sharesUp;
      }
      if (marketStats.sharesDown && marketStats.sharesDown > 0 && marketStats.totalCostDown !== undefined) {
        avgCostDown = marketStats.totalCostDown / marketStats.sharesDown;
      }
    }

    this.logTrade({
      transactionHash: activity.transactionHash,
      conditionId: activity.conditionId,
      asset: activity.asset,
      side,
      size,
      price,
      usdcSize,
      marketName,
      marketSlug: activity.slug || activity.eventSlug,
      marketKey,
      outcome,
      outcomeIndex,
      priceUp: marketStats?.currentPriceUp,
      priceDown: marketStats?.currentPriceDown,
      avgCostUp,
      avgCostDown,
      skewMagnitude: strategyInfo?.skewMagnitude,
      dominantSide: strategyInfo?.dominantSide,
      targetAllocation: strategyInfo?.targetAllocation,
      reason: strategyInfo?.reason,
      entryType: strategyInfo?.entryType,
      traderAddress: activity.proxyWallet || activity.trader,
      traderName: ENV.PAPER_MODE ? 'PaperTrader' : 'Watcher',
    });
  }

  /**
   * Get list of all market CSV files created
   */
  getMarketFiles(): Map<string, string> {
    return new Map(this.marketCsvFiles);
  }

  /**
   * Get the markets directory path
   */
  getMarketsDir(): string {
    return this.marketsDir;
  }
}

// Singleton instance
export const tradeLogger = new TradeLogger();
export default tradeLogger;
