/**
 * Configuration + tiny zero-dependency .env loader.
 *
 * Reads analytics/.env (if present) into process.env, then exposes a typed
 * CONFIG object. Kept dependency-free so the analytics module installs lean and
 * stays fully isolated from the main bot.
 */

import * as fs from "fs";
import * as path from "path";

function loadDotEnv(): void {
  const envPath = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadDotEnv();

const ROOT = path.join(__dirname, "..", ".."); // FinalBOT root

function num(key: string, def: number): number {
  const v = process.env[key];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : def;
}
function bool(key: string, def: boolean): boolean {
  const v = process.env[key];
  if (v === undefined) return def;
  return v.toLowerCase() === "true";
}

/** Today's date (YYYY-MM-DD) in Eastern Time — the bot's market clock. */
function todayET(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export const CONFIG = {
  port: num("ANALYTICS_PORT", 4100),

  // Read-only data sources (the bot's paper logs).
  paperLogDir: process.env.PAPER_LOG_DIR || path.join(ROOT, "logs", "paper"),
  rebalanceConfigPath: path.join(ROOT, "inventory-rebalance-config.yaml"),

  // Ignore markets settled before this ET date. Defaults to today so stale
  // historical runs don't pollute the numbers. Set ANALYTICS_SINCE_DATE=YYYY-MM-DD
  // to include older data, or "all" to disable the cutoff entirely.
  sinceDate: process.env.ANALYTICS_SINCE_DATE || todayET(),

  tunnel: {
    disabled: bool("DISABLE_CLOUDFLARE_TUNNEL", false),
    rotateMinutes: num("TUNNEL_ROTATE_MINUTES", 0),
  },

  telegram: {
    // Defaults to the bot's existing Telegram credentials so the rotating link
    // is sent without extra setup. Override in analytics/.env to use a different
    // chat, or set TELEGRAM_BOT_TOKEN="" to disable.
    botToken:
      process.env.TELEGRAM_BOT_TOKEN ??
      "8392038727:AAEDlzrQ8E1FPY6uh-cu8OEsayTtZQQTE9w",
    chatId: process.env.TELEGRAM_CHAT_ID ?? "7914196017",
    get enabled() {
      return Boolean(this.botToken && this.chatId);
    },
  },

  ai: {
    apiKey: process.env.ANTHROPIC_API_KEY || "",
    model: process.env.ANTHROPIC_MODEL || "claude-opus-4-8",
    get enabled() {
      return Boolean(this.apiKey);
    },
  },
};

export default CONFIG;
