import { ClobClient } from "@polymarket/clob-client";
import { fetchData } from "../utils/fetchData";
import { Market, OrderBook, UserPosition } from "../interfaces";
import logger from "../utils/logger";

const GAMMA_API_URL = "https://gamma-api.polymarket.com";
const DATA_API_URL = "https://data-api.polymarket.com";

export class MarketDataService {
  private clobClient: ClobClient;

  constructor(clobClient: ClobClient) {
    this.clobClient = clobClient;
  }

  async getMarkets(limit: number = 100, active: boolean = true): Promise<Market[]> {
    const startTime = Date.now();
    logger.debug(`[MARKET_DATA] getMarkets() called with limit: ${limit}, active: ${active}`);
    try {
      const url = `${GAMMA_API_URL}/markets?limit=${limit}&active=${active}`;
      logger.debug(`[MARKET_DATA] Fetching markets from URL: ${url}`);
      const fetchStartTime = Date.now();
      const markets = await fetchData<Market[]>(url);
      const fetchDuration = Date.now() - fetchStartTime;
      const totalDuration = Date.now() - startTime;
      logger.debug(`[MARKET_DATA] getMarkets() completed in ${totalDuration}ms (fetch: ${fetchDuration}ms), found ${markets.length} market(s)`);
      return markets;
    } catch (error) {
      const totalDuration = Date.now() - startTime;
      logger.error(`[MARKET_DATA] Failed to fetch markets after ${totalDuration}ms:`, error);
      logger.debug(`[MARKET_DATA] Error details: message=${error instanceof Error ? error.message : 'Unknown error'}, stack=${error instanceof Error ? error.stack : 'N/A'}`);
      return [];
    }
  }

  async getMarket(conditionId: string): Promise<Market | null> {
    const startTime = Date.now();
    logger.debug(`[MARKET_DATA] getMarket() called with conditionId: ${conditionId}`);
    try {
      const url = `${GAMMA_API_URL}/markets/${conditionId}`;
      logger.debug(`[MARKET_DATA] Fetching market from URL: ${url}`);
      const fetchStartTime = Date.now();
      const market = await fetchData<Market>(url);
      const fetchDuration = Date.now() - fetchStartTime;
      logger.debug(`[MARKET_DATA] Market fetch completed in ${fetchDuration}ms for conditionId: ${conditionId}`);
      
      // Validate market has required fields
      if (!market || !market.conditionId || !market.question) {
        logger.warn(`[MARKET_DATA] Market validation failed for conditionId ${conditionId}:`, {
          hasMarket: !!market,
          hasConditionId: !!market?.conditionId,
          hasQuestion: !!market?.question,
          marketData: market ? { conditionId: market.conditionId, question: market.question?.substring(0, 50) } : null
        });
        return null;
      }
      
      logger.debug(`[MARKET_DATA] Market fetched successfully: conditionId=${market.conditionId}, question=${market.question.substring(0, 50)}..., active=${market.active}, slug=${market.slug}`);
      const totalDuration = Date.now() - startTime;
      logger.debug(`[MARKET_DATA] getMarket() completed in ${totalDuration}ms for conditionId: ${conditionId}`);
      return market;
    } catch (error: any) {
      const totalDuration = Date.now() - startTime;
      // Don't log 422 errors (invalid IDs) as errors, just debug
      if (error?.response?.status === 422) {
        logger.debug(`[MARKET_DATA] Invalid market ID ${conditionId} (422 error) after ${totalDuration}ms: ${error.response?.data?.error || 'id is invalid'}`);
      } else {
        logger.error(`[MARKET_DATA] Failed to fetch market ${conditionId} after ${totalDuration}ms:`, error);
        logger.debug(`[MARKET_DATA] Error details: status=${error?.response?.status}, message=${error instanceof Error ? error.message : 'Unknown error'}, stack=${error instanceof Error ? error.stack : 'N/A'}`);
      }
      return null;
    }
  }

  async getOrderBook(tokenId: string): Promise<OrderBook | null> {
    const startTime = Date.now();
    logger.debug(`[MARKET_DATA] getOrderBook() called with tokenId: ${tokenId}`);
    try {
      logger.debug(`[MARKET_DATA] Calling clobClient.getOrderBook(${tokenId})`);
      const fetchStartTime = Date.now();
      const orderBook = await this.clobClient.getOrderBook(tokenId);
      const fetchDuration = Date.now() - fetchStartTime;
      const totalDuration = Date.now() - startTime;
      logger.debug(`[MARKET_DATA] getOrderBook() completed in ${totalDuration}ms (fetch: ${fetchDuration}ms) for tokenId: ${tokenId}`);
      return orderBook as OrderBook;
    } catch (error) {
      const totalDuration = Date.now() - startTime;
      logger.error(`[MARKET_DATA] Failed to fetch order book for ${tokenId} after ${totalDuration}ms:`, error);
      logger.debug(`[MARKET_DATA] Error details: message=${error instanceof Error ? error.message : 'Unknown error'}, stack=${error instanceof Error ? error.stack : 'N/A'}`);
      return null;
    }
  }

