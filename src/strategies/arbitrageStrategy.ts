/**
 * Example Arbitrage Strategy using poly-sdk enhanced features
 * 
 * This strategy detects arbitrage opportunities and generates trade signals.
 * 
 * NOTE: This is an example strategy. Modify it based on your risk management
 * and capital allocation preferences.
 */

import { BaseStrategy } from "./baseStrategy";
import { StrategyResult, Market, TradeSignal } from "../interfaces";
import { EnhancedMarketDataService } from "../services/enhancedMarketData";
import { detectArbitrage, logArbitrageOpportunity, validatePrices } from "../utils/arbitrageUtils";
import logger from "../utils/logger";

interface ArbitrageStrategyConfig {
  minProfitPercent: number; // Minimum profit % to trigger (default: 0.5%)
  maxTradeSize: number; // Maximum trade size per opportunity (default: 100)
  minTradeSize: number; // Minimum trade size (default: 5)
  enabled: boolean;
}

export class ArbitrageStrategy extends BaseStrategy {
  private arbConfig: ArbitrageStrategyConfig;
  private monitoredMarkets: Set<string> = new Set();

  constructor(config: any, marketData: EnhancedMarketDataService) {
    super(config, marketData);
    
    this.arbConfig = {
      minProfitPercent: (config.parameters?.minProfitPercent as number) || 0.5,
      maxTradeSize: (config.parameters?.maxTradeSize as number) || 100,
      minTradeSize: (config.parameters?.minTradeSize as number) || 5,
      enabled: config.enabled !== false,
    };
  }

  async analyze(): Promise<StrategyResult> {
    const signals: TradeSignal[] = [];

    if (!this.arbConfig.enabled) {
      return { signals };
    }

    // Check if we have enhanced market data service
    if (!(this.marketData instanceof EnhancedMarketDataService)) {
      this.log("Enhanced market data service not available - skipping arbitrage detection");
      return { signals };
    }

    // Get active markets
    const markets = await this.marketData.getMarkets(50, true);

    for (const market of markets) {
      if (!market.conditionId || !market.active) {
        continue;
      }

      try {
        // Use enhanced service to detect arbitrage
        const arb = await this.marketData.detectArbitrage(
          market.conditionId,
          this.arbConfig.minProfitPercent
        );

        if (arb) {
          this.log(`Arbitrage found: ${market.question}`);
          logArbitrageOpportunity(market.conditionId, market.question, {
            exists: true,
            type: arb.type,
            profit: arb.profit,
            profitPercent: arb.profit * 100,
            action: arb.action,
            effectivePrices: {
              effectiveBuyYes: 0,
              effectiveBuyNo: 0,
              effectiveSellYes: 0,
              effectiveSellNo: 0,
            },
          });

          // Generate signals based on arbitrage type
          const arbSignals = this.generateArbitrageSignals(market, arb);
          signals.push(...arbSignals);

          this.monitoredMarkets.add(market.conditionId);
        }
      } catch (error) {
        logger.debug(`Error detecting arbitrage for ${market.conditionId}:`, error);
      }
    }

    return { signals };
  }

  /**
   * Generate trade signals based on arbitrage opportunity
   */
  private generateArbitrageSignals(
    market: Market,
    arb: { type: "long" | "short"; profit: number; action: string }
  ): TradeSignal[] {
    const signals: TradeSignal[] = [];

    // Only proceed if we have enough balance
    if (this.balance < this.arbConfig.minTradeSize) {
      return signals;
    }

    // Calculate trade size based on profit and available balance
    const profitMultiplier = Math.min(arb.profit * 100, 5); // Cap at 5x
    const tradeSize = Math.min(
      this.arbConfig.maxTradeSize,
      Math.max(this.arbConfig.minTradeSize, this.balance * 0.1 * profitMultiplier)
    );

    // Get orderbook for accurate prices
    if (this.marketData instanceof EnhancedMarketDataService) {
      this.marketData
        .getProcessedOrderbook(market.conditionId)
        .then((orderbook: any) => {
          if (!orderbook) {
            return;
          }

          // Get tokens from orderbook or market structure
          const yesToken = (orderbook.yesToken || orderbook.tokens?.find((t: any) => 
            t.outcome === "Yes" || t.outcome === "Up"
          ));
          const noToken = (orderbook.noToken || orderbook.tokens?.find((t: any) => 
            t.outcome === "No" || t.outcome === "Down"
          ));

          if (!yesToken || !noToken) {
            return;
          }

          if (arb.type === "long") {
            // Long arbitrage: Buy YES + Buy NO, then merge
            // Buy YES
            const yesAsk = (orderbook.yesToken?.asks?.[0]?.price || 
                           orderbook.asks?.yes?.[0]?.price || 0.5);
            if (yesAsk > 0 && yesAsk < 1) {
              const yesTokenId = yesToken.tokenId || yesToken.token_id || '';
              if (yesTokenId) {
                signals.push(
                  this.createBuySignal(
                    market,
                    yesTokenId,
                    yesAsk,
                    tradeSize / yesAsk,
                    {
                      arbitrage: true,
                      arbType: "long",
                      arbProfit: arb.profit,
                      outcome: yesToken.outcome || "Yes",
                    }
                  )
                );
              }
            }

            // Buy NO
            const noAsk = (orderbook.noToken?.asks?.[0]?.price || 
                          orderbook.asks?.no?.[0]?.price || 0.5);
            if (noAsk > 0 && noAsk < 1) {
              const noTokenId = noToken.tokenId || noToken.token_id || '';
              if (noTokenId) {
                signals.push(
                  this.createBuySignal(
                    market,
                    noTokenId,
                    noAsk,
                    tradeSize / noAsk,
                    {
                      arbitrage: true,
                      arbType: "long",
                      arbProfit: arb.profit,
                      outcome: noToken.outcome || "No",
                    }
                  )
                );
              }
            }
          } else if (arb.type === "short") {
            // Short arbitrage: Split $1 into YES + NO, then sell both
            // NOTE: Short arbitrage requires on-chain CTF operations
            // This is a simplified example - you'd need to handle the split/merge
            this.log(
              `Short arbitrage requires CTF operations - not implemented in this example`
            );
          }
        })
        .catch((error: any) => {
          logger.debug(`Error getting orderbook for arbitrage:`, error);
        });
    }

    return signals;
  }
}

export default ArbitrageStrategy;
