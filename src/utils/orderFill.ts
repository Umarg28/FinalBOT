/**
 * Helpers for deriving the *actual* fill price/size from a CLOB / poly-sdk
 * order response, and for computing fees from a centralized rate.
 *
 * FOK/FAK orders can fill at a better price than requested, so live PnL must be
 * booked at the real fill — never the signal price. When the response doesn't
 * carry enough detail to recover the fill, we fall back to the signal price and
 * flag it so callers can warn.
 */

import { TradeSide } from "../interfaces";

export interface ParsedFill {
  price: number;
  size: number;
  /** True when price/size came from the response; false when we fell back to the signal. */
  fromResponse: boolean;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

/**
 * Best-effort extraction of the realized fill from an order response.
 *
 * Recognizes:
 *  - explicit `executedPrice` / `executedSize` (poly-sdk)
 *  - `price` / `size` (filled) fields
 *  - maker/taker amounts: for a BUY the taker receives shares (`takingAmount`)
 *    and pays USDC (`makingAmount`); for a SELL it's reversed. price = usdc/shares.
 *
 * Falls back to the signal's price/size with `fromResponse: false` when nothing
 * usable is present.
 */
export function parseFillFromResponse(
  response: any,
  side: TradeSide,
  signalPrice: number,
  signalSize: number
): ParsedFill {
  if (response && typeof response === "object") {
    // 1. Explicit executed fields (preferred).
    const execPrice = num(response.executedPrice);
    const execSize = num(response.executedSize);
    if (execPrice !== null && execSize !== null && execPrice > 0 && execSize > 0) {
      return { price: execPrice, size: execSize, fromResponse: true };
    }

    // 2. Generic filled price/size fields.
    const fPrice = num(response.price ?? response.fillPrice ?? response.avgPrice);
    const fSize = num(response.sizeMatched ?? response.filledSize ?? response.matchedAmount);
    if (fPrice !== null && fSize !== null && fPrice > 0 && fSize > 0 && fPrice <= 1) {
      return { price: fPrice, size: fSize, fromResponse: true };
    }

    // 3. Maker/taker amounts.
    const making = num(response.makingAmount);
    const taking = num(response.takingAmount);
    if (making !== null && taking !== null && making > 0 && taking > 0) {
      // BUY: pay USDC (making), receive shares (taking) -> price = usdc/shares
      // SELL: give shares (making), receive USDC (taking) -> price = usdc/shares
      const usdc = side === "BUY" ? making : taking;
      const shares = side === "BUY" ? taking : making;
      const price = usdc / shares;
      if (shares > 0 && price > 0 && price <= 1) {
        return { price, size: shares, fromResponse: true };
      }
    }
  }

  return { price: signalPrice, size: signalSize, fromResponse: false };
}

/** Compute fee (USDC) from a notional and a basis-point rate. */
export function computeFee(notionalUsdc: number, feeRateBps: number): number {
  if (!Number.isFinite(notionalUsdc) || !Number.isFinite(feeRateBps) || feeRateBps <= 0) {
    return 0;
  }
  return (notionalUsdc * feeRateBps) / 10_000;
}
