/**
 * Analytics dashboard HTTP server.
 *
 * Zero-framework Node http server that:
 *   - serves the static dashboard from public/
 *   - exposes read-only JSON APIs over the bot's PnL history
 *   - runs the Cloudflare tunnel and pushes the rotating link to Telegram
 *
 * Fully isolated: it only READS the bot's log files and never imports bot code.
 */

import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { URL } from "url";
import CONFIG from "./config";
import { loadRecords } from "./dataSource";
import { overview, perMarketType, daily, dailyByType } from "./analytics";
import { analyzeOverall, analyzeMarket } from "./heuristics";
import { analyzeWithAI } from "./aiAnalysis";
import TunnelManager from "./tunnel";
import { sendDashboardLink } from "./telegram";
import { MarketRecord } from "./types";

const PUBLIC_DIR = path.join(__dirname, "..", "public");

// ── Lightweight record cache (files are small; reload at most every 2s) ───────
let cache: { at: number; records: MarketRecord[] } | null = null;
function records(): MarketRecord[] {
  if (!cache || Date.now() - cache.at > 2000) {
    cache = { at: Date.now(), records: loadRecords() };
  }
  return cache.records;
}

const tunnel = new TunnelManager(CONFIG.port);

// ── Helpers ───────────────────────────────────────────────────────────────────
function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(data);
}

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function serveStatic(res: http.ServerResponse, pathname: string): void {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.join(PUBLIC_DIR, rel);
  // Prevent path traversal.
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(buf);
  });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(body));
  });
}

// ── Router ────────────────────────────────────────────────────────────────────
async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const p = url.pathname;
  const recs = records();

  if (p === "/api/overview") {
    return sendJson(res, 200, {
      overview: overview(recs),
      byMarketType: perMarketType(recs),
      readiness: analyzeOverall(recs).readiness,
      tunnelUrl: tunnel.getUrl(),
      tunnelStatus: tunnel.getStatus(),
      aiEnabled: CONFIG.ai.enabled,
      sinceDate: CONFIG.sinceDate,
    });
  }

  if (p === "/api/daily") {
    return sendJson(res, 200, daily(recs));
  }

  if (p.startsWith("/api/daily/")) {
    const date = decodeURIComponent(p.slice("/api/daily/".length));
    return sendJson(res, 200, {
      date,
      byMarketType: dailyByType(recs, date),
      markets: recs.filter((r) => r.date === date).sort((a, b) => b.timestamp - a.timestamp),
    });
  }

  if (p === "/api/markets") {
    const type = url.searchParams.get("type");
    const result = (type ? recs.filter((r) => r.marketType === type) : recs)
      .slice()
      .sort((a, b) => b.timestamp - a.timestamp);
    return sendJson(res, 200, result);
  }

  if (p.startsWith("/api/market/")) {
    const id = decodeURIComponent(p.slice("/api/market/".length));
    const rec = recs.find((r) => r.conditionId === id);
    if (!rec) return sendJson(res, 404, { error: "Market not found" });
    return sendJson(res, 200, { market: rec, analysis: analyzeMarket(rec, recs) });
  }

  if (p === "/api/analysis") {
    return sendJson(res, 200, analyzeOverall(recs));
  }

  if (p === "/api/analysis/ai") {
    if (!CONFIG.ai.enabled) {
      return sendJson(res, 400, { error: "AI disabled. Set ANTHROPIC_API_KEY in analytics/.env." });
    }
    try {
      const text = await analyzeWithAI(recs);
      return sendJson(res, 200, { text });
    } catch (e) {
      return sendJson(res, 502, { error: (e as Error).message });
    }
  }

  if (p === "/api/tunnel") {
    return sendJson(res, 200, { url: tunnel.getUrl(), status: tunnel.getStatus() });
  }

  if (p === "/api/tunnel/rotate" && req.method === "POST") {
    await readBody(req);
    tunnel.rotate("manual refresh from dashboard");
    return sendJson(res, 200, { ok: true, message: "Rotating tunnel — new link will appear shortly and be sent to Telegram." });
  }

  return sendJson(res, 404, { error: "Unknown endpoint" });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${CONFIG.port}`);
  if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url).catch((e) => sendJson(res, 500, { error: (e as Error).message }));
  } else {
    serveStatic(res, url.pathname);
  }
});

server.listen(CONFIG.port, () => {
  console.log(`\n📊 BetaBot Analytics dashboard → http://localhost:${CONFIG.port}`);
  console.log(`   Data source: ${CONFIG.paperLogDir}`);
  console.log(`   AI analysis: ${CONFIG.ai.enabled ? `enabled (${CONFIG.ai.model})` : "disabled (heuristics only)"}`);
  console.log(`   Telegram:    ${CONFIG.telegram.enabled ? "enabled" : "disabled"}`);

  // Push the tunnel link to Telegram — but ONLY when it's verified reachable,
  // de-duplicated, and at most once per cooldown window. This stops both the
  // "broken link sent to Telegram" and the rotation spam.
  let lastSentUrl: string | null = null;
  let lastSentAt = 0;
  const LINK_COOLDOWN_MS = 10 * 60 * 1000; // never re-announce more than once per 10 min
  tunnel.onUrl((url, verified) => {
    if (!verified) {
      console.log(`[tunnel] not announcing unverified link to Telegram: ${url}`);
      return;
    }
    const now = Date.now();
    if (url === lastSentUrl) return; // same link, already sent
    if (now - lastSentAt < LINK_COOLDOWN_MS && lastSentUrl !== null) {
      console.log(`[tunnel] link changed but within cooldown; skipping Telegram announce`);
      lastSentUrl = url;
      return;
    }
    lastSentUrl = url;
    lastSentAt = now;
    void sendDashboardLink(url, "Dashboard link");
  });
  tunnel.start();
});

function shutdown(): void {
  console.log("\nShutting down analytics dashboard...");
  tunnel.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
