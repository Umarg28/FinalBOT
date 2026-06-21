import { EventEmitter } from "events";
import type {
  ClobApiKeyCreds,
  ConnectionStatus,
  Message,
  RealTimeDataClient,
} from "@polymarket/real-time-data-client";
import { ENV } from "../config/env";
import logger from "../utils/logger";

type SubscriptionSpec = {
  topic: string;
  type: string;
  filters?: string;
  clob_auth?: ClobApiKeyCreds;
};

export interface OfficialPriceUpdate {
  tokenId: string;
  conditionId?: string;
  price?: number;
  bestBid?: number;
  bestAsk?: number;
  timestamp: number;
  sourceType: string;
}

export interface OfficialUserOrder {
  orderId?: string;
  market?: string;
  asset?: string;
  side?: string;
  price?: number;
  originalSize?: number;
  matchedSize?: number;
  eventType?: string;
  timestamp: number;
}

export interface OfficialUserTrade {
  tradeId?: string;
  market?: string;
  asset?: string;
  side?: string;
  price?: number;
  size?: number;
  status?: string;
  transactionHash?: string;
  timestamp: number;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizeTimestamp(value: unknown, fallback: number = Date.now()): number {
  const numeric = toNumber(value);
  if (numeric === undefined) return fallback;
  return numeric < 1e12 ? numeric * 1000 : numeric;
}

function firstString(payload: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export class OfficialRealtimeStreamService extends EventEmitter {
  private client: RealTimeDataClient | null = null;
  private connected = false;
  private marketTokenIds = new Set<string>();
  private readonly subscriptions = new Map<string, { subscriptions: SubscriptionSpec[] }>();
  private readonly latestPrices = new Map<string, OfficialPriceUpdate>();
  private userSubscribed = false;

  start(): void {
    if (this.client || !ENV.ENABLE_OFFICIAL_REALTIME) return;

    void this.loadClient()
      .then(({ RealTimeDataClient: Client }) => {
        this.client = new Client({
          onConnect: () => this.handleConnect(),
          onMessage: (_client: RealTimeDataClient, message: Message) => this.handleMessage(message),
          onStatusChange: (status: ConnectionStatus) => this.handleStatus(status),
          autoReconnect: true,
          pingInterval: 5000,
        });
        this.client.connect();
      })
      .catch((error) => {
        logger.warn(
          `Official real-time client unavailable: ${error instanceof Error ? error.message : String(error)}`
        );
      });
  }

  stop(): void {
    this.client?.disconnect();
    this.client = null;
    this.connected = false;
    this.subscriptions.clear();
    this.marketTokenIds.clear();
    this.userSubscribed = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getLatestPrice(tokenId: string): OfficialPriceUpdate | undefined {
    return this.latestPrices.get(tokenId);
  }

  setMarketTokenIds(tokenIds: string[]): void {
    const normalized = tokenIds.filter(Boolean);
    const nextKey = normalized.slice().sort().join(",");
    const currentKey = [...this.marketTokenIds].sort().join(",");
    if (nextKey === currentKey) return;

    this.unsubscribe("market");
    this.marketTokenIds = new Set(normalized);
    if (normalized.length === 0) return;

    const subscriptions: SubscriptionSpec[] = [
      { topic: "clob_market", type: "agg_orderbook", filters: JSON.stringify(normalized) },
      { topic: "clob_market", type: "price_change", filters: JSON.stringify(normalized) },
      { topic: "clob_market", type: "last_trade_price", filters: JSON.stringify(normalized) },
      { topic: "clob_market", type: "tick_size_change", filters: JSON.stringify(normalized) },
    ];
    this.subscribe("market", subscriptions);
    logger.info(`Official real-time market stream tracking ${normalized.length} token(s)`);
  }

  subscribeUserEvents(credentials: ClobApiKeyCreds | null): void {
    if (!credentials?.key || this.userSubscribed) return;
    const subscriptions: SubscriptionSpec[] = [
      { topic: "clob_user", type: "*", clob_auth: credentials },
    ];
    this.subscribe("user", subscriptions);
    this.userSubscribed = true;
    logger.info("Official real-time user stream subscribed");
  }

  private async loadClient(): Promise<typeof import("@polymarket/real-time-data-client")> {
    return import("@polymarket/real-time-data-client");
  }

  private handleConnect(): void {
    this.connected = true;
    for (const subscription of this.subscriptions.values()) {
      this.client?.subscribe(subscription);
    }
    logger.success("Official Polymarket real-time stream connected");
  }

  private handleStatus(status: ConnectionStatus): void {
    this.connected = String(status) === "CONNECTED";
    if (ENV.OFFICIAL_REALTIME_DEBUG) {
      logger.debug(`Official real-time status: ${String(status)}`);
    }
  }

  private subscribe(key: string, subscriptions: SubscriptionSpec[]): void {
    const message = { subscriptions };
    this.subscriptions.set(key, message);
    if (this.connected) {
      this.client?.subscribe(message);
    }
  }

  private unsubscribe(key: string): void {
    const message = this.subscriptions.get(key);
    if (message && this.connected) {
      this.client?.unsubscribe(message);
    }
    this.subscriptions.delete(key);
    if (key === "user") this.userSubscribed = false;
  }

  private handleMessage(message: Message): void {
    const payload = (message.payload || {}) as Record<string, unknown>;
    const timestamp = normalizeTimestamp(payload.timestamp, normalizeTimestamp(message.timestamp));

    if (message.topic === "clob_market") {
      this.handleMarketMessage(message.type, payload, timestamp);
      return;
    }

    if (message.topic === "clob_user") {
      this.handleUserMessage(message.type, payload, timestamp);
    }
  }

  private handleMarketMessage(type: string, payload: Record<string, unknown>, timestamp: number): void {
    if (type === "agg_orderbook") {
      const tokenId = firstString(payload, ["asset_id", "assetId", "token_id", "tokenId"]);
      if (!tokenId) return;

      const bids = Array.isArray(payload.bids) ? payload.bids as Array<Record<string, unknown>> : [];
      const asks = Array.isArray(payload.asks) ? payload.asks as Array<Record<string, unknown>> : [];
      const bestBid = toNumber(bids[0]?.price);
      const bestAsk = toNumber(asks[0]?.price);
      const price =
        bestBid !== undefined && bestAsk !== undefined
          ? (bestBid + bestAsk) / 2
          : undefined;

      const update: OfficialPriceUpdate = {
        tokenId,
        conditionId: firstString(payload, ["market", "condition_id", "conditionId"]),
        price,
        bestBid,
        bestAsk,
        timestamp,
        sourceType: type,
      };
      this.latestPrices.set(tokenId, update);
      this.emit("price", update);
      return;
    }

    if (type === "price_change") {
      const changes = Array.isArray(payload.price_changes)
        ? payload.price_changes as Array<Record<string, unknown>>
        : [payload];

      for (const change of changes) {
        const tokenId = firstString(change, ["asset_id", "assetId", "token_id", "tokenId"]);
        if (!tokenId) continue;
        const update: OfficialPriceUpdate = {
          tokenId,
          conditionId: firstString(payload, ["market", "condition_id", "conditionId"]),
          price: toNumber(change.price),
          bestBid: toNumber(change.best_bid),
          bestAsk: toNumber(change.best_ask),
          timestamp,
          sourceType: type,
        };
        this.latestPrices.set(tokenId, update);
        this.emit("price", update);
      }
      return;
    }

    if (type === "last_trade_price") {
      const tokenId = firstString(payload, ["asset_id", "assetId", "token_id", "tokenId"]);
      if (!tokenId) return;
      const update: OfficialPriceUpdate = {
        tokenId,
        conditionId: firstString(payload, ["market", "condition_id", "conditionId"]),
        price: toNumber(payload.price),
        timestamp,
        sourceType: type,
      };
      this.latestPrices.set(tokenId, update);
      this.emit("price", update);
      return;
    }

    if (type === "market_created" || type === "market_resolved") {
      this.emit("marketEvent", { type, payload, timestamp });
    }
  }

  private handleUserMessage(type: string, payload: Record<string, unknown>, timestamp: number): void {
    if (type === "order" || payload.order_id || payload.orderId) {
      const order: OfficialUserOrder = {
        orderId: firstString(payload, ["order_id", "orderId", "id"]),
        market: firstString(payload, ["market", "condition_id", "conditionId"]),
        asset: firstString(payload, ["asset", "asset_id", "token_id"]),
        side: firstString(payload, ["side"]),
        price: toNumber(payload.price),
        originalSize: toNumber(payload.original_size) ?? toNumber(payload.originalSize),
        matchedSize: toNumber(payload.matched_size) ?? toNumber(payload.matchedSize),
        eventType: firstString(payload, ["event_type", "eventType"]),
        timestamp,
      };
      this.emit("userOrder", order);
    }

    if (type === "trade" || payload.trade_id || payload.transaction_hash) {
      const trade: OfficialUserTrade = {
        tradeId: firstString(payload, ["trade_id", "tradeId", "id"]),
        market: firstString(payload, ["market", "condition_id", "conditionId"]),
        asset: firstString(payload, ["asset", "asset_id", "token_id"]),
        side: firstString(payload, ["side"]),
        price: toNumber(payload.price),
        size: toNumber(payload.size),
        status: firstString(payload, ["status"]),
        transactionHash: firstString(payload, ["transaction_hash", "transactionHash"]),
        timestamp,
      };
      this.emit("userTrade", trade);
    }
  }
}

export const officialRealtimeStream = new OfficialRealtimeStreamService();
export default officialRealtimeStream;
