/**
 * Read-only data source over the bot's persisted PnL history.
 *
 * Loads every logs/paper/pnl_history*.json file, de-duplicates by market, and
 * normalizes each entry into a MarketRecord the analytics layer can aggregate.
 * Never writes - it only reads files the bot produces, so it cannot affect
 * core trading.
 */

import * as fs from "fs";
import * as path from "path";
import CONFIG from "./config";
import { Asset, Duration, MarketRecord, Outcome, RawHistoryEntry } from "./types";

const ET = "America/New_York";

function etDate(ts: number): string {
  // YYYY-MM-DD in Eastern Time (the bot's market clock).
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ET,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ts));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function parseAsset(name: string): Asset {
  const n = name.toLowerCase();
  if (n.includes("bitcoin") || n.includes("btc")) return "BTC";
  if (n.includes("ethereum") || n.includes("eth")) return "ETH";
  return "OTHER";
}

/** Derive market duration from the time range in the market name. */
function parseDuration(name: string): Duration {
  // Match e.g. "12:25PM-12:30PM" or "11:00AM-11:05AM".
  const range = name.match(/(\d{1,2})(?::(\d{2}))?\s*([AP]M)\s*-\s*(\d{1,2})(?::(\d{2}))?\s*([AP]M)/i);
  if (range) {
    const toMin = (h: string, m: string | undefined, ap: string) => {
      let hh = parseInt(h, 10) % 12;
      if (ap.toUpperCase() === "PM") hh += 12;
      return hh * 60 + (m ? parseInt(m, 10) : 0);
    };
    let diff = toMin(range[4], range[5], range[6]) - toMin(range[1], range[2], range[3]);
    if (diff < 0) diff += 24 * 60; // crosses midnight
    if (diff <= 7) return "5m";
    if (diff <= 20) return "15m";
    if (diff <= 90) return "1h";
    return "other";
  }
  // No range -> typically a 1-hour market ("... June 21, 11AM ET").
  if (/\d{1,2}\s*[AP]M\s*ET/i.test(name)) return "1h";
  return "other";
}

function normalize(e: RawHistoryEntry): MarketRecord | null {
  if (!e || !e.conditionId || typeof e.totalPnl !== "number") return null;

  const asset = parseAsset(e.marketName || "");
  const duration = parseDuration(e.marketName || "");

  // Derive per-side cost / avg price from positions when available.
  let costUp = 0;
  let costDown = 0;
  let avgCostUp = 0;
  let avgCostDown = 0;
  for (const p of e.marketPnL?.positions ?? []) {
    const side = (p.position.outcome || "").toLowerCase();
    if (side === "up" || side === "yes") {
      costUp = p.costBasis;
      avgCostUp = p.position.avgPrice;
    } else if (side === "down" || side === "no") {
      costDown = p.costBasis;
      avgCostDown = p.position.avgPrice;
    }
  }
  const invested = costUp + costDown || e.marketPnL?.totalCostBasis || 0;

  const outcome: Outcome = e.priceUp >= e.priceDown ? "UP" : "DOWN";
  const avgCostWinner = outcome === "UP" ? avgCostUp : avgCostDown;
  const avgCostLoser = outcome === "UP" ? avgCostDown : avgCostUp;
  const winnerShares = outcome === "UP" ? e.sharesUp : e.sharesDown;
  const loserShares = outcome === "UP" ? e.sharesDown : e.sharesUp;

  return {
    conditionId: e.conditionId,
    marketName: e.marketName || "Unknown",
    asset,
    duration,
    marketType: `${asset}-${duration}`,
    date: etDate(e.timestamp),
    timestamp: e.timestamp,
    outcome,
    win: e.totalPnl > 0,
    totalPnl: e.totalPnl,
    pnlPercent: e.pnlPercent,
    sharesUp: e.sharesUp,
    sharesDown: e.sharesDown,
    costUp,
    costDown,
    avgCostUp,
    avgCostDown,
    invested,
    avgCostWinner,
    avgCostLoser,
    settlePriceUp: outcome === "UP" ? 1 : 0,
    settlePriceDown: outcome === "UP" ? 0 : 1,
    winnerShares,
    loserShares,
    payout: winnerShares, // each winning share settles at $1
  };
}

/** Load and normalize every market record from disk. Sorted oldest -> newest. */
export function loadRecords(): MarketRecord[] {
  const dir = CONFIG.paperLogDir;
  if (!fs.existsSync(dir)) return [];

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("pnl_history") && f.endsWith(".json"));

  // De-dupe: prefer the latest timestamp per conditionId (markets can appear in
  // both the rolling pnl_history.json and a dated file).
  const byKey = new Map<string, MarketRecord>();
  for (const file of files) {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    } catch {
      continue; // skip corrupt/partial file
    }
    const entries: RawHistoryEntry[] = Array.isArray(raw)
      ? raw
      : raw && typeof raw === "object"
        ? Object.values(raw as Record<string, RawHistoryEntry>)
        : [];
    for (const e of entries) {
      const rec = normalize(e);
      if (!rec) continue;
      const key = `${rec.conditionId}:${rec.timestamp}`;
      const existing = byKey.get(rec.conditionId);
      // Keep one record per conditionId (latest capture wins).
      if (!existing || rec.timestamp >= existing.timestamp) {
        byKey.set(rec.conditionId, rec);
      }
      void key;
    }
  }

  let records = [...byKey.values()];

  // Drop anything before the configured cutoff (defaults to today) so stale
  // historical runs don't pollute the numbers.
  if (CONFIG.sinceDate && CONFIG.sinceDate.toLowerCase() !== "all") {
    records = records.filter((r) => r.date >= CONFIG.sinceDate);
  }

  return records.sort((a, b) => a.timestamp - b.timestamp);
}
