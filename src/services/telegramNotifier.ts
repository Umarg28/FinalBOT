/**
 * Telegram Notifier Service
 * Sends critical alerts to Telegram for market connection issues and errors
 */

import https from 'https';
import logger from '../utils/logger';

// Telegram Bot Configuration
const TELEGRAM_CONFIG = {
  BOT_TOKEN: '8392038727:AAEDlzrQ8E1FPY6uh-cu8OEsayTtZQQTE9w',
  ADMIN_CHAT_ID: '7914196017',
};

// Rate limiting to avoid spam.
//  - MIN_INTERVAL_MS: throttle per message kind (type+title+market)
//  - GLOBAL_MIN_INTERVAL_MS: hard cap on how often ANY telegram alert is sent,
//    so many distinct per-market alerts can't collectively spam the chat.
// All tunable via env so you can quiet things down without code changes.
const RATE_LIMIT = {
  MIN_INTERVAL_MS: Number(process.env.TELEGRAM_MIN_INTERVAL_MS) || 15 * 60 * 1000, // 15 min per kind
  GLOBAL_MIN_INTERVAL_MS: Number(process.env.TELEGRAM_GLOBAL_MIN_INTERVAL_MS) || 5 * 60 * 1000, // 5 min between any alerts
  lastSentTimes: new Map<string, number>(),
  lastGlobalSent: 0,
};

// Master switches. Default: alerts on, but noisy "warning"-level alerts off
// (price delays, market skips, missing markets) since those fire constantly
// during normal operation. Set TELEGRAM_WARNINGS_ENABLED=true to re-enable.
const ALERTS_ENABLED = (process.env.TELEGRAM_ALERTS_ENABLED ?? 'true').toLowerCase() === 'true';
const WARNINGS_ENABLED = (process.env.TELEGRAM_WARNINGS_ENABLED ?? 'false').toLowerCase() === 'true';

export type AlertType = 'error' | 'warning' | 'info';

interface TelegramMessage {
  type: AlertType;
  title: string;
  details: string;
  market?: string;
}

/**
 * Send a message to Telegram
 */
async function sendTelegramMessage(text: string): Promise<boolean> {
  return new Promise((resolve) => {
    const url = `https://api.telegram.org/bot${TELEGRAM_CONFIG.BOT_TOKEN}/sendMessage`;

    const data = JSON.stringify({
      chat_id: TELEGRAM_CONFIG.ADMIN_CHAT_ID,
      text: text,
      parse_mode: 'HTML',
    });

    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };

    const req = https.request(url, options, (res) => {
      if (res.statusCode === 200) {
        resolve(true);
      } else {
        logger.warn(`[TELEGRAM] Failed to send message: HTTP ${res.statusCode}`);
        resolve(false);
      }
    });

    req.on('error', (error) => {
      logger.warn(`[TELEGRAM] Error sending message: ${error.message}`);
      resolve(false);
    });

    req.write(data);
    req.end();
  });
}

/**
 * Format and send an alert to Telegram
 */
export async function sendAlert(message: TelegramMessage): Promise<boolean> {
  const now = Date.now();

  // Master kill-switch and noisy-warning suppression.
  if (!ALERTS_ENABLED) return false;
  if (message.type === 'warning' && !WARNINGS_ENABLED) {
    logger.debug(`[TELEGRAM] Warning suppressed (TELEGRAM_WARNINGS_ENABLED=false): ${message.title}`);
    return false;
  }

  // Per-kind throttle.
  const rateKey = `${message.type}:${message.title}:${message.market || 'global'}`;
  const lastSent = RATE_LIMIT.lastSentTimes.get(rateKey) || 0;
  if (now - lastSent < RATE_LIMIT.MIN_INTERVAL_MS) {
    logger.debug(`[TELEGRAM] Rate limited (per-kind): ${rateKey}`);
    return false;
  }

  // Global throttle so many distinct per-market alerts can't collectively spam.
  if (now - RATE_LIMIT.lastGlobalSent < RATE_LIMIT.GLOBAL_MIN_INTERVAL_MS) {
    logger.debug(`[TELEGRAM] Rate limited (global): ${rateKey}`);
    return false;
  }

  RATE_LIMIT.lastSentTimes.set(rateKey, now);
  RATE_LIMIT.lastGlobalSent = now;

  // Format message with emoji based on type
  const emoji = message.type === 'error' ? '🚨' : message.type === 'warning' ? '⚠️' : 'ℹ️';
  const typeLabel = message.type.toUpperCase();

  let text = `${emoji} <b>BETABOT ${typeLabel}</b>\n\n`;
  text += `<b>${message.title}</b>\n`;

  if (message.market) {
    text += `\n📊 <b>Market:</b> ${message.market}\n`;
  }

  text += `\n${message.details}\n`;
  text += `\n⏰ ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET`;

  return sendTelegramMessage(text);
}

/**
 * Send market connection error alert
 */