  async getMidPrice(tokenId: string): Promise<number | null> {
    const startTime = Date.now();
    logger.debug(`[MARKET_DATA] getMidPrice() called with tokenId: ${tokenId}`);
    try {
      logger.debug(`[MARKET_DATA] Calling clobClient.getMidpoint(${tokenId})`);
      const fetchStartTime = Date.now();
      const midPrice = await this.clobClient.getMidpoint(tokenId);
      const fetchDuration = Date.now() - fetchStartTime;
      logger.debug(`[MARKET_DATA] getMidpoint() returned in ${fetchDuration}ms, raw value: ${midPrice} (type: ${typeof midPrice})`);
      
      const num =
        typeof midPrice === "number"
          ? midPrice
          : parseFloat(String(midPrice));

      if (Number.isNaN(num) || !Number.isFinite(num)) {
        logger.warn(`[MARKET_DATA] Mid price for ${tokenId} is not a finite number`, {
          raw: midPrice,
          parsed: num,
          type: typeof midPrice,
        });
        return null;
      }

      const totalDuration = Date.now() - startTime;
      logger.debug(`[MARKET_DATA] getMidPrice() completed in ${totalDuration}ms for tokenId ${tokenId}: ${num}`);
      return num;
    } catch (error) {
      const totalDuration = Date.now() - startTime;
      logger.error(`[MARKET_DATA] Failed to fetch mid price for ${tokenId} after ${totalDuration}ms:`, error);
      logger.debug(`[MARKET_DATA] Error details: message=${error instanceof Error ? error.message : 'Unknown error'}, stack=${error instanceof Error ? error.stack : 'N/A'}`);
      return null;
    }
  }

  async getPrice(tokenId: string, side: "BUY" | "SELL"): Promise<number | null> {
    const startTime = Date.now();
    logger.debug(`[MARKET_DATA] getPrice() called with tokenId: ${tokenId}, side: ${side}`);
    try {
      logger.debug(`[MARKET_DATA] Calling clobClient.getPrice(${tokenId}, ${side})`);
      const fetchStartTime = Date.now();
      const price = await this.clobClient.getPrice(tokenId, side);
      const fetchDuration = Date.now() - fetchStartTime;
      logger.debug(`[MARKET_DATA] getPrice() returned in ${fetchDuration}ms, raw value: ${price} (type: ${typeof price})`);
      
      const num =
        typeof price === "number"
          ? price
          : parseFloat(String(price));

      if (Number.isNaN(num) || !Number.isFinite(num)) {
        logger.warn(`[MARKET_DATA] Price for ${tokenId} (${side}) is not a finite number`, {
          raw: price,
          parsed: num,
          type: typeof price,
        });
        return null;
      }

      const totalDuration = Date.now() - startTime;
      logger.debug(`[MARKET_DATA] getPrice() completed in ${totalDuration}ms for tokenId ${tokenId} (${side}): ${num}`);
      return num;
    } catch (error) {
      const totalDuration = Date.now() - startTime;
      logger.error(`[MARKET_DATA] Failed to fetch ${side} price for ${tokenId} after ${totalDuration}ms:`, error);
      logger.debug(`[MARKET_DATA] Error details: message=${error instanceof Error ? error.message : 'Unknown error'}, stack=${error instanceof Error ? error.stack : 'N/A'}`);
      return null;
    }
  }

  async getUserPositions(walletAddress: string): Promise<UserPosition[]> {
    const startTime = Date.now();
    logger.debug(`[MARKET_DATA] getUserPositions() called with walletAddress: ${walletAddress.substring(0, 10)}...`);
    try {
      const url = `${DATA_API_URL}/positions?user=${walletAddress}`;
      logger.debug(`[MARKET_DATA] Fetching user positions from URL: ${url}`);
      const fetchStartTime = Date.now();
      const positions = await fetchData<UserPosition[]>(url);
      const fetchDuration = Date.now() - fetchStartTime;
      const totalDuration = Date.now() - startTime;
      logger.debug(`[MARKET_DATA] getUserPositions() completed in ${totalDuration}ms (fetch: ${fetchDuration}ms) for ${walletAddress.substring(0, 10)}..., found ${positions.length} position(s)`);
      return positions;
    } catch (error) {
      const totalDuration = Date.now() - startTime;
      logger.error(`[MARKET_DATA] Failed to fetch positions for ${walletAddress.substring(0, 10)}... after ${totalDuration}ms:`, error);
      logger.debug(`[MARKET_DATA] Error details: message=${error instanceof Error ? error.message : 'Unknown error'}, stack=${error instanceof Error ? error.stack : 'N/A'}`);
      return [];
    }
  }

