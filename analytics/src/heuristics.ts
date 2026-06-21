/**
 * Deterministic ("heuristic") analysis engine.
 *
 * Turns the aggregated stats into plain-English findings, concrete parameter
 * suggestions (referencing the real inventory-rebalance-config.yaml keys), and a
 * go-live readiness verdict. Works fully offline - no API key required. The AI
 * hook (aiAnalysis.ts) is an optional richer alternative that consumes the same
 * inputs.
 */

import * as fs from "fs";
import CONFIG from "./config";
import { perMarketType } from "./analytics";
import { GroupStats, MarketRecord } from "./types";

export interface Finding {
  level: "good" | "warn" | "bad" | "info";
  text: string;
}

export interface Analysis {
  findings: Finding[];
  suggestions: string[];
  readiness: {
    verdict: "ready" | "close" | "not-ready";
    summary: string;
    winRate: number;
    profitFactor: number;
    targetWinRate: number;
  };
}

const TARGET_WIN_RATE = 90; // rebalance thesis: tight params -> ~90% of markets profitable

/** Best-effort read of a numeric key from the YAML config (no yaml dependency). */
function readConfigNumber(key: string): number | null {
  try {
    if (!fs.existsSync(CONFIG.rebalanceConfigPath)) return null;
    const txt = fs.readFileSync(CONFIG.rebalanceConfigPath, "utf8");
    const m = txt.match(new RegExp(`^\\s*${key}\\s*:\\s*([-\\d.]+)`, "m"));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

export function analyzeOverall(records: MarketRecord[]): Analysis {
  const findings: Finding[] = [];
  const suggestions: string[] = [];

  if (records.length === 0) {
    return {
      findings: [{ level: "info", text: "No settled markets recorded yet. Let the bot run, then come back." }],
      suggestions: [],
      readiness: { verdict: "not-ready", summary: "No data yet.", winRate: 0, profitFactor: 0, targetWinRate: TARGET_WIN_RATE },
    };
  }

  const byType = perMarketType(records);
  const wins = records.filter((r) => r.win).length;
  const winRate = (wins / records.length) * 100;
  const totalPnl = records.reduce((s, r) => s + r.totalPnl, 0);
  const grossWin = records.filter((r) => r.totalPnl > 0).reduce((s, r) => s + r.totalPnl, 0);
  const grossLoss = records.filter((r) => r.totalPnl < 0).reduce((s, r) => s + -r.totalPnl, 0);
  const profitFactor = grossLoss ? grossWin / grossLoss : Infinity;

  // ── Top-level health ────────────────────────────────────────────────────────
  findings.push({
    level: totalPnl > 0 ? "good" : "bad",
    text: `Net PnL across ${records.length} markets is ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)} (win rate ${winRate.toFixed(1)}%, profit factor ${profitFactor === Infinity ? "∞" : profitFactor.toFixed(2)}).`,
  });

  if (winRate < TARGET_WIN_RATE) {
    findings.push({
      level: winRate >= 70 ? "warn" : "bad",
      text: `Win rate ${winRate.toFixed(1)}% is below the ${TARGET_WIN_RATE}% target for a tight rebalance strategy. The losing tail is where the edge is leaking.`,
    });
  } else {
    findings.push({ level: "good", text: `Win rate ${winRate.toFixed(1)}% meets the ${TARGET_WIN_RATE}% rebalance target.` });
  }

  // ── Per-market-type winners and losers ──────────────────────────────────────
  const losers = byType.filter((t) => !t.profitable);
  const winnersTypes = byType.filter((t) => t.profitable);
  for (const t of winnersTypes) {
    findings.push({
      level: "good",
      text: `${t.key}: profitable (+$${t.totalPnl.toFixed(2)}, ${t.winRate.toFixed(0)}% win, ${t.count} markets, ROI ${t.roi.toFixed(1)}%).`,
    });
  }
  for (const t of losers) {
    findings.push({
      level: "bad",
      text: `${t.key}: losing (-$${Math.abs(t.totalPnl).toFixed(2)}, ${t.winRate.toFixed(0)}% win, ${t.count} markets, ROI ${t.roi.toFixed(1)}%).`,
    });
  }

  // ── Concrete parameter suggestions ──────────────────────────────────────────
  suggestions.push(...suggestParameters(records, byType, losers));

  // ── Readiness verdict ───────────────────────────────────────────────────────
  let verdict: "ready" | "close" | "not-ready";
  let summary: string;
  if (totalPnl > 0 && winRate >= TARGET_WIN_RATE && profitFactor >= 2) {
    verdict = "ready";
    summary = `Consistently profitable with a ${winRate.toFixed(0)}% win rate and ${profitFactor === Infinity ? "∞" : profitFactor.toFixed(1)}x profit factor. Consider a small-size live trial.`;
  } else if (totalPnl > 0 && winRate >= 70) {
    verdict = "close";
    summary = `Net positive but below the ${TARGET_WIN_RATE}% target. Tighten the losing market types below before going live.`;
  } else {
    verdict = "not-ready";
    summary = `Not yet ready for live. Net ${totalPnl >= 0 ? "positive" : "negative"} with a ${winRate.toFixed(0)}% win rate — address the losing market types and the expensive-entry tail first.`;
  }

  return {
    findings,
    suggestions,
    readiness: { verdict, summary, winRate, profitFactor, targetWinRate: TARGET_WIN_RATE },
  };
}

function suggestParameters(records: MarketRecord[], byType: GroupStats[], losers: GroupStats[]): string[] {
  const out: string[] = [];

  // 1. Disable/de-weight chronically losing market types.
  for (const t of losers) {
    if (t.count >= 5 && t.winRate < 50) {
      out.push(
        `Disable or shrink ${t.key}: ${t.winRate.toFixed(0)}% win over ${t.count} markets. Remove it from MARKET_TYPES or cut its max_trade_size so it can't drag the book.`
      );
    }
  }

  // 2. Expensive winner entries -> late entry / bell curve.
  const lossRecords = records.filter((r) => !r.win);
  const expensiveWinner = lossRecords.filter((r) => r.avgCostWinner >= 0.6).length;
  if (lossRecords.length > 0 && expensiveWinner / lossRecords.length >= 0.4) {
    const lateEntry = readConfigNumber("late_entry_threshold");
    out.push(
      `In ${Math.round((expensiveWinner / lossRecords.length) * 100)}% of losing markets you were holding the winning side at an avg cost ≥ $0.60 — you paid up after the move. Lower late_entry_threshold (currently ${lateEntry ?? "?"}) toward 0.62, and/or reduce bell_curve sizing near the extremes so you stop adding to expensive sides.`
    );
  }

  // 3. Overweight the loser -> skew / edge / trend gating.
  const overweightLoser = lossRecords.filter((r) => {
    const loserShares = r.outcome === "UP" ? r.sharesDown : r.sharesUp;
    const winnerShares = r.outcome === "UP" ? r.sharesUp : r.sharesDown;
    return winnerShares > 0 && loserShares > winnerShares * 1.3;
  }).length;
  if (lossRecords.length > 0 && overweightLoser / lossRecords.length >= 0.4) {
    const edge = readConfigNumber("edge_threshold");
    const trend = readConfigNumber("trend_threshold");
    const skew = readConfigNumber("max_skew_ratio");
    out.push(
      `In ${Math.round((overweightLoser / lossRecords.length) * 100)}% of losses you were overweight the side that lost. The regime gates fired too late — lower edge_threshold (currently ${edge ?? "?"}) and trend_threshold (currently ${trend ?? "?"}) so the losing side is suppressed earlier, and tighten max_skew_ratio (currently ${skew ?? "?"}).`
    );
  }

  // 4. Healthy book but thin sample.
  if (records.length < 30) {
    out.push(`Only ${records.length} settled markets so far — collect more before trusting these numbers or going live.`);
  }

  if (out.length === 0) {
    out.push("No systematic leak detected in the current sample. Keep parameters and grow the sample before increasing size.");
  }
  return out;
}

/** Per-market "why did this happen" narrative for the detail drill-down. */
export function analyzeMarket(r: MarketRecord, allRecords: MarketRecord[]): { findings: Finding[]; suggestion: string } {
  const findings: Finding[] = [];
  const loserShares = r.outcome === "UP" ? r.sharesDown : r.sharesUp;
  const winnerShares = r.outcome === "UP" ? r.sharesUp : r.sharesDown;

  findings.push({
    level: r.win ? "good" : "bad",
    text: `${r.outcome} won. Result: ${r.totalPnl >= 0 ? "+" : ""}$${r.totalPnl.toFixed(2)} (${r.pnlPercent.toFixed(1)}%) on $${r.invested.toFixed(0)} invested.`,
  });
  findings.push({
    level: "info",
    text: `Avg cost — winning side (${r.outcome}) $${r.avgCostWinner.toFixed(3)}, losing side $${r.avgCostLoser.toFixed(3)}. Inventory — winner ${winnerShares.toFixed(0)} sh, loser ${loserShares.toFixed(0)} sh.`,
  });

  let suggestion: string;
  if (r.win) {
    suggestion = `Profitable: you held more of the winner (${r.outcome}) and/or entered it cheaply ($${r.avgCostWinner.toFixed(3)}). This is the shape you want to reproduce.`;
  } else if (r.avgCostWinner >= 0.6) {
    findings.push({ level: "warn", text: `You paid up: the winning side averaged $${r.avgCostWinner.toFixed(3)} — entered after the move was already priced in.` });
    suggestion = `Loss driven by expensive entry on the winner. Lower late_entry_threshold and reduce bell-curve size near the extremes so you don't keep adding once a side is decided.`;
  } else if (winnerShares > 0 && loserShares > winnerShares * 1.3) {
    findings.push({ level: "warn", text: `Overweight the loser: ${loserShares.toFixed(0)} losing-side shares vs ${winnerShares.toFixed(0)} winning-side. The rebalance/regime gate reacted too slowly.` });
    suggestion = `Loss driven by inventory skew toward the side that lost. Lower edge_threshold/trend_threshold so the losing side is suppressed earlier, and tighten max_skew_ratio.`;
  } else {
    suggestion = `Marginal loss without an obvious structural cause — likely a genuine coin-flip market that resolved against a balanced book. Acceptable variance if rare.`;
  }

  void allRecords;
  return { findings, suggestion };
}
