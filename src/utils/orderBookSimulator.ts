/**
 * Order Book Fill Simulator
 *
 * Simulates a realistic market-order fill against a Polymarket order book by
 * walking the book level-by-level (best price first) and computing the
 * size-weighted average fill price.
 *
 * This replaces the previous "top-of-book + random slippage" approximation in
 * paperTrader.executeOrder, so that paper PnL reflects what would actually
 * happen on Polymarket: large orders eat through depth and pay a worse
 * average price than the top-of-book quote.
 *
 * Notes:
 *  - For BUYs we walk the asks ascending (cheapest seller first).
 *  - For SELLs we walk the bids descending (highest buyer first).
 *  - We never cross beyond a sanity cap (default 0.99 for BUY, 0.01 for SELL)
 *    so a thin or one-sided book cannot trigger absurd fills.
 *  - If the book lacks depth to fully fill the requested size at acceptable
 *    prices, we return a partial fill; the caller decides what to do with it.
 */
import { OrderBook } from "../interfaces";

export interface BookLevelFill {
  price: number;
  size: number;
}

export interface FillResult {
  /** True if the entire requested size was filled at acceptable prices. */
  filled: boolean;
  /** Number of shares actually filled (may be less than requested). */
  sharesFilled: number;
  /** Total dollar cost (BUY) or proceeds (SELL) of the filled shares. */
  totalCost: number;
  /** Size-weighted average fill price across all levels consumed. */
  avgPrice: number;
  /** Shares not filled (because depth ran out before the cap was hit). */
  unfilledSize: number;
  /** Per-level breakdown of the fills produced. */
  fills: BookLevelFill[];
  /** Total shares the book had within the acceptable price range. */
  bookDepthShares: number;
  /** Top-of-book price for reference (best ask for BUY, best bid for SELL). */
  topOfBookPrice: number;
  /** Slippage in dollars: (avgPrice - topOfBookPrice) * sharesFilled for BUY. */
  slippageCost: number;
}

interface ParsedLevel {
  price: number;
  size: number;
}

function parseAndSortLevels(
  raw: { price: string | number; size: string | number }[] | undefined,
  ascending: boolean
): ParsedLevel[] {
  if (!raw || raw.length === 0) return [];

  const parsed: ParsedLevel[] = [];
  for (const lvl of raw) {
    const price = typeof lvl.price === "number" ? lvl.price : parseFloat(String(lvl.price));
    const size = typeof lvl.size === "number" ? lvl.size : parseFloat(String(lvl.size));
    if (!Number.isFinite(price) || !Number.isFinite(size)) continue;
    if (price <= 0 || price >= 1) continue;
    if (size <= 0) continue;
    parsed.push({ price, size });
  }

  parsed.sort((a, b) => (ascending ? a.price - b.price : b.price - a.price));
  return parsed;
}

/**
 * Simulate a market BUY against the book by walking the asks.
 *
 * @param book        Order book snapshot from Polymarket CLOB.
 * @param sizeWanted  Number of shares requested.
 * @param maxPrice    Hard upper bound on per-level price; default 0.99.
 *                    Levels above this are skipped (treated as no liquidity).
 */
export function simulateMarketBuy(
  book: OrderBook | null | undefined,
  sizeWanted: number,
  maxPrice: number = 0.99
): FillResult {
  const asks = parseAndSortLevels(book?.asks, true);
  return walkLevels(asks, sizeWanted, "BUY", maxPrice);
}

/**
 * Simulate a market SELL against the book by walking the bids.
 *
 * @param book        Order book snapshot from Polymarket CLOB.
 * @param sizeWanted  Number of shares requested.
 * @param minPrice    Hard lower bound on per-level price; default 0.01.
 *                    Levels below this are skipped (treated as no liquidity).
 */
export function simulateMarketSell(
  book: OrderBook | null | undefined,
  sizeWanted: number,
  minPrice: number = 0.01
): FillResult {
  const bids = parseAndSortLevels(book?.bids, false);
  return walkLevels(bids, sizeWanted, "SELL", minPrice);
}

function walkLevels(
  levels: ParsedLevel[],
  sizeWanted: number,
  side: "BUY" | "SELL",
  priceCap: number
): FillResult {
  const topOfBookPrice = levels[0]?.price ?? 0;

  let bookDepthShares = 0;
  for (const lvl of levels) {
    const inRange = side === "BUY" ? lvl.price <= priceCap : lvl.price >= priceCap;
    if (inRange) bookDepthShares += lvl.size;
  }

  let remaining = sizeWanted;
  let totalCost = 0;
  let sharesFilled = 0;
  const fills: BookLevelFill[] = [];

  for (const lvl of levels) {
    if (remaining <= 0) break;

    const inRange = side === "BUY" ? lvl.price <= priceCap : lvl.price >= priceCap;
    if (!inRange) break;

    const take = Math.min(remaining, lvl.size);
    sharesFilled += take;
    totalCost += take * lvl.price;
    fills.push({ price: lvl.price, size: take });
    remaining -= take;
  }

  const avgPrice = sharesFilled > 0 ? totalCost / sharesFilled : 0;
  const slippageCost =
    sharesFilled > 0 && topOfBookPrice > 0
      ? side === "BUY"
        ? (avgPrice - topOfBookPrice) * sharesFilled
        : (topOfBookPrice - avgPrice) * sharesFilled
      : 0;

  return {
    filled: remaining <= 1e-9,
    sharesFilled,
    totalCost,
    avgPrice,
    unfilledSize: Math.max(0, remaining),
    fills,
    bookDepthShares,
    topOfBookPrice,
    slippageCost,
  };
}