  async searchMarkets(query: string): Promise<Market[]> {
    const startTime = Date.now();
    logger.debug(`[MARKET_DATA] searchMarkets() called with query: "${query}"`);
    try {
      const url = `${GAMMA_API_URL}/markets?_q=${encodeURIComponent(query)}`;
      logger.debug(`[MARKET_DATA] Searching markets from URL: ${url}`);
      const fetchStartTime = Date.now();
      const markets = await fetchData<Market[]>(url);
      const fetchDuration = Date.now() - fetchStartTime;
      const totalDuration = Date.now() - startTime;
      logger.debug(`[MARKET_DATA] searchMarkets() completed in ${totalDuration}ms (fetch: ${fetchDuration}ms) for query "${query}", found ${markets.length} market(s)`);
      return markets;
    } catch (error) {
      const totalDuration = Date.now() - startTime;
      logger.error(`[MARKET_DATA] Failed to search markets for "${query}" after ${totalDuration}ms:`, error);
      logger.debug(`[MARKET_DATA] Error details: message=${error instanceof Error ? error.message : 'Unknown error'}, stack=${error instanceof Error ? error.stack : 'N/A'}`);
      return [];
    }
  }

  /**
   * Get market by slug (from Polymarket URL) or search query
   */
  async getMarketBySlug(slug: string): Promise<Market | null> {
    const startTime = Date.now();
    logger.debug(`[MARKET_DATA] getMarketBySlug() called with slug: ${slug}`);
    try {
      // Extract key terms from slug for searching
      const searchTerms = slug
        .replace(/-/g, " ")
        .replace(/\d+/g, "")
        .trim()
        .split(" ")
        .filter((t) => t.length > 2)
        .slice(0, 3)
        .join(" ");

      logger.debug(`[MARKET_DATA] Extracted search terms from slug "${slug}": "${searchTerms}"`);

      // Try searching for the market
      logger.debug(`[MARKET_DATA] Searching markets with terms: ${searchTerms}`);
      const searchStartTime = Date.now();
      const markets = await this.searchMarkets(searchTerms);
      const searchDuration = Date.now() - searchStartTime;
      logger.debug(`[MARKET_DATA] Market search completed in ${searchDuration}ms, found ${markets.length} market(s)`);
      
      // Try to match by slug first
      logger.debug(`[MARKET_DATA] Attempting exact/partial slug match in ${markets.length} search result(s)`);
      let market = markets.find((m) => m.slug === slug || m.slug.includes(slug));
      if (market) {
        const totalDuration = Date.now() - startTime;
        logger.debug(`[MARKET_DATA] getMarketBySlug() found market by slug match in ${totalDuration}ms: conditionId=${market.conditionId}, slug=${market.slug}`);
        return market;
      }
      logger.debug(`[MARKET_DATA] No exact/partial slug match found in search results`);

      // Try to match by partial slug
      const slugParts = slug.split("-");
      logger.debug(`[MARKET_DATA] Attempting partial slug matching with parts:`, slugParts);
      for (const part of slugParts) {
        if (part.length > 5) {
          logger.debug(`[MARKET_DATA] Checking slug part "${part}" (length: ${part.length})`);
          market = markets.find((m) => m.slug.includes(part));
          if (market) {
            const totalDuration = Date.now() - startTime;
            logger.debug(`[MARKET_DATA] getMarketBySlug() found market by slug part match in ${totalDuration}ms: conditionId=${market.conditionId}, slug=${market.slug}, matched part=${part}`);
            return market;
          }
        }
      }
      logger.debug(`[MARKET_DATA] No partial slug match found in search results`);

      // If still not found, search in all active markets
      logger.debug(`[MARKET_DATA] Searching in all active markets (limit: 200)`);
      const allMarketsStartTime = Date.now();
      const allMarkets = await this.getMarkets(200, true);
      const allMarketsDuration = Date.now() - allMarketsStartTime;
      logger.debug(`[MARKET_DATA] Fetched ${allMarkets.length} active markets in ${allMarketsDuration}ms`);
      
      logger.debug(`[MARKET_DATA] Attempting slug match in all active markets`);
      market = allMarkets.find((m) => 
        m.slug === slug || 
        m.slug.includes(slug) ||
        slugParts.some((part) => part.length > 5 && m.slug.includes(part))
      );

      const totalDuration = Date.now() - startTime;
      if (market) {
        logger.debug(`[MARKET_DATA] getMarketBySlug() found market in all markets in ${totalDuration}ms: conditionId=${market.conditionId}, slug=${market.slug}`);
      } else {
        logger.warn(`[MARKET_DATA] getMarketBySlug() failed to find market for slug "${slug}" after ${totalDuration}ms (searched ${markets.length} search results + ${allMarkets.length} active markets)`);
      }

      return market || null;
    } catch (error) {
      const totalDuration = Date.now() - startTime;
      logger.error(`[MARKET_DATA] Failed to find market by slug ${slug} after ${totalDuration}ms:`, error);
      logger.debug(`[MARKET_DATA] Error details: message=${error instanceof Error ? error.message : 'Unknown error'}, stack=${error instanceof Error ? error.stack : 'N/A'}`);
      return null;
    }
  }
}

export default MarketDataService;
