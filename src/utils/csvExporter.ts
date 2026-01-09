/**
 * Enhanced CSV Exporter matching poly-sdk standards
 * 
 * Provides comprehensive CSV export functionality for:
 * - Trade history
 * - PnL reports
 * - Portfolio analytics
 * - Market-level statistics
 */

import * as fs from 'fs';
import * as path from 'path';
import { Position, TradeHistory } from '../interfaces';
import { PnLCalculator, PortfolioPnL, MarketPnL } from './pnlCalculator';
import { getRunId } from './runId';
import logger from './logger';

export interface CSVExportOptions {
  includeHeaders?: boolean;
  append?: boolean;
  delimiter?: string;
}

export class CSVExporter {
  private baseDir: string;
  private runId: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir || path.join(process.cwd(), 'logs');
    this.runId = getRunId();
    this.ensureDirectory();
  }

  private ensureDirectory(): void {
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  /**
   * Export comprehensive PnL report (matches poly-sdk format)
   */
  async exportPnLReport(
    portfolio: PortfolioPnL,
    filename?: string,
    options: CSVExportOptions = {}
  ): Promise<string> {
    const opts = {
      includeHeaders: true,
      append: false,
      delimiter: ',',
      ...options,
    };

    const filepath = path.join(
      this.baseDir,
      filename || `PnL_Report_${this.runId}.csv`
    );

    const rows: string[] = [];

    // Headers
    if (opts.includeHeaders && !opts.append) {
      rows.push([
        'Timestamp',
        'Date',
        'Market',
        'Condition ID',
        'Position Type',
        'Shares',
        'Avg Cost',
        'Current Price',
        'Cost Basis',
        'Current Value',
        'Unrealized PnL',
        'Unrealized PnL %',
        'Realized PnL',
        'Total PnL',
        'Total PnL %',
      ].join(opts.delimiter));
    }

    // Portfolio summary row
    const now = new Date();
    const summaryRow = [
      now.getTime(),
      now.toISOString(),
      'PORTFOLIO SUMMARY',
      '',
      'ALL',
      '',
      '',
      '',
      portfolio.totalCostBasis.toFixed(4),
      portfolio.totalCurrentValue.toFixed(4),
      portfolio.totalUnrealizedPnL.toFixed(4),
      portfolio.totalCostBasis > 0 
        ? ((portfolio.totalUnrealizedPnL / portfolio.totalCostBasis) * 100).toFixed(2)
        : '0.00',
      portfolio.totalRealizedPnL.toFixed(4),
      portfolio.totalPnL.toFixed(4),
        portfolio.totalPnLPercent.toFixed(2),
    ].join(opts.delimiter);
    rows.push(summaryRow);

    // Market-level rows
    for (const market of portfolio.markets.values()) {
      const marketRow = [
        now.getTime(),
        now.toISOString(),
        `"${market.marketName.replace(/"/g, '""')}"`,
        market.conditionId,
        'MARKET TOTAL',
        market.positions.reduce((sum, p) => sum + p.position.size, 0).toFixed(4),
        '',
        '',
        market.totalCostBasis.toFixed(4),
        market.totalCurrentValue.toFixed(4),
        market.totalUnrealizedPnL.toFixed(4),
        market.totalCostBasis > 0
          ? ((market.totalUnrealizedPnL / market.totalCostBasis) * 100).toFixed(2)
          : '0.00',
        market.totalRealizedPnL.toFixed(4),
        market.totalPnL.toFixed(4),
        market.totalPnLPercent.toFixed(2),
      ].join(opts.delimiter);
      rows.push(marketRow);

      // Individual position rows
      for (const posPnL of market.positions) {
        const posRow = [
          now.getTime(),
          now.toISOString(),
          `"${market.marketName.replace(/"/g, '""')}"`,
          market.conditionId,
          posPnL.position.outcome || 'Unknown',
          posPnL.position.size.toFixed(4),
          posPnL.position.avgPrice.toFixed(6),
          (posPnL.position.currentPrice || posPnL.position.avgPrice).toFixed(6),
          posPnL.costBasis.toFixed(4),
          posPnL.currentValue.toFixed(4),
          posPnL.unrealizedPnL.toFixed(4),
          posPnL.unrealizedPnLPercent.toFixed(2),
          '0.00', // Realized PnL is at market level
          posPnL.unrealizedPnL.toFixed(4),
        posPnL.unrealizedPnLPercent.toFixed(2),
        ].join(opts.delimiter);
        rows.push(posRow);
      }
    }

    // Write to file
    const content = rows.join('\n') + (opts.append ? '' : '\n');
    if (opts.append) {
      fs.appendFileSync(filepath, content, 'utf8');
    } else {
      fs.writeFileSync(filepath, content, 'utf8');
    }

    logger.info(`PnL report exported to: ${filepath}`);
    return filepath;
  }

  /**
   * Export trade history (enhanced format)
   */
  async exportTradeHistory(
    trades: TradeHistory[],
    filename?: string,
    options: CSVExportOptions = {}
  ): Promise<string> {
    const opts = {
      includeHeaders: true,
      append: false,
      delimiter: ',',
      ...options,
    };

    const filepath = path.join(
      this.baseDir,
      filename || `Trade_History_${this.runId}.csv`
    );

    const rows: string[] = [];

    // Headers
    if (opts.includeHeaders && !opts.append) {
      rows.push([
        'Timestamp',
        'Date',
        'Time',
        'Trade ID',
        'Condition ID',
        'Token ID',
        'Side',
        'Price',
        'Size',
        'Shares',
        'USDC Value',
        'Cost Basis',
        'Net Proceeds',
        'Strategy',
        'Paper Trade',
        'Transaction Hash',
      ].join(opts.delimiter));
    }

    // Trade rows
    for (const trade of trades) {
      const timestamp = new Date(trade.timestamp);
      // Cost basis excludes fees to match Polymarket API PnL calculation
      // Fees removed - cost basis and proceeds are the same as usdcSize
      const costBasis = trade.side === 'BUY' ? trade.usdcSize : 0;
      const netProceeds = trade.side === 'SELL' ? trade.usdcSize : 0;

      const row = [
        timestamp.getTime(),
        timestamp.toISOString().split('T')[0],
        timestamp.toTimeString().split(' ')[0],
        trade.marketId,
        trade.conditionId,
        trade.tokenId,
        trade.side,
        trade.price.toFixed(6),
        trade.size.toFixed(4),
        trade.size.toFixed(4),
        trade.usdcSize.toFixed(4),
        costBasis.toFixed(4),
        netProceeds.toFixed(4),
        trade.strategyName,
        trade.paperTrade ? 'Yes' : 'No',
        trade.transactionHash || '',
      ].join(opts.delimiter);
      rows.push(row);
    }

    // Write to file
    const content = rows.join('\n') + '\n';
    if (opts.append) {
      fs.appendFileSync(filepath, content, 'utf8');
    } else {
      fs.writeFileSync(filepath, content, 'utf8');
    }

    logger.info(`Trade history exported to: ${filepath}`);
    return filepath;
  }

  /**
   * Export market PnL snapshot (enhanced format matching poly-sdk)
   */
  async exportMarketPnLSnapshot(
    marketPnL: MarketPnL,
    finalPrices?: { priceUp: number; priceDown: number },
    filename?: string,
    options: CSVExportOptions = {}
  ): Promise<string> {
    const opts = {
      includeHeaders: true,
      append: true, // Usually append for market snapshots
      delimiter: ',',
      ...options,
    };

    const paperDir = path.join(this.baseDir, 'paper');
    if (!fs.existsSync(paperDir)) {
      fs.mkdirSync(paperDir, { recursive: true });
    }

    const filepath = path.join(
      paperDir,
      filename || `Market_PNL_${this.runId}.csv`
    );

    const rows: string[] = [];

    // Headers (only if new file)
    if (opts.includeHeaders && !fs.existsSync(filepath)) {
      rows.push([
        'Timestamp',
        'Date',
        'Year',
        'Month',
        'Day',
        'Hour',
        'Minute',
        'Second',
        'Millisecond',
        'Market Name',
        'Condition ID',
        'Market Slug',
        'Outcome',
        'Total Invested',
        'Cost Basis',
        'Shares Up',
        'Shares Down',
        'Avg Cost Up',
        'Avg Cost Down',
        'Final Price Up',
        'Final Price Down',
        'Current Value',
        'Realized PnL',
        'Unrealized PnL',
        'Total PnL',
        'PnL %',
        'Trades Up',
        'Trades Down',
        'Switch Reason',
      ].join(opts.delimiter));
    }

    // Calculate aggregated values
    const upPositions = marketPnL.positions.filter(p => 
      p.position.outcome?.toLowerCase() === 'up' || p.position.outcome?.toLowerCase() === 'yes'
    );
    const downPositions = marketPnL.positions.filter(p => 
      p.position.outcome?.toLowerCase() === 'down' || p.position.outcome?.toLowerCase() === 'no'
    );

    const sharesUp = upPositions.reduce((sum, p) => sum + p.position.size, 0);
    const sharesDown = downPositions.reduce((sum, p) => sum + p.position.size, 0);
    const costBasisUp = upPositions.reduce((sum, p) => sum + p.costBasis, 0);
    const costBasisDown = downPositions.reduce((sum, p) => sum + p.costBasis, 0);
    const avgCostUp = sharesUp > 0 ? costBasisUp / sharesUp : 0;
    const avgCostDown = sharesDown > 0 ? costBasisDown / sharesDown : 0;

    const finalPriceUp = finalPrices?.priceUp || 
      (upPositions.length > 0 ? upPositions[0].position.currentPrice || upPositions[0].position.avgPrice : 0);
    const finalPriceDown = finalPrices?.priceDown || 
      (downPositions.length > 0 ? downPositions[0].position.currentPrice || downPositions[0].position.avgPrice : 0);

    const currentValueUp = sharesUp * finalPriceUp;
    const currentValueDown = sharesDown * finalPriceDown;
    const totalCurrentValue = currentValueUp + currentValueDown;

    const unrealizedPnLUp = currentValueUp - costBasisUp;
    const unrealizedPnLDown = currentValueDown - costBasisDown;

    const totalInvested = marketPnL.totalCostBasis;
    const totalPnL = marketPnL.totalPnL;

    // Determine outcome: the side with the higher price wins
    // When market closes, winning side = $1.00, losing side = $0.00
    let outcome = 'Unknown';
    if (finalPriceUp >= 0.99 || finalPriceDown <= 0.01) {
      outcome = 'UP Won';
    } else if (finalPriceDown >= 0.99 || finalPriceUp <= 0.01) {
      outcome = 'DOWN Won';
    } else if (finalPriceUp > 0 || finalPriceDown > 0) {
      // Determine winner from which side has higher price
      if (finalPriceUp > finalPriceDown) {
        outcome = 'UP Won';
      } else if (finalPriceDown > finalPriceUp) {
        outcome = 'DOWN Won';
      }
    }

    const now = new Date();
    const timestamp = now.getTime();
    const date = now.toISOString();

    const row = [
      timestamp,
      date,
      now.getFullYear(),
      now.getMonth() + 1,
      now.getDate(),
      now.getHours(),
      now.getMinutes(),
      now.getSeconds(),
      now.getMilliseconds(),
      `"${marketPnL.marketName.replace(/"/g, '""')}"`,
      marketPnL.conditionId,
      '', // Market slug - would need to be passed
      outcome,
      totalInvested.toFixed(4),
      marketPnL.totalCostBasis.toFixed(4),
      sharesUp.toFixed(4),
      sharesDown.toFixed(4),
      avgCostUp > 0 ? avgCostUp.toFixed(6) : '',
      avgCostDown > 0 ? avgCostDown.toFixed(6) : '',
      finalPriceUp.toFixed(6),
      finalPriceDown.toFixed(6),
      totalCurrentValue.toFixed(4),
      marketPnL.totalRealizedPnL.toFixed(4),
      marketPnL.totalUnrealizedPnL.toFixed(4),
      totalPnL.toFixed(4),
        marketPnL.totalPnLPercent.toFixed(2),
        upPositions.length,
      downPositions.length,
      'Market Closed',
    ].join(opts.delimiter);

    rows.push(row);

    // Write to file
    const content = rows.join('\n') + '\n';
    fs.appendFileSync(filepath, content, 'utf8');

    logger.info(`Market PnL snapshot exported to: ${filepath}`);
    return filepath;
  }
}

export default CSVExporter;
