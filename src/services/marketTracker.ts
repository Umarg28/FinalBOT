import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import { ENV } from '../config/env';
import fetchData from '../utils/fetchData';
import priceStreamLogger from './priceStreamLogger';
import { getRunId } from '../utils/runId';
import logger from '../utils/logger';

/**
 * Helper function to break down timestamp into detailed components
 */
function getTimestampBreakdown(timestamp: number): {
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
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1, // 1-12
        day: date.getUTCDate(),
        hour: date.getUTCHours(),
        minute: date.getUTCMinutes(),
        second: date.getUTCSeconds(),
        millisecond: date.getUTCMilliseconds(),
    };
}

export interface MarketStats {
    marketKey: string; // e.g., "BTC-15min"
    marketName: string; // Full market name
    marketSlug?: string; // Market slug (for CSV alignment with paper bot)
    sharesUp: number;
    sharesDown: number;
    investedUp: number;
    investedDown: number;
    totalCostUp: number; // Total cost for UP shares (for average calculation)
    totalCostDown: number; // Total cost for DOWN shares (for average calculation)
    tradesUp: number;
    tradesDown: number;
    lastUpdate: number;
    endDate?: number; // Market end date timestamp (if available)
    conditionId?: string; // Condition ID for market lookup
    assetUp?: string; // Asset ID for UP outcome
    assetDown?: string; // Asset ID for DOWN outcome
    currentPriceUp?: number; // Current market price for UP
    currentPriceDown?: number; // Current market price for DOWN
    lastPriceUpdate?: number; // Timestamp of last price update
    marketOpenTime?: number; // Timestamp when this market was first opened
    category?: string; // Market category (e.g., "BTC-UpDown-15", "ETH-UpDown-15")
    // Snapshot prices captured shortly before market end
    closingPriceUp?: number;
    closingPriceDown?: number;
    // Internal: last time we tried to fetch asset IDs from Gamma (for backoff)
    lastAssetFetchAttempt?: number;
}

export class MarketTracker {
    private markets: Map<string, MarketStats> = new Map();
    private lastDisplayTime = 0;
    // Stable dashboard: update every 500ms for responsive price updates
    private displayInterval = 500;
    private lastMarketCount = 0;
    private loggedMarkets: Set<string> = new Set(); // Track markets already logged to CSV
    private csvFilePath: string;
    private maxMarkets = 8; // Maximum number of markets to track at once (4 current + 4 next)
    private marketsToClose: MarketStats[] = []; // Markets that need to be closed
    private onMarketCloseCallback?: (market: MarketStats) => Promise<void>; // Callback for closing positions
    private onPreCloseCallback?: (market: MarketStats) => Promise<void>; // Callback 5 seconds before market ends
    private preCloseTriggeredMarkets: Set<string> = new Set(); // Track markets that have already triggered pre-close
    private processedTrades: Set<string> = new Set(); // Track processed trades to prevent double-counting
    private displayMode: 'WATCH' | 'TRADING' | 'PAPER' = 'TRADING'; // Display mode for header
    private isDisplaying = false; // Lock to prevent concurrent display updates
    private priceUpdateInterval: NodeJS.Timeout | null = null; // Interval for frequent price updates
    private lastPriceFetchTime = 0; // Track last price fetch time

    constructor() {
        // Initialize CSV file path - use paper folder if in PAPER mode, otherwise watcher folder
        const logsDir = path.join(process.cwd(), 'logs');
        const isPaperMode = ENV.PAPER_MODE;
        const targetDir = path.join(logsDir, isPaperMode ? 'paper' : 'watcher');
        const fileName = isPaperMode ? 'Paper Market PNL' : 'Watcher Market PNL';
        
        // Create directories
        if (!fs.existsSync(logsDir)) {
            fs.mkdirSync(logsDir, { recursive: true });
        }
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }
        
