/**
 * Pure aggregation layer: turns normalized MarketRecord[] into the overview,
 * daily, and per-market-type statistics the dashboard renders. No I/O here so
 * it is trivially testable.
 */

import { DailyStats, GroupStats, MarketRecord, Overview } from "./types";

function statsFor(key: string, records: MarketRecord[]): GroupStats {
  const count = records.length;
  let wins = 0;
  let totalPnl = 0;
  let invested = 0;
  let grossWin = 0;
  let grossLoss = 0;
  let bestPnl = -Infinity;
  let worstPnl = Infinity;

  for (const r of records) {
    if (r.win) wins++;
    totalPnl += r.totalPnl;
    invested += r.invested;
    if (r.totalPnl >= 0) grossWin += r.totalPnl;
    else grossLoss += -r.totalPnl;
    bestPnl = Math.max(bestPnl, r.totalPnl);
    worstPnl = Math.min(worstPnl, r.totalPnl);
  }

  const losses = count - wins;
  return {
    key,
    count,
    wins,
    losses,
    winRate: count ? (wins / count) * 100 : 0,
    totalPnl,
    avgPnl: count ? totalPnl / count : 0,
    bestPnl: count ? bestPnl : 0,
    worstPnl: count ? worstPnl : 0,
    invested,
    roi: invested ? (totalPnl / invested) * 100 : 0,
    profitFactor: grossLoss ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    profitable: totalPnl > 0,
  };
}

function groupBy<T>(items: T[], keyFn: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = keyFn(it);
    const arr = m.get(k) ?? [];
    arr.push(it);
    m.set(k, arr);
  }
  return m;
}

export function overview(records: MarketRecord[]): Overview {
  const all = statsFor("all", records);
  const byType = perMarketType(records);
  const profitableSorted = [...byType].sort((a, b) => b.totalPnl - a.totalPnl);
  const dates = records.map((r) => r.date).sort();

  return {
    totalPnl: all.totalPnl,
    count: all.count,
    winRate: all.winRate,
    profitFactor: all.profitFactor,
    invested: all.invested,
    roi: all.roi,
    bestMarketType: profitableSorted[0]?.key ?? null,
    worstMarketType: profitableSorted[profitableSorted.length - 1]?.key ?? null,
    firstDate: dates[0] ?? null,
    lastDate: dates[dates.length - 1] ?? null,
  };
}

export function perMarketType(records: MarketRecord[]): GroupStats[] {
  return [...groupBy(records, (r) => r.marketType).entries()]
    .map(([k, recs]) => statsFor(k, recs))
    .sort((a, b) => b.totalPnl - a.totalPnl);
}

export function daily(records: MarketRecord[]): DailyStats[] {
  return [...groupBy(records, (r) => r.date).entries()]
    .map(([date, recs]) => ({ ...statsFor(date, recs), date }))
    .sort((a, b) => (a.date < b.date ? 1 : -1)); // newest first
}

/** Per-market-type breakdown *within* a single day (for the daily drill-down). */
export function dailyByType(records: MarketRecord[], date: string): GroupStats[] {
  return perMarketType(records.filter((r) => r.date === date));
}
