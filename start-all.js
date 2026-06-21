#!/usr/bin/env node
/**
 * Unified launcher: starts the trading bot AND the analytics dashboard
 * (with its Cloudflare tunnel + Telegram link) in a single command. Used by:
 *   - `npm run start`  → compiled bot (dist) + analytics
 *   - `npm run paper`  → ts-node bot in PAPER_MODE + analytics (no build needed)
 *
 * The bot is given the REAL terminal (stdio: inherit) so its live dashboard
 * renders exactly as if run on its own. The quieter analytics output is written
 * to logs/analytics.log so it doesn't fight the bot for the screen. The
 * analytics dashboard only READS the bot's logs/paper files, so both share the
 * exact same paper data and a crash of one never takes down the other.
 *
 * Env flags:
 *   START_ANALYTICS=false  → run the bot alone
 *   BOT_TS_NODE=true       → run the bot via ts-node (paper/dev, no build)
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const startAnalytics = (process.env.START_ANALYTICS ?? "false").toLowerCase() === "true";
const botTsNode = (process.env.BOT_TS_NODE ?? "false").toLowerCase() === "true";

const children = [];

// ── Analytics dashboard (optional) → log file ─────────────────────────────────
// Prefers the compiled build; falls back to ts-node so the paper/dev workflow
// works without a build step.
if (startAnalytics) {
  const compiled = path.join(ROOT, "analytics", "dist", "server.js");
  const tsEntry = path.join(ROOT, "analytics", "src", "server.ts");
  let cmd, args;
  if (fs.existsSync(compiled)) {
    cmd = process.execPath;
    args = [compiled];
  } else if (fs.existsSync(tsEntry)) {
    cmd = process.execPath;
    args = ["-r", "ts-node/register", tsEntry];
  }

  if (cmd) {
    const logsDir = path.join(ROOT, "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    const logPath = path.join(logsDir, "analytics.log");
    const logStream = fs.createWriteStream(logPath, { flags: "a" });
    logStream.write(`\n=== analytics started ${new Date().toISOString()} ===\n`);

    const analytics = spawn(cmd, args, {
      cwd: path.join(ROOT, "analytics"),
      env: { ...process.env, TS_NODE_TRANSPILE_ONLY: "true" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    analytics.stdout.pipe(logStream);
    analytics.stderr.pipe(logStream);
    children.push({ name: "analytics", child: analytics });

    console.log(`📊 Analytics dashboard → http://localhost:${process.env.ANALYTICS_PORT || 4100}`);
    console.log(`   (output → ${path.relative(ROOT, logPath)}; tunnel link is sent to Telegram)\n`);
  } else {
    console.warn(`\n⚠️  Analytics entrypoint not found. Skipping. (START_ANALYTICS=false to silence.)\n`);
  }
}

// ── Bot → inherits the real terminal so its dashboard renders ─────────────────
let botCmd, botArgs;
if (botTsNode) {
  const tsEntry = path.join(ROOT, "src", "index.ts");
  botCmd = process.execPath;
  botArgs = ["-r", "ts-node/register", tsEntry];
} else {
  const botEntry = path.join(ROOT, "dist", "src", "index.js");
  if (!fs.existsSync(botEntry)) {
    console.error(`\n❌ ${botEntry} not found. Run "npm run build" first (or use "npm run paper").\n`);
    shutdown();
    process.exit(1);
  }
  botCmd = process.execPath;
  botArgs = [botEntry];
}
const bot = spawn(botCmd, botArgs, { cwd: ROOT, env: process.env, stdio: "inherit" });
children.push({ name: "bot", child: bot });
bot.on("exit", (code) => {
  console.log(`\n[bot] exited with code ${code}`);
  shutdown();
});

// ── Clean shutdown ────────────────────────────────────────────────────────────
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children) {
    try { child.kill("SIGINT"); } catch {}
  }
  setTimeout(() => {
    for (const { child } of children) {
      try { child.kill("SIGKILL"); } catch {}
    }
    process.exit(0);
  }, 4000);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
