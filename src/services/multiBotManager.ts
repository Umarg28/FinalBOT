/**
 * Multi-Bot Manager
 * Manages multiple bot instances, each with its own config, paper trader, and PnL tracking
 */

import { BotConfig, loadAllBotConfigs } from "../config/multiConfigLoader";
import { RebalanceConfig } from "../config/rebalanceConfig";
import { PaperTrader } from "./paperTrader";
import { MarketDataService } from "./marketData";
import logger from "../utils/logger";
import { ENV } from "../config/env";
import * as fs from "fs";
import * as path from "path";

export interface BotInstance {
  botId: string;
  botName: string;
  config: RebalanceConfig;
  configPath: string;
  paperTrader: PaperTrader;
  startTime: number;
  // Per-bot state for strategy
  lastTradeTime: Map<string, number>; // marketKey -> timestamp
  lastPrices: Map<string, { up: number; down: number }>; // marketKey -> prices
}

export class MultiBotManager {
  private bots: Map<string, BotInstance> = new Map();
  private marketData: MarketDataService;
  private configWatchers: Map<string, fs.FSWatcher> = new Map();

  constructor(marketData: MarketDataService) {
    this.marketData = marketData;
  }

  /**
   * Initialize all bots from config files
   */
  async initialize(): Promise<void> {
    const botConfigs = loadAllBotConfigs();

    for (const botConfig of botConfigs) {
      await this.addBot(botConfig);
    }

    logger.info(`[MULTI-BOT] Initialized ${this.bots.size} bot(s)`);

    // Start watching config files for hot-reload
    this.startConfigWatchers();
  }

  /**
   * Add a new bot instance
   */
  private async addBot(botConfig: BotConfig): Promise<void> {
    const { botId, botName, config, configPath } = botConfig;

    // Create separate paper trader for this bot
    // Use bot-specific starting balance from config or default
    const startingBalance = config.bankroll_total || ENV.PAPER_BALANCE;

    // Create paper trader with bot-specific directory
    const paperTrader = new PaperTrader(this.marketData, startingBalance);

    const instance: BotInstance = {
      botId,
      botName,
      config,
      configPath,
      paperTrader,
      startTime: Date.now(),
      lastTradeTime: new Map(),
      lastPrices: new Map(),
    };

    this.bots.set(botId, instance);
    logger.info(`[MULTI-BOT] Added bot: ${botName} (${botId}) with $${startingBalance} balance`);
  }

  /**
   * Get all bot instances
   */
  getBots(): Map<string, BotInstance> {
    return this.bots;
  }

  /**
   * Get a specific bot by ID
   */
  getBot(botId: string): BotInstance | undefined {
    return this.bots.get(botId);
  }

  /**
   * Get bot IDs
   */
  getBotIds(): string[] {
    return Array.from(this.bots.keys());
  }

  /**
   * Get all bot summaries for dashboard
   */
  getAllBotSummaries(): Array<{
    botId: string;
    botName: string;
    balance: number;
    startingBalance: number;
    totalPnL: number;
    totalPnLPercent: number;
    totalTrades: number;
    pnlHistory: any[];
  }> {
    const summaries = [];

    for (const [botId, bot] of this.bots) {
      const pnlHistory = bot.paperTrader.getPnLHistory();
      const balance = bot.paperTrader.getBalance();
      const startingBalance = bot.paperTrader.getStartingBalance();
      const totalPnL = balance - startingBalance;
      const totalPnLPercent = startingBalance > 0 ? (totalPnL / startingBalance) * 100 : 0;

      summaries.push({
        botId,
        botName: bot.botName,
        balance,
        startingBalance,
        totalPnL,
        totalPnLPercent,
        totalTrades: pnlHistory.length,
        pnlHistory,
      });
    }

    return summaries;
  }

  /**
   * Start watching config files for hot-reload
   */
  private startConfigWatchers(): void {
    for (const [botId, bot] of this.bots) {
      if (!bot.configPath) continue;

      try {
        let debounceTimer: NodeJS.Timeout | null = null;

        const watcher = fs.watch(bot.configPath, (eventType) => {
          if (eventType === "change") {
            if (debounceTimer) clearTimeout(debounceTimer);

            debounceTimer = setTimeout(() => {
              this.reloadBotConfig(botId);
            }, 100);
          }
        });

        this.configWatchers.set(botId, watcher);
        logger.info(`[MULTI-BOT] Watching config for ${botId}: ${bot.configPath}`);
      } catch (error) {
        logger.error(`[MULTI-BOT] Failed to watch config for ${botId}: ${error}`);
      }
    }
  }

  /**
   * Reload a specific bot's config
   */
  private reloadBotConfig(botId: string): void {
    const bot = this.bots.get(botId);
    if (!bot || !bot.configPath) return;

    try {
      const yaml = require("js-yaml");
      const fileContents = fs.readFileSync(bot.configPath, "utf8");
      const newConfig = yaml.load(fileContents) as Partial<RebalanceConfig>;

      // Merge with existing config
      bot.config = { ...bot.config, ...newConfig };

      logger.info(`[MULTI-BOT] Hot-reloaded config for ${botId}`);
      logger.info(`  bankroll_total: $${bot.config.bankroll_total}`);
      logger.info(`  tilt_threshold: ${bot.config.tilt_threshold}`);
    } catch (error) {
      logger.error(`[MULTI-BOT] Failed to reload config for ${botId}: ${error}`);
    }
  }

  /**
   * Stop all config watchers
   */
  stopConfigWatchers(): void {
    for (const [botId, watcher] of this.configWatchers) {
      watcher.close();
      logger.info(`[MULTI-BOT] Stopped watching config for ${botId}`);
    }
    this.configWatchers.clear();
  }

  /**
   * Get aggregated data for external webapp
   * Returns array of bot data, each formatted for the webapp
   */
  getWebappData(): Array<{
    botId: string;
    botName: string;
    portfolio: {
      balance: number;
      totalPnL: number;
      totalPnLPercent: number;
      totalTrades: number;
      startingBalance: number;
    };
    pnlHistory: any[];
    config: RebalanceConfig;
  }> {
    const data = [];

    for (const [botId, bot] of this.bots) {
      const pnlHistory = bot.paperTrader.getPnLHistory();
      const balance = bot.paperTrader.getBalance();
      const startingBalance = bot.paperTrader.getStartingBalance();
      const totalPnL = balance - startingBalance;
      const totalPnLPercent = startingBalance > 0 ? (totalPnL / startingBalance) * 100 : 0;

      data.push({
        botId,
        botName: bot.botName,
        portfolio: {
          balance,
          totalPnL,
          totalPnLPercent,
          totalTrades: pnlHistory.length,
          startingBalance,
        },
        pnlHistory,
        config: bot.config,
      });
    }

    return data;
  }
}

// Singleton instance
let multiBotManager: MultiBotManager | null = null;

export function getMultiBotManager(): MultiBotManager | null {
  return multiBotManager;
}

export function initMultiBotManager(marketData: MarketDataService): MultiBotManager {
  multiBotManager = new MultiBotManager(marketData);
  return multiBotManager;
}
