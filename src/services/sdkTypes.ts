/**
 * Minimal type definitions for the dynamically-imported
 * @catalyst-team/poly-sdk PolymarketSDK, covering only the surface this bot
 * uses. The SDK ships loose types and is loaded via dynamic import, so this
 * gives us compile-time safety at the call sites that previously used `as any`.
 */

import { TradeSide } from "../interfaces";

export interface SdkOrderResult {
  success: boolean;
  errorMsg?: string;
  error?: string;
  transactionHashes?: string[];
  /** Realized fill fields (presence varies by SDK version). */
  executedPrice?: number;
  executedSize?: number;
  makingAmount?: number | string;
  takingAmount?: number | string;
}

export interface CreateLimitOrderParams {
  tokenId: string;
  side: TradeSide;
  price: number;
  size: number;
  orderType: "GTC" | "GTD" | "FOK" | "FAK";
  expiration?: number;
}

export interface CreateMarketOrderParams {
  tokenId: string;
  side: TradeSide;
  amount: number;
  orderType: "GTC" | "GTD" | "FOK" | "FAK";
}

export interface PolySdkTradingService {
  createLimitOrder(params: CreateLimitOrderParams): Promise<SdkOrderResult>;
  createMarketOrder(params: CreateMarketOrderParams): Promise<SdkOrderResult>;
  getOpenOrders(): Promise<unknown[]>;
  cancelOrder(orderId: string): Promise<unknown>;
  cancelAllOrders(): Promise<unknown>;
  isOrderScoring(orderId: string): Promise<boolean>;
  getCurrentRewards(): Promise<unknown>;
  getEarnings?(date: string): Promise<unknown>;
}

export interface PolySdk {
  tradingService: PolySdkTradingService;
  stop(): void;
}
