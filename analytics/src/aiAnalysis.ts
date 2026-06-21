/**
 * Optional Claude-powered analysis. Only used when ANTHROPIC_API_KEY is set;
 * otherwise the dashboard falls back to the heuristic engine. Uses the Anthropic
 * Messages API directly via global fetch (no SDK dependency).
 */

import CONFIG from "./config";
import { perMarketType, overview } from "./analytics";
import { MarketRecord } from "./types";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

function buildPrompt(records: MarketRecord[]): string {
  const ov = overview(records);
  const byType = perMarketType(records);
  const recentLosses = records
    .filter((r) => !r.win)
    .slice(-15)
    .map(
      (r) =>
        `- ${r.marketType} ${r.date}: PnL ${r.totalPnl.toFixed(2)} (${r.pnlPercent.toFixed(1)}%), winner=${r.outcome} avgCostWinner=${r.avgCostWinner.toFixed(3)} avgCostLoser=${r.avgCostLoser.toFixed(3)} sharesUp=${r.sharesUp.toFixed(0)} sharesDown=${r.sharesDown.toFixed(0)}`
    )
    .join("\n");

  const typeLines = byType
    .map(
      (t) =>
        `- ${t.key}: ${t.count} markets, win ${t.winRate.toFixed(0)}%, PnL ${t.totalPnl.toFixed(2)}, ROI ${t.roi.toFixed(1)}%, profitFactor ${t.profitFactor === Infinity ? "inf" : t.profitFactor.toFixed(2)}`
    )
    .join("\n");

  return `You are a quantitative trading analyst reviewing a Polymarket inventory-rebalancing (market-maker style) bot that trades short-duration BTC/ETH up-or-down markets. The thesis is: with tight parameters the book should be profitable on ~90% of markets, because rebalancing keeps inventory balanced and suppresses the losing side as a trend emerges.

Key tunable parameters: edge_threshold, trend_threshold, price_stop_threshold (regime gates that suppress the losing side as price moves), late_entry_threshold (skip entering a side already priced high), max_skew_ratio / max_inventory_imbalance_ratio (how lopsided inventory may get), bell_curve sizing (smaller size near price extremes), max_trade_size, and per-duration sizing.

OVERVIEW: net PnL ${ov.totalPnl.toFixed(2)}, ${ov.count} markets, win rate ${ov.winRate.toFixed(1)}%, profit factor ${ov.profitFactor === Infinity ? "inf" : ov.profitFactor.toFixed(2)}, ROI ${ov.roi.toFixed(1)}%.

PER MARKET TYPE:
${typeLines}

RECENT LOSSES:
${recentLosses || "(none)"}

Write a concise but specific analysis (markdown, max ~400 words):
1. What is working and what isn't (be concrete about which market types).
2. WHY the losing markets lost — distinguish "paid up / entered the winner too expensively" vs "overweight the side that lost / regime gate fired too late" vs "genuine variance".
3. Concrete parameter adjustments (name the exact parameters and the direction to move them) to push the win rate toward 90%.
4. A one-line go-live verdict: ready / close / not ready, and why.`;
}

export async function analyzeWithAI(records: MarketRecord[]): Promise<string> {
  if (!CONFIG.ai.enabled) {
    throw new Error("AI analysis disabled (set ANTHROPIC_API_KEY).");
  }
  if (typeof fetch !== "function") {
    throw new Error("global fetch unavailable - use Node 18+.");
  }

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": CONFIG.ai.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CONFIG.ai.model,
      max_tokens: 1200,
      messages: [{ role: "user", content: buildPrompt(records) }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Anthropic API error ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  const text = (data.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n")
    .trim();
  return text || "No analysis returned.";
}