        const runId = getRunId();
        // CSV file generation disabled - only TXT reports are used now
        // this.csvFilePath = path.join(targetDir, `${fileName}_${runId}.csv`);
        // this.initializeCsvFile();
        this.csvFilePath = ''; // Initialize to satisfy TypeScript (CSV functionality disabled)
    }

    /**
     * Initialize CSV file with headers (always create new file for each run)
     */
    private initializeCsvFile(): void {
        try {
            const headers = [
                'Timestamp',
                'Date',
                'Year',
                'Month',
                'Day',
                'Hour',
                'Minute',
                'Second',
                'Millisecond',
                'Market Key',
                'Market Name',
                'Condition ID',
                'Invested Up ($)',
                'Invested Down ($)',
                'Total Invested ($)',
                'Shares Up',
                'Shares Down',
                'Final Price Up ($)',
                'Final Price Down ($)',
                'Final Value Up ($)',
                'Final Value Down ($)',
                'Total Final Value ($)',
                'PnL Up ($)',
                'PnL Down ($)',
                'Total PnL ($)',
                'PnL Percent (%)',
                'Average Cost Per Share UP ($)',
                'Average Cost Per Share DOWN ($)',
                'Trades Up',
                'Trades Down',
                'Outcome',
                'Market Switch Reason',
                // Paper-specific column kept for 1:1 CSV format
                'Market Slug'
            ].join(',');
            fs.writeFileSync(this.csvFilePath, headers + '\n', 'utf8');
            console.log(`✓ Created CSV file: ${this.csvFilePath}`);
        } catch (error) {
            console.error(`✗ Failed to create CSV file ${this.csvFilePath}:`, error);
        }
    }

    /**
     * Fetch final prices for a closed market
     */
    private async fetchFinalPrices(market: MarketStats): Promise<{ priceUp?: number; priceDown?: number }> {
        const prices: { priceUp?: number; priceDown?: number } = {};

        try {
            // Try to get final prices from positions of tracked traders
            for (const traderAddress of ENV.USER_ADDRESSES) {
                try {
                    const positions = await fetchData(
                        `https://data-api.polymarket.com/positions?user=${traderAddress}`
                    ).catch(() => null);

                    if (Array.isArray(positions)) {
                        for (const pos of positions) {
                            if (market.assetUp && pos.asset === market.assetUp && pos.curPrice !== undefined) {
                                prices.priceUp = parseFloat(pos.curPrice);
                            }
                            if (market.assetDown && pos.asset === market.assetDown && pos.curPrice !== undefined) {
                                prices.priceDown = parseFloat(pos.curPrice);
                            }
                        }
                    }
                } catch (e) {
                    // Continue to next trader
                }
            }

            // If we have current prices from the market, use those as fallback
            if (prices.priceUp === undefined && market.currentPriceUp !== undefined) {
                prices.priceUp = market.currentPriceUp;
            }
            if (prices.priceDown === undefined && market.currentPriceDown !== undefined) {
                prices.priceDown = market.currentPriceDown;
            }
        } catch (e) {
            // Silently fail - will use current prices if available
        }

        return prices;
    }

    /**
     * Log closed market PnL to CSV file
     */
    private async logClosedMarketPnL(market: MarketStats): Promise<void> {
        // Skip if already logged
        if (this.loggedMarkets.has(market.marketKey)) {
            return;
        }

        // Fetch final prices (used as fallback if we don't have a closing snapshot)
        const finalPrices = await this.fetchFinalPrices(market);

        // Calculate final values and PnL
        const totalInvested = market.investedUp + market.investedDown;
        const totalCostBasis = market.totalCostUp + market.totalCostDown; // Cost basis excludes fees (matches Polymarket API)

        let finalValueUp = 0;
        let finalValueDown = 0;
        let pnlUp = 0;
        let pnlDown = 0;

        let rawPriceUp =
            market.closingPriceUp ??
            finalPrices.priceUp ??
            market.currentPriceUp ??
            0;
        let rawPriceDown =
            market.closingPriceDown ??
            finalPrices.priceDown ??
            market.currentPriceDown ??
            0;

        // Determine winner: the side with the higher price wins
        // When market closes, winning side = $1.00, losing side = $0.00
        let outcome = 'Unknown';
        let finalPriceUp = rawPriceUp;
        let finalPriceDown = rawPriceDown;

        // If prices are already resolved (0.99+ or 0.01-), use them directly
        if (rawPriceUp >= 0.99 || rawPriceDown >= 0.99 || rawPriceUp <= 0.01 || rawPriceDown <= 0.01) {
            if (rawPriceUp >= 0.99) {
                outcome = 'UP Won';
                finalPriceUp = 1.0;
                finalPriceDown = 0.0;
            } else if (rawPriceDown >= 0.99) {
                outcome = 'DOWN Won';
                finalPriceUp = 0.0;
                finalPriceDown = 1.0;
            } else if (rawPriceUp <= 0.01) {
                outcome = 'DOWN Won';
                finalPriceUp = 0.0;
                finalPriceDown = 1.0;
            } else if (rawPriceDown <= 0.01) {
                outcome = 'UP Won';
                finalPriceUp = 1.0;
                finalPriceDown = 0.0;
            }
        } else if (rawPriceUp > 0 || rawPriceDown > 0) {
            // Prices not yet resolved - determine winner from which side has higher price
            // Higher price = more likely to win = winner
            if (rawPriceUp > rawPriceDown) {
                outcome = 'UP Won';
                finalPriceUp = 1.0;
                finalPriceDown = 0.0;
            } else if (rawPriceDown > rawPriceUp) {
                outcome = 'DOWN Won';
                finalPriceUp = 0.0;
                finalPriceDown = 1.0;
            } else {
                // Equal prices - treat as unknown/tie, use raw prices
                outcome = 'Tie';
            }
        }

        if (market.sharesUp > 0) {
            finalValueUp = market.sharesUp * finalPriceUp;
            // Cost basis excludes fees (matches Polymarket API)
            pnlUp = finalValueUp - market.totalCostUp;
        }

        if (market.sharesDown > 0) {
            finalValueDown = market.sharesDown * finalPriceDown;
            // Cost basis excludes fees (matches Polymarket API)
            pnlDown = finalValueDown - market.totalCostDown;
        }

        const totalFinalValue = finalValueUp + finalValueDown;
        const totalPnl = pnlUp + pnlDown;
        // Cost basis excludes fees (matches Polymarket API)
        const pnlPercent = totalCostBasis > 0 ? (totalPnl / totalCostBasis) * 100 : 0;

        // Calculate average cost per share
        const avgCostUp = market.sharesUp > 0 ? market.totalCostUp / market.sharesUp : 0;
        const avgCostDown = market.sharesDown > 0 ? market.totalCostDown / market.sharesDown : 0;

        // Create CSV row with full timestamp breakdown
        const timestamp = Date.now();
        const date = new Date().toISOString();
        const timeBreakdown = getTimestampBreakdown(timestamp);
        const row = [
            timestamp,
            date,
            timeBreakdown.year,
            timeBreakdown.month,
            timeBreakdown.day,
            timeBreakdown.hour,
            timeBreakdown.minute,
            timeBreakdown.second,
            timeBreakdown.millisecond,
            market.marketKey,
            `"${market.marketName.replace(/"/g, '""')}"`, // Escape quotes in market name
            market.conditionId || '',
            market.investedUp.toFixed(2),
            market.investedDown.toFixed(2),
            totalInvested.toFixed(2),
            market.sharesUp.toFixed(4),
            market.sharesDown.toFixed(4),
            finalPriceUp.toFixed(4),
            finalPriceDown.toFixed(4),
            finalValueUp.toFixed(2),
            finalValueDown.toFixed(2),
            totalFinalValue.toFixed(2),
            pnlUp.toFixed(2),
            pnlDown.toFixed(2),
            totalPnl.toFixed(2),
            pnlPercent.toFixed(2),
            avgCostUp > 0 ? avgCostUp.toFixed(4) : '',
            avgCostDown > 0 ? avgCostDown.toFixed(4) : '',
            market.tradesUp,
            market.tradesDown,
            outcome,
            'Market Closed', // Market Switch Reason
            market.marketSlug || '' // Market Slug
        ].join(',');

        // CSV writing disabled - only TXT reports are used now
        // try {
        //     fs.appendFileSync(this.csvFilePath, row + '\n', 'utf8');
        //     this.loggedMarkets.add(market.marketKey);
        // } catch (error) {
        //     console.error(`Failed to write PnL to CSV: ${error}`);
        // }
        this.loggedMarkets.add(market.marketKey);
    }

    /**
     * Check if market is 15min or hourly (1h) market
     * Returns true if market matches 15min or hourly pattern
     */
    private is15MinOrHourlyMarket(activity: any): boolean {
        const rawTitle =
            activity?.slug ||
            activity?.eventSlug ||
            activity?.title ||
            activity?.asset ||
            '';
        
        if (!rawTitle) return false;
        
        const titleLower = rawTitle.toLowerCase();
        
        // Check for 15-minute timeframe
        const has15Min = /\b15\s*min|\b15min|updown.*?15|15.*?updown/i.test(rawTitle);
        
        // Check for hourly timeframe (1h, 1 hour, hourly)
        const hasHourly = /\b1\s*h|\b1\s*hour|\bhourly/i.test(rawTitle);
        
        // Check for hourly markets by pattern: "Up or Down" with single time (e.g., "6AM ET") but NO time range
        // Hourly markets: "Bitcoin Up or Down - December 24, 6AM ET" (single time, no range)
        // 15min markets: "Bitcoin Up or Down - December 24, 6:00AM-6:15AM ET" (has time range with colon)
        // Also handle slug format: "bitcoin-up-or-down-december-24-9am-et" (with hyphens)
        const hasUpDown = /(?:up|down).*?(?:up|down)|updown/i.test(titleLower);
        const hasCrypto = /(?:bitcoin|ethereum|btc|eth)/i.test(rawTitle);
        // Pattern like "6AM ET" or "7PM ET" (with spaces) OR "9am-et" (with hyphens in slug)
        const hasSingleTime = /\d{1,2}\s*(?:am|pm)\s*et/i.test(rawTitle) || /\d{1,2}(?:am|pm)-et/i.test(rawTitle);
        const hasTimeRange = /\d{1,2}:\d{2}\s*(?:am|pm)\s*[-–]\s*\d{1,2}:\d{2}\s*(?:am|pm)/i.test(rawTitle); // Pattern like "6:00AM-6:15AM"
        
        // If it's an Up/Down crypto market with single time but NO time range, it's hourly
        const isHourlyPattern = hasUpDown && hasCrypto && hasSingleTime && !hasTimeRange;
        
        return has15Min || hasHourly || isHourlyPattern;
    }

    /**
     * Check if market is ETH-UpDown-15 or BTC-UpDown-15 type
     * Returns normalized key like "ETH-UpDown-15" or "BTC-UpDown-15" if it matches, null otherwise
     */
    private getUpDown15MarketType(activity: any): string | null {
        const rawTitle =
            activity?.slug ||
            activity?.eventSlug ||
            activity?.title ||
            activity?.asset ||
            '';

        if (!rawTitle) return null;

        const titleLower = rawTitle.toLowerCase();

        // Check for 15-minute timeframe:
        // 1. Explicit "15 min" or "15min" patterns
        // 2. Slug pattern like "updown-15m-"
        // 3. Time range pattern like "5:00PM-5:15PM" (15-minute window)
        const hasExplicit15Min = /\b15\s*min|\b15min|updown.*?15m|15m.*?updown/i.test(rawTitle);
        // Time range like "X:00PM-X:15PM" or "X:15PM-X:30PM" etc (15-min windows)
        const hasTimeRange = /\d{1,2}:\d{2}\s*(?:am|pm)?\s*[-–]\s*\d{1,2}:\d{2}\s*(?:am|pm)?/i.test(rawTitle);
        const has15Min = hasExplicit15Min || hasTimeRange;

        // Check for hourly timeframe (explicit)
        const hasHourly = /\b1\s*h|\b1\s*hour|\bhourly/i.test(rawTitle);

        // Check for hourly markets by pattern: "Up or Down" with single time (e.g., "6AM ET") but NO time range
        // Also handle slug format: "bitcoin-up-or-down-december-24-9am-et" (with hyphens)
        const hasUpDown = /(?:up|down).*?(?:up|down)|updown/i.test(titleLower);
        const hasCrypto = /(?:bitcoin|ethereum|btc|eth)/i.test(rawTitle);
        // Pattern like "6AM ET" or "7PM ET" (with spaces) OR "9am-et" (with hyphens in slug)
        const hasSingleTime = /\d{1,2}\s*(?:am|pm)\s*et/i.test(rawTitle) || /\d{1,2}(?:am|pm)-et/i.test(rawTitle);
        const isHourlyPattern = hasUpDown && hasCrypto && hasSingleTime && !hasTimeRange;

        // If it's not 15min, not explicitly hourly, and not hourly by pattern, skip
        if (!has15Min && !hasHourly && !isHourlyPattern) {
            return null;
        }

        // Check for UpDown pattern (up/down/updown) - required for categorization
        if (hasUpDown || has15Min || hasHourly || isHourlyPattern) {
            // Check for Bitcoin
            if (titleLower.includes('bitcoin') || titleLower.includes('btc') || /^btc/i.test(rawTitle)) {
                return has15Min ? 'BTC-UpDown-15' : 'BTC-UpDown-1h';
            }
            // Check for Ethereum
            if (titleLower.includes('ethereum') || titleLower.includes('eth') || /^eth/i.test(rawTitle)) {
                return has15Min ? 'ETH-UpDown-15' : 'ETH-UpDown-1h';
            }
        }

        return null;
    }

    /**
     * Extract market category for grouping similar markets
     * Returns category string like "BTC-UpDown-15" or "ETH-UpDown-1h"
     */
    private extractMarketCategory(activity: any): string | null {
        const upDownType = this.getUpDown15MarketType(activity);
        if (upDownType) {
            return upDownType;
        }
        
        // Try to extract category from market name
        const rawTitle =
            activity?.slug ||
            activity?.eventSlug ||
            activity?.title ||
            activity?.asset ||
            '';
        
        if (!rawTitle) return null;
        
        const titleLower = rawTitle.toLowerCase();
        
        // Check for Bitcoin
        if (titleLower.includes('bitcoin') || titleLower.includes('btc') || /^btc/i.test(rawTitle)) {
            const hasExplicit15Min = /\b15\s*min|\b15min|updown.*?15m/i.test(rawTitle);
            const hasTimeRange = /\d{1,2}:\d{2}\s*(?:am|pm)?\s*[-–]\s*\d{1,2}:\d{2}\s*(?:am|pm)?/i.test(rawTitle);
            const has15Min = hasExplicit15Min || hasTimeRange;
            const hasHourly = /\b1\s*h|\b1\s*hour|\bhourly/i.test(rawTitle);
            // Also check for hourly pattern: single time without range
            const hasUpDown = /(?:up|down).*?(?:up|down)|updown/i.test(titleLower);
            const hasSingleTime = /\d{1,2}\s*(?:am|pm)\s*et/i.test(rawTitle) || /\d{1,2}(?:am|pm)-et/i.test(rawTitle);
            const isHourlyPattern = hasUpDown && hasSingleTime && !hasTimeRange;

            if (has15Min) return 'BTC-UpDown-15';
            if (hasHourly || isHourlyPattern) return 'BTC-UpDown-1h';
            return 'BTC';
        }

        // Check for Ethereum
        if (titleLower.includes('ethereum') || titleLower.includes('eth') || /^eth/i.test(rawTitle)) {
            const hasExplicit15Min = /\b15\s*min|\b15min|updown.*?15m/i.test(rawTitle);
            const hasTimeRange = /\d{1,2}:\d{2}\s*(?:am|pm)?\s*[-–]\s*\d{1,2}:\d{2}\s*(?:am|pm)?/i.test(rawTitle);
            const has15Min = hasExplicit15Min || hasTimeRange;
            const hasHourly = /\b1\s*h|\b1\s*hour|\bhourly/i.test(rawTitle);
            // Also check for hourly pattern: single time without range
            const hasUpDown = /(?:up|down).*?(?:up|down)|updown/i.test(titleLower);
            const hasSingleTime = /\d{1,2}\s*(?:am|pm)\s*et/i.test(rawTitle) || /\d{1,2}(?:am|pm)-et/i.test(rawTitle);
            const isHourlyPattern = hasUpDown && hasSingleTime && !hasTimeRange;

            if (has15Min) return 'ETH-UpDown-15';
            if (hasHourly || isHourlyPattern) return 'ETH-UpDown-1h';
            return 'ETH';
        }
        
        return null;
    }

    /**
     * Set callback for closing positions when markets are switched
     */
    setMarketCloseCallback(callback: (market: MarketStats) => Promise<void>): void {
        this.onMarketCloseCallback = callback;
    }

    /**
     * Set callback for 5 seconds before market ends (to capture final PnL)
     */
    setPreCloseCallback(callback: (market: MarketStats) => Promise<void>): void {
        this.onPreCloseCallback = callback;
    }

    /**
     * Extract market key from activity
     * Priority:
     * 1) Normalized UpDown-15 or UpDown-1h key (for BTC/ETH markets)
     * 2) conditionId (most stable per market)
     * 3) slug / eventSlug
     * 4) title / asset fallback
     */
    private extractMarketKey(activity: any): string {
        // Get raw title once for reuse
        const rawTitle =
            activity?.slug ||
            activity?.eventSlug ||
            activity?.title ||
            activity?.asset ||
            '';

        // Check for ETH-UpDown-15, ETH-UpDown-1h, BTC-UpDown-15, or BTC-UpDown-1h markets
        const upDownType = this.getUpDown15MarketType(activity);
        if (upDownType) {
            // For 15min markets, we need to add the timestamp to make unique keys
            // This ensures each 15-min window has its own market entry and can be closed/logged properly
            if (upDownType === 'BTC-UpDown-15' || upDownType === 'ETH-UpDown-15') {
                // Extract timestamp from slug (e.g., "updown-15m-1736319600" -> "1736319600")
                const slug = activity?.slug || activity?.eventSlug || '';
                const timestampMatch = slug.match(/updown-15m-(\d+)/);
                if (timestampMatch) {
                    // Return unique key with timestamp: BTC-UpDown-15-1736319600
                    return `${upDownType}-${timestampMatch[1]}`;
                }
                // Fallback: use conditionId if available for uniqueness
                if (activity?.conditionId) {
                    return `${upDownType}-${activity.conditionId.slice(-8)}`;
                }
                return upDownType;
            }

            // For hourly markets, we need to add the hour to make unique keys
            // Extract the hour from the time (e.g., "9AM ET" -> "9" or "9am-et" -> "9")
            if (rawTitle) {
                // Try pattern with spaces first (title format), then with hyphens (slug format)
                let timeMatch = rawTitle.match(/(\d{1,2})\s*(?:am|pm)\s*et/i);
                if (!timeMatch) {
                    timeMatch = rawTitle.match(/(\d{1,2})(?:am|pm)-et/i);
                }
                if (timeMatch) {
                    const hour = timeMatch[1];
                    // Return unique key with hour: BTC-UpDown-1h-9, ETH-UpDown-1h-9, etc.
                    return `${upDownType}-${hour}`;
                }
            }
            // Fallback: use category without hour (shouldn't happen, but safe fallback)
            return upDownType;
        }

        // For hourly markets detected by pattern but not categorized above, try to create a key
        if (rawTitle) {
            const titleLower = rawTitle.toLowerCase();
            const hasUpDown = /(?:up|down).*?(?:up|down)|updown/i.test(titleLower);
            // Handle both title format (with spaces) and slug format (with hyphens)
            const hasSingleTime = /\d{1,2}\s*(?:am|pm)\s*et/i.test(rawTitle) || /\d{1,2}(?:am|pm)-et/i.test(rawTitle);
            const hasTimeRange = /\d{1,2}:\d{2}\s*(?:am|pm)\s*[-–]\s*\d{1,2}:\d{2}\s*(?:am|pm)/i.test(rawTitle);
            const isHourlyPattern = hasUpDown && hasSingleTime && !hasTimeRange;
            
            if (isHourlyPattern) {
                // Extract the hour from the time (e.g., "6AM ET" -> "6" or "9am-et" -> "9")
                // Try pattern with spaces first (title format), then with hyphens (slug format)
                let timeMatch = rawTitle.match(/(\d{1,2})\s*(?:am|pm)\s*et/i);
                if (!timeMatch) {
                    timeMatch = rawTitle.match(/(\d{1,2})(?:am|pm)-et/i);
                }
                if (timeMatch) {
                    const hour = timeMatch[1];
                    // Check for crypto
                    if (titleLower.includes('bitcoin') || titleLower.includes('btc')) {
                        return `BTC-UpDown-1h-${hour}`;
                    }
                    if (titleLower.includes('ethereum') || titleLower.includes('eth')) {
                        return `ETH-UpDown-1h-${hour}`;
                    }
                }
            }
        }

        if (activity?.conditionId) {
            const slugPart = (rawTitle || 'Unknown').substring(0, 30);
            return `CID-${activity.conditionId}-${slugPart}`;
        }

        if (!rawTitle) return 'Unknown';
        
        // Try to extract crypto symbol and timeframe
        const titleLower = rawTitle.toLowerCase();
        
        // Check for Bitcoin patterns
        if (titleLower.includes('bitcoin') || titleLower.includes('btc')) {
            const match = rawTitle.match(/(\d+)\s*min/i);
            if (match) {
                return `BTC-${match[1]}min`;
            }
            // Check for other timeframes
            const hourMatch = rawTitle.match(/(\d+)\s*h/i);
            if (hourMatch) {
                return `BTC-${hourMatch[1]}h`;
            }
            return 'BTC';
        }
        
        // Check for Ethereum patterns
        if (titleLower.includes('ethereum') || titleLower.includes('eth')) {
            const match = rawTitle.match(/(\d+)\s*min/i);
            if (match) {
                return `ETH-${match[1]}min`;
            }
            const hourMatch = rawTitle.match(/(\d+)\s*h/i);
            if (hourMatch) {
                return `ETH-${hourMatch[1]}h`;
            }
            return 'ETH';
        }
        
        // Check for Solana
        if (titleLower.includes('solana') || titleLower.includes('sol')) {
            const match = rawTitle.match(/(\d+)\s*min/i);
            if (match) {
                return `SOL-${match[1]}min`;
            }
            return 'SOL';
        }
        
        // Check for generic crypto patterns: "CRYPTO 15min" or "CRYPTO/USD 15min"
        const cryptoMatch = rawTitle.match(/([A-Z]{2,5})\s*\/?\s*USD?\s*(\d+)\s*min/i);
        if (cryptoMatch) {
            return `${cryptoMatch[1].toUpperCase()}-${cryptoMatch[2]}min`;
        }
        
        // Check for standalone crypto symbols with timeframes
        const symbolMatch = rawTitle.match(/\b([A-Z]{2,5})\b.*?(\d+)\s*min/i);
        if (symbolMatch) {
            return `${symbolMatch[1].toUpperCase()}-${symbolMatch[2]}min`;
        }

        // If slug contains date/time segments, keep more of it for uniqueness
        if (activity?.slug) {
            const slugParts = activity.slug.split('-');
            if (slugParts.length >= 3) {
                return slugParts.slice(0, 4).join('-').substring(0, 40);
            }
            return activity.slug.substring(0, 40);
        }
        if (activity?.eventSlug) {
            const slugParts = activity.eventSlug.split('-');
            if (slugParts.length >= 3) {
                return slugParts.slice(0, 4).join('-').substring(0, 40);
            }
            return activity.eventSlug.substring(0, 40);
        }
        
        // Fallback: use first meaningful words (limit to 25 chars)
        const parts = rawTitle.split(/\s+/).filter((p: string) => p.length > 0);
        if (parts.length >= 2) {
            return `${parts[0].substring(0, 10)}-${parts[1].substring(0, 10)}`.substring(0, 25);
        }
        if (parts.length > 0) {
            return parts[0].substring(0, 25);
        }
        
        return 'Unknown';
    }

    /**
     * Extract hour number from market key (e.g., "BTC-UpDown-1h-6" -> 6)
     */
    private extractHourFromMarketKey(marketKey: string): number | null {
        // Market keys for 1-hour markets have format: "BTC-UpDown-1h-6" or "ETH-UpDown-1h-9"
        const match = marketKey.match(/-1h-(\d+)$/);
        if (match) {
            return parseInt(match[1], 10);
        }
        return null;
    }

    /**
     * Check if a market is a 1-hour market (not a 15-min time-window market)
     * 1-hour markets have single times like "6AM ET", not ranges like "10:15-10:30"
     */
    private is1HourMarket(marketKey: string, marketName?: string): boolean {
        // Check by market key pattern
        if (marketKey.includes('-1h')) {
            return true;
        }
        
        // Check by market name pattern if provided
        if (marketName) {
            const nameLower = marketName.toLowerCase();
            // 1-hour markets have single time like "6AM ET" but NO time range with colon
            const hasSingleTime = /\d{1,2}\s*(?:am|pm)\s*et/i.test(marketName) || /\d{1,2}(?:am|pm)-et/i.test(marketName);
            const hasTimeRange = /\d{1,2}:\d{2}\s*(?:am|pm)\s*[-–]\s*\d{1,2}:\d{2}\s*(?:am|pm)/i.test(marketName);
            const hasUpDown = /(?:up|down).*?(?:up|down)|updown/i.test(nameLower);
            const hasCrypto = /(?:bitcoin|ethereum|btc|eth)/i.test(marketName);
            
            // If it's Up/Down crypto with single time but NO time range, it's hourly
            return hasUpDown && hasCrypto && hasSingleTime && !hasTimeRange;
        }
        
        return false;
    }

    /**
     * Extract time window from market name (e.g., "10:15-10:30" or "10:30-10:45")
     * Returns null for 1-hour markets (they don't have time windows)
     */
    private extractTimeWindow(marketName: string): string | null {
        // First check if this is a 1-hour market - if so, don't extract time window
        // 1-hour markets have single times like "6AM ET", not ranges
        const hasSingleTime = /\d{1,2}\s*(?:am|pm)\s*et/i.test(marketName) || /\d{1,2}(?:am|pm)-et/i.test(marketName);
        const hasTimeRange = /\d{1,2}:\d{2}\s*(?:am|pm)\s*[-–]\s*\d{1,2}:\d{2}\s*(?:am|pm)/i.test(marketName);
        const nameLower = marketName.toLowerCase();
        const hasUpDown = /(?:up|down).*?(?:up|down)|updown/i.test(nameLower);
        const hasCrypto = /(?:bitcoin|ethereum|btc|eth)/i.test(marketName);
        
        // If it's a 1-hour market (Up/Down crypto with single time but NO time range), return null
        if (hasUpDown && hasCrypto && hasSingleTime && !hasTimeRange) {
            return null;
        }
        
        // Look for patterns like "10:15-10:30", "10:30-10:45", "10:15AM-10:30AM", "10:15 AM - 10:30 AM", etc.
        // Also handle formats like "December 23, 10:15AM-10:30AM ET"
        const timePatterns = [
            /(\d{1,2}:\d{2}(?:\s*[AP]M)?)\s*[-–]\s*(\d{1,2}:\d{2}(?:\s*[AP]M)?)/i,
            /(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})/i, // Without AM/PM
        ];
        
        for (const pattern of timePatterns) {
            const match = marketName.match(pattern);
            if (match) {
                return `${match[1].trim()}-${match[2].trim()}`;
            }
        }
        return null;
    }

    /**
     * Check if a time-window market has passed (e.g., "10:30-10:45" where current time > 10:45)
     * Assumes times are in ET/EST timezone
     * Returns false for 1-hour markets (they use endDate instead)
     */
    private isTimeWindowMarketPassed(marketName: string, marketKey?: string): boolean {
        // Skip 1-hour markets - they use endDate check instead
        if (marketKey && this.is1HourMarket(marketKey, marketName)) {
            return false;
        }
        
        const timeWindow = this.extractTimeWindow(marketName);
        if (!timeWindow) {
            return false; // Not a time-window market, can't determine if passed
        }

        try {
            // Extract end time (e.g., "10:45" from "10:30-10:45")
            const parts = timeWindow.split(/[-–]/);
            if (parts.length !== 2) {
                return false;
            }

            const endTimeStr = parts[1].trim();
            
            // Parse the end time
            // Handle formats like "10:45", "10:45AM", "10:45 PM", etc.
            const hasAMPM = /[AP]M/i.test(endTimeStr);
            const cleaned = endTimeStr.replace(/\s*[AP]M/i, '').trim();
            const timeParts = cleaned.split(':');
            
            if (timeParts.length !== 2) {
                return false;
            }

            let hours = parseInt(timeParts[0], 10);
            const minutes = parseInt(timeParts[1], 10);
            
            if (isNaN(hours) || isNaN(minutes)) {
                return false;
            }

            // Handle 12-hour format
            if (hasAMPM) {
                const isPM = /PM/i.test(endTimeStr);
                if (isPM && hours !== 12) {
                    hours += 12;
                } else if (!isPM && hours === 12) {
                    hours = 0;
                }
            }

            // Get current time in ET/EST
            // Use Intl.DateTimeFormat to get ET time (handles EST/EDT automatically)
            const now = new Date();
            const etFormatter = new Intl.DateTimeFormat('en-US', {
                timeZone: 'America/New_York',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false,
            });
            
            // Format as "HH:mm" and parse
            const etTimeStr = etFormatter.format(now);
            const [etHoursStr, etMinutesStr] = etTimeStr.split(':');
            const etHours = parseInt(etHoursStr || '0', 10);
            const etMinutes = parseInt(etMinutesStr || '0', 10);
            const currentTotalMinutes = etHours * 60 + etMinutes;
            const endTotalMinutes = hours * 60 + minutes;

            // Check if end time has passed today
            // If end time is early (e.g., 1:00 AM) and current time is late (e.g., 11:00 PM),
            // assume the market ended yesterday, so it's definitely passed
            if (endTotalMinutes < 6 * 60 && currentTotalMinutes > 18 * 60) {
                // End time is before 6 AM and current time is after 6 PM - market likely ended yesterday
                return true;
            }

            // Otherwise, check if current time is past end time
            return currentTotalMinutes > endTotalMinutes;
        } catch (e) {
            // If we can't parse, assume market hasn't passed (safer to show than hide)
            return false;
        }
    }

    /**
     * Get base market name without time window (e.g., "Bitcoin Up or Down" from "Bitcoin Up or Down - 10:15-10:30")
     */
    private getBaseMarketName(marketName: string): string {
        const timeWindow = this.extractTimeWindow(marketName);
        if (timeWindow) {
            // Remove the time window part
            return marketName.replace(new RegExp(`\\s*[-–]\\s*${timeWindow.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'), '').trim();
        }
        return marketName;
    }

    /**
     * Remove older ETH-UpDown-15, ETH-UpDown-1h, BTC-UpDown-15, or BTC-UpDown-1h markets when a new one appears
     * For 15min markets: Remove older markets in the same category (only keep the newest)
     * For hourly markets: Only remove if we're at max markets limit, otherwise allow multiple hours to coexist
     */
    private removeOlderUpDown15Markets(newMarketKey: string, newMarketActivity: any): void {
        // Check if this is an UpDown market (15min or hourly)
        // Keys now include timestamp suffix: BTC-UpDown-15-1736319600, ETH-UpDown-1h-9
        const isUpDown15 = newMarketKey.startsWith('ETH-UpDown-15') || newMarketKey.startsWith('BTC-UpDown-15');
        const isUpDown1h = newMarketKey.startsWith('ETH-UpDown-1h') || newMarketKey.startsWith('BTC-UpDown-1h');

        if (!isUpDown15 && !isUpDown1h) {
            return;
        }

        // Extract category for comparison (BTC-UpDown-15, BTC-UpDown-1h, etc.)
        // For 15min: "BTC-UpDown-15-1736319600" -> "BTC-UpDown-15"
        // For hourly: "BTC-UpDown-1h-6" -> "BTC-UpDown-1h"
        const newCategory = newMarketKey.split('-').slice(0, 3).join('-');

        const marketsToRemove: string[] = [];
        const now = Date.now();

        // CRITICAL: Only remove markets in the SAME category that have actually ENDED
        // Do NOT reset markets early - wait until their time is up (endDate <= now)
        // Do NOT reset 1-hour markets when 15-min markets switch, and vice versa

        // Check all existing markets to find UpDown markets of the same category
        for (const [key, market] of this.markets.entries()) {
            // Skip if it's the same key - we'll update it, not remove it
            if (key === newMarketKey) {
                continue;
            }

            // Check if this existing market is in the same category
            let existingCategory: string | null = null;
            if (key.startsWith('ETH-UpDown-15') || key.startsWith('BTC-UpDown-15')) {
                existingCategory = key.split('-').slice(0, 3).join('-'); // "BTC-UpDown-15"
            } else if (key.startsWith('ETH-UpDown-1h') || key.startsWith('BTC-UpDown-1h')) {
                existingCategory = key.split('-').slice(0, 3).join('-'); // "BTC-UpDown-1h"
            } else {
                // Try to get category from market name
                const existingUpDownType = this.getUpDown15MarketType({
                    slug: market.marketName,
                    title: market.marketName,
                    eventSlug: market.marketName,
                });
                if (existingUpDownType) {
                    existingCategory = existingUpDownType;
                }
            }

            // CRITICAL: Only process markets in the SAME category
            // Don't reset 1-hour markets when 15-min markets switch, and vice versa
            if (existingCategory === newCategory) {
                // Found a market in the same category
                // CRITICAL: Only remove if market has actually ENDED (endDate <= now)
                // Do NOT remove markets early - wait until their time is up
                const hasEnded = market.endDate && market.endDate <= now;
                if (!hasEnded) {
                    logger.debug(`[MARKET-TRACKER] removeOlderUpDown15Markets() - keeping market ${key} in category ${newCategory} (hasn't ended yet, endDate=${market.endDate ? new Date(market.endDate).toISOString() : 'N/A'})`);
                    continue; // Skip - market hasn't ended yet
                }
                
                // Market has ended - mark for removal
                marketsToRemove.push(key);
            }
        }

        // Remove older markets that have ended (but first call the close callback to log PnL)
        if (marketsToRemove.length > 0) {
            logger.info(`[MARKET-TRACKER] removeOlderUpDown15Markets() - removing ${marketsToRemove.length} ended market(s) in category ${newCategory}: ${marketsToRemove.join(', ')}`);
        }
        for (const key of marketsToRemove) {
            const marketToRemove = this.markets.get(key);
            if (marketToRemove && this.onMarketCloseCallback) {
                // Call the close callback before removing to ensure PnL is logged
                this.onMarketCloseCallback(marketToRemove).catch(error => {
                    logger.error(`[MARKET-TRACKER] Error in close callback for removed market ${key}:`, error);
                });
            }
            this.markets.delete(key);
            logger.debug(`[MARKET-TRACKER] removeOlderUpDown15Markets() - deleted market ${key}, markets count now=${this.markets.size}`);
        }
    }

    /**
     * Remove previous time window markets when a new one starts
     * Skips 1-hour markets - they are handled by closeOldMarketsInCategory
     */
    private removePreviousTimeWindow(newMarket: MarketStats): void {
        logger.debug(`[MARKET-TRACKER] removePreviousTimeWindow() called for marketKey=${newMarket.marketKey}, marketName=${newMarket.marketName}`);
        
        // Skip 1-hour markets - they don't have time windows and are handled differently
        if (this.is1HourMarket(newMarket.marketKey, newMarket.marketName)) {
            logger.debug(`[MARKET-TRACKER] removePreviousTimeWindow() skipped - 1-hour market`);
            return;
        }
        
        const newTimeWindow = this.extractTimeWindow(newMarket.marketName);
        if (!newTimeWindow) {
            logger.debug(`[MARKET-TRACKER] removePreviousTimeWindow() skipped - no time window extracted from market name`);
            return; // Not a time-window market
        }

        const baseName = this.getBaseMarketName(newMarket.marketName);
        const now = Date.now();
        logger.debug(`[MARKET-TRACKER] removePreviousTimeWindow() - newTimeWindow=${newTimeWindow}, baseName=${baseName}, checking ${this.markets.size} markets`);
        
        // Find markets with the same base name but different (earlier) time windows
        // CRITICAL: Only remove markets that have actually ENDED (endDate < now)
        // Don't remove markets just because a new one started - wait until old market has fully ended
        const marketsToRemove: string[] = [];
        
        for (const [key, market] of this.markets.entries()) {
            if (key === newMarket.marketKey) {
                continue; // Don't remove the new market
            }

            const marketBaseName = this.getBaseMarketName(market.marketName);
            if (marketBaseName === baseName) {
                const marketTimeWindow = this.extractTimeWindow(market.marketName);
                logger.debug(`[MARKET-TRACKER] removePreviousTimeWindow() - checking market ${key}, marketBaseName=${marketBaseName}, marketTimeWindow=${marketTimeWindow}`);
                if (marketTimeWindow && marketTimeWindow !== newTimeWindow) {
                    
                    // CRITICAL: Only remove if market has actually ended (endDate < now)
                    const hasEnded = market.endDate && market.endDate <= now;
                    if (!hasEnded) {
                        logger.debug(`[MARKET-TRACKER] removePreviousTimeWindow() - keeping market ${key} (hasn't ended yet, endDate=${market.endDate ? new Date(market.endDate).toISOString() : 'N/A'}, now=${new Date(now).toISOString()})`);
                        continue; // Skip - market hasn't ended yet
                    }
                    // Extract start times to compare
                    const newStart = newTimeWindow.split(/[-–]/)[0].trim();
                    const marketStart = marketTimeWindow.split(/[-–]/)[0].trim();
                    
                    // Parse times (handle formats like "10:15", "10:15AM", "10:15 AM", etc.)
                    const parseTime = (timeStr: string): number | null => {
                        try {
                            const cleaned = timeStr.replace(/\s*[AP]M/i, '').trim();
                            const parts = cleaned.split(':');
                            if (parts.length !== 2) return null;
                            
                            let hours = parseInt(parts[0], 10);
                            const minutes = parseInt(parts[1], 10);
                            
                            if (isNaN(hours) || isNaN(minutes)) return null;
                            
                            // Handle 12-hour format (if AM/PM was present, but we already removed it)
                            // For now, assume 24-hour format or that hours are already correct
                            return hours * 60 + minutes;
                        } catch (e) {
                            return null;
                        }
                    };

                    const newStartMinutes = parseTime(newStart);
                    const marketStartMinutes = parseTime(marketStart);
                    
                    // Only remove if we can successfully parse both times
                    if (newStartMinutes !== null && marketStartMinutes !== null) {
                        // Remove markets with earlier start times (previous time windows)
                        // Also handle wrap-around (e.g., 11:45 -> 12:00, but 12:00 is later)
                        if (marketStartMinutes < newStartMinutes) {
                            logger.debug(`[MARKET-TRACKER] removePreviousTimeWindow() - marking market ${key} for removal (${marketStartMinutes} < ${newStartMinutes})`);
                            marketsToRemove.push(key);
                        } else {
                            logger.debug(`[MARKET-TRACKER] removePreviousTimeWindow() - keeping market ${key} (${marketStartMinutes} >= ${newStartMinutes})`);
                        }
                    } else {
                        logger.debug(`[MARKET-TRACKER] removePreviousTimeWindow() - cannot parse times, newStartMinutes=${newStartMinutes}, marketStartMinutes=${marketStartMinutes}`);
                    }
                }
            }
        }

        // Remove the previous time window markets (but first call the close callback to log PnL)
        logger.info(`[MARKET-TRACKER] removePreviousTimeWindow() - removing ${marketsToRemove.length} previous time window market(s): ${marketsToRemove.join(', ')}`);
        for (const key of marketsToRemove) {
            const marketToRemove = this.markets.get(key);
            if (marketToRemove && this.onMarketCloseCallback) {
                logger.debug(`[MARKET-TRACKER] removePreviousTimeWindow() - calling close callback for market ${key}`);
                // Call the close callback before removing to ensure PnL is logged
                this.onMarketCloseCallback(marketToRemove).catch(error => {
                    logger.error(`[MARKET-TRACKER] Error in close callback for removed market ${key}:`, error);
                });
            }
            this.markets.delete(key);
            logger.debug(`[MARKET-TRACKER] removePreviousTimeWindow() - deleted market ${key}, markets count now=${this.markets.size}`);
        }
        logger.debug(`[MARKET-TRACKER] removePreviousTimeWindow() completed, final markets count=${this.markets.size}`);
    }

    /**
     * Determine if outcome is UP or DOWN
     */
    private isUpOutcome(activity: any): boolean {
        // Primary method: use outcomeIndex (0 = UP/YES, 1 = DOWN/NO typically)
        if (activity.outcomeIndex !== undefined) {
            return activity.outcomeIndex === 0;
        }
        
        // Fallback: check outcome and asset strings
        const outcome = (activity.outcome || '').toLowerCase();
        const asset = (activity.asset || '').toLowerCase();
        
        // Check for UP indicators
        if (outcome.includes('up') || 
            outcome.includes('higher') ||
            outcome.includes('above') ||
            outcome.includes('yes') ||
            asset.includes('yes') ||
            asset.includes('up')) {
            return true;
        }
        
        // Check for DOWN indicators
        if (outcome.includes('down') ||
            outcome.includes('lower') ||
            outcome.includes('below') ||
            outcome.includes('no') ||
            asset.includes('no') ||
            asset.includes('down')) {
            return false;
        }
        
        // Default: assume first outcome is UP
        return true;
    }

    /**
     * Close old markets in the same category when a new one opens
     * Only closes the oldest market in the same category, not all of them
     * For hourly markets: Close old markets that have ended, or if at max limit
     * This allows different categories to coexist up to the max limit
     */
    private async closeOldMarketsInCategory(newMarket: MarketStats, newCategory: string | null): Promise<void> {
        if (!newCategory) return;

        // Check if this is an hourly market category
        const isHourlyCategory = newCategory === 'BTC-UpDown-1h' || newCategory === 'ETH-UpDown-1h';
        const now = Date.now();

        // Find all markets in the same category (excluding the new one)
        const marketsInCategory: Array<{ key: string; market: MarketStats }> = [];
        
        for (const [key, market] of this.markets.entries()) {
            if (key === newMarket.marketKey) continue;
            
            // Check if this market is in the same category
            if (market.category === newCategory) {
                marketsInCategory.push({ key, market });
            }
        }

        if (marketsInCategory.length === 0) {
            return; // No markets in same category to close
        }

        // For hourly markets: Close old markets that have ended (endDate passed)
        // OR when a new hour market starts, close the previous hour (even if not expired)
        // OR if we're at max limit, close the oldest one
        if (isHourlyCategory) {
            // First, close any markets that have ended
            const expiredMarkets = marketsInCategory.filter(m => 
                m.market.endDate && m.market.endDate <= now
            );
            
            if (expiredMarkets.length > 0) {
                // Close all expired markets
                for (const expiredMarket of expiredMarkets) {
                    // Record profit from point of new market opening
                    await this.recordProfitAtMarketSwitch(expiredMarket.market, newMarket);
                    
                    // Remove from tracking
                    this.markets.delete(expiredMarket.key);
                    
                    // Trigger position closing callback if set
                    if (this.onMarketCloseCallback) {
                        try {
                            await this.onMarketCloseCallback(expiredMarket.market);
                        } catch (error) {
                            console.error(`Error closing positions for market ${expiredMarket.key}:`, error);
                        }
                    }
                }
                return; // Done closing expired markets
            }
            
            // For 1-hour markets: When a new hour market starts, close the previous hour
            // BUT only if the previous hour market has actually ENDED
            // Don't close markets just because a new one started - wait until old market has fully ended
            // Check if newMarket has a different hour than existing markets
            const newMarketHour = this.extractHourFromMarketKey(newMarket.marketKey);
            if (newMarketHour !== null) {
                // Find markets from previous hours (different hour number) that have actually ENDED
                const previousHourMarkets = marketsInCategory.filter(m => {
                    const marketHour = this.extractHourFromMarketKey(m.market.marketKey);
                    const isDifferentHour = marketHour !== null && marketHour !== newMarketHour;
                    // CRITICAL: Only include markets that have actually ended
                    const hasEnded = m.market.endDate && m.market.endDate <= now;
                    return isDifferentHour && hasEnded;
                });

                if (previousHourMarkets.length > 0) {
                    // Close all previous hour markets that have ended (switch to new hour)
                    for (const prevMarket of previousHourMarkets) {
                        // Record profit from point of new market opening
                        await this.recordProfitAtMarketSwitch(prevMarket.market, newMarket);

                        // Remove from tracking
                        this.markets.delete(prevMarket.key);

                        // Trigger position closing callback if set
                        if (this.onMarketCloseCallback) {
                            try {
                                await this.onMarketCloseCallback(prevMarket.market);
                            } catch (error) {
                                console.error(`Error closing positions for market ${prevMarket.key}:`, error);
                            }
                        }
                    }
                    return; // Done closing previous hour markets that have ended
                } else {
                    logger.debug(`[MARKET-TRACKER] closeOldMarketsInCategory() - no previous hour markets have ended yet for category ${newCategory}`);
                }
            }
            
            // If no expired markets and no previous hour markets, and we're at max limit, close the oldest one
            if (this.markets.size >= this.maxMarkets) {
                marketsInCategory.sort((a, b) => a.market.lastUpdate - b.market.lastUpdate);
                const oldestMarket = marketsInCategory[0];
                
                // Record profit from point of new market opening
                await this.recordProfitAtMarketSwitch(oldestMarket.market, newMarket);
                
                // Remove from tracking
                this.markets.delete(oldestMarket.key);
                
                // Trigger position closing callback if set
                if (this.onMarketCloseCallback) {
                    try {
                        await this.onMarketCloseCallback(oldestMarket.market);
                    } catch (error) {
                        console.error(`Error closing positions for market ${oldestMarket.key}:`, error);
                    }
                }
            }
            // If not at max limit and no expired/previous hour markets, allow multiple hours to coexist
            return;
        }

        // For non-hourly markets (15-min): Only close the oldest one if it has actually ENDED
        // Don't close markets just because a new one started - wait until old market has fully ended
        marketsInCategory.sort((a, b) => a.market.lastUpdate - b.market.lastUpdate);
        const oldestMarket = marketsInCategory[0];

        // CRITICAL: Only remove if market has actually ended (endDate < now)
        const hasEnded = oldestMarket.market.endDate && oldestMarket.market.endDate <= now;
        if (!hasEnded) {
            logger.debug(`[MARKET-TRACKER] closeOldMarketsInCategory() - keeping oldest market ${oldestMarket.key} in category ${newCategory} (hasn't ended yet, endDate=${oldestMarket.market.endDate ? new Date(oldestMarket.market.endDate).toISOString() : 'N/A'}, now=${new Date(now).toISOString()})`);
            return; // Don't close - market hasn't ended yet
        }

        // Record profit from point of new market opening
        await this.recordProfitAtMarketSwitch(oldestMarket.market, newMarket);

        // Remove from tracking
        this.markets.delete(oldestMarket.key);

        // Trigger position closing callback if set
        if (this.onMarketCloseCallback) {
            try {
                await this.onMarketCloseCallback(oldestMarket.market);
            } catch (error) {
                console.error(`Error closing positions for market ${oldestMarket.key}:`, error);
            }
        }
    }

    /**
     * Record profit from point of new market opening
     * This records PnL for a market at the time a new market opens
     */
    private async recordProfitAtNewMarketOpening(market: MarketStats, newMarket: MarketStats, isSwitching: boolean = false): Promise<void> {
        // Fetch current prices at the time of new market opening (used as fallback)
        const finalPrices = await this.fetchFinalPrices(market);

        const totalInvested = market.investedUp + market.investedDown;

        // Skip if no investment
        if (totalInvested === 0) {
            return;
        }

        const totalCostBasis = market.totalCostUp + market.totalCostDown; // Cost basis excludes fees (matches Polymarket API)

        let finalValueUp = 0;
        let finalValueDown = 0;
        let pnlUp = 0;
        let pnlDown = 0;

        let rawPriceUp =
            market.closingPriceUp ??
            finalPrices.priceUp ??
            market.currentPriceUp ??
            0;
        let rawPriceDown =
            market.closingPriceDown ??
            finalPrices.priceDown ??
            market.currentPriceDown ??
            0;

        // Determine winner: the side with the higher price wins
        // When market closes, winning side = $1.00, losing side = $0.00
        let outcome = 'Unknown';
        let finalPriceUp = rawPriceUp;
        let finalPriceDown = rawPriceDown;

        // If prices are already resolved (0.99+ or 0.01-), use them directly
        if (rawPriceUp >= 0.99 || rawPriceDown >= 0.99 || rawPriceUp <= 0.01 || rawPriceDown <= 0.01) {
            if (rawPriceUp >= 0.99) {
                outcome = 'UP Won';
                finalPriceUp = 1.0;
                finalPriceDown = 0.0;
            } else if (rawPriceDown >= 0.99) {
                outcome = 'DOWN Won';
                finalPriceUp = 0.0;
                finalPriceDown = 1.0;
            } else if (rawPriceUp <= 0.01) {
                outcome = 'DOWN Won';
                finalPriceUp = 0.0;
                finalPriceDown = 1.0;
            } else if (rawPriceDown <= 0.01) {
                outcome = 'UP Won';
                finalPriceUp = 1.0;
                finalPriceDown = 0.0;
            }
        } else if (rawPriceUp > 0 || rawPriceDown > 0) {
            // Prices not yet resolved - determine winner from which side has higher price
            // Higher price = more likely to win = winner
            if (rawPriceUp > rawPriceDown) {
                outcome = 'UP Won';
                finalPriceUp = 1.0;
                finalPriceDown = 0.0;
            } else if (rawPriceDown > rawPriceUp) {
                outcome = 'DOWN Won';
                finalPriceUp = 0.0;
                finalPriceDown = 1.0;
            } else {
                // Equal prices - treat as unknown/tie, use raw prices
                outcome = 'Tie';
            }
        }

        if (market.sharesUp > 0) {
            finalValueUp = market.sharesUp * finalPriceUp;
            // Cost basis excludes fees (matches Polymarket API)
            pnlUp = finalValueUp - market.totalCostUp;
        }

        if (market.sharesDown > 0) {
            finalValueDown = market.sharesDown * finalPriceDown;
            // Cost basis excludes fees (matches Polymarket API)
            pnlDown = finalValueDown - market.totalCostDown;
        }

        const totalFinalValue = finalValueUp + finalValueDown;
        const totalPnl = pnlUp + pnlDown;
        // Cost basis excludes fees (matches Polymarket API)
        const pnlPercent = totalCostBasis > 0 ? (totalPnl / totalCostBasis) * 100 : 0;

        // Calculate average cost per share
        const avgCostUp = market.sharesUp > 0 ? market.totalCostUp / market.sharesUp : 0;
        const avgCostDown = market.sharesDown > 0 ? market.totalCostDown / market.sharesDown : 0;

        // Log to CSV
        const timestamp = Date.now();
        const date = new Date().toISOString();
        const timeBreakdown = getTimestampBreakdown(timestamp);
        const marketKeyDisplay = isSwitching 
            ? `${market.marketKey}->${newMarket.marketKey}`
            : market.marketKey;
        const marketNameDisplay = isSwitching
            ? `"${market.marketName.replace(/"/g, '""')} (New market: ${newMarket.marketName.replace(/"/g, '""')})"`
            : `"${market.marketName.replace(/"/g, '""')} (Snapshot at new market: ${newMarket.marketName.replace(/"/g, '""')})"`;
        
        const row = [
            timestamp,
            date,
            timeBreakdown.year,
            timeBreakdown.month,
            timeBreakdown.day,
            timeBreakdown.hour,
            timeBreakdown.minute,
            timeBreakdown.second,
            timeBreakdown.millisecond,
            marketKeyDisplay,
            marketNameDisplay,
            market.conditionId || '',
            market.investedUp.toFixed(2),
            market.investedDown.toFixed(2),
            totalInvested.toFixed(2),
            market.sharesUp.toFixed(4),
            market.sharesDown.toFixed(4),
            finalPriceUp.toFixed(4),
            finalPriceDown.toFixed(4),
            finalValueUp.toFixed(2),
            finalValueDown.toFixed(2),
            totalFinalValue.toFixed(2),
            pnlUp.toFixed(2),
            pnlDown.toFixed(2),
            totalPnl.toFixed(2),
            pnlPercent.toFixed(2),
            avgCostUp > 0 ? avgCostUp.toFixed(4) : '',
            avgCostDown > 0 ? avgCostDown.toFixed(4) : '',
            market.tradesUp,
            market.tradesDown,
            outcome,
            isSwitching ? 'Market Switch' : 'New Market Snapshot',
            market.marketSlug || ''
        ].join(',');

        // CSV writing disabled - only TXT reports are used now
        // try {
        //     fs.appendFileSync(this.csvFilePath, row + '\n', 'utf8');
        // } catch (error) {
        //     console.error(`Failed to write market PnL to CSV: ${error}`);
        // }
    }

    /**
     * Record profit from point of new market opening (legacy method name for backward compatibility)
     */
    private async recordProfitAtMarketSwitch(oldMarket: MarketStats, newMarket: MarketStats): Promise<void> {
        await this.recordProfitAtNewMarketOpening(oldMarket, newMarket, true);
    }

    /**
     * Record PnL for all active markets when a new market opens
     */
    private async recordAllMarketsPnLAtNewMarketOpening(newMarket: MarketStats): Promise<void> {
        // Record PnL for all existing markets (except the new one)
        const marketsToRecord = Array.from(this.markets.values()).filter(
            m => m.marketKey !== newMarket.marketKey
        );

        // Record PnL for each market
        for (const market of marketsToRecord) {
            // Only record if there's actual investment
            if (market.investedUp > 0 || market.investedDown > 0) {
                await this.recordProfitAtNewMarketOpening(market, newMarket, false);
            }
        }
    }

    /**
     * Limit markets to maximum count, removing oldest ones
     */
    private async enforceMaxMarkets(): Promise<void> {
        if (this.markets.size <= this.maxMarkets) {
            return;
        }

        // Sort markets by lastUpdate (oldest first)
        const sortedMarkets = Array.from(this.markets.entries())
            .sort((a, b) => a[1].lastUpdate - b[1].lastUpdate);

        // Remove oldest markets until we're at max
        const toRemove = sortedMarkets.slice(0, this.markets.size - this.maxMarkets);
        
        for (const [key, market] of toRemove) {
            // Record profit before removing
            await this.logClosedMarketPnL(market);
            
            // Remove from tracking
            this.markets.delete(key);
            
            // Trigger position closing callback if set
            if (this.onMarketCloseCallback) {
                try {
                    await this.onMarketCloseCallback(market);
                } catch (error) {
                    console.error(`Error closing positions for market ${key}:`, error);
                }
            }
        }
    }

    /**
     * Process a new trade
     */
    async processTrade(activity: any): Promise<void> {
        const processStartTime = Date.now();
        logger.debug(`[MARKET-TRACKER] processTrade() called - transactionHash=${activity.transactionHash || 'N/A'}, asset=${activity.asset || 'N/A'}, side=${activity.side || 'N/A'}, slug=${activity.slug || activity.eventSlug || 'N/A'}`);
        
        // Only process 15min or hourly markets
        if (!this.is15MinOrHourlyMarket(activity)) {
            logger.debug(`[MARKET-TRACKER] processTrade() skipped - not a 15min or hourly market`);
            return; // Skip non-15min/hourly markets
        }

        // ==========================================================================
        // CRITICAL: For 15-min markets, verify this trade is for the CURRENT window!
        // This prevents trades on OLD markets that haven't expired yet
        // Same logic as paper mode for consistency
        // ==========================================================================
        const slug = activity.slug || activity.eventSlug || '';
        const is15MinMarket = /updown-15m-|15\s*min/i.test(slug) ||
                              (activity.title && /\d{1,2}:\d{2}\s*(?:am|pm)?\s*[-–]\s*\d{1,2}:\d{2}/i.test(activity.title));

        if (is15MinMarket && slug) {
            const slugTimestampMatch = slug.match(/updown-15m-(\d+)/);
            if (slugTimestampMatch) {
                const now = Date.now();
                const marketStartTimestamp = parseInt(slugTimestampMatch[1], 10) * 1000;
                const marketEndTimestamp = marketStartTimestamp + (15 * 60 * 1000);

                // Accept trades if:
                // 1. Market hasn't ended yet (still active)
                // 2. Market ended within the last 60 seconds (grace period for settlement)
                const isMarketActive = now < marketEndTimestamp;
                const isWithinGracePeriod = now < marketEndTimestamp + (60 * 1000);

                if (!isMarketActive && !isWithinGracePeriod) {
                    // Skip trades for markets that have been closed for more than 60 seconds
                    return;
                }
            }
        }

        // Create unique trade identifier to prevent double-counting
        // Use transactionHash + asset + side as unique key
        const tradeId = activity.transactionHash
            ? `${activity.transactionHash}:${activity.asset}:${activity.side || 'BUY'}`
            : `${activity.timestamp}:${activity.asset}:${activity.side || 'BUY'}`;

        // Skip if we've already processed this exact trade
        if (this.processedTrades.has(tradeId)) {
            return; // Already processed this trade, skip to prevent double-counting
        }

        const marketKey = this.extractMarketKey(activity);
        const isUp = this.isUpOutcome(activity);
        const shares = parseFloat(activity.size || '0');
        const invested = parseFloat(activity.usdcSize || '0');
        const side = activity.side?.toUpperCase() || 'BUY';
        const category = this.extractMarketCategory(activity);

        logger.debug(`[MARKET-TRACKER] Trade parsed - marketKey=${marketKey}, isUp=${isUp}, shares=${shares}, invested=${invested}, side=${side}, category=${category || 'N/A'}`);

        const isNewMarket = !this.markets.has(marketKey);
        logger.debug(`[MARKET-TRACKER] Market status - isNewMarket=${isNewMarket}, current markets count=${this.markets.size}`);

        // Remove older UpDown-15 markets before adding/updating
        // Always check, even if market exists, to catch older markets with different keys
        logger.debug(`[MARKET-TRACKER] Removing older UpDown-15 markets before processing trade`);
        const removeOlderStartTime = Date.now();
        this.removeOlderUpDown15Markets(marketKey, activity);
        logger.debug(`[MARKET-TRACKER] removeOlderUpDown15Markets() completed in ${Date.now() - removeOlderStartTime}ms, markets count now=${this.markets.size}`);
        
        let market = this.markets.get(marketKey);
        logger.debug(`[MARKET-TRACKER] Market lookup - marketKey=${marketKey}, found=${!!market}`);

        if (!market) {
            // Calculate endDate - ALWAYS calculate from slug for 15-min markets (API endDate is unreliable)
            let endDate: number | undefined;
            const slug = activity.slug || activity.eventSlug || '';
            const is15MinMarket = slug.includes('updown-15m');

            if (is15MinMarket) {
                // For 15-min markets: ALWAYS calculate from slug timestamp (most reliable)
                const timestamp15Match = slug.match(/updown-15m-(\d+)/);
                if (timestamp15Match) {
                    const startTime = parseInt(timestamp15Match[1], 10) * 1000;
                    endDate = startTime + (15 * 60 * 1000); // 15 minutes from start
                    
                    // Validate: endDate should not be more than 16 minutes in the future
                    const now = Date.now();
                    const timeUntilEnd = endDate - now;
                    if (timeUntilEnd > 16 * 60 * 1000) {
                        logger.warn(`⚠️ Calculated endDate for ${marketKey} seems wrong: ${(timeUntilEnd/1000/60).toFixed(1)}min until end (expected <16min). Recalculating...`);
                        // Recalculate - maybe the timestamp in slug is wrong, use current time + 15min as fallback
                        endDate = now + (15 * 60 * 1000);
                    }
                }
            } else {
                // For hourly markets: try API first, then calculate from slug
                if (activity.endDate) {
                    endDate = activity.endDate * 1000;
                }

                // Fallback: calculate from slug for hourly markets
                if (!endDate) {
                    const hourlyMatch = slug.match(/(\w+)-(\d+)-(\d{1,2})(am|pm)-et$/i);
                    if (hourlyMatch) {
                        const monthName = hourlyMatch[1];
                        const day = parseInt(hourlyMatch[2], 10);
                        let hour = parseInt(hourlyMatch[3], 10);
                        const ampm = hourlyMatch[4].toLowerCase();
                        if (ampm === 'pm' && hour !== 12) hour += 12;
                        if (ampm === 'am' && hour === 12) hour = 0;

                        const months: {[key: string]: number} = {
                            january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
                            july: 6, august: 7, september: 8, october: 9, november: 10, december: 11
                        };
                        const monthNum = months[monthName.toLowerCase()] ?? 0;
                        const year = new Date().getFullYear();

                        // Create ET time and convert to UTC
                        const etDateStr = `${year}-${String(monthNum + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00`;
                        const tempDate = new Date(etDateStr);
                        const etOffset = new Date(tempDate.toLocaleString('en-US', { timeZone: 'America/New_York' })).getTime() -
                                         new Date(tempDate.toLocaleString('en-US', { timeZone: 'UTC' })).getTime();
                        const startTimeUTC = tempDate.getTime() - etOffset;
                        endDate = startTimeUTC + (60 * 60 * 1000); // 1 hour from start
                    }
                }
            }

            market = {
                marketKey,
                marketName: activity.title || activity.slug || marketKey,
                marketSlug: activity.slug || activity.eventSlug || '',
                sharesUp: 0,
                sharesDown: 0,
                investedUp: 0,
                investedDown: 0,
                totalCostUp: 0,
                totalCostDown: 0,
                tradesUp: 0,
                tradesDown: 0,
                lastUpdate: Date.now(),
                endDate, // Now properly calculated
                conditionId: activity.conditionId,
                // Set BOTH asset IDs if provided (paper trades provide both)
                // Otherwise infer from single asset based on outcome direction
                assetUp: activity.assetUp || (isUp ? activity.asset : undefined),
                assetDown: activity.assetDown || (!isUp ? activity.asset : undefined),
                marketOpenTime: Date.now(),
                category: category || undefined,
            };
            this.markets.set(marketKey, market);
            logger.info(`[MARKET-TRACKER] NEW MARKET CREATED - marketKey=${marketKey}, marketName=${market.marketName}, conditionId=${market.conditionId || 'N/A'}, endDate=${market.endDate ? new Date(market.endDate).toISOString() : 'N/A'}, category=${market.category || 'N/A'}`);

            // Notify priceStreamLogger that a new market window has started
            // This enables logging for this market
            const marketSlugForNotify = market.marketSlug || '';
            if (marketSlugForNotify) {
                const is15Min = marketSlugForNotify.includes('updown-15m');
                const isHourly = !is15Min && marketKey.includes('-1h');
                const isBTC = marketKey.includes('BTC');
                const type: 'BTC' | 'ETH' = isBTC ? 'BTC' : 'ETH';
                const timeframe: '15m' | '1h' = is15Min ? '15m' : '1h';

                // Extract window start timestamp
                let windowStart = 0;
                if (is15Min) {
                    // 15-min markets: extract from slug
                    const match = marketSlugForNotify.match(/updown-15m-(\d+)/);
                    if (match) windowStart = parseInt(match[1], 10);
                } else if (isHourly && market.endDate) {
                    // Hourly markets: calculate from endDate (endDate - 1 hour = start)
                    windowStart = Math.floor(market.endDate / 1000) - 3600;
                }

                if (windowStart > 0) {
                    priceStreamLogger.notifyNewMarketWindow(type, timeframe, windowStart);
                }
            }

            // Remove previous time window markets when a new one starts (only for same category)
            // Note: This skips 1-hour markets which are handled by closeOldMarketsInCategory
            const is15MinCategory = category && (category.includes('UpDown-15'));
            const is1HourCategory = category && (category.includes('UpDown-1h'));
            
            if (is15MinCategory) {
                // Only process 15-min market switching - don't affect 1-hour markets
                logger.debug(`[MARKET-TRACKER] Removing previous 15-min time window markets for new market ${marketKey}`);
                const removePrevStartTime = Date.now();
                const marketsBeforeRemove = this.markets.size;
                this.removePreviousTimeWindow(market);
                const marketsAfterRemove = this.markets.size;
                logger.debug(`[MARKET-TRACKER] removePreviousTimeWindow() completed in ${Date.now() - removePrevStartTime}ms, markets: ${marketsBeforeRemove} -> ${marketsAfterRemove}`);
            } else if (is1HourCategory) {
                logger.debug(`[MARKET-TRACKER] New 1-hour market created: ${marketKey} - will handle via closeOldMarketsInCategory`);
            }
            
            // CRITICAL: Only close/record PnL for markets in the SAME category
            // Do NOT reset 1-hour markets when 15-min markets switch, and vice versa
            // Each market type should only reset when its own time is up
            if (category) {
                logger.debug(`[MARKET-TRACKER] Processing market closure for category: ${category} (only affects markets in same category)`);
                const closeOldStartTime = Date.now();
                await this.closeOldMarketsInCategory(market, category);
                logger.debug(`[MARKET-TRACKER] closeOldMarketsInCategory() completed in ${Date.now() - closeOldStartTime}ms`);
            }
            
            // Enforce max markets limit
            logger.debug(`[MARKET-TRACKER] Enforcing max markets limit (max=${this.maxMarkets})`);
            const enforceMaxStartTime = Date.now();
            await this.enforceMaxMarkets();
            logger.debug(`[MARKET-TRACKER] enforceMaxMarkets() completed in ${Date.now() - enforceMaxStartTime}ms, markets count=${this.markets.size}`);
            
            // Force immediate display update for new markets
            if (isNewMarket) {
                this.lastDisplayTime = 0; // Force display on next call
                logger.debug(`[MARKET-TRACKER] Forcing immediate display update for new market`);
            }

            // If the first trade is SELL, still register the market but don't accumulate
            if (side !== 'BUY') {
                return;
            }
        } else {
            // Update endDate - ALWAYS calculate from slug for 15-min markets (API endDate is unreliable)
            const slugForEndDate = activity.slug || activity.eventSlug || market.marketSlug || '';
            const is15MinMarket = slugForEndDate.includes('updown-15m');

            if (is15MinMarket) {
                // For 15-min markets: ALWAYS recalculate from slug (don't trust API)
                const timestamp15Match = slugForEndDate.match(/updown-15m-(\d+)/);
                if (timestamp15Match) {
                    const startTime = parseInt(timestamp15Match[1], 10) * 1000;
                    const calculatedEndDate = startTime + (15 * 60 * 1000); // 15 minutes from start
                    
                    // Validate: endDate should not be more than 16 minutes in the future
                    const now = Date.now();
                    const timeUntilEnd = calculatedEndDate - now;
                    if (timeUntilEnd > 16 * 60 * 1000) {
                        logger.warn(`⚠️ Calculated endDate for existing market ${marketKey} seems wrong: ${(timeUntilEnd/1000/60).toFixed(1)}min until end (expected <16min). Keeping existing endDate.`);
                    } else {
                        market.endDate = calculatedEndDate;
                    }
                }
            } else if (!market.endDate) {
                // For hourly markets: use API if available, otherwise calculate
                if (activity.endDate) {
                    market.endDate = activity.endDate * 1000;
                } else {
                    const hourlyMatch = slugForEndDate.match(/(\w+)-(\d+)-(\d{1,2})(am|pm)-et$/i);
                    if (hourlyMatch) {
                        const monthName = hourlyMatch[1];
                        const day = parseInt(hourlyMatch[2], 10);
                        let hour = parseInt(hourlyMatch[3], 10);
                        const ampm = hourlyMatch[4].toLowerCase();
                        if (ampm === 'pm' && hour !== 12) hour += 12;
                        if (ampm === 'am' && hour === 12) hour = 0;

                        const months: {[key: string]: number} = {
                            january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
                            july: 6, august: 7, september: 8, october: 9, november: 10, december: 11
                        };
                        const monthNum = months[monthName.toLowerCase()] ?? 0;
                        const year = new Date().getFullYear();

                        const etDateStr = `${year}-${String(monthNum + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00`;
                        const tempDate = new Date(etDateStr);
                        const etOffset = new Date(tempDate.toLocaleString('en-US', { timeZone: 'America/New_York' })).getTime() -
                                         new Date(tempDate.toLocaleString('en-US', { timeZone: 'UTC' })).getTime();
                        const startTimeUTC = tempDate.getTime() - etOffset;
                        market.endDate = startTimeUTC + (60 * 60 * 1000); // 1 hour from start
                    }
                }
            }
            if (activity.conditionId) {
                // Update conditionId - handles market rotations (new 15-min window)
                market.conditionId = activity.conditionId;

                // ALWAYS update assets when provided (handles market rotations)
                if (activity.assetUp) {
                    market.assetUp = activity.assetUp;
                }
                if (activity.assetDown) {
                    market.assetDown = activity.assetDown;
                }
                // Fallback: infer from single asset field based on outcome
                if (isUp && activity.asset) {
                    market.assetUp = activity.asset;
                }
                if (!isUp && activity.asset) {
                    market.assetDown = activity.asset;
                }
            } else {
                // No conditionId - still update assets if provided and missing
                if (activity.assetUp && !market.assetUp) {
                    market.assetUp = activity.assetUp;
                }
                if (activity.assetDown && !market.assetDown) {
                    market.assetDown = activity.assetDown;
                }
                if (isUp && activity.asset && !market.assetUp) {
                    market.assetUp = activity.asset;
                }
                if (!isUp && activity.asset && !market.assetDown) {
                    market.assetDown = activity.asset;
                }
            }
            // Update category if not set
            if (!market.category && category) {
                market.category = category;
            }
        }

        const price = parseFloat(activity.price || '0');
        const cost = shares * price; // Total cost for this trade

        // CRITICAL: In PAPER mode, only track positions for paper trades (transactionHash starts with "paper-")
        // Watcher trades should only discover markets, not add positions
        const isPaperTrade = activity.transactionHash && activity.transactionHash.startsWith('paper-');
        const shouldTrackPosition = this.displayMode !== 'PAPER' || isPaperTrade;

        if (shouldTrackPosition) {
            if (side === 'BUY') {
                // BUY: Add shares and cost basis
                if (isUp) {
                    market.sharesUp += shares;
                    market.investedUp += invested;
                    market.totalCostUp += cost;
                    market.tradesUp += 1;
                } else {
                    market.sharesDown += shares;
                    market.investedDown += invested;
                    market.totalCostDown += cost;
                    market.tradesDown += 1;
                }
            } else if (side === 'SELL') {
                // SELL: Reduce shares and cost basis proportionally using average cost method
                if (isUp && market.sharesUp > 0) {
                    // Calculate average cost per share before selling
                    const avgCostPerShare = market.totalCostUp / market.sharesUp;
                    // Calculate cost basis of shares being sold (can't sell more than we have)
                    const sharesToSell = Math.min(shares, market.sharesUp);
                    const costBasisOfSale = sharesToSell * avgCostPerShare;
                    
                    // Reduce shares and cost basis proportionally
                    market.sharesUp = Math.max(0, market.sharesUp - sharesToSell);
                    market.totalCostUp = Math.max(0, market.totalCostUp - costBasisOfSale);
                    // Note: investedUp represents total capital deployed (historical), we keep it unchanged
                    // Only totalCostUp (current cost basis) is reduced
                } else if (!isUp && market.sharesDown > 0) {
                    // Calculate average cost per share before selling
                    const avgCostPerShare = market.totalCostDown / market.sharesDown;
                    // Calculate cost basis of shares being sold (can't sell more than we have)
                    const sharesToSell = Math.min(shares, market.sharesDown);
                    const costBasisOfSale = sharesToSell * avgCostPerShare;
                    
                    // Reduce shares and cost basis proportionally
                    market.sharesDown = Math.max(0, market.sharesDown - sharesToSell);
                    market.totalCostDown = Math.max(0, market.totalCostDown - costBasisOfSale);
                    // Note: investedDown represents total capital deployed (historical), we keep it unchanged
                    // Only totalCostDown (current cost basis) is reduced
                }
                // Note: We don't increment trade counters for SELL trades to keep them as BUY-only counters
            }
            
            // Mark this trade as processed to prevent double-counting
            this.processedTrades.add(tradeId);
        } else {
            // For watcher trades in PAPER mode, mark as processed but don't add positions
            this.processedTrades.add(tradeId);
        }

        market.lastUpdate = Date.now();
        const processDuration = Date.now() - processStartTime;
        logger.debug(`[MARKET-TRACKER] processTrade() completed in ${processDuration}ms - marketKey=${marketKey}, sharesUp=${market.sharesUp}, sharesDown=${market.sharesDown}, investedUp=${market.investedUp}, investedDown=${market.investedDown}, tradesUp=${market.tradesUp}, tradesDown=${market.tradesDown}`);
    }

    /**
     * Fetch order book prices from CLOB API (most accurate method)
     */
    private async fetchOrderBookPrice(assetId: string): Promise<number | null> {
        try {
            const bookData = await fetchData(
                `https://clob.polymarket.com/book?token_id=${assetId}`
            ).catch(() => null);

            const typedBookData = bookData as { bids?: any[]; asks?: any[] } | null;
            if (typedBookData && typedBookData.bids && typedBookData.asks) {
                const bids = typedBookData.bids;
                const asks = typedBookData.asks;

                if (bids.length > 0 && asks.length > 0) {
                    // Get best bid (highest price) and best ask (lowest price)
                    const bestBid = Math.max(...bids.map((b: any) => parseFloat(b.price || 0)));
                    const bestAsk = Math.min(...asks.map((a: any) => parseFloat(a.price || 1)));

                    if (bestBid > 0 && bestAsk > 0 && bestBid <= 1 && bestAsk <= 1) {
                        // Use mid price (average of best bid and best ask) - most accurate
                        return (bestBid + bestAsk) / 2;
                    }
                }
            }
        } catch (e) {
            // Silently fail
        }
        return null;
    }

    /**
     * Fetch current prices for market assets using order book (most accurate) with fallback to positions
     */
    /**
     * Fetch asset IDs from Gamma API if missing
     */
    private async fetchAssetIdsIfMissing(market: MarketStats): Promise<boolean> {
        // Only fetch if we're missing asset IDs and have conditionId or slug
        if ((market.assetUp && market.assetDown) || (!market.conditionId && !market.marketSlug)) {
            return false; // Already have assets or no way to fetch them
        }

        const now = Date.now();
        const ASSET_FETCH_BACKOFF_MS = 60 * 1000; // At most once per minute per market

        if (market.lastAssetFetchAttempt && now - market.lastAssetFetchAttempt < ASSET_FETCH_BACKOFF_MS) {
            return false;
        }

        market.lastAssetFetchAttempt = now;

        try {
            // Try fetching by slug first (more reliable for new 15-min markets)
            if (market.marketSlug) {
                const slugUrl = `https://gamma-api.polymarket.com/events?slug=${market.marketSlug}`;
                const data = await fetchData(slugUrl).catch(() => null);
                if (data && Array.isArray(data) && data.length > 0) {
                    const event = data[0];
                    const markets = event.markets || [];
                    if (markets.length > 0) {
                        const marketData = markets[0];
                        const clobTokenIds = marketData.clobTokenIds || [];
                        if (clobTokenIds.length >= 2) {
                            const outcomes = marketData.outcomes || ['Up', 'Down'];
                            const isFirstUp = outcomes[0]?.toLowerCase().includes('up');
                            market.assetUp = isFirstUp ? clobTokenIds[0] : clobTokenIds[1];
                            market.assetDown = isFirstUp ? clobTokenIds[1] : clobTokenIds[0];
                            return true; // Successfully fetched asset IDs
                        }
                    }
                }
            }

            // Fallback: Fetch from general markets list by conditionId
            if (market.conditionId) {
                const gammaUrl = `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=500`;
                const marketList = await fetchData(gammaUrl).catch(() => null);

                if (Array.isArray(marketList)) {
                    const marketData = marketList.find((m: any) => m.condition_id === market.conditionId);
                    if (marketData && marketData.clobTokenIds && marketData.clobTokenIds.length >= 2) {
                        const outcomes = marketData.outcomes || ['Up', 'Down'];
                        const isFirstUp = outcomes[0]?.toLowerCase().includes('up');
                        market.assetUp = isFirstUp ? marketData.clobTokenIds[0] : marketData.clobTokenIds[1];
                        market.assetDown = isFirstUp ? marketData.clobTokenIds[1] : marketData.clobTokenIds[0];
                        return true; // Successfully fetched asset IDs
                    }
                }
            }
        } catch (e) {
            // Silently fail - will retry on next update
        }
        return false; // Failed to fetch asset IDs
    }

    private async fetchCurrentPricesFromAPI(market: MarketStats): Promise<void> {
        try {
            logger.info(
                `[PRICE-FETCH] Start for ${market.marketKey} (slug=${market.marketSlug || 'n/a'}, conditionId=${market.conditionId || 'n/a'})`
            );

            // If asset IDs are missing, try to fetch them first
            if (!market.assetUp || !market.assetDown) {
                logger.info(
                    `[PRICE-FETCH] ${market.marketKey}: assetUp/assetDown missing, attempting to fetch from Gamma`
                );
                await this.fetchAssetIdsIfMissing(market);
            }

            // FIRST: Try WebSocket prices from priceStreamLogger by MARKET TYPE
            // The WebSocket tracks current market windows, so we need to look up by market type
            // rather than by the dashboard's asset IDs (which may be from an old window)
            const marketKey = market.marketKey;
            let wsMarketType: string | null = null;

            // Map dashboard marketKey to WebSocket market type
            if (marketKey.includes('BTC') && marketKey.includes('-15')) {
                wsMarketType = 'btc-updown-15m';
            } else if (marketKey.includes('ETH') && marketKey.includes('-15')) {
                wsMarketType = 'eth-updown-15m';
            } else if (marketKey.includes('BTC') && marketKey.includes('-1h')) {
                wsMarketType = 'bitcoin-up-or-down';
            } else if (marketKey.includes('ETH') && marketKey.includes('-1h')) {
                wsMarketType = 'ethereum-up-or-down';
            }

            if (wsMarketType) {
                logger.info(
                    `[PRICE-FETCH] ${market.marketKey}: looking up WebSocket market type ${wsMarketType}`
                );
                const currentMarkets = priceStreamLogger.getCurrentMarkets();
                const nextMarkets = priceStreamLogger.getNextMarkets();

                // Collect candidate WebSocket markets for this type from both current and next maps
                const candidates: Array<{ source: 'currentMarkets' | 'nextMarkets'; info: any }> = [];
                const currentByType = currentMarkets.get(wsMarketType);
                const nextByType = nextMarkets.get(wsMarketType);
                if (currentByType) {
                    candidates.push({ source: 'currentMarkets', info: currentByType });
                }
                if (nextByType) {
                    candidates.push({ source: 'nextMarkets', info: nextByType });
                }

                let wsMarket: any | null = null;
                let marketSource: 'currentMarkets' | 'nextMarkets' | 'currentMarkets-fallback' | 'nextMarkets-fallback' = 'currentMarkets-fallback';

                if (candidates.length === 1) {
                    wsMarket = candidates[0].info;
                    marketSource = candidates[0].source;
                } else if (candidates.length > 1) {
                    // Prefer a candidate whose condition_id matches this dashboard market
                    if (market.conditionId) {
                        const byCondition = candidates.find(
                            c => c.info.condition_id === market.conditionId
                        );
                        if (byCondition) {
                            wsMarket = byCondition.info;
                            marketSource = byCondition.source;
                        }
                    }

                    // Next, try to match by asset IDs if we have them
                    if (!wsMarket && (market.assetUp || market.assetDown)) {
                        const assetSet = new Set<string>();
                        if (market.assetUp) assetSet.add(market.assetUp);
                        if (market.assetDown) assetSet.add(market.assetDown);
                        const byAsset = candidates.find(c =>
                            c.info.tokens?.some((t: any) => assetSet.has(t.token_id))
                        );
                        if (byAsset) {
                            wsMarket = byAsset.info;
                            marketSource = byAsset.source;
                        }
                    }

                    // Finally, try to match by slug if available
                    if (!wsMarket && market.marketSlug) {
                        const slugLower = market.marketSlug.toLowerCase();
                        const bySlug = candidates.find(
                            c => (c.info.slug || '').toLowerCase() === slugLower
                        );
                        if (bySlug) {
                            wsMarket = bySlug.info;
                            marketSource = bySlug.source;
                        }
                    }

                    // If no specific match, fall back to current then next
                    if (!wsMarket) {
                        if (currentByType) {
                            wsMarket = currentByType;
                            marketSource = 'currentMarkets-fallback';
                        } else if (nextByType) {
                            wsMarket = nextByType;
                            marketSource = 'nextMarkets-fallback';
                        }
                    }
                }

                if (wsMarket && wsMarket.tokens && wsMarket.tokens.length >= 2) {
                    // Find UP and DOWN tokens from the WebSocket market
                    const upToken = wsMarket.tokens.find(
                        (t: any) => t.outcome && t.outcome.toUpperCase() === 'UP'
                    );
                    const downToken = wsMarket.tokens.find(
                        (t: any) => t.outcome && t.outcome.toUpperCase() === 'DOWN'
                    );

                    if (upToken && downToken) {
                        const wsUpPrice = priceStreamLogger.getMidPrice(upToken.token_id);
                        const wsDownPrice = priceStreamLogger.getMidPrice(downToken.token_id);

                        if (wsUpPrice !== null && wsDownPrice !== null && wsUpPrice > 0 && wsDownPrice > 0) {
                            logger.info(
                                `[PRICE-FETCH] ${market.marketKey}: got prices from WebSocket ${marketSource} type=${wsMarketType} ` +
                                `UP=${wsUpPrice.toFixed(4)} DOWN=${wsDownPrice.toFixed(4)}`
                            );
                            market.currentPriceUp = wsUpPrice;
                            market.currentPriceDown = wsDownPrice;
                            market.lastPriceUpdate = Date.now();

                            // Also update asset IDs to match the WebSocket market tokens
                            market.assetUp = upToken.token_id;
                            market.assetDown = downToken.token_id;
                            return; // Successfully got prices from WebSocket
                        } else {
                            logger.info(
                                `[PRICE-FETCH] ${market.marketKey}: WebSocket prices missing/invalid from ${marketSource} (up=${wsUpPrice}, down=${wsDownPrice})`
                            );
                        }
                    } else {
                        logger.info(
                            `[PRICE-FETCH] ${market.marketKey}: WebSocket market ${wsMarketType} from ${marketSource} missing UP/DOWN tokens`
                        );
                    }
                } else if (wsMarketType) {
                    logger.info(
                        `[PRICE-FETCH] ${market.marketKey}: no WebSocket market found in currentMarkets or nextMarkets for type ${wsMarketType}`
                    );
                }
            }

            // SECOND: Try WebSocket prices using dashboard's asset IDs (may work if same window)
            if (market.assetUp && market.assetDown) {
                logger.info(
                    `[PRICE-FETCH] ${market.marketKey}: trying WebSocket prices by asset IDs ` +
                    `(assetUp=${market.assetUp}, assetDown=${market.assetDown})`
                );
                const wsUpPrice = priceStreamLogger.getMidPrice(market.assetUp);
                const wsDownPrice = priceStreamLogger.getMidPrice(market.assetDown);

                if (wsUpPrice !== null && wsDownPrice !== null && wsUpPrice > 0 && wsDownPrice > 0) {
                    logger.info(
                        `[PRICE-FETCH] ${market.marketKey}: got prices from WebSocket by asset IDs ` +
                        `UP=${wsUpPrice.toFixed(4)} DOWN=${wsDownPrice.toFixed(4)}`
                    );
                    market.currentPriceUp = wsUpPrice;
                    market.currentPriceDown = wsDownPrice;
                    market.lastPriceUpdate = Date.now();
                    return; // Successfully got prices from WebSocket
                } else {
                    logger.info(
                        `[PRICE-FETCH] ${market.marketKey}: WebSocket asset-ID prices missing/invalid (up=${wsUpPrice}, down=${wsDownPrice})`
                    );
                }
            }

            // FALLBACK: Always try order book prices via HTTP if WebSocket didn't work
            // This ensures we get prices even if WebSocket is unavailable
            if (market.assetUp && market.assetDown) {
                logger.info(
                    `[PRICE-FETCH] ${market.marketKey}: falling back to order book for assetUp=${market.assetUp}, assetDown=${market.assetDown}`
                );
                const [priceUpFromBook, priceDownFromBook] = await Promise.all([
                    this.fetchOrderBookPrice(market.assetUp),
                    this.fetchOrderBookPrice(market.assetDown),
                ]);

                if (priceUpFromBook !== null && priceDownFromBook !== null) {
                    logger.info(
                        `[PRICE-FETCH] ${market.marketKey}: got prices from order book ` +
                        `UP=${priceUpFromBook.toFixed(4)} DOWN=${priceDownFromBook.toFixed(4)}`
                    );
                    market.currentPriceUp = priceUpFromBook;
                    market.currentPriceDown = priceDownFromBook;
                    market.lastPriceUpdate = Date.now();
                    return; // Successfully got prices from order book
                } else {
                    logger.info(
                        `[PRICE-FETCH] ${market.marketKey}: order book prices missing/invalid (up=${priceUpFromBook}, down=${priceDownFromBook})`
                    );
                }
            }
            
            // If we still don't have prices and asset IDs are missing, try one more time to fetch them
            // This handles cases where asset IDs weren't available initially
            if ((!market.currentPriceUp || !market.currentPriceDown) && (!market.assetUp || !market.assetDown)) {
                logger.info(
                    `[PRICE-FETCH] ${market.marketKey}: still missing prices and assets, re-attempting asset fetch`
                );
                const fetchedAssets = await this.fetchAssetIdsIfMissing(market);
                if (fetchedAssets && market.assetUp && market.assetDown) {
                    // Try order book one more time with newly fetched asset IDs
                    logger.info(
                        `[PRICE-FETCH] ${market.marketKey}: got assets from Gamma on retry, trying order book again`
                    );
                    const [priceUpFromBook, priceDownFromBook] = await Promise.all([
                        this.fetchOrderBookPrice(market.assetUp),
                        this.fetchOrderBookPrice(market.assetDown),
                    ]);

                    if (priceUpFromBook !== null && priceDownFromBook !== null) {
                        logger.info(
                            `[PRICE-FETCH] ${market.marketKey}: got prices from order book on retry ` +
                            `UP=${priceUpFromBook.toFixed(4)} DOWN=${priceDownFromBook.toFixed(4)}`
                        );
                        market.currentPriceUp = priceUpFromBook;
                        market.currentPriceDown = priceDownFromBook;
                        market.lastPriceUpdate = Date.now();
                        return; // Successfully got prices from order book
                    } else {
                        logger.info(
                            `[PRICE-FETCH] ${market.marketKey}: order book retry still missing/invalid (up=${priceUpFromBook}, down=${priceDownFromBook})`
                        );
                    }
                }
            }

            market.lastPriceUpdate = Date.now();
        } catch (e) {
            logger.warn(
                `[PRICE-FETCH] ${market.marketKey}: exception during price fetch, will retry later`,
                e
            );
        }
    }

    /**
     * Fetch current prices for market assets
     * This method is called frequently and uses cached prices when possible
     * @param force - If true, bypasses throttle and forces immediate fetch
     */
    private async fetchCurrentPrices(market: MarketStats, force: boolean = false): Promise<void> {
        const now = Date.now();

        // Always fetch if we don't have prices yet, otherwise throttle to 500ms
        // This ensures prices appear immediately when markets are discovered
        // If force is true, always fetch regardless of throttle
        const hasNoPrices = !market.currentPriceUp || !market.currentPriceDown;
        const isStale = !market.lastPriceUpdate || (now - market.lastPriceUpdate >= 500);
        const shouldFetchFromAPI = force || hasNoPrices || isStale;

        if (shouldFetchFromAPI) {
            logger.info(
                `[PRICE-FETCH] ${market.marketKey}: fetchCurrentPrices(force=${force}, hasNoPrices=${hasNoPrices}, isStale=${isStale})`
            );
            await this.fetchCurrentPricesFromAPI(market);
        }

        // Only log prices for CURRENT active markets (not expired ones)
        // This prevents multiple markets from the same category writing different prices
        if (!market.endDate || market.endDate <= now) {
            return; // Skip expired markets
        }

        // Check if this is the current active market for its category
        // For hourly markets like BTC-UpDown-1h-6, extract base category BTC-UpDown-1h
        const marketKey = market.marketKey;
        let baseCategory: string;
        if (marketKey.match(/-\d+$/)) {
            baseCategory = marketKey.split('-').slice(0, 3).join('-'); // "BTC-UpDown-1h"
        } else {
            baseCategory = marketKey; // "BTC-UpDown-15"
        }

        // Find all markets in same category and check if this is the current one
        const sameCategory = Array.from(this.markets.values()).filter(m => {
            const mKey = m.marketKey;
            const mBase = mKey.match(/-\d+$/) ? mKey.split('-').slice(0, 3).join('-') : mKey;
            return mBase === baseCategory && m.endDate && m.endDate > now;
        });

        // Sort by endDate ascending - the one ending soonest is the current active market
        sameCategory.sort((a, b) => (a.endDate || 0) - (b.endDate || 0));

        // Only log if this is the current active market (first in sorted list)
        if (sameCategory.length > 0 && sameCategory[0].marketKey !== marketKey) {
            return; // Not the current active market, skip logging
        }

        // Log prices to CSV for live chart
        const priceUp = market.currentPriceUp ?? 0;
        const priceDown = market.currentPriceDown ?? 0;

        // Only log if we have actual prices (not both zero)
        if (priceUp > 0 || priceDown > 0) {
            const marketSlug = market.marketSlug || market.marketName || market.marketKey || '';
            priceStreamLogger.logPrice(
                marketSlug,
                market.marketName,
                priceUp,
                priceDown
            );
        }
    }

    /**
     * Display market statistics
     */
    async displayStats(): Promise<void> {
        const displayStartTime = Date.now();
        logger.debug(`[MARKET-TRACKER] displayStats() called, isDisplaying=${this.isDisplaying}, displayMode=${this.displayMode}, markets=${this.markets.size}`);
        
        // Prevent concurrent display updates
        if (this.isDisplaying) {
            logger.debug(`[MARKET-TRACKER] displayStats() skipped - already displaying`);
            return;
        }

        // Proactively discover markets if in watch mode (auto-discovers BTC/ETH 15m and 1h markets)
        if (this.displayMode === 'WATCH' || this.displayMode === 'PAPER') {
            logger.debug(`[MARKET-TRACKER] Proactively discovering 15-min markets (mode: ${this.displayMode})`);
            const discoveryStartTime = Date.now();
            await this.proactivelyDiscover15MinMarkets();
            logger.debug(`[MARKET-TRACKER] Proactive discovery completed in ${Date.now() - discoveryStartTime}ms`);
        }

        const now = Date.now();
        const timeSinceLastDisplay = now - this.lastDisplayTime;
        
        // Always update if new market detected, otherwise respect interval
        const hasNewMarket = this.markets.size !== this.lastMarketCount;
        
        // Force update if new market detected, or if enough time has passed
        // Also force update if lastDisplayTime was reset to 0 (forced refresh)
        const shouldUpdate = hasNewMarket || 
                            timeSinceLastDisplay >= this.displayInterval || 
                            this.lastDisplayTime === 0;
        
        logger.debug(`[MARKET-TRACKER] Display update check: hasNewMarket=${hasNewMarket}, timeSinceLastDisplay=${timeSinceLastDisplay}ms, displayInterval=${this.displayInterval}ms, lastDisplayTime=${this.lastDisplayTime}, shouldUpdate=${shouldUpdate}`);
        
        if (!shouldUpdate) {
            logger.debug(`[MARKET-TRACKER] displayStats() skipped - not time to update yet`);
            return;
        }
        
        // Set lock
        this.isDisplaying = true;
        logger.debug(`[MARKET-TRACKER] Display lock acquired, starting update`);
        
        try {
            // Update tracking variables
            const previousMarketCount = this.lastMarketCount;
            this.lastDisplayTime = now;
            this.lastMarketCount = this.markets.size;
            logger.debug(`[MARKET-TRACKER] Market count: previous=${previousMarketCount}, current=${this.markets.size}`);

        if (this.markets.size === 0) {
            // Show empty state if we had markets before but now have none
            if (previousMarketCount > 0) {
                const emptyStateLines = [
                    chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'),
                    chalk.cyan.bold('  📊 MARKET TRACKING SUMMARY'),
                    chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'),
                    '',
                    chalk.gray('  No active markets to display'),
                    ''
                ];
                // Clear screen completely and move cursor to top
                process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
                const paddedEmpty1 = emptyStateLines.map(line => {
                    const visualLength = line.replace(/\x1b\[[0-9;]*m/g, '').length;
                    return line + ' '.repeat(Math.max(0, 82 - visualLength));
                });
                process.stdout.write(paddedEmpty1.join('\n'));
                process.stdout.write('\n\x1b[0J');
            }
            return; // Lock will be released in finally block
        }

        // Get nextMarkets info EARLY to help with filtering
        const nextMarketsFromStreamForFilter = priceStreamLogger.getNextMarkets();
        const nextMarketKeysForFilter = new Set<string>();
        for (const [marketType, info] of nextMarketsFromStreamForFilter.entries()) {
            const is15MinType = marketType.includes('15m');
            const is1HourType = marketType.includes('up-or-down') && !marketType.includes('15m');
            if (!is15MinType && !is1HourType) continue;
            const isBTCType = marketType.includes('btc') || marketType.includes('bitcoin');
            let marketKey: string | null = null;
            if (is15MinType) {
                const slug = (info.slug || '').toLowerCase();
                const tsMatch = slug.match(/updown-15m-(\d+)/);
                const timestamp = tsMatch ? tsMatch[1] : '';
                const baseKey = isBTCType ? 'BTC-UpDown-15' : 'ETH-UpDown-15';
                marketKey = timestamp ? `${baseKey}-${timestamp}` : baseKey;
            } else if (is1HourType) {
                const question = info.question || '';
                const slug = (info.slug || '').toLowerCase();
                let hourNum = '0';
                const questionMatch = question.match(/,\s*(\d{1,2})\s*(AM|PM)\s*ET/i);
                const slugMatch = slug.match(/-(\d{1,2})(am|pm)-et$/i);
                if (questionMatch) {
                    hourNum = questionMatch[1];
                } else if (slugMatch) {
                    hourNum = slugMatch[1];
                }
                marketKey = isBTCType ? `BTC-UpDown-1h-${hourNum}` : `ETH-UpDown-1h-${hourNum}`;
            }
            if (marketKey) nextMarketKeysForFilter.add(marketKey);
        }
        
        // Filter out closed markets (where endDate has passed or time window has passed)
        // Keep markets stable - only remove if they're actually closed
        // Fallback: if market hasn't been updated in 7 days, consider it stale/closed
        const STALE_MARKET_THRESHOLD = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds
        
        // Track markets before filtering to detect changes
        const marketsBeforeFilter = this.markets.size;
        
        const activeMarkets = Array.from(this.markets.values()).filter((m) => {
            // If market has an endDate and it has passed, consider it closed
            if (m.endDate && now > m.endDate) {
                return false; // Market is closed
            }
            // Sanity check: 1-hour markets should never have more than ~65 minutes left
            // EXCEPTION: Allow upcoming markets from nextMarkets (they can have future endDate without being treated as bad)
            if (this.is1HourMarket(m.marketKey, m.marketName) && m.endDate) {
                const timeLeft = m.endDate - now;
                const isUpcomingFromStream = nextMarketKeysForFilter.has(m.marketKey);
                // Only apply the strict sanity check to 1-hour markets that are NOT recognised
                // as upcoming by the price stream. Official upcoming markets from nextMarkets
                // can legitimately have more than 65 minutes until end.
                if (!isUpcomingFromStream && timeLeft > 65 * 60 * 1000) {
                    return false; // Stale 1-hour market with bad endDate
                }
            }
            // Check if time-window market has passed (e.g., "10:30-10:45" where current time > 10:45)
            // Skip this check for 1-hour markets - they use endDate instead
            if (!this.is1HourMarket(m.marketKey, m.marketName) && this.isTimeWindowMarketPassed(m.marketName, m.marketKey)) {
                return false; // Market time window has passed
            }
            // Fallback: if market hasn't been updated in a very long time, consider it stale
            if (now - m.lastUpdate > STALE_MARKET_THRESHOLD) {
                return false; // Market is stale/closed
            }
            // Keep all other markets (stable dashboard)
            return true;
        });

        // IMPORTANT: Allow up to 2 markets per category (current + next) for 8-market display
        // Keep the current market (ending soonest) and next market (ending after that)
        // CRITICAL: Only remove markets that have actually ENDED, not just because there are more than 2
        // This ensures upcoming markets stay stable and don't disappear
        const categories = ['BTC-UpDown-15', 'ETH-UpDown-15', 'BTC-UpDown-1h', 'ETH-UpDown-1h'];
        for (const category of categories) {
            const marketsInCategory = Array.from(this.markets.entries())
                .filter(([key]) => key.startsWith(category))
                .map(([key, market]) => ({ key, market }));

            if (marketsInCategory.length > 2) {
                // Sort by endDate ascending - keep current (ending soonest) and next (ending after that)
                marketsInCategory.sort((a, b) => {
                    const endA = a.market.endDate || Infinity;
                    const endB = b.market.endDate || Infinity;
                    return endA - endB;
                });

                // Only remove markets beyond the next one IF they have actually ENDED
                // Don't remove upcoming markets that haven't started yet
                for (let i = 2; i < marketsInCategory.length; i++) {
                    const marketToRemove = marketsInCategory[i];
                    // CRITICAL: Only remove if market has actually ended (endDate < now)
                    // This prevents removing upcoming markets that are being synced from priceStreamLogger
                    const hasEnded = marketToRemove.market.endDate && marketToRemove.market.endDate <= now;
                    if (!hasEnded) {
                        // Market hasn't ended yet - keep it (it might be a valid upcoming market)
                        continue;
                    }
                    
                    // Log PnL before removing if it has trades
                    if (marketToRemove.market.investedUp > 0 || marketToRemove.market.investedDown > 0) {
                        if (this.onPreCloseCallback && !this.preCloseTriggeredMarkets.has(marketToRemove.key)) {
                            this.preCloseTriggeredMarkets.add(marketToRemove.key);
                            this.onPreCloseCallback(marketToRemove.market).catch(() => {});
                        }
                    }
                    this.markets.delete(marketToRemove.key);
                    logger.debug(`[MARKET-TRACKER] Removed old market beyond next (has ended): ${marketToRemove.key} (keeping current + next only)`);
                }
            }
        }

        // Remove closed/stale markets from tracking and log PnL
        // CRITICAL: Trigger pre-close callback for markets about to be closed BEFORE removing them
        const closedMarkets: MarketStats[] = [];
        for (const [key, value] of this.markets.entries()) {
            const isClosed = value.endDate && now > value.endDate;
            // Skip time-window check for 1-hour markets - they use endDate instead
            const isTimeWindowPassed = !this.is1HourMarket(key, value.marketName) && this.isTimeWindowMarketPassed(value.marketName, key);
            const isStale = now - value.lastUpdate > STALE_MARKET_THRESHOLD;
            // Sanity check: 1-hour markets with >65 minutes left have bad endDate
            const isUpcoming1hFromStream =
                this.is1HourMarket(key, value.marketName) &&
                nextMarketKeysForFilter.has(value.marketKey);
            const is1hWithBadEndDate =
                this.is1HourMarket(key, value.marketName) &&
                value.endDate &&
                !isUpcoming1hFromStream &&
                (value.endDate - now) > 65 * 60 * 1000;
            if (isClosed || isTimeWindowPassed || isStale || is1hWithBadEndDate) {
                // Trigger pre-close callback for markets about to be removed (if not already triggered)
                // This ensures 15-min markets get their PnL logged even if endDate-based trigger missed them
                if (this.onPreCloseCallback && !this.preCloseTriggeredMarkets.has(value.marketKey)) {
                    if (value.investedUp > 0 || value.investedDown > 0) {
                        this.preCloseTriggeredMarkets.add(value.marketKey);
                        try {
                            // Use fire-and-forget to avoid blocking
                            this.onPreCloseCallback(value).catch(err => {
                                console.error(`Error in pre-close callback for closing market ${value.marketKey}:`, err);
                            });
                        } catch (error) {
                            console.error(`Error in pre-close callback for ${value.marketKey}:`, error);
                        }
                    }
                }
                // Only log markets that have actual investment (not just stale with no trades)
                if (value.investedUp > 0 || value.investedDown > 0) {
                    closedMarkets.push(value);
                }
                this.markets.delete(key);
            }
        }

        // Log closed markets and trigger market close callback (for PnL report update)
        if (closedMarkets.length > 0) {
            // Log each closed market and trigger callback
            closedMarkets.forEach(market => {
                this.logClosedMarketPnL(market).catch(err => {
                    console.error(`Failed to log closed market ${market.marketKey}: ${err}`);
                });

                // Trigger market close callback to update PnL report
                if (this.onMarketCloseCallback) {
                    this.onMarketCloseCallback(market).catch(err => {
                        console.error(`Failed to trigger market close callback for ${market.marketKey}: ${err}`);
                    });
                }
            });
        }

        // Update market count after filtering
        this.lastMarketCount = this.markets.size;

        // Always display if we have active markets, even if count didn't change
        // (markets might have been updated with new trades)
        if (activeMarkets.length === 0) {
            // Only show empty state if we had markets before
            if (marketsBeforeFilter > 0) {
                const emptyStateLines = [
                    chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'),
                    chalk.cyan.bold('  📊 MARKET TRACKING SUMMARY'),
                    chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'),
                    '',
                    chalk.gray('  No active markets to display'),
                    ''
                ];
                // Clear screen completely and move cursor to top
                process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
                const paddedEmpty2 = emptyStateLines.map(line => {
                    const visualLength = line.replace(/\x1b\[[0-9;]*m/g, '').length;
                    return line + ' '.repeat(Math.max(0, 82 - visualLength));
                });
                process.stdout.write(paddedEmpty2.join('\n'));
                process.stdout.write('\n\x1b[0J');
            }
            return; // Lock will be released in finally block
        }

        // Fetch current prices for all active markets (in parallel)
        // Force fetch if prices are missing to ensure instant display
        const pricePromises = activeMarkets.map(m => {
            const hasNoPrices = !m.currentPriceUp || !m.currentPriceDown;
            return this.fetchCurrentPrices(m, hasNoPrices); // Force fetch if missing
        });
        await Promise.allSettled(pricePromises);
        
        // CRITICAL: Refresh lastUpdate for all active markets to prevent them from being marked stale
        // This ensures upcoming markets stay on dashboard even if they don't get frequent updates
        const refreshTime = Date.now();
        for (const market of activeMarkets) {
            market.lastUpdate = refreshTime;
        }
        
        // If any markets still don't have prices after first attempt, try once more
        // This ensures prices appear instantly even if first fetch failed
        const marketsNeedingPrices = activeMarkets.filter(m => !m.currentPriceUp || !m.currentPriceDown);
        if (marketsNeedingPrices.length > 0) {
            const retryPromises = marketsNeedingPrices.map(m => this.fetchCurrentPrices(m, true));
            await Promise.allSettled(retryPromises);
        }

        // Capture closing price snapshot around 2 minutes before market switches to next market
        // This ensures PnL is recorded with prices from ~2 minutes before market switch
        const SNAPSHOT_WINDOW_MS = 2 * 60 * 1000; // 2 minutes
        const SNAPSHOT_EARLY_MS = 30 * 1000; // 30 seconds buffer (capture between 2:00-1:30 before end)
        const PRE_CLOSE_SECONDS = 5 * 1000; // 5 seconds before market ends
        for (const m of activeMarkets) {
            if (
                m.endDate &&
                m.closingPriceUp === undefined &&
                m.closingPriceDown === undefined &&
                m.currentPriceUp !== undefined &&
                m.currentPriceDown !== undefined
            ) {
                const timeUntilEnd = m.endDate - now;
                // Capture when we're between 2 minutes and 1.5 minutes before market end
                // This gives us a ~30 second window to capture the snapshot
                if (
                    timeUntilEnd <= SNAPSHOT_WINDOW_MS &&
                    timeUntilEnd >= (SNAPSHOT_WINDOW_MS - SNAPSHOT_EARLY_MS)
                ) {
                    m.closingPriceUp = m.currentPriceUp;
                    m.closingPriceDown = m.currentPriceDown;
                }
            }

            // Trigger pre-close callback 5 seconds before market ends
            if (
                m.endDate &&
                this.onPreCloseCallback &&
                !this.preCloseTriggeredMarkets.has(m.marketKey)
            ) {
                const timeUntilEnd = m.endDate - now;
                
                // CRITICAL: Validate endDate is reasonable before triggering callback
                // For 15-min markets: endDate should be within 0-16 minutes from now
                // For 1-hour markets: endDate should be within 0-65 minutes from now
                const is15Min = m.marketKey.includes('-15');
                const maxTimeUntilEnd = is15Min ? 16 * 60 * 1000 : 65 * 60 * 1000;
                const isEndDateReasonable = timeUntilEnd >= 0 && timeUntilEnd <= maxTimeUntilEnd;
                
                // Only trigger if:
                // 1. We're within 5 seconds of end (timeUntilEnd <= 5s and > 0)
                // 2. endDate is reasonable (not in distant future)
                if (timeUntilEnd <= PRE_CLOSE_SECONDS && timeUntilEnd > 0 && isEndDateReasonable) {
                    // CRITICAL: Force fetch prices BEFORE triggering pre-close callback
                    // This ensures prices are available even if WebSocket switched early
                    if (!m.currentPriceUp || !m.currentPriceDown) {
                        await this.fetchCurrentPrices(m, true); // Force fetch
                    }
                    
                    // Log timing info for debugging
                    const endDateStr = new Date(m.endDate).toLocaleString('en-US', { timeZone: 'America/New_York' });
                    const nowStr = new Date(now).toLocaleString('en-US', { timeZone: 'America/New_York' });
                    logger.info(`⏰ Pre-close callback triggered for ${m.marketName}: endDate=${endDateStr}, now=${nowStr}, timeUntilEnd=${(timeUntilEnd/1000).toFixed(1)}s`);
                    
                    this.preCloseTriggeredMarkets.add(m.marketKey);
                    try {
                        await this.onPreCloseCallback(m);
                    } catch (error) {
                        console.error(`Error in pre-close callback for ${m.marketKey}:`, error);
                    }
                } else if (timeUntilEnd <= PRE_CLOSE_SECONDS && timeUntilEnd > 0 && !isEndDateReasonable) {
                    // Log warning if endDate seems wrong
                    logger.warn(`⚠️ Skipping pre-close callback for ${m.marketName}: endDate seems incorrect (timeUntilEnd=${(timeUntilEnd/1000).toFixed(1)}s, max expected=${(maxTimeUntilEnd/1000/60).toFixed(1)}min)`);
                }
            }
        }

        // Separate markets into "current" and "upcoming" based on priceStreamLogger
        // Markets in nextMarkets are "upcoming", all others are "current"
        const currentMarketsFromStream = priceStreamLogger.getCurrentMarkets();
        const nextMarketsFromStream = priceStreamLogger.getNextMarkets();

        // Log stream status for debugging intermittent issues
        if (currentMarketsFromStream.size < 4 || nextMarketsFromStream.size < 4) {
            const currentTypes = Array.from(currentMarketsFromStream.keys()).join(', ');
            const nextTypes = Array.from(nextMarketsFromStream.keys()).join(', ');
            logger.warn(`[MARKET-TRACKER] WebSocket stream incomplete: currentMarkets=${currentMarketsFromStream.size}/4 [${currentTypes}], nextMarkets=${nextMarketsFromStream.size}/4 [${nextTypes}]`);
        }

        // Build a set of marketKeys that correspond to nextMarkets for direct matching,
        // and ensure corresponding dashboard markets exist as soon as the price stream
        // discovers them (so upcoming 1-hour markets appear without delay).
        const nextMarketKeys = new Set<string>();
        for (const [marketType, info] of nextMarketsFromStream.entries()) {
            const is15MinType = marketType.includes('15m');
            const is1HourType = marketType.includes('up-or-down') && !marketType.includes('15m');
            if (!is15MinType && !is1HourType) continue;
            
            const isBTCType = marketType.includes('btc') || marketType.includes('bitcoin');
            
            let marketKey: string | null = null;
            if (is15MinType) {
                const slug = (info.slug || '').toLowerCase();
                const tsMatch = slug.match(/updown-15m-(\d+)/);
                const timestamp = tsMatch ? tsMatch[1] : '';
                const baseKey = isBTCType ? 'BTC-UpDown-15' : 'ETH-UpDown-15';
                marketKey = timestamp ? `${baseKey}-${timestamp}` : baseKey;
            } else if (is1HourType) {
                const question = info.question || '';
                const slug = (info.slug || '').toLowerCase();
                let hourNum = '0';
                const questionMatch = question.match(/,\s*(\d{1,2})\s*(AM|PM)\s*ET/i);
                const slugMatch = slug.match(/-(\d{1,2})(am|pm)-et$/i);
                if (questionMatch) {
                    hourNum = questionMatch[1];
                } else if (slugMatch) {
                    hourNum = slugMatch[1];
                }
                marketKey = isBTCType ? `BTC-UpDown-1h-${hourNum}` : `ETH-UpDown-1h-${hourNum}`;
            }
            
            if (marketKey) {
                nextMarketKeys.add(marketKey);
                logger.debug(`[MARKET-TRACKER] Built nextMarketKey: ${marketKey} from marketType=${marketType}, slug=${info.slug || 'N/A'}`);

                // Always sync upcoming market data to ensure correct name/slug/endDate
                // This is critical because upcoming markets need to display their FUTURE
                // market name, not the current market name
                let assetUp = '';
                let assetDown = '';
                if (info.tokens && info.tokens.length >= 2) {
                    const upToken =
                        info.tokens.find((t: any) => t.outcome && t.outcome.toUpperCase().includes('UP')) ||
                        info.tokens[0];
                    const downToken =
                        info.tokens.find((t: any) => t.outcome && t.outcome.toUpperCase().includes('DOWN')) ||
                        info.tokens[1];
                    assetUp = upToken.token_id;
                    assetDown = downToken.token_id;
                }
                const endDateMs = info.end_date_iso ? new Date(info.end_date_iso).getTime() : undefined;
                const isNewMarket = !this.markets.has(marketKey);

                this.ensureMarketWithAssets(
                    marketKey,
                    info.question || info.slug || marketKey,
                    info.slug || '',
                    info.condition_id,
                    assetUp,
                    assetDown,
                    endDateMs
                );

                if (isNewMarket) {
                    logger.info(`[MARKET-TRACKER] Created dashboard market ${marketKey} from nextMarkets (displayStats sync)`);
                }
            }
        }
        
        // Helper to check if a market is in currentMarkets (to exclude from upcoming)
        const isMarketCurrent = (market: MarketStats): boolean => {
            // FALLBACK: If market has endDate and it's within the current window, consider it current
            // This prevents markets from disappearing when WebSocket data is incomplete
            if (market.endDate && market.endDate > now) {
                const timeLeft = market.endDate - now;
                const is15Min = market.marketKey.includes('-15');
                const is1Hour = market.marketKey.includes('-1h-');

                // For 15-min markets: current if <= 15 minutes left
                if (is15Min && timeLeft <= 15 * 60 * 1000) {
                    return true;
                }
                // For 1-hour markets: current if <= 60 minutes left
                if (is1Hour && timeLeft <= 60 * 60 * 1000) {
                    return true;
                }
            }

            // Check if market matches any currentMarket by conditionId, assetUp/assetDown, or slug pattern
            for (const currentMarket of currentMarketsFromStream.values()) {
                // Match by conditionId (most reliable)
                if (market.conditionId && market.conditionId === currentMarket.condition_id) {
                    return true;
                }
                // Match by asset IDs
                if (market.assetUp && currentMarket.tokens.some((t: any) => t.token_id === market.assetUp)) {
                    return true;
                }
                if (market.assetDown && currentMarket.tokens.some((t: any) => t.token_id === market.assetDown)) {
                    return true;
                }
                
                const is15MinMarket = market.marketKey.includes('-15');
                const is1HourMarket = market.marketKey.includes('-1h-');
                
                // For 15-minute markets: match by timestamp in slug
                if (is15MinMarket && market.marketSlug && currentMarket.slug) {
                    const marketSlugLower = market.marketSlug.toLowerCase();
                    const currentSlugLower = currentMarket.slug.toLowerCase();
                    const marketTsMatch = marketSlugLower.match(/updown-15m-(\d+)/);
                    const currentTsMatch = currentSlugLower.match(/updown-15m-(\d+)/);
                    if (marketTsMatch && currentTsMatch) {
                        const marketTimestamp = marketTsMatch[1];
                        const currentTimestamp = currentTsMatch[1];
                        const marketIsBTC = market.marketKey.includes('BTC');
                        const currentIsBTC = currentSlugLower.includes('btc');
                        if (marketTimestamp === currentTimestamp && marketIsBTC === currentIsBTC) {
                            return true;
                        }
                    }
                }
                
                // For 1-hour markets: match by hour pattern from slug or question (same logic as marketKey extraction)
                if (is1HourMarket) {
                    const marketSlugLower = (market.marketSlug || '').toLowerCase();
                    const currentSlugLower = (currentMarket.slug || '').toLowerCase();
                    const marketQuestion = (market.marketName || '').toLowerCase();
                    const currentQuestion = (currentMarket.question || '').toLowerCase();
                    
                    // Extract hour from market (same pattern as marketKey extraction)
                    let marketHourStr = '';
                    const marketQuestionMatch = marketQuestion.match(/,\s*(\d{1,2})\s*(am|pm)\s*et/i);
                    const marketSlugMatch = marketSlugLower.match(/-(\d{1,2})(am|pm)-et$/i);
                    if (marketQuestionMatch) {
                        marketHourStr = marketQuestionMatch[1] + marketQuestionMatch[2].toLowerCase();
                    } else if (marketSlugMatch) {
                        marketHourStr = marketSlugMatch[1] + marketSlugMatch[2].toLowerCase();
                    }
                    
                    // Extract hour from currentMarket (same pattern as marketKey extraction)
                    let currentHourStr = '';
                    const currentQuestionMatch = currentQuestion.match(/,\s*(\d{1,2})\s*(am|pm)\s*et/i);
                    const currentSlugMatch = currentSlugLower.match(/-(\d{1,2})(am|pm)-et$/i);
                    if (currentQuestionMatch) {
                        currentHourStr = currentQuestionMatch[1] + currentQuestionMatch[2].toLowerCase();
                    } else if (currentSlugMatch) {
                        currentHourStr = currentSlugMatch[1] + currentSlugMatch[2].toLowerCase();
                    }
                    
                    if (marketHourStr && currentHourStr) {
                        const marketIsBTC = market.marketKey.includes('BTC');
                        const currentIsBTC = currentSlugLower.includes('bitcoin') || currentSlugLower.includes('btc') || currentQuestion.includes('bitcoin');
                        if (marketHourStr === currentHourStr && marketIsBTC === currentIsBTC) {
                            return true;
                        }
                    }
                }
            }
            return false;
        };
        
        // Helper to check if a market is in nextMarkets (upcoming)
        const isMarketUpcoming = (market: MarketStats): boolean => {
            // First, exclude if it's a current market
            if (isMarketCurrent(market)) {
                logger.debug(`[MARKET-TRACKER] Market ${market.marketKey} is CURRENT, not upcoming`);
                return false;
            }
            
            // FIRST: Check if marketKey directly matches a nextMarketKey (most reliable)
            if (nextMarketKeys.has(market.marketKey)) {
                logger.info(`[MARKET-TRACKER] Market ${market.marketKey} MATCHED as upcoming by direct marketKey match`);
                return true;
            }
            
            // ALWAYS match if marketKey ends with -1h- and we have nextMarkets (for 1-hour markets)
            // This ensures 1-hour upcoming markets always show
            if (market.marketKey.includes('-1h-') && nextMarketsFromStream.size > 0) {
                // Check if this marketKey pattern matches any nextMarket (by extracting hour)
                const marketKeyHourMatch = market.marketKey.match(/-1h-(\d+)$/);
                if (marketKeyHourMatch) {
                    const marketHour = marketKeyHourMatch[1];
                    const marketIsBTC = market.marketKey.includes('BTC');
                    
                    // Check if any nextMarket has this hour
                    for (const [marketType, nextMarket] of nextMarketsFromStream.entries()) {
                        if (marketType.includes('up-or-down') && !marketType.includes('15m')) {
                            const nextIsBTC = marketType.includes('btc') || marketType.includes('bitcoin');
                            if (marketIsBTC === nextIsBTC) {
                                const nextSlug = (nextMarket.slug || '').toLowerCase();
                                const nextQuestion = (nextMarket.question || '').toLowerCase();
                                const nextSlugMatch = nextSlug.match(/-(\d{1,2})(am|pm)-et$/i);
                                const nextQuestionMatch = nextQuestion.match(/,\s*(\d{1,2})\s*(am|pm)\s*et/i);
                                
                                let nextHour = '0';
                                if (nextQuestionMatch) {
                                    nextHour = nextQuestionMatch[1];
                                } else if (nextSlugMatch) {
                                    nextHour = nextSlugMatch[1];
                                }
                                
                                if (marketHour === nextHour) {
                                    logger.info(`[MARKET-TRACKER] Market ${market.marketKey} MATCHED as upcoming by hour match (hour=${marketHour})`);
                                    return true;
                                }
                            }
                        }
                    }
                }
            }
            
            // SECOND: Check if market matches any nextMarket by conditionId, assetUp/assetDown, or slug pattern
            for (const nextMarket of nextMarketsFromStream.values()) {
                // Match by conditionId (most reliable)
                if (market.conditionId && market.conditionId === nextMarket.condition_id) {
                    logger.debug(`[MARKET-TRACKER] Market ${market.marketKey} MATCHED as upcoming by conditionId: ${market.conditionId}`);
                    return true;
                }
                // Match by asset IDs
                if (market.assetUp && nextMarket.tokens.some((t: any) => t.token_id === market.assetUp)) {
                    logger.debug(`[MARKET-TRACKER] Market ${market.marketKey} MATCHED as upcoming by assetUp: ${market.assetUp}`);
                    return true;
                }
                if (market.assetDown && nextMarket.tokens.some((t: any) => t.token_id === market.assetDown)) {
                    logger.debug(`[MARKET-TRACKER] Market ${market.marketKey} MATCHED as upcoming by assetDown: ${market.assetDown}`);
                    return true;
                }
                
                const is15MinMarket = market.marketKey.includes('-15');
                const is1HourMarket = market.marketKey.includes('-1h-');
                
                // For 15-minute markets: match by timestamp in slug
                if (is15MinMarket && market.marketSlug && nextMarket.slug) {
                    const marketSlugLower = market.marketSlug.toLowerCase();
                    const nextSlugLower = nextMarket.slug.toLowerCase();
                    const marketTsMatch = marketSlugLower.match(/updown-15m-(\d+)/);
                    const nextTsMatch = nextSlugLower.match(/updown-15m-(\d+)/);
                    if (marketTsMatch && nextTsMatch) {
                        const marketTimestamp = marketTsMatch[1];
                        const nextTimestamp = nextTsMatch[1];
                        const marketIsBTC = market.marketKey.includes('BTC');
                        const nextIsBTC = nextSlugLower.includes('btc');
                        if (marketTimestamp === nextTimestamp && marketIsBTC === nextIsBTC) {
                            return true;
                        }
                    }
                }
                
                // For 1-hour markets: match by hour pattern from slug or question (same logic as marketKey extraction)
                if (is1HourMarket) {
                    const marketSlugLower = (market.marketSlug || '').toLowerCase();
                    const nextSlugLower = (nextMarket.slug || '').toLowerCase();
                    const marketQuestion = (market.marketName || '').toLowerCase();
                    const nextQuestion = (nextMarket.question || '').toLowerCase();
                    
                    // Extract hour from market (same pattern as marketKey extraction)
                    let marketHourStr = '';
                    const marketQuestionMatch = marketQuestion.match(/,\s*(\d{1,2})\s*(am|pm)\s*et/i);
                    const marketSlugMatch = marketSlugLower.match(/-(\d{1,2})(am|pm)-et$/i);
                    if (marketQuestionMatch) {
                        marketHourStr = marketQuestionMatch[1] + marketQuestionMatch[2].toLowerCase();
                    } else if (marketSlugMatch) {
                        marketHourStr = marketSlugMatch[1] + marketSlugMatch[2].toLowerCase();
                    }
                    
                    // Extract hour from nextMarket (same pattern as marketKey extraction)
                    let nextHourStr = '';
                    const nextQuestionMatch = nextQuestion.match(/,\s*(\d{1,2})\s*(am|pm)\s*et/i);
                    const nextSlugMatch = nextSlugLower.match(/-(\d{1,2})(am|pm)-et$/i);
                    if (nextQuestionMatch) {
                        nextHourStr = nextQuestionMatch[1] + nextQuestionMatch[2].toLowerCase();
                    } else if (nextSlugMatch) {
                        nextHourStr = nextSlugMatch[1] + nextSlugMatch[2].toLowerCase();
                    }
                    
                    if (marketHourStr && nextHourStr) {
                        const marketIsBTC = market.marketKey.includes('BTC');
                        const nextIsBTC = nextSlugLower.includes('bitcoin') || nextSlugLower.includes('btc') || nextQuestion.includes('bitcoin');
                        
                        if (marketHourStr === nextHourStr && marketIsBTC === nextIsBTC) {
                            logger.debug(`[MARKET-TRACKER] 1-hour market MATCHED as upcoming: marketKey=${market.marketKey}, marketHour=${marketHourStr}, nextHour=${nextHourStr}, marketIsBTC=${marketIsBTC}, nextIsBTC=${nextIsBTC}`);
                            return true;
                        }
                    }
                }
            }
            
            // If no match found, log for debugging (but only log once per market to avoid spam)
            return false;
        };
        
        // Separate markets into current and upcoming
        const currentMarkets: MarketStats[] = [];
        const upcomingMarkets: MarketStats[] = [];
        
        // Log all active markets and nextMarkets for debugging
        if (nextMarketsFromStream.size > 0 && activeMarkets.length > 0) {
            logger.info(`[MARKET-TRACKER] DEBUG: Checking ${activeMarkets.length} active markets against ${nextMarketsFromStream.size} nextMarkets`);
            for (const market of activeMarkets) {
                logger.info(`[MARKET-TRACKER] DEBUG ActiveMarket: key=${market.marketKey}, conditionId=${market.conditionId || 'N/A'}, assetUp=${market.assetUp?.substring(0, 20) || 'N/A'}..., assetDown=${market.assetDown?.substring(0, 20) || 'N/A'}..., slug=${market.marketSlug || 'N/A'}`);
            }
            for (const [marketType, nextMarket] of nextMarketsFromStream.entries()) {
                const nextAssetUp = nextMarket.tokens?.find((t: any) => t.outcome?.toUpperCase().includes('UP'))?.token_id?.substring(0, 20) || 'N/A';
                const nextAssetDown = nextMarket.tokens?.find((t: any) => t.outcome?.toUpperCase().includes('DOWN'))?.token_id?.substring(0, 20) || 'N/A';
                logger.info(`[MARKET-TRACKER] DEBUG NextMarket [${marketType}]: conditionId=${nextMarket.condition_id || 'N/A'}, assetUp=${nextAssetUp}..., assetDown=${nextAssetDown}..., slug=${nextMarket.slug || 'N/A'}`);
            }
        }
        
        for (const market of activeMarkets) {
            if (isMarketUpcoming(market)) {
                upcomingMarkets.push(market);
                logger.info(`[MARKET-TRACKER] Market ${market.marketKey} identified as UPCOMING (slug: ${market.marketSlug || 'N/A'}, conditionId: ${market.conditionId || 'N/A'}, assetUp: ${market.assetUp || 'N/A'}, assetDown: ${market.assetDown || 'N/A'})`);
            } else {
                currentMarkets.push(market);
            }
        }

        // STABILITY FIX: Ensure we always have one current market per category (BTC-15m, ETH-15m, BTC-1h, ETH-1h)
        // This prevents markets from disappearing when WebSocket data is temporarily unavailable
        const currentCategories = ['BTC-UpDown-15', 'ETH-UpDown-15', 'BTC-UpDown-1h', 'ETH-UpDown-1h'];
        for (const category of currentCategories) {
            const hasCurrent = currentMarkets.some(m => m.marketKey.startsWith(category));
            if (!hasCurrent) {
                // Find a market in this category that should be current (endDate in future and soonest)
                const categoryMarkets = activeMarkets
                    .filter(m => m.marketKey.startsWith(category) && m.endDate && m.endDate > now)
                    .sort((a, b) => (a.endDate || Infinity) - (b.endDate || Infinity));

                if (categoryMarkets.length > 0) {
                    const soonestMarket = categoryMarkets[0];
                    // Move from upcoming to current if it's there
                    const upcomingIdx = upcomingMarkets.findIndex(m => m.marketKey === soonestMarket.marketKey);
                    if (upcomingIdx !== -1) {
                        upcomingMarkets.splice(upcomingIdx, 1);
                    }
                    currentMarkets.push(soonestMarket);
                    logger.info(`[MARKET-TRACKER] STABILITY FIX: Added ${soonestMarket.marketKey} to current (category ${category} had no current market)`);
                }
            }
        }

        // CRITICAL: Ensure ALL markets from nextMarketKeys are in upcomingMarkets
        // This ensures upcoming markets ALWAYS show 24/7
        // Check all markets in activeMarkets that match nextMarketKeys
        for (const market of activeMarkets) {
            if (nextMarketKeys.has(market.marketKey)) {
                const alreadyUpcoming = upcomingMarkets.some(m => m.marketKey === market.marketKey);
                if (!alreadyUpcoming && !isMarketCurrent(market)) {
                    upcomingMarkets.push(market);
                    logger.info(`[MARKET-TRACKER] Added market ${market.marketKey} to upcoming (from nextMarketKeys, direct match)`);
                }
            }
        }
        
        // EXTRA SAFETY: Also check this.markets directly for any markets matching nextMarketKeys
        // This catches markets that might not be in activeMarkets yet
        for (const marketKey of nextMarketKeys) {
            const alreadyUpcoming = upcomingMarkets.some(m => m.marketKey === marketKey);
            if (!alreadyUpcoming) {
                const market = this.markets.get(marketKey);
                if (market && (!market.endDate || market.endDate > now)) {
                    const inCurrent = currentMarkets.some(m => m.marketKey === marketKey);
                    if (!inCurrent && !isMarketCurrent(market)) {
                        upcomingMarkets.push(market);
                        logger.info(`[MARKET-TRACKER] Added market ${marketKey} to upcoming (from this.markets, nextMarketKey match)`);
                    }
                }
            }
        }

        // FALLBACK: Guarantee per-category upcoming markets based purely on endDate ordering.
        // If matching against nextMarketsFromStream fails, this still keeps a stable
        // "current + next" pair per category so the UPCOMING section never disappears.
        const categoryKeys = ['BTC-UpDown-15', 'ETH-UpDown-15', 'BTC-UpDown-1h', 'ETH-UpDown-1h'];
        for (const category of categoryKeys) {
            const categoryMarkets = activeMarkets.filter(m => {
                if (m.marketKey.startsWith(category)) return true;
                if (m.category && m.category === category) return true;
                return false;
            });
            if (categoryMarkets.length <= 1) continue;

            const sortedByEnd = [...categoryMarkets].sort((a, b) => {
                const endA = a.endDate || Infinity;
                const endB = b.endDate || Infinity;
                return endA - endB;
            });

            const fallbackUpcoming = sortedByEnd[1];
            if (!fallbackUpcoming || (fallbackUpcoming.endDate && fallbackUpcoming.endDate <= now)) {
                continue;
            }

            const alreadyUpcoming = upcomingMarkets.some(m => m.marketKey === fallbackUpcoming.marketKey);
            if (!alreadyUpcoming) {
                const idxCurrent = currentMarkets.findIndex(m => m.marketKey === fallbackUpcoming.marketKey);
                if (idxCurrent !== -1) {
                    currentMarkets.splice(idxCurrent, 1);
                }
                upcomingMarkets.push(fallbackUpcoming);
                logger.info(`[MARKET-TRACKER] Fallback upcoming assignment for category ${category}: ${fallbackUpcoming.marketKey}`);
            }
        }
        
        logger.info(`[MARKET-TRACKER] Market separation: ${currentMarkets.length} current, ${upcomingMarkets.length} upcoming. ActiveMarkets: ${activeMarkets.length}, NextMarketsFromStream size: ${nextMarketsFromStream.size}, NextMarketKeys: ${Array.from(nextMarketKeys).join(', ')}`);
        if (nextMarketsFromStream.size > 0) {
            const nextMarketTypes = Array.from(nextMarketsFromStream.keys()).join(', ');
            logger.debug(`[MARKET-TRACKER] NextMarketsFromStream types: ${nextMarketTypes}`);
            for (const [marketType, nextMarket] of nextMarketsFromStream.entries()) {
                logger.debug(`[MARKET-TRACKER] NextMarket [${marketType}]: conditionId=${nextMarket.condition_id}, slug=${nextMarket.slug}, question=${nextMarket.question?.substring(0, 50) || 'N/A'}`);
            }
        }
        
        // Sort current markets by total invested (descending)
        currentMarkets.sort((a, b) => {
            const totalA = a.investedUp + a.investedDown;
            const totalB = b.investedUp + b.investedDown;
            return totalB - totalA;
        });

        // Sort upcoming markets by endDate (soonest first) to show the NEXT market for each type
        // This ensures 8AM markets show before 9AM markets, etc.
        upcomingMarkets.sort((a, b) => {
            const endA = a.endDate || Infinity;
            const endB = b.endDate || Infinity;
            return endA - endB;
        });

        // For upcoming markets, select one of each category (BTC-15m, ETH-15m, BTC-1h, ETH-1h)
        // This ensures all 4 market types are represented in upcoming
        const upcomingByCategory = new Map<string, MarketStats>();
        for (const market of upcomingMarkets) {
            let category = '';
            if (market.marketKey.includes('BTC') && market.marketKey.includes('-15')) {
                category = 'BTC-15m';
            } else if (market.marketKey.includes('ETH') && market.marketKey.includes('-15')) {
                category = 'ETH-15m';
            } else if (market.marketKey.includes('BTC') && market.marketKey.includes('-1h')) {
                category = 'BTC-1h';
            } else if (market.marketKey.includes('ETH') && market.marketKey.includes('-1h')) {
                category = 'ETH-1h';
            }
            // Only take the first (soonest) market for each category
            if (category && !upcomingByCategory.has(category)) {
                upcomingByCategory.set(category, market);
            }
        }

        // Limit to 4 markets each (current and upcoming)
        const sortedCurrentMarkets = currentMarkets.slice(0, 4);
        const sortedUpcomingMarkets = Array.from(upcomingByCategory.values()).slice(0, 4);

        // Build entire output as string first to prevent partial prints
        const outputLines: string[] = [];

        // Show mode header based on display mode or ENV setting
        const isWatchMode = ENV.TRACK_ONLY_MODE;
        let modeHeader: string;
        if (this.displayMode === 'PAPER') {
            modeHeader = '📊 PAPER MODE';
        } else if (this.displayMode === 'WATCH' || isWatchMode) {
            modeHeader = '👀 WATCH MODE';
        } else {
            modeHeader = '📊 TRADING MODE';
        }
        
        // Combine current and upcoming markets for header calculations
        const allMarketsForHeader = [...sortedCurrentMarkets, ...sortedUpcomingMarkets];
        
        // Calculate overall PnL for header display (before building rest of output)
        let headerTotalCostBasis = 0;
        let headerTotalValue = 0;
        for (const market of allMarketsForHeader) {
            const marketCostBasis = market.totalCostUp + market.totalCostDown;
            headerTotalCostBasis += marketCostBasis;
            // Calculate current value
            let marketValue = 0;
            if (market.currentPriceUp && market.sharesUp > 0) {
                marketValue += market.sharesUp * market.currentPriceUp;
            }
            if (market.currentPriceDown && market.sharesDown > 0) {
                marketValue += market.sharesDown * market.currentPriceDown;
            }
            headerTotalValue += marketValue;
        }
        const headerTotalPnl = headerTotalValue - headerTotalCostBasis;
        const headerPnlPercent = headerTotalCostBasis > 0 ? ((headerTotalPnl / headerTotalCostBasis) * 100).toFixed(1) : '0.0';
        const headerPnlSign = headerTotalPnl >= 0 ? '+' : '';
        const headerPnlColor = headerTotalPnl >= 0 ? chalk.green : chalk.red;
        
        outputLines.push(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
        // Build header with PnL - ensure proper formatting
        if (headerTotalCostBasis > 0) {
            const pnlValue = `${headerPnlSign}$${headerTotalPnl.toFixed(2)}`;
            const pnlPercent = `(${headerPnlSign}${headerPnlPercent}%)`;
            const headerPnlStr = ` PnL: ` + headerPnlColor(pnlValue + ' ' + pnlPercent);
            outputLines.push(chalk.cyan.bold(`  ${modeHeader} - TRADER MARKET TRACKING`) + headerPnlStr);
        } else {
            outputLines.push(chalk.cyan.bold(`  ${modeHeader} - TRADER MARKET TRACKING`));
        }
        
        if (this.displayMode === 'PAPER') {
            // Paper mode header - show paper trading info
            // Calculate paper mode capital from tracked markets
            const paperStartingCapital = parseFloat(process.env.PAPER_STARTING_CAPITAL || '10000');
            // Calculate current capital and portfolio value from market positions
            let paperCurrentCapital = paperStartingCapital;
            let paperPortfolioValue = 0;
            for (const market of allMarketsForHeader) {
                const marketInvested = market.investedUp + market.investedDown;
                paperCurrentCapital -= marketInvested; // Deduct invested amount
                // Add current value to portfolio
                if (market.currentPriceUp && market.sharesUp > 0) {
                    paperPortfolioValue += market.sharesUp * market.currentPriceUp;
                }
                if (market.currentPriceDown && market.sharesDown > 0) {
                    paperPortfolioValue += market.sharesDown * market.currentPriceDown;
                }
            }
            paperCurrentCapital = Math.max(0, paperCurrentCapital); // Don't go negative
            outputLines.push(chalk.gray(`  Strategy: Dual-side accumulation (independent trader)`));
            outputLines.push(chalk.gray(`  Starting Capital: $${paperStartingCapital.toFixed(2)} | Available: $${paperCurrentCapital.toFixed(2)} | Portfolio: $${paperPortfolioValue.toFixed(2)}`));
            outputLines.push(chalk.gray(`  Active Markets: ${allMarketsForHeader.length}/${this.maxMarkets} | Trading on same markets as watcher mode`));
        } else if (ENV.USER_ADDRESSES.length > 0) {
            if (ENV.USER_ADDRESSES.length === 1) {
                const addr = ENV.USER_ADDRESSES[0];
                outputLines.push(chalk.gray(`  Watching: ${chalk.white(addr)}`));
                outputLines.push(chalk.gray(`  Active Markets: ${allMarketsForHeader.length}/${this.maxMarkets} | All trades verified from target wallet`));
            } else {
                outputLines.push(chalk.gray(`  Watching: ${ENV.USER_ADDRESSES.length} traders`));
                ENV.USER_ADDRESSES.forEach((addr, idx) => {
                    outputLines.push(chalk.gray(`    ${idx + 1}. ${addr}`));
                });
                outputLines.push(chalk.gray(`  Active Markets: ${allMarketsForHeader.length}/${this.maxMarkets}`));
            }
        }
        outputLines.push(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
        outputLines.push(''); // Empty line

        // Render CURRENT MARKETS section
        if (sortedCurrentMarkets.length > 0) {
            outputLines.push(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
            outputLines.push(chalk.cyan.bold('  📊 CURRENT MARKETS'));
            outputLines.push(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
            outputLines.push(''); // Empty line
        }

        // Calculate totals across all markets (both current and upcoming)
        let totalInvestedAll = 0;
        let totalCostBasisAll = 0;
        let totalValueAll = 0;
        let totalPnlAll = 0;
        let totalTradesAll = 0;
        let totalInvested15m = 0;
        let totalCostBasis15m = 0;
        let totalValue15m = 0;
        let totalPnl15m = 0;
        let totalTrades15m = 0;
        let totalInvested1h = 0;
        let totalCostBasis1h = 0;
        let totalValue1h = 0;
        let totalPnl1h = 0;
        let totalTrades1h = 0;

        // Helper function to render a market and accumulate totals
        const renderMarket = (market: MarketStats, totals: {
            totalInvestedAll: number;
            totalCostBasisAll: number;
            totalValueAll: number;
            totalPnlAll: number;
            totalTradesAll: number;
            totalInvested15m: number;
            totalCostBasis15m: number;
            totalValue15m: number;
            totalPnl15m: number;
            totalTrades15m: number;
            totalInvested1h: number;
            totalCostBasis1h: number;
            totalValue1h: number;
            totalPnl1h: number;
            totalTrades1h: number;
        }) => {
            const totalInvested = market.investedUp + market.investedDown;
            const totalCostBasis = market.totalCostUp + market.totalCostDown;
            const upPercent = totalInvested > 0 ? (market.investedUp / totalInvested) * 100 : 0;
            const downPercent = totalInvested > 0 ? (market.investedDown / totalInvested) * 100 : 0;

            // Calculate average prices
            const avgPriceUp = market.sharesUp > 0 ? market.totalCostUp / market.sharesUp : 0;
            const avgPriceDown = market.sharesDown > 0 ? market.totalCostDown / market.sharesDown : 0;
            
            // Calculate unrealized PnL
            // Cost basis excludes fees (matches Polymarket API)
            // Only calculate if we have valid prices (> 0) and shares
            let currentValueUp = 0;
            let currentValueDown = 0;
            let pnlUp = 0;
            let pnlDown = 0;
            let totalPnl = 0;

            const hasValidPriceUp = market.currentPriceUp !== undefined && 
                                   market.currentPriceUp > 0 && 
                                   market.currentPriceUp <= 1;
            const hasValidPriceDown = market.currentPriceDown !== undefined && 
                                     market.currentPriceDown > 0 && 
                                     market.currentPriceDown <= 1;

            if (hasValidPriceUp && market.sharesUp > 0 && market.currentPriceUp !== undefined) {
                currentValueUp = market.sharesUp * market.currentPriceUp;
                // Cost basis excludes fees (matches Polymarket API)
                pnlUp = currentValueUp - market.totalCostUp;
            }

            if (hasValidPriceDown && market.sharesDown > 0 && market.currentPriceDown !== undefined) {
                currentValueDown = market.sharesDown * market.currentPriceDown;
                // Cost basis excludes fees (matches Polymarket API)
                pnlDown = currentValueDown - market.totalCostDown;
            }

            totalPnl = pnlUp + pnlDown;
            
            // Determine market type (15m or 1h)
            const is15m = market.marketKey.includes('-15');
            const is1h = market.marketKey.includes('-1h');
            
            // Accumulate totals (using the totals object passed in)
            totals.totalInvestedAll += totalInvested;
            totals.totalCostBasisAll += totalCostBasis;
            totals.totalValueAll += (currentValueUp + currentValueDown);
            totals.totalPnlAll += totalPnl;
            totals.totalTradesAll += (market.tradesUp + market.tradesDown);
            
            // Accumulate by market type
            if (is15m) {
                totals.totalInvested15m += totalInvested;
                totals.totalCostBasis15m += totalCostBasis;
                totals.totalValue15m += (currentValueUp + currentValueDown);
                totals.totalPnl15m += totalPnl;
                totals.totalTrades15m += (market.tradesUp + market.tradesDown);
            } else if (is1h) {
                totals.totalInvested1h += totalInvested;
                totals.totalCostBasis1h += totalCostBasis;
                totals.totalValue1h += (currentValueUp + currentValueDown);
                totals.totalPnl1h += totalPnl;
                totals.totalTrades1h += (market.tradesUp + market.tradesDown);
            }
            
            // Calculate time left - ALWAYS recalculate for 15-min markets from slug
            let timeLeftStr = '';
            const is15Min = market.marketKey.includes('-15');

            if (is15Min) {
                // For 15-min markets: Calculate endDate from marketKey timestamp (most reliable)
                // marketKey format: BTC-UpDown-15-1768221900 where 1768221900 is the START time in seconds
                let calculatedEndDate: number | null = null;

                try {
                    // First try extracting timestamp from marketKey (most reliable for upcoming markets)
                    const marketKeyTsMatch = market.marketKey.match(/UpDown-15-(\d+)$/);
                    if (marketKeyTsMatch && marketKeyTsMatch[1]) {
                        const startTime = parseInt(marketKeyTsMatch[1], 10) * 1000;
                        if (!isNaN(startTime) && startTime > 0) {
                            calculatedEndDate = startTime + (15 * 60 * 1000);
                        }
                    }

                    // Fallback: try slug pattern matching
                    if (!calculatedEndDate && market.marketSlug) {
                        const tsMatch1 = market.marketSlug.match(/updown-15m-(\d+)/i);
                        const tsMatch2 = !tsMatch1 ? market.marketSlug.match(/15m-(\d+)/i) : null;
                        const tsMatch = tsMatch1 || tsMatch2;

                        if (tsMatch && tsMatch[1]) {
                            const startTime = parseInt(tsMatch[1], 10) * 1000;
                            if (!isNaN(startTime) && startTime > 0) {
                                calculatedEndDate = startTime + (15 * 60 * 1000);
                            }
                        }
                    }
                } catch (e) {
                    // Silently handle regex errors
                }

                // If parsing failed, calculate from current 15-min window (only for current markets)
                if (!calculatedEndDate) {
                    const current15MinStart = Math.floor(now / (15 * 60 * 1000)) * (15 * 60 * 1000);
                    calculatedEndDate = current15MinStart + (15 * 60 * 1000);
                }

                // Update market.endDate with calculated value
                if (calculatedEndDate) {
                    market.endDate = calculatedEndDate;
                    const timeLeftMs = calculatedEndDate - now;

                    // Show countdown for any positive time (including upcoming markets)
                    if (timeLeftMs > 0) {
                        const mins = Math.floor(timeLeftMs / 60000);
                        const secs = Math.floor((timeLeftMs % 60000) / 1000);
                        timeLeftStr = `⏱️ ${mins}m ${secs}s left`;
                    } else {
                        timeLeftStr = '⌛ Expired';
                    }
                } else {
                    timeLeftStr = '⏱️ Calculating...';
                }
            } else if (market.endDate && market.endDate > 0) {
                // For hourly markets: use endDate
                const endDateMs = market.endDate < 10000000000 ? market.endDate * 1000 : market.endDate;
                const timeLeftMs = endDateMs - now;
                if (timeLeftMs > 0) {
                    const mins = Math.floor(timeLeftMs / 60000);
                    const secs = Math.floor((timeLeftMs % 60000) / 1000);
                    timeLeftStr = `⏱️ ${mins}m ${secs}s left`;
                } else {
                    timeLeftStr = '⌛ Expired';
                }
            }

            // Build market name for display using the FINAL endDate, so the
            // window label (e.g., "4:15PM-4:30PM") always matches the countdown
            let marketNameDisplay = market.marketName;
            if (is15Min && market.endDate && market.endDate > 0) {
                try {
                    const endDateMs = market.endDate < 10000000000 ? market.endDate * 1000 : market.endDate;
                    const endTime = endDateMs;
                    const startTime = endTime - (15 * 60 * 1000); // 15 minutes before end

                    const formatTimeWindow = (date: Date) => {
                        const etFormatter = new Intl.DateTimeFormat("en-US", {
                            timeZone: "America/New_York",
                            hour: "2-digit",
                            minute: "2-digit",
                            hour12: false,
                        });
                        const parts = etFormatter.formatToParts(date);
                        const h = parseInt(parts.find((p) => p.type === "hour")?.value || "0", 10);
                        const m = parseInt(parts.find((p) => p.type === "minute")?.value || "0", 10);
                        const ampm = h >= 12 ? "PM" : "AM";
                        const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
                        return `${h12}:${m.toString().padStart(2, "0")}${ampm}`;
                    };

                    const startStr = formatTimeWindow(new Date(startTime));
                    const endStr = formatTimeWindow(new Date(endTime));

                    // For Up/Down crypto markets, normalize base name to just
                    // "Bitcoin Up or Down" or "Ethereum Up or Down" so we can
                    // append our own clean time window without duplicating the
                    // original Polymarket window text.
                    let baseName = market.marketName;
                    const upDownMatch = market.marketName.match(/^(Bitcoin Up or Down|Ethereum Up or Down)\b/i);
                    if (upDownMatch) {
                        baseName = upDownMatch[1];
                    } else {
                        baseName = this.getBaseMarketName(market.marketName);
                    }
                    const dateMatch = market.marketName.match(
                        /(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d+/i
                    );
                    const dateStr =
                        (dateMatch ? dateMatch[0] : 
                        new Date().toLocaleDateString("en-US", {
                            month: "long",
                            day: "numeric",
                            timeZone: "America/New_York",
                        }));

                    marketNameDisplay = `${baseName} - ${dateStr}, ${startStr}-${endStr} ET`;
                } catch (e) {
                    // If parsing fails, use original market name
                }
            }

            if (marketNameDisplay.length > 65) {
                marketNameDisplay = marketNameDisplay.substring(0, 62) + "...";
            }

            // Calculate next market timer (only show in final minute)
            let nextMarketTimerStr = '';
            if (is15Min && market.endDate && market.endDate > 0) {
                // Use market.endDate which was set from calculatedEndDate above
                // It's already in milliseconds (from calculatedEndDate calculation)
                const currentMarketEndMs = market.endDate;
                
                // Next market window: starts at current market end, ends 15 minutes later
                const nextMarketStart = currentMarketEndMs;
                const nextMarketEnd = nextMarketStart + (15 * 60 * 1000);
                const timeUntilNextMarket = nextMarketStart - now;
                
                // Only show if less than or equal to 60 seconds until next market (final minute)
                if (timeUntilNextMarket > 0 && timeUntilNextMarket <= 60 * 1000) {
                        // Format next market time window in ET (e.g., "4:30PM-4:45PM")
                        const formatTimeWindow = (date: Date) => {
                            const etFormatter = new Intl.DateTimeFormat('en-US', {
                                timeZone: 'America/New_York',
                                hour: '2-digit',
                                minute: '2-digit',
                                hour12: false,
                            });
                            const parts = etFormatter.formatToParts(date);
                            const h = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
                            const m = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);
                            const ampm = h >= 12 ? 'PM' : 'AM';
                            const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
                            return `${h12}:${m.toString().padStart(2, '0')}${ampm}`;
                        };
                        
                        const nextStartStr = formatTimeWindow(new Date(nextMarketStart));
                        const nextEndStr = formatTimeWindow(new Date(nextMarketEnd));
                        const nextMarketWindowStr = `${nextStartStr}-${nextEndStr}`;
                        
                        // Format countdown (minutes and seconds in final minute)
                        const minsUntilNext = Math.floor(timeUntilNextMarket / 60000);
                        const secsUntilNext = Math.floor((timeUntilNextMarket % 60000) / 1000);
                        nextMarketTimerStr = ` | ${nextMarketWindowStr} market starting in : ${minsUntilNext}m ${secsUntilNext.toString().padStart(2, '0')}sec`;
                    }
            } else if (market.endDate && market.endDate > 0) {
                // For hourly markets, calculate next hour market
                const endDateMs = market.endDate < 10000000000 ? market.endDate * 1000 : market.endDate;
                const nextHourStart = endDateMs; // Next market starts when current ends
                const nextHourEnd = nextHourStart + (60 * 60 * 1000); // 1 hour later
                const timeUntilNextMarket = nextHourStart - now;
                
                // Only show if less than or equal to 60 seconds until next market
                if (timeUntilNextMarket > 0 && timeUntilNextMarket <= 60 * 1000) {
                    // Format next market time window in ET
                    const formatTimeWindow = (date: Date) => {
                        const etFormatter = new Intl.DateTimeFormat('en-US', {
                            timeZone: 'America/New_York',
                            hour: '2-digit',
                            minute: '2-digit',
                            hour12: false,
                        });
                        const parts = etFormatter.formatToParts(date);
                        const h = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
                        const m = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);
                        const ampm = h >= 12 ? 'PM' : 'AM';
                        const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
                        return `${h12}:${m.toString().padStart(2, '0')}${ampm}`;
                    };
                    
                    const nextStartStr = formatTimeWindow(new Date(nextHourStart));
                    const nextEndStr = formatTimeWindow(new Date(nextHourEnd));
                    const nextMarketWindowStr = `${nextStartStr}-${nextEndStr}`;
                    
                    // Format countdown (minutes and seconds in final minute)
                    const minsUntilNext = Math.floor(timeUntilNextMarket / 60000);
                    const secsUntilNext = Math.floor((timeUntilNextMarket % 60000) / 1000);
                    nextMarketTimerStr = ` | ${nextMarketWindowStr} market starting in : ${minsUntilNext}m ${secsUntilNext.toString().padStart(2, '0')}sec`;
                }
            }

            // Ensure clean formatting - no extra characters
            outputLines.push(chalk.yellow(`┌─ ${market.marketKey} ${timeLeftStr}${nextMarketTimerStr}`));
            outputLines.push(chalk.gray(`│  ${marketNameDisplay}`));
            
            // UP line - matching paper mode format
            const upLiveStr = hasValidPriceUp ? chalk.yellow.bold(`LIVE: $${market.currentPriceUp!.toFixed(4)}`) : chalk.gray('LIVE: fetching...');
            const upPnlColor = pnlUp >= 0 ? chalk.green : chalk.red;
            const upPnlStr = hasValidPriceUp ? upPnlColor(`${pnlUp >= 0 ? '+' : ''}$${pnlUp.toFixed(2)} (${market.totalCostUp > 0 ? ((pnlUp/market.totalCostUp)*100).toFixed(1) : '0.0'}%)`) : '';
            outputLines.push(chalk.gray(`│  `) + chalk.green('📈 UP:   ') + chalk.white(`${market.sharesUp.toFixed(2)} shares | $${market.investedUp.toFixed(2)} @ $${avgPriceUp.toFixed(4)} avg | `) + upLiveStr + chalk.white(' | ') + upPnlStr + chalk.gray(` | ${market.tradesUp} trades`));

            // DOWN line - matching paper mode format
            const downLiveStr = hasValidPriceDown ? chalk.yellow.bold(`LIVE: $${market.currentPriceDown!.toFixed(4)}`) : chalk.gray('LIVE: fetching...');
            const downPnlColor = pnlDown >= 0 ? chalk.green : chalk.red;
            const downPnlStr = hasValidPriceDown ? downPnlColor(`${pnlDown >= 0 ? '+' : ''}$${pnlDown.toFixed(2)} (${market.totalCostDown > 0 ? ((pnlDown/market.totalCostDown)*100).toFixed(1) : '0.0'}%)`) : '';
            outputLines.push(chalk.gray(`│  `) + chalk.red('📉 DOWN: ') + chalk.white(`${market.sharesDown.toFixed(2)} shares | $${market.investedDown.toFixed(2)} @ $${avgPriceDown.toFixed(4)} avg | `) + downLiveStr + chalk.white(' | ') + downPnlStr + chalk.gray(` | ${market.tradesDown} trades`));

            // Live price sum check
            if (hasValidPriceUp && hasValidPriceDown) {
                const liveSum = market.currentPriceUp! + market.currentPriceDown!;
                const sumStatus = Math.abs(liveSum - 1.0) < 0.02 ? chalk.green('✓') : chalk.yellow('⚠️');
                // Ensure clean line - no extra content
                outputLines.push(chalk.gray(`│  💵 Live Prices: UP $${market.currentPriceUp!.toFixed(4)} + DOWN $${market.currentPriceDown!.toFixed(4)} = $${liveSum.toFixed(4)} `) + sumStatus);
            }

            // Summary line with PnL
            const totalCurrentValue = currentValueUp + currentValueDown;
            const totalPnlColor = totalPnl >= 0 ? chalk.green : chalk.red;
            const totalPnlSign = totalPnl >= 0 ? '+' : '';
            const marketCostBasis = market.totalCostUp + market.totalCostDown;
            const totalPnlPercent = marketCostBasis > 0 ? ((totalPnl / marketCostBasis) * 100).toFixed(1) : '0.0';

            if (totalPnl !== 0 || (hasValidPriceUp || hasValidPriceDown)) {
                outputLines.push(chalk.gray(`│  💰 Invested: $${totalInvested.toFixed(2)} | Value: $${totalCurrentValue.toFixed(2)} | PnL: `) + totalPnlColor(`${totalPnlSign}$${totalPnl.toFixed(2)} (${totalPnlSign}${totalPnlPercent}%)`));
            } else {
                outputLines.push(chalk.gray(`│  💰 Total Invested: $${totalInvested.toFixed(2)} | ${market.tradesUp + market.tradesDown} trades`));
            }

            // Visual bar - colorful like paper mode (40 chars)
            const barLength = 40;
            const upBars = Math.round((upPercent / 100) * barLength);
            const downBars = barLength - upBars;
            const upBar = chalk.green('█'.repeat(upBars));
            const downBar = chalk.red('█'.repeat(downBars));
            outputLines.push(chalk.gray(`│  [`) + upBar + downBar + chalk.gray(`] `) + chalk.green(`${upPercent.toFixed(1)}% UP`) + chalk.gray(' / ') + chalk.red(`${downPercent.toFixed(1)}% DOWN`));
            outputLines.push(chalk.yellow('└' + '─'.repeat(80)));
            outputLines.push(''); // Empty line between markets
        };

        // Create a single totals object to accumulate values across all renderMarket calls
        // (JavaScript passes objects by reference, so mutations inside renderMarket will persist)
        const totals = {
            totalInvestedAll,
            totalCostBasisAll,
            totalValueAll,
            totalPnlAll,
            totalTradesAll,
            totalInvested15m,
            totalCostBasis15m,
            totalValue15m,
            totalPnl15m,
            totalTrades15m,
            totalInvested1h,
            totalCostBasis1h,
            totalValue1h,
            totalPnl1h,
            totalTrades1h
        };

        // Render current markets
        for (const market of sortedCurrentMarkets) {
            renderMarket(market, totals);
        }

        // Render UPCOMING MARKETS section (ALWAYS show if we have upcoming markets)
        if (sortedUpcomingMarkets.length > 0) {
            outputLines.push(''); // Extra spacing
            outputLines.push(chalk.magenta('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
            outputLines.push(chalk.magenta.bold('  🔮 UPCOMING MARKETS'));
            outputLines.push(chalk.magenta('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
            outputLines.push(''); // Empty line

            // Render upcoming markets using the same totals object
            for (const market of sortedUpcomingMarkets) {
                renderMarket(market, totals);
            }
            logger.debug(`[MARKET-TRACKER] Displayed ${sortedUpcomingMarkets.length} upcoming market(s) with live prices`);
        } else {
            logger.debug(`[MARKET-TRACKER] No upcoming markets to display (sortedUpcomingMarkets.length=0, upcomingMarkets.length=${upcomingMarkets.length}, nextMarketsFromStream.size=${nextMarketsFromStream.size})`);
        }

        // Portfolio Summary Section - matching paper mode format
        outputLines.push(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
        outputLines.push(chalk.cyan.bold('  📊 PORTFOLIO SUMMARY'));

        // 15-minute markets summary
        const pnl15mSign = totals.totalPnl15m >= 0 ? '+' : '';
        const pnl15mPercent = totals.totalCostBasis15m > 0 ? ((totals.totalPnl15m / totals.totalCostBasis15m) * 100).toFixed(2) : '0.00';
        const pnl15mColor = totals.totalPnl15m >= 0 ? chalk.green : chalk.red;
        outputLines.push('');
        outputLines.push(chalk.white.bold('  ⏱️  15-Minute Markets (BTC + ETH)'));
        outputLines.push(chalk.gray(`    Invested: $${totals.totalInvested15m.toFixed(2)} | Value: $${totals.totalValue15m.toFixed(2)} | PnL: `) + pnl15mColor(`${pnl15mSign}$${totals.totalPnl15m.toFixed(2)} (${pnl15mSign}${pnl15mPercent}%)`) + chalk.gray(` | Trades: ${totals.totalTrades15m}`));

        // 1-hour markets summary
        const pnl1hSign = totals.totalPnl1h >= 0 ? '+' : '';
        const pnl1hPercent = totals.totalCostBasis1h > 0 ? ((totals.totalPnl1h / totals.totalCostBasis1h) * 100).toFixed(2) : '0.00';
        const pnl1hColor = totals.totalPnl1h >= 0 ? chalk.green : chalk.red;
        outputLines.push('');
        outputLines.push(chalk.white.bold('  🕐 1-Hour Markets (BTC + ETH)'));
        outputLines.push(chalk.gray(`    Invested: $${totals.totalInvested1h.toFixed(2)} | Value: $${totals.totalValue1h.toFixed(2)} | PnL: `) + pnl1hColor(`${pnl1hSign}$${totals.totalPnl1h.toFixed(2)} (${pnl1hSign}${pnl1hPercent}%)`) + chalk.gray(` | Trades: ${totals.totalTrades1h}`));

        // Total summary
        const totalPnlSign = totals.totalPnlAll >= 0 ? '+' : '';
        const totalPnlPercent = totals.totalCostBasisAll > 0 ? ((totals.totalPnlAll / totals.totalCostBasisAll) * 100).toFixed(2) : '0.00';
        const totalPnlAllColor = totals.totalPnlAll >= 0 ? chalk.green : chalk.red;

        outputLines.push('');
        outputLines.push(chalk.yellow.bold('  📈 TOTAL (All Markets)'));
        outputLines.push(chalk.white(`    Invested: $${totals.totalInvestedAll.toFixed(2)} | Value: $${totals.totalValueAll.toFixed(2)}`));
        outputLines.push(chalk.gray('    PnL: ') + totalPnlAllColor.bold(`${totalPnlSign}$${totals.totalPnlAll.toFixed(2)} (${totalPnlSign}${totalPnlPercent}%)`) + chalk.gray(` | Total Trades: ${totals.totalTradesAll}`));

        outputLines.push(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));

        // ==========================================================================
        // UPCOMING MARKETS MINI DASHBOARD - Same as paper mode for consistency
        // ==========================================================================
        outputLines.push('');
        outputLines.push(chalk.magenta.bold('  🔮 UPCOMING MARKETS'));

        // Get current ET window info
        const upcomingETFormatter = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        });
        const upcomingETParts = upcomingETFormatter.formatToParts(new Date(now));
        const upcomingHour = parseInt(upcomingETParts.find(p => p.type === 'hour')?.value || '0', 10);
        const upcomingMinute = parseInt(upcomingETParts.find(p => p.type === 'minute')?.value || '0', 10);
        const current15MinWindow = Math.floor(upcomingMinute / 15) * 15;
        const next15MinWindow = (current15MinWindow + 15) % 60;
        const nextWindowHour = current15MinWindow + 15 >= 60 ? (upcomingHour + 1) % 24 : upcomingHour;

        // Format times
        const formatTimeUpcoming = (h: number, m: number) => {
            const ampm = h >= 12 ? 'PM' : 'AM';
            const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
            return `${h12}:${m.toString().padStart(2, '0')}${ampm}`;
        };

        const currentWindowStr = `${formatTimeUpcoming(upcomingHour, current15MinWindow)}-${formatTimeUpcoming(nextWindowHour, next15MinWindow)}`;
        // Fix hour formatting for next hour display
        let nextHourDisplay = (upcomingHour + 1) % 24;
        const nextHourAmPm = nextHourDisplay >= 12 ? 'PM' : 'AM';
        const nextHour12 = nextHourDisplay === 0 ? 12 : nextHourDisplay > 12 ? nextHourDisplay - 12 : nextHourDisplay;
        const nextHourStr = `${nextHour12}${nextHourAmPm} ET`;

        // Check what markets we have discovered (use startsWith for 15m since keys now include timestamp)
        const hasBTC15m = Array.from(this.markets.values()).some(m => m.marketKey.startsWith('BTC-UpDown-15') && m.endDate && m.endDate > now);
        const hasETH15m = Array.from(this.markets.values()).some(m => m.marketKey.startsWith('ETH-UpDown-15') && m.endDate && m.endDate > now);
        const hasBTC1h = Array.from(this.markets.values()).some(m => m.marketKey.startsWith('BTC-UpDown-1h') && m.endDate && m.endDate > now);
        const hasETH1h = Array.from(this.markets.values()).some(m => m.marketKey.startsWith('ETH-UpDown-1h') && m.endDate && m.endDate > now);

        // Calculate seconds until next windows
        const secsToNext15m = (15 - (upcomingMinute % 15)) * 60 - new Date(now).getSeconds();

        outputLines.push('');
        outputLines.push(chalk.gray('    Current Window: ') + chalk.white(currentWindowStr) + chalk.gray(' ET'));
        outputLines.push('');

        // 15-min status
        const btc15mStatus = hasBTC15m ? chalk.green('✓ READY') : chalk.yellow('⏳ Waiting...');
        const eth15mStatus = hasETH15m ? chalk.green('✓ READY') : chalk.yellow('⏳ Waiting...');
        outputLines.push(chalk.gray('    15-Min: ') + chalk.cyan('BTC ') + btc15mStatus + chalk.gray(' | ') + chalk.cyan('ETH ') + eth15mStatus + chalk.gray(` | Next in ${secsToNext15m}s`));

        // 1h status
        const btc1hStatus = hasBTC1h ? chalk.green('✓ READY') : chalk.yellow('⏳ Waiting...');
        const eth1hStatus = hasETH1h ? chalk.green('✓ READY') : chalk.yellow('⏳ Waiting...');
        outputLines.push(chalk.gray('    1-Hour: ') + chalk.cyan('BTC ') + btc1hStatus + chalk.gray(' | ') + chalk.cyan('ETH ') + eth1hStatus + chalk.gray(` | Next: ${nextHourStr}`));

        // Show tracked market slugs for debugging
        const slugs15m = Array.from(this.markets.values())
            .filter(m => m.marketKey.includes('-15'))
            .map(m => {
                const ts = m.marketSlug?.match(/updown-15m-(\d+)/)?.[1];
                const isBTC = m.marketKey.includes('BTC');
                return ts ? `${isBTC ? 'B' : 'E'}:${ts?.slice(-4)}` : null;
            })
            .filter(Boolean);

        if (slugs15m.length > 0) {
            outputLines.push(chalk.gray(`    Tracked: `) + chalk.dim(slugs15m.join(' | ')));
        }

        outputLines.push(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
        outputLines.push(''); // Empty line at end

        // Clear screen completely and move cursor to top
        // \x1b[2J = clear entire screen, \x1b[3J = clear scrollback, \x1b[H = move cursor to top-left
        process.stdout.write('\x1b[2J\x1b[3J\x1b[H');

        // Pad each line to 82 chars to prevent overlap from previous longer lines
        const paddedLines = outputLines.map(line => {
            // Strip ANSI codes to get visual length
            const visualLength = line.replace(/\x1b\[[0-9;]*m/g, '').length;
            const padding = Math.max(0, 82 - visualLength);
            return line + ' '.repeat(padding);
        });

        // Build output string and write in one go to prevent corruption
        const output = paddedLines.join('\n');
        process.stdout.write(output);
        process.stdout.write('\n'); // Final newline

        // Clear any remaining lines below (in case previous output was longer)
        process.stdout.write('\x1b[0J');
        const displayDuration = Date.now() - displayStartTime;
        logger.debug(`[MARKET-TRACKER] displayStats() completed successfully in ${displayDuration}ms`);
        } finally {
            // Release lock
            this.isDisplaying = false;
            const finalDisplayDuration = Date.now() - displayStartTime;
            logger.debug(`[MARKET-TRACKER] displayStats() finally block - lock released, total duration=${finalDisplayDuration}ms`);
        }
    }

    /**
     * Set display mode for header (WATCH, TRADING, or PAPER)
     */
    setDisplayMode(mode: 'WATCH' | 'TRADING' | 'PAPER'): void {
        this.displayMode = mode;
    }

    /**
     * Force immediate display update on next call to displayStats()
     */
    forceDisplayUpdate(): void {
        this.lastDisplayTime = 0;
    }

    /**
     * Get all market stats (for external use)
     */
    getStats(): MarketStats[] {
        return Array.from(this.markets.values());
    }

    /**
     * Get markets map (for external use)
     */
    getMarkets(): Map<string, MarketStats> {
        return this.markets;
    }

    /**
     * Get market stats by condition ID (used by paper bot to mirror watcher prices)
     */
    getMarketByConditionId(conditionId: string): MarketStats | undefined {
        for (const market of this.markets.values()) {
            if (market.conditionId === conditionId) {
                return market;
            }
        }
        return undefined;
    }

    /**
     * Get current live prices for a market by slug pattern
     * This is used to inject exact orderbook prices into trades before logging
     */
    getLivePricesBySlug(slug: string): { priceUp: number; priceDown: number } | null {
        if (!slug) return null;

        const slugLower = slug.toLowerCase();

        // Find market that matches this slug pattern
        for (const market of this.markets.values()) {
            const marketSlugLower = (market.marketSlug || '').toLowerCase();

            // Direct slug match
            if (marketSlugLower === slugLower) {
                if (market.currentPriceUp !== undefined && market.currentPriceDown !== undefined) {
                    return { priceUp: market.currentPriceUp, priceDown: market.currentPriceDown };
                }
            }

            // Pattern match (btc-updown-15m, eth-updown-15m, etc.)
            if (slugLower.includes('btc-updown-15m') && marketSlugLower.includes('btc-updown-15m')) {
                if (market.currentPriceUp !== undefined && market.currentPriceDown !== undefined) {
                    return { priceUp: market.currentPriceUp, priceDown: market.currentPriceDown };
                }
            }
            if (slugLower.includes('eth-updown-15m') && marketSlugLower.includes('eth-updown-15m')) {
                if (market.currentPriceUp !== undefined && market.currentPriceDown !== undefined) {
                    return { priceUp: market.currentPriceUp, priceDown: market.currentPriceDown };
                }
            }
            if (slugLower.includes('btc') && slugLower.includes('1h') && marketSlugLower.includes('btc') && marketSlugLower.includes('1h')) {
                if (market.currentPriceUp !== undefined && market.currentPriceDown !== undefined) {
                    return { priceUp: market.currentPriceUp, priceDown: market.currentPriceDown };
                }
            }
            if (slugLower.includes('eth') && slugLower.includes('1h') && marketSlugLower.includes('eth') && marketSlugLower.includes('1h')) {
                if (market.currentPriceUp !== undefined && market.currentPriceDown !== undefined) {
                    return { priceUp: market.currentPriceUp, priceDown: market.currentPriceDown };
                }
            }
        }

        return null;
    }

    /**
     * Fetch FRESH prices from CLOB API for a market by slug
     * This fetches directly from the orderbook - not cached values
     * Returns null if unable to fetch (missing asset IDs, API failure, etc.)
     */
    async fetchFreshPricesBySlug(slug: string): Promise<{ priceUp: number; priceDown: number } | null> {
        if (!slug) return null;

        const slugLower = slug.toLowerCase();

        // Find market that matches this slug pattern to get asset IDs
        for (const market of this.markets.values()) {
            const marketSlugLower = (market.marketSlug || '').toLowerCase();

            // Check for match
            const isMatch = marketSlugLower === slugLower ||
                (slugLower.includes('btc-updown-15m') && marketSlugLower.includes('btc-updown-15m')) ||
                (slugLower.includes('eth-updown-15m') && marketSlugLower.includes('eth-updown-15m')) ||
                (slugLower.includes('btc') && slugLower.includes('1h') && marketSlugLower.includes('btc') && marketSlugLower.includes('1h')) ||
                (slugLower.includes('eth') && slugLower.includes('1h') && marketSlugLower.includes('eth') && marketSlugLower.includes('1h'));

            if (isMatch && market.assetUp && market.assetDown) {
                // Fetch BOTH prices from CLOB API in parallel
                const [priceUp, priceDown] = await Promise.all([
                    this.fetchOrderBookPrice(market.assetUp),
                    this.fetchOrderBookPrice(market.assetDown)
                ]);

                if (priceUp !== null && priceDown !== null) {
                    return { priceUp, priceDown };
                }
            }
        }

        return null;
    }

    /**
     * Update market asset IDs (used when we fetch assets from Gamma API)
     * This allows price fetching to work when watcher trades only provided one asset
     */
    updateMarketAssets(conditionId: string, assetUp: string, assetDown: string, marketKey?: string): void {
        // First try by conditionId
        for (const market of this.markets.values()) {
            if (market.conditionId === conditionId) {
                // FORCE set assets even if already set (might have been wrong)
                if (assetUp) market.assetUp = assetUp;
                if (assetDown) market.assetDown = assetDown;
                return;
            }
        }
        // Fallback: try by marketKey
        if (marketKey) {
            const market = this.markets.get(marketKey);
            if (market) {
                if (assetUp) market.assetUp = assetUp;
                if (assetDown) market.assetDown = assetDown;
                if (conditionId) market.conditionId = conditionId;
            }
        }
    }

    /**
     * Ensure a market exists with both asset IDs (for proactive discovery)
     * Creates the market if it doesn't exist, updates assets if it does
     */
    ensureMarketWithAssets(
        marketKey: string,
        marketName: string,
        marketSlug: string,
        conditionId: string,
        assetUp: string,
        assetDown: string,
        endDate?: number
    ): void {
        let market = this.markets.get(marketKey);
        if (!market) {
            // Create new market with assets for immediate price fetching
            market = {
                marketKey,
                marketName,
                marketSlug,
                sharesUp: 0,
                sharesDown: 0,
                investedUp: 0,
                investedDown: 0,
                totalCostUp: 0,
                totalCostDown: 0,
                tradesUp: 0,
                tradesDown: 0,
                lastUpdate: Date.now(),
                endDate,
                conditionId,
                assetUp,
                assetDown,
                marketOpenTime: Date.now(),
            };
            this.markets.set(marketKey, market);
            logger.debug(`[MARKET-TRACKER] Created new market: ${marketKey} (slug: ${marketSlug}, endDate: ${endDate ? new Date(endDate).toISOString() : 'N/A'})`);
        } else {
            // Update existing market with the latest authoritative data from the WebSocket/Gamma APIs.
            // For time-windowed markets, asset IDs can change between windows, so we always refresh
            // them when new data is available.
            if (assetUp) market.assetUp = assetUp;
            if (assetDown) market.assetDown = assetDown;
            if (conditionId) market.conditionId = conditionId;
            // Always update endDate if provided (critical for upcoming markets to stay stable)
            if (endDate) market.endDate = endDate;
            // Always update name/slug to ensure we have the latest info
            if (marketName) market.marketName = marketName;
            if (marketSlug) market.marketSlug = marketSlug;
            // Update lastUpdate timestamp to prevent market from being marked as stale
            market.lastUpdate = Date.now();
            logger.debug(`[MARKET-TRACKER] Updated existing market: ${marketKey} (endDate: ${market.endDate ? new Date(market.endDate).toISOString() : 'N/A'}, lastUpdate refreshed)`);
        }
    }

    /**
     * Sync paper positions to marketTracker for display
     * This allows paper mode to use the same dashboard as watcher mode
     * Uses exact same PnL calculation as watcher mode
     */
    syncPaperPositions(paperPositions: Array<{
        conditionId: string;
        marketKey: string;
        marketName: string;
        marketSlug?: string;
        sharesUp: number;
        sharesDown: number;
        costBasisUp: number;
        costBasisDown: number;
        avgPriceUp: number;
        avgPriceDown: number;
        tradesUp: number;
        tradesDown: number;
        endDate?: number;
    }>, marketData: Map<string, {
        conditionId: string;
        priceUp: number;
        priceDown: number;
        assetUp?: string;
        assetDown?: string;
        endDate?: number;
    }>): void {
        // Clear existing markets and replace with paper positions
        this.markets.clear();

        for (const position of paperPositions) {
            const marketInfo = marketData.get(position.marketKey);
            if (!marketInfo) {
                continue;
            }

            // Convert paper position to MarketStats format
            // IMPORTANT: Cost basis excludes fees (matches Polymarket API)
            // In watcher mode: totalCostUp = shares * price (accumulated from trades)
            // For paper mode: costBasisUp is already the total cost, but we calculate it as shares * avgPrice
            // to match watcher mode's exact calculation
            const totalCostUp = position.sharesUp > 0 ? position.sharesUp * position.avgPriceUp : 0;
            const totalCostDown = position.sharesDown > 0 ? position.sharesDown * position.avgPriceDown : 0;

            const market: MarketStats = {
                marketKey: position.marketKey,
                marketName: position.marketName,
                marketSlug: position.marketSlug,
                sharesUp: position.sharesUp,
                sharesDown: position.sharesDown,
                investedUp: position.costBasisUp, // For display (shows invested amount)
                investedDown: position.costBasisDown, // For display
                totalCostUp: totalCostUp, // For accurate PnL calculation (actual cost basis)
                totalCostDown: totalCostDown, // For accurate PnL calculation (actual cost basis)
                tradesUp: position.tradesUp,
                tradesDown: position.tradesDown,
                lastUpdate: Date.now(),
                endDate: position.endDate || marketInfo.endDate,
                conditionId: position.conditionId,
                assetUp: marketInfo.assetUp,
                assetDown: marketInfo.assetDown,
                currentPriceUp: marketInfo.priceUp,
                currentPriceDown: marketInfo.priceDown,
                lastPriceUpdate: Date.now(),
                marketOpenTime: Date.now(),
            };

            this.markets.set(position.marketKey, market);
        }
    }

    /**
     * Proactively discover 15-minute markets from Gamma API
     * This ensures new markets appear on dashboard immediately, even before trader trades
     * Matches paper mode's aggressive discovery technique
     */
    private lastProactiveDiscovery = 0;
    // Slightly slower to avoid hitting Gamma API rate limits, while still feeling real-time
    private proactiveDiscoveryInterval = 3000; // Check every 3 seconds
    private discoveredSlugs: Set<string> = new Set(); // Track already discovered slugs

    async proactivelyDiscover15MinMarkets(): Promise<void> {
        const discoveryStartTime = Date.now();
        const now = Date.now();
        logger.debug(`[MARKET-TRACKER] proactivelyDiscover15MinMarkets() called, lastProactiveDiscovery=${this.lastProactiveDiscovery}, interval=${this.proactiveDiscoveryInterval}ms`);

        // Rate limit: check every 1 second
        if (now - this.lastProactiveDiscovery < this.proactiveDiscoveryInterval) {
            const timeSinceLast = now - this.lastProactiveDiscovery;
            logger.debug(`[MARKET-TRACKER] proactivelyDiscover15MinMarkets() skipped - rate limited (${timeSinceLast}ms < ${this.proactiveDiscoveryInterval}ms)`);
            return;
        }
        this.lastProactiveDiscovery = now;
        logger.debug(`[MARKET-TRACKER] proactivelyDiscover15MinMarkets() starting discovery, current markets=${this.markets.size}`);

        // Calculate current AND next 15-min window starts (like paper mode)
        const current15MinStart = Math.floor(now / (15 * 60 * 1000)) * (15 * 60 * 1000);
        const next15MinStart = current15MinStart + (15 * 60 * 1000);
        const current15MinTimestamp = Math.floor(current15MinStart / 1000);
        const next15MinTimestamp = Math.floor(next15MinStart / 1000);

        // Generate expected slugs for BOTH current and next windows
        // 15-minute markets: btc-updown-15m-{timestamp}
        const slugsToCheck = [
            `btc-updown-15m-${current15MinTimestamp}`,
            `eth-updown-15m-${current15MinTimestamp}`,
            `btc-updown-15m-${next15MinTimestamp}`,
            `eth-updown-15m-${next15MinTimestamp}`,
        ];
        logger.debug(`[MARKET-TRACKER] proactivelyDiscover15MinMarkets() - checking ${slugsToCheck.length} slugs:`, slugsToCheck);

        // Also check for 1-hour markets
        const etFormatter = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: 'numeric',
            hour12: true,
        });
        const etParts = etFormatter.formatToParts(new Date(now));
        const month = etParts.find(p => p.type === 'month')?.value?.toLowerCase() || '';
        const day = etParts.find(p => p.type === 'day')?.value || '';
        const hour = parseInt(etParts.find(p => p.type === 'hour')?.value || '0', 10);
        const ampm = etParts.find(p => p.type === 'dayPeriod')?.value?.toLowerCase() || 'am';

        // Current and next hour slugs
        const currentHourSlug = `${hour}${ampm}`;
        const nextHour = ampm === 'am' && hour === 11 ? 12 : ampm === 'pm' && hour === 11 ? 12 : (hour % 12) + 1;
        const nextAmpm = ampm === 'am' && hour === 11 ? 'pm' : ampm === 'pm' && hour === 11 ? 'am' : ampm;
        const nextHourSlug = `${nextHour}${nextAmpm}`;

        // Check minutes - if within 5 minutes of next hour, aggressively fetch next hour's markets
        const minutes = new Date(now).getMinutes();
        const secondsUntilNextHour = (60 - minutes) * 60 - new Date(now).getSeconds();
        const withinPreFetchWindow = secondsUntilNextHour <= 300; // 5 minutes = 300 seconds

        // Next hour's day (handles midnight rollover)
        let nextHourDay = day;
        let nextHourMonth = month;
        if (hour === 11 && ampm === 'pm') {
            // 11 PM -> 12 AM next day
            const tomorrow = new Date(now);
            tomorrow.setDate(tomorrow.getDate() + 1);
            const tomorrowET = new Intl.DateTimeFormat('en-US', {
                timeZone: 'America/New_York',
                month: 'long',
                day: 'numeric',
            }).formatToParts(tomorrow);
            nextHourDay = tomorrowET.find(p => p.type === 'day')?.value || day;
            nextHourMonth = tomorrowET.find(p => p.type === 'month')?.value?.toLowerCase() || month;
        }

        // Build next hour slugs (1-hour markets) for reference, but do NOT
        // aggressively fetch them via the Gamma API here. Hourly markets are
        // already discovered by priceStreamLogger, and hammering the slug
        // endpoint caused 429 rate limits and delayed ETH-1h discovery.
        const nextHourBtcSlug = `bitcoin-up-or-down-${nextHourMonth}-${nextHourDay}-${nextHourSlug}-et`;
        const nextHourEthSlug = `ethereum-up-or-down-${nextHourMonth}-${nextHourDay}-${nextHourSlug}-et`;

        // If within 5 minutes of next hour, clear next hour slugs from cache to force re-sync
        if (withinPreFetchWindow) {
            this.discoveredSlugs.delete(nextHourBtcSlug);
            this.discoveredSlugs.delete(nextHourEthSlug);
        }

        // NOTE: We intentionally do not push the 1-hour slugs into slugsToCheck
        // any more. Hourly markets are synced from priceStreamLogger below,
        // which already performs its own (now rate-limited) discovery. This
        // keeps dashboard behaviour correct while avoiding duplicate slug
        // requests that were triggering 429s.

        // Fetch all slugs in parallel for speed
        const fetchPromises = slugsToCheck.map(async (slug) => {
            // Skip if already discovered this exact slug
            if (this.discoveredSlugs.has(slug)) {
                return null;
            }

            // Determine market key
            const isBTC = slug.includes('btc') || slug.includes('bitcoin');
            const is15Min = slug.includes('updown-15m');
            const is1Hour = slug.includes('up-or-down');
            let marketKey: string;

            if (is15Min) {
                // Extract timestamp from slug to create unique key matching extractMarketKey()
                const tsMatch = slug.match(/updown-15m-(\d+)/);
                const timestamp = tsMatch ? tsMatch[1] : '';
                const baseKey = isBTC ? 'BTC-UpDown-15' : 'ETH-UpDown-15';
                marketKey = timestamp ? `${baseKey}-${timestamp}` : baseKey;
            } else if (is1Hour) {
                // Skip direct 1-hour slug discovery here and rely on
                // priceStreamLogger's MarketDiscovery instead. This avoids
                // duplicated Gamma API calls which were being rate limited.
                return null;
            } else {
                // Unknown format - skip
                return null;
            }

            // DEBUG: Log which slugs we're probing for 15-minute discovery
            if (is15Min && slug.includes('updown-15m')) {
                logger.info(
                    `[MARKET-TRACKER DEBUG] Probing 15m slug=${slug} -> marketKey=${marketKey}`
                );
            }

            // Check if we already have this exact slug in markets
            const existingMarket = this.markets.get(marketKey);
            if (existingMarket && existingMarket.marketSlug === slug) {
                this.discoveredSlugs.add(slug);
                return null;
            }

            // For 15-min markets, check if existing is from current window
            if (is15Min && existingMarket && existingMarket.endDate && existingMarket.endDate > now) {
                const pattern = /updown-15m-(\d+)/;
                const existingTimestamp = existingMarket.marketSlug?.match(pattern)?.[1];
                const targetTimestamp = slug.match(pattern)?.[1];
                if (existingTimestamp === targetTimestamp) {
                    this.discoveredSlugs.add(slug);
                    return null;
                }
                // If timestamps don't match, we need to replace the old market
                // Don't return null - continue to fetch and replace
            }

            try {
                const url = `https://gamma-api.polymarket.com/events?slug=${slug}`;
                const data = await fetchData(url).catch(() => null);

                if (data && Array.isArray(data) && data.length > 0) {
                    logger.info(
                        `[MARKET-TRACKER DEBUG] Gamma returned ${data.length} event(s) for slug=${slug}`
                    );
                    return { slug, data: data[0], marketKey, is15Min, is1Hour, isBTC };
                }
                logger.info(
                    `[MARKET-TRACKER DEBUG] Gamma returned NO events for slug=${slug}`
                );
            } catch {
                // Silently ignore
            }
            return null;
        });

        const results = await Promise.all(fetchPromises);

        for (const result of results) {
            if (!result) continue;

            const { slug, data: event, marketKey, is15Min, is1Hour } = result;
            const markets = event.markets || [];

            if (markets.length === 0) continue;

            const market = markets[0];
            const conditionId = market.conditionId;

            // Parse clobTokenIds - API returns it as JSON string, not array
            let clobTokenIds: string[] = [];
            if (typeof market.clobTokenIds === 'string') {
                try {
                    clobTokenIds = JSON.parse(market.clobTokenIds);
                } catch {
                    clobTokenIds = [];
                }
            } else if (Array.isArray(market.clobTokenIds)) {
                clobTokenIds = market.clobTokenIds;
            }

            if (clobTokenIds.length < 2) continue;

            // Parse end date - calculate from slug or API
            let endDate: number | undefined;

            if (is15Min) {
                // For 15-min markets: calculate from slug timestamp
                const tsMatch = slug.match(/updown-15m-(\d+)/);
                if (tsMatch) {
                    const startTime = parseInt(tsMatch[1], 10) * 1000;
                    endDate = startTime + (15 * 60 * 1000); // 15 minutes after start
                }
            } else if (is1Hour) {
                // For 1-hour markets: ALWAYS calculate from slug first (most reliable)
                // Then validate against API endDate if available
                const hourlyMatch = slug.match(/-(\w+)-(\d+)-(\d{1,2})(am|pm)-et$/i);
                if (hourlyMatch) {
                    const monthName = hourlyMatch[1];
                    const dayNum = parseInt(hourlyMatch[2], 10);
                    let hourNum = parseInt(hourlyMatch[3], 10);
                    const ampmVal = hourlyMatch[4].toLowerCase();

                    // Convert 12-hour to 24-hour format
                    if (ampmVal === 'pm' && hourNum !== 12) hourNum += 12;
                    if (ampmVal === 'am' && hourNum === 12) hourNum = 0;

                    const months: {[key: string]: number} = {
                        january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
                        july: 6, august: 7, september: 8, october: 9, november: 10, december: 11
                    };
                    const monthNum = months[monthName.toLowerCase()] ?? new Date().getMonth();
                    const year = new Date().getFullYear();

                    // Create date in ET timezone - market ENDS at the hour, so if slug says "7am",
                    // the market ends at 7:00 AM ET (runs from 6:00 AM to 7:00 AM)
                    // Actually, markets START at the hour and END 1 hour later
                    // So "7am" market starts at 7:00 AM ET and ends at 8:00 AM ET
                    const startHour = hourNum;
                    const endHour = startHour + 1;

                    // Use Intl to properly handle ET timezone
                    const etDate = new Date();
                    etDate.setFullYear(year, monthNum, dayNum);
                    etDate.setHours(endHour, 0, 0, 0);

                    // Convert to UTC by parsing as ET
                    const etDateStr = `${year}-${String(monthNum + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}T${String(endHour).padStart(2, '0')}:00:00`;
                    const formatter = new Intl.DateTimeFormat('en-US', {
                        timeZone: 'America/New_York',
                        year: 'numeric', month: '2-digit', day: '2-digit',
                        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
                    });

                    // Parse the ET time properly
                    const tempDate = new Date(`${etDateStr}`);
                    // Adjust for timezone - ET is UTC-5 (EST) or UTC-4 (EDT)
                    const jan = new Date(year, 0, 1);
                    const jul = new Date(year, 6, 1);
                    const stdOffset = Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset());
                    const isDST = tempDate.getTimezoneOffset() < stdOffset;
                    const etOffsetHours = isDST ? -4 : -5;

                    // endDate is when market ends (startHour + 1 hour) in UTC
                    endDate = Date.UTC(year, monthNum, dayNum, endHour - etOffsetHours, 0, 0);
                }

                // Validate against API endDate if available
                if (market.endDate || event.endDate) {
                    const apiEndDate = market.endDate || event.endDate;
                    const apiEndDateMs = typeof apiEndDate === 'string'
                        ? new Date(apiEndDate).getTime()
                        : apiEndDate < 10000000000 ? apiEndDate * 1000 : apiEndDate;

                    // Use API endDate if our calculation seems off by more than 5 minutes
                    if (endDate && Math.abs(apiEndDateMs - endDate) > 5 * 60 * 1000) {
                        endDate = apiEndDateMs;
                    } else if (!endDate) {
                        endDate = apiEndDateMs;
                    }
                }
            }

            // Skip if expired
            if (endDate && endDate < now) continue;

            // Get asset IDs
            let assetUp = clobTokenIds[0] || '';
            let assetDown = clobTokenIds[1] || '';

            // Parse outcomes - API returns it as JSON string, not array
            let outcomes: string[] = [];
            if (typeof market.outcomes === 'string') {
                try {
                    outcomes = JSON.parse(market.outcomes);
                } catch {
                    outcomes = [];
                }
            } else if (Array.isArray(market.outcomes)) {
                outcomes = market.outcomes;
            }

            // Check outcomes to determine correct order
            if (outcomes.length >= 2) {
                const firstOutcome = (outcomes[0] || '').toLowerCase();
                if (firstOutcome === 'down' || firstOutcome === 'no') {
                    [assetUp, assetDown] = [assetDown, assetUp];
                }
            }

            const marketName = market.question || event.title || slug;

            // For 15-min markets, update endDate if needed but don't remove markets here
            // Market removal is handled by cleanup logic in displayStats()
            if (is15Min) {
                const existingMarket = this.markets.get(marketKey);
                if (existingMarket && existingMarket.marketSlug === slug) {
                    // Same slug - update endDate to ensure it's correct
                    // Recalculate endDate from slug to fix any timing issues
                    const tsMatch = slug.match(/updown-15m-(\d+)/);
                    if (tsMatch) {
                        const startTime = parseInt(tsMatch[1], 10) * 1000;
                        const correctEndDate = startTime + (15 * 60 * 1000);
                        // Validate: 15-min markets should never have more than 15 minutes left
                        const timeLeft = correctEndDate - now;
                        if (timeLeft <= 16 * 60 * 1000) {
                            existingMarket.endDate = correctEndDate;
                        }
                    }
                    // Skip creating new market - keep existing one
                    continue;
                }
            }

            // Add new market (or update if exists)
            const existingMarket = this.markets.get(marketKey);
            
            // For 1-hour markets: check if we need to replace with new hour's market
            if (!is15Min && existingMarket) {
                // Only remove if market has ended AND it's a different slug (new hour)
                // Don't remove markets that are still active - let cleanup logic handle it
                if (existingMarket.marketSlug === slug && existingMarket.endDate && existingMarket.endDate > now) {
                    // Same 1-hour market, still active - just update endDate if needed
                    if (endDate && (!existingMarket.endDate || Math.abs(existingMarket.endDate - endDate) > 60000)) {
                        existingMarket.endDate = endDate;
                    }
                    this.discoveredSlugs.add(slug);
                    continue; // Skip creating new market - keep existing one
                }
                // If different slug or market has ended, let it be created/updated below
                // Market removal is handled by cleanup logic in displayStats()
            }
            
            if (!existingMarket || existingMarket.marketSlug !== slug) {
                // For 15-min markets, ensure endDate is calculated correctly from slug
                let finalEndDate = endDate;
                if (is15Min && slug) {
                    const tsMatch = slug.match(/updown-15m-(\d+)/);
                    if (tsMatch) {
                        const startTime = parseInt(tsMatch[1], 10) * 1000;
                        finalEndDate = startTime + (15 * 60 * 1000); // Always 15 minutes from start
                    }
                }
                
                const newMarket: MarketStats = {
                    marketKey,
                    marketName,
                    marketSlug: slug,
                    sharesUp: existingMarket?.sharesUp || 0,
                    sharesDown: existingMarket?.sharesDown || 0,
                    investedUp: existingMarket?.investedUp || 0,
                    investedDown: existingMarket?.investedDown || 0,
                    totalCostUp: existingMarket?.totalCostUp || 0,
                    totalCostDown: existingMarket?.totalCostDown || 0,
                    tradesUp: existingMarket?.tradesUp || 0,
                    tradesDown: existingMarket?.tradesDown || 0,
                    lastUpdate: now,
                    endDate: finalEndDate,
                    conditionId,
                    assetUp,
                    assetDown,
                    marketOpenTime: now,
                    category: marketKey,
                };

                this.markets.set(marketKey, newMarket);
                this.discoveredSlugs.add(slug);

                // Notify priceStreamLogger that a new market window has started
                const isBTC = marketKey.includes('BTC');
                const type: 'BTC' | 'ETH' = isBTC ? 'BTC' : 'ETH';
                const timeframe: '15m' | '1h' = is15Min ? '15m' : '1h';

                // Extract window start timestamp
                let windowStart = 0;
                if (is15Min) {
                    // 15-min markets: extract from slug (e.g., btc-updown-15m-1735545600)
                    const match = slug.match(/updown-15m-(\d+)/);
                    if (match) windowStart = parseInt(match[1], 10);
                } else {
                    // Hourly markets: calculate from endDate (endDate - 1 hour = start)
                    // Hourly slugs are like "btc-6am-et-up-down" without timestamp
                    if (endDate) {
                        windowStart = Math.floor(endDate / 1000) - 3600; // endDate in ms, subtract 1 hour
                    }
                }

                if (windowStart > 0) {
                    priceStreamLogger.notifyNewMarketWindow(type, timeframe, windowStart);
                }

                // Force display update
                this.lastDisplayTime = 0;
            }
        }

        // Sync BOTH current AND next markets from priceStreamLogger
        // This allows showing 8 markets on dashboard (4 current + 4 next)
        // Next markets are loaded 10 seconds before current markets end
        const currentMarkets = priceStreamLogger.getCurrentMarkets();
        const nextMarkets = priceStreamLogger.getNextMarkets();
        
        // Helper function to sync markets from priceStreamLogger
        const syncMarketsFromPriceStream = (marketsMap: Map<string, any>, isNext: boolean) => {
            for (const [marketType, info] of marketsMap.entries()) {
                const is15MinType = marketType.includes('15m');
                const is1HourType = marketType.includes('up-or-down') && !marketType.includes('15m');
                if (!is15MinType && !is1HourType) continue;

                const isBTCType = marketType.includes('btc') || marketType.includes('bitcoin');

                // Build dashboard marketKey
                let marketKey: string | null = null;
                if (is15MinType) {
                    // Extract timestamp from slug to create unique key matching extractMarketKey()
                    const slug = (info.slug || '').toLowerCase();
                    const tsMatch = slug.match(/updown-15m-(\d+)/);
                    const timestamp = tsMatch ? tsMatch[1] : '';
                    const baseKey = isBTCType ? 'BTC-UpDown-15' : 'ETH-UpDown-15';
                    marketKey = timestamp ? `${baseKey}-${timestamp}` : baseKey;
                } else if (is1HourType) {
                    // Extract hour number from question or slug (e.g., ", 2PM ET" or "-2pm-et")
                    const question = info.question || '';
                    const slug = (info.slug || '').toLowerCase();
                    let hourNum = '0';

                    const questionMatch = question.match(/,\s*(\d{1,2})\s*(AM|PM)\s*ET/i);
                    const slugMatch = slug.match(/-(\d{1,2})(am|pm)-et$/i);
                    if (questionMatch) {
                        hourNum = questionMatch[1];
                    } else if (slugMatch) {
                        hourNum = slugMatch[1];
                    }

                    marketKey = isBTCType ? `BTC-UpDown-1h-${hourNum}` : `ETH-UpDown-1h-${hourNum}`;
                }

                if (!marketKey) continue;

                // Determine UP/DOWN asset IDs from tokens
                let assetUp = '';
                let assetDown = '';
                if (info.tokens && info.tokens.length >= 2) {
                    const upToken =
                        info.tokens.find((t: any) => t.outcome && t.outcome.toUpperCase().includes('UP')) ||
                        info.tokens[0];
                    const downToken =
                        info.tokens.find((t: any) => t.outcome && t.outcome.toUpperCase().includes('DOWN')) ||
                        info.tokens[1];

                    assetUp = upToken.token_id;
                    assetDown = downToken.token_id;
                }

                const endDateMs = info.end_date_iso ? new Date(info.end_date_iso).getTime() : undefined;

                // Create or update market - mark as synced from nextMarkets if isNext=true
                const existingMarket = this.markets.get(marketKey);
                this.ensureMarketWithAssets(
                    marketKey,
                    info.question || info.slug || marketKey,
                    info.slug || '',
                    info.condition_id,
                    assetUp,
                    assetDown,
                    endDateMs
                );
                // Store that this market came from nextMarkets for upcoming classification
                if (isNext && existingMarket) {
                    // Market was updated - we'll rely on matching logic
                } else if (isNext) {
                    // New market from nextMarkets - store a marker (we'll use conditionId/asset matching)
                    logger.debug(`[MARKET-TRACKER] Created market ${marketKey} from nextMarkets (isNext=true)`);
                }
            }
        };

        // Sync current markets (always)
        syncMarketsFromPriceStream(currentMarkets, false);
        
        // Also sync next markets (for 8-market display and early trading)
        // CRITICAL: Always sync next markets to ensure upcoming markets stay on dashboard
        if (nextMarkets.size > 0) {
            logger.info(`[MARKET-TRACKER] Syncing ${nextMarkets.size} next market(s) from priceStreamLogger for upcoming markets display`);
            const marketsBeforeSync = this.markets.size;
            syncMarketsFromPriceStream(nextMarkets, true);
            const marketsAfterSync = this.markets.size;
            logger.info(`[MARKET-TRACKER] Finished syncing next markets. Markets count: ${marketsBeforeSync} -> ${marketsAfterSync} (added ${marketsAfterSync - marketsBeforeSync})`);
            // Log all markets in nextMarkets for debugging
            for (const [marketType, info] of nextMarkets.entries()) {
                logger.info(`[MARKET-TRACKER] NextMarket [${marketType}]: conditionId=${info.condition_id}, slug=${info.slug}, question=${info.question?.substring(0, 60) || 'N/A'}`);
            }
        } else {
            logger.info(`[MARKET-TRACKER] No next markets to sync (nextMarkets.size=0)`);
        }

        // Clean up old slugs from discoveredSlugs - be aggressive for 1-hour markets
        // Remove 1-hour slugs that don't match the current or next hour
        const currentHourPattern = new RegExp(`-${hour}${ampm}-et$`, 'i');
        const nextHourPattern = new RegExp(`-${nextHour}${nextAmpm}-et$`, 'i');

        for (const cachedSlug of this.discoveredSlugs) {
            // Check if it's a 1-hour slug (contains 'up-or-down' but not '15m')
            if (cachedSlug.includes('up-or-down') && !cachedSlug.includes('15m')) {
                // Keep only current and next hour slugs
                if (!currentHourPattern.test(cachedSlug) && !nextHourPattern.test(cachedSlug)) {
                    this.discoveredSlugs.delete(cachedSlug);
                }
            }
        }

        // Also clean up if too many slugs (prevent memory leak)
        if (this.discoveredSlugs.size > 50) {
            const oldSlugs = Array.from(this.discoveredSlugs).slice(0, 30);
            for (const s of oldSlugs) {
                this.discoveredSlugs.delete(s);
            }
        }
    }

    /**
     * Clear all stats
     */
    clear(): void {
        this.markets.clear();
    }
}

const marketTrackerInstance = new MarketTracker();
export default marketTrackerInstance;
export type MarketTrackerInstance = MarketTracker;