export async function alertMarketConnectionError(market: string, error: string, delaySeconds?: number): Promise<boolean> {
  let details = `Connection issue detected.\n\n`;
  details += `❌ Error: ${error}`;

  if (delaySeconds !== undefined) {
    details += `\n⏱️ Delay: ${delaySeconds.toFixed(1)}s`;
  }

  return sendAlert({
    type: 'error',
    title: 'Market Connection Failed',
    market,
    details,
  });
}

/**
 * Send market switch error alert
 */
export async function alertMarketSwitchError(fromMarket: string, toMarket: string, error: string): Promise<boolean> {
  const details = `Failed to switch markets.\n\n` +
    `📍 From: ${fromMarket}\n` +
    `📍 To: ${toMarket}\n` +
    `❌ Error: ${error}`;

  return sendAlert({
    type: 'error',
    title: 'Market Switch Failed',
    market: toMarket,
    details,
  });
}

/**
 * Send WebSocket disconnection alert
 */
export async function alertWebSocketDisconnected(code: number, reconnectAttempts: number): Promise<boolean> {
  const details = `WebSocket connection lost.\n\n` +
    `🔌 Close Code: ${code}\n` +
    `🔄 Reconnect Attempts: ${reconnectAttempts}\n\n` +
    `Bot is attempting to reconnect...`;

  return sendAlert({
    type: 'error',
    title: 'WebSocket Disconnected',
    details,
  });
}

/**
 * Send price delay warning
 */
export async function alertPriceDelay(market: string, delaySeconds: number): Promise<boolean> {
  const details = `Prices taking too long to arrive.\n\n` +
    `⏱️ Delay: ${delaySeconds.toFixed(1)} seconds\n\n` +
    `Trading may be delayed until prices are received.`;

  return sendAlert({
    type: 'warning',
    title: 'Price Connection Delayed',
    market,
    details,
  });
}

/**
 * Send no markets found alert
 */
export async function alertNoMarketsFound(): Promise<boolean> {
  const details = `No active markets discovered.\n\n` +
    `The bot cannot find any current Up/Down markets.\n` +
    `This may indicate an API issue or all markets have closed.`;

  return sendAlert({
    type: 'error',
    title: 'No Markets Available',
    details,
  });
}

/**
 * Send recovery notification (market reconnected)
 */
export async function alertRecovered(market: string): Promise<boolean> {
  const details = `Market connection has been restored.\n\n` +
    `✅ Trading can now resume normally.`;

  return sendAlert({
    type: 'info',
    title: 'Connection Recovered',
    market,
    details,
  });
}

/**
 * Send missing markets alert (some markets not found)
 */
export async function alertMissingMarkets(missingMarkets: string[], foundMarkets: string[]): Promise<boolean> {
  const details = `Some markets are not available.\n\n` +
    `❌ Missing: ${missingMarkets.join(', ')}\n` +
    `✅ Found: ${foundMarkets.length > 0 ? foundMarkets.join(', ') : 'None'}\n\n` +
    `Trading will continue on available markets.`;

  return sendAlert({
    type: 'warning',
    title: 'Markets Missing',
    details,
  });
}

/**
 * Send low balance alert
 */
export async function alertLowBalance(currentBalance: number, minRequired: number): Promise<boolean> {
  const details = `Account balance is too low to trade.\n\n` +
    `💰 Current: $${currentBalance.toFixed(2)}\n` +
    `📉 Minimum: $${minRequired.toFixed(2)}\n\n` +
    `Trading is paused until balance is restored.`;

  return sendAlert({
    type: 'warning',
    title: 'Low Balance',
    details,
  });
}

/**
 * Send trade execution error alert
 */
export async function alertTradeError(market: string, side: string, error: string): Promise<boolean> {
  const details = `Trade execution failed.\n\n` +
    `📊 Side: ${side}\n` +
    `❌ Error: ${error}`;

  return sendAlert({
    type: 'error',
    title: 'Trade Failed',
    market,
    details,
  });
}

/**
 * Send market skipped alert (waiting for prices too long)
 */
export async function alertMarketSkipped(market: string, reason: string): Promise<boolean> {
  const details = `Market is being skipped.\n\n` +
    `⏭️ Reason: ${reason}\n\n` +
    `Bot will retry on next cycle.`;

  return sendAlert({
    type: 'warning',
    title: 'Market Skipped',
    market,
    details,
  });
}

/**
 * Send strategy error alert
 */
export async function alertStrategyError(strategyName: string, error: string): Promise<boolean> {
  const details = `Strategy encountered an error.\n\n` +
    `📋 Strategy: ${strategyName}\n` +
    `❌ Error: ${error}`;

  return sendAlert({
    type: 'error',
    title: 'Strategy Error',
    details,
  });
}

export default {
  sendAlert,
  alertMarketConnectionError,
  alertMarketSwitchError,
  alertWebSocketDisconnected,
  alertPriceDelay,
  alertNoMarketsFound,
  alertRecovered,
  alertMissingMarkets,
  alertLowBalance,
  alertTradeError,
  alertMarketSkipped,
  alertStrategyError,
};
