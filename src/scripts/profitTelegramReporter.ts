/**
 * Profit Telegram Reporter (standalone)
 *
 * Reads the bot's PnL history files (logs/paper/pnl_history*.json) and posts a
 * single live "scoreboard" message to a Telegram chat that gets edited in
 * place every refresh interval. Does NOT touch any bot trading logic — purely
 * a read-only watcher.
 *
 * Run with:  npm run profits
 *
 * Configuration via env vars (or hard-coded defaults below):
 *   TELEGRAM_PROFIT_CHAT_ID   chat ID to post to (negative for groups)
 *   TELEGRAM_PROFIT_INTERVAL  refresh interval in ms (default 15000)
 *   TELEGRAM_BOT_TOKEN        override bot token
 *   PAPER_LOG_DIR             override paper log directory (default logs/paper)
 */

import https from 'https';
import fs from 'fs';
import path from 'path';

// ---------- config ----------
const BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN ||
  '8392038727:AAEDlzrQ8E1FPY6uh-cu8OEsayTtZQQTE9w';

// Default to admin chat until a shared group chat ID is provided
const CHAT_ID = process.env.TELEGRAM_PROFIT_CHAT_ID || '7914196017';

const REFRESH_MS = Number(process.env.TELEGRAM_PROFIT_INTERVAL || 15_000);

const PAPER_DIR =
  process.env.PAPER_LOG_DIR || path.resolve(process.cwd(), 'logs', 'paper');

const STATE_FILE = path.join(PAPER_DIR, 'profit_telegram_state.json');

// ---------- types ----------
interface PnLEntry {
  marketName: string;
  conditionId: string;
  totalPnl: number;
  pnlPercent: number;
  priceUp: number;
  priceDown: number;
  sharesUp: number;
  sharesDown: number;
  timestamp: number;
}

interface ReporterState {
  chatId: string;
  messageId?: number;
  lastText?: string;
}

// ---------- telegram helpers ----------
function tgRequest(method: string, payload: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
    const req = https.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            if (parsed.ok) {
              resolve(parsed.result);
            } else {
              reject(new Error(`${method} failed: ${parsed.description || body}`));
            }
          } catch (e) {
            reject(new Error(`${method} parse error: ${(e as Error).message}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function sendMessage(text: string): Promise<number> {
  const result = await tgRequest('sendMessage', {
    chat_id: CHAT_ID,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    disable_notification: true,
  });
  return result.message_id;
}

async function editMessage(messageId: number, text: string): Promise<void> {
  await tgRequest('editMessageText', {
    chat_id: CHAT_ID,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
}

// ---------- state persistence ----------
function loadState(): ReporterState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as ReporterState;
      // If the chat ID was changed, drop the old message ID so we post a fresh
      // message in the new chat instead of trying to edit a message that
      // doesn't exist there.
      if (parsed.chatId === CHAT_ID) return parsed;
    }
  } catch {
    /* ignore */
  }
  return { chatId: CHAT_ID };
}

function saveState(state: ReporterState): void {
  try {
    if (!fs.existsSync(PAPER_DIR)) fs.mkdirSync(PAPER_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.error('[profits] failed to save state:', err);
  }
}

// ---------- pnl loading ----------
function readJsonArray(filePath: string): PnLEntry[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PnLEntry[]) : [];
  } catch {
    return [];
  }
}

function loadAllEntries(): PnLEntry[] {
  if (!fs.existsSync(PAPER_DIR)) return [];

  const seen = new Map<string, PnLEntry>();
  const files = fs.readdirSync(PAPER_DIR).filter((f) => /^pnl_history.*\.json$/.test(f));

  for (const file of files) {
    const entries = readJsonArray(path.join(PAPER_DIR, file));
    for (const entry of entries) {
      if (!entry || typeof entry.totalPnl !== 'number' || !entry.conditionId) continue;
      // Keep the latest record per conditionId (handles main file + daily file
      // duplicates without double-counting).
      const existing = seen.get(entry.conditionId);
      if (!existing || (entry.timestamp || 0) >= (existing.timestamp || 0)) {
        seen.set(entry.conditionId, entry);
      }
    }
  }

  return Array.from(seen.values()).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
}

// ---------- formatting ----------
const ET = 'America/New_York';

function isToday(ts: number): boolean {
  const d = new Date(ts);
  const now = new Date();
  // Compare in ET so "today" matches what the trader sees on the dashboard.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: ET,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(d) === fmt.format(now);
}

function fmtMoney(n: number): string {
  const sign = n > 0 ? '+' : n < 0 ? '−' : ' ';
  const abs = Math.abs(n);
  return `${sign}$${abs.toFixed(2)}`;
}

function fmtTimeET(ts: number): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: ET,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(ts));
}

type Frame = '5m' | '15m' | '1h' | 'other';

function classifyAsset(name: string): 'BTC' | 'ETH' | 'OTHER' {
  if (/bitcoin/i.test(name)) return 'BTC';
  if (/ethereum/i.test(name)) return 'ETH';
  return 'OTHER';
}

function classifyFrame(name: string): Frame {
  // Hourly title shape: "April 27, 3PM ET" (no minute window)
  if (/\d{1,2}(AM|PM)\s*ET/i.test(name) && !/\d{1,2}:\d{2}/.test(name)) return '1h';
  const m = name.match(/(\d{1,2}):(\d{2})\s*(?:AM|PM)?\s*-\s*(\d{1,2}):(\d{2})\s*(?:AM|PM)?/i);
  if (m) {
    const startMin = parseInt(m[2], 10);
    const endMin = parseInt(m[4], 10);
    let diff = endMin - startMin;
    if (diff < 0) diff += 60;
    if (diff === 5) return '5m';
    if (diff === 15) return '15m';
    if (diff === 60) return '1h';
    if (diff === 0) {
      const sH = parseInt(m[1], 10);
      const eH = parseInt(m[3], 10);
      if (sH !== eH) return '1h';
    }
  }
  return 'other';
}

function shortMarketName(name: string): string {
  const asset = classifyAsset(name);
  const windowMatch = name.match(/(\d{1,2}:\d{2})\s*([AP]M)?\s*-\s*(\d{1,2}:\d{2})/i);
  if (windowMatch) return `${asset} ${windowMatch[1]}-${windowMatch[3]}`;
  const hourMatch = name.match(/(\d{1,2})(AM|PM)\s*ET/i);
  if (hourMatch) return `${asset} ${hourMatch[1]}${hourMatch[2].toUpperCase()}`;
  return asset;
}

function tally(entries: PnLEntry[]): { wins: number; losses: number; flat: number; total: number } {
  let wins = 0,
    losses = 0,
    flat = 0,
    total = 0;
  for (const e of entries) {
    total += e.totalPnl;
    if (e.totalPnl > 0.005) wins++;
    else if (e.totalPnl < -0.005) losses++;
    else flat++;
  }
  return { wins, losses, flat, total };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

interface GroupKey {
  asset: 'BTC' | 'ETH' | 'OTHER';
  frame: Frame;
}

function groupLabel(g: GroupKey): string {
  const frameLabel =
    g.frame === '5m' ? '5m' : g.frame === '15m' ? '15m' : g.frame === '1h' ? '1h' : '?';
  return `${g.asset.padEnd(3, ' ')} ${frameLabel.padEnd(3, ' ')}`;
}

function groupEntries(entries: PnLEntry[]): Map<string, { key: GroupKey; entries: PnLEntry[] }> {
  const groups = new Map<string, { key: GroupKey; entries: PnLEntry[] }>();
  for (const e of entries) {
    const key: GroupKey = { asset: classifyAsset(e.marketName), frame: classifyFrame(e.marketName) };
    const id = `${key.asset}-${key.frame}`;
    if (!groups.has(id)) groups.set(id, { key, entries: [] });
    groups.get(id)!.entries.push(e);
  }
  return groups;
}

// Stable display order: 5m → 15m → 1h, BTC before ETH inside each frame
const GROUP_ORDER: Array<[GroupKey['asset'], Frame]> = [
  ['BTC', '5m'], ['ETH', '5m'],
  ['BTC', '15m'], ['ETH', '15m'],
  ['BTC', '1h'], ['ETH', '1h'],
  ['BTC', 'other'], ['ETH', 'other'], ['OTHER', 'other'],
];

function orderedGroupIds(): string[] {
  return GROUP_ORDER.map(([a, f]) => `${a}-${f}`);
}

function buildMessage(entries: PnLEntry[]): string {
  const all = tally(entries);
  const todayEntries = entries.filter((e) => isToday(e.timestamp));
  const today = tally(todayEntries);

  const allWinRate = all.wins + all.losses > 0 ? (all.wins / (all.wins + all.losses)) * 100 : 0;
  const todayWinRate =
    today.wins + today.losses > 0 ? (today.wins / (today.wins + today.losses)) * 100 : 0;

  const totalEmoji = all.total >= 0 ? '🟢' : '🔴';
  const todayEmoji = today.total >= 0 ? '📈' : '📉';

  const lines: string[] = [];
  lines.push(`${totalEmoji} <b>BETABOT P&amp;L · LIVE</b>`);
  lines.push('━━━━━━━━━━━━━━━━━━━━');
  lines.push(`💰 <b>ALL-TIME:</b> <b>${fmtMoney(all.total)}</b>`);
  lines.push(`   ${all.wins}W / ${all.losses}L  (${allWinRate.toFixed(1)}%)`);
  lines.push(`${todayEmoji} <b>TODAY:</b> <b>${fmtMoney(today.total)}</b>`);
  lines.push(`   ${today.wins}W / ${today.losses}L  (${todayWinRate.toFixed(1)}%)`);
  lines.push('━━━━━━━━━━━━━━━━━━━━');

  if (todayEntries.length === 0) {
    lines.push('<i>No markets resolved today yet…</i>');
  } else {
    lines.push(`<b>TODAY BY MARKET TYPE</b>`);
    const todayGroups = groupEntries(todayEntries);
    for (const id of orderedGroupIds()) {
      const g = todayGroups.get(id);
      if (!g || g.entries.length === 0) continue;
      const t = tally(g.entries);
      const wr = t.wins + t.losses > 0 ? (t.wins / (t.wins + t.losses)) * 100 : 0;
      const icon = t.total >= 0 ? '🟢' : '🔴';
      const money = fmtMoney(t.total).padStart(9, ' ');
      lines.push(
        `${icon} <code>${money}</code>  ${groupLabel(g.key)}  ${String(t.wins).padStart(2)}W/${String(t.losses).padStart(2)}L  ${wr.toFixed(0).padStart(3)}%`,
      );
    }

    lines.push('');
    const wins = todayEntries.filter((e) => e.totalPnl > 0.005).sort((a, b) => b.totalPnl - a.totalPnl).slice(0, 3);
    const losses = todayEntries.filter((e) => e.totalPnl < -0.005).sort((a, b) => a.totalPnl - b.totalPnl).slice(0, 3);

    if (wins.length > 0) {
      lines.push(`<b>TOP WINS TODAY</b>`);
      for (const w of wins) {
        const money = fmtMoney(w.totalPnl).padStart(9, ' ');
        const name = escapeHtml(shortMarketName(w.marketName));
        lines.push(`✅ <code>${money}</code>  ${name}  <i>${fmtTimeET(w.timestamp)}</i>`);
      }
    }
    if (losses.length > 0) {
      lines.push(`<b>WORST TODAY</b>`);
      for (const l of losses) {
        const money = fmtMoney(l.totalPnl).padStart(9, ' ');
        const name = escapeHtml(shortMarketName(l.marketName));
        lines.push(`❌ <code>${money}</code>  ${name}  <i>${fmtTimeET(l.timestamp)}</i>`);
      }
    }
  }

  lines.push('━━━━━━━━━━━━━━━━━━━━');
  lines.push(`🕒 Updated ${fmtTimeET(Date.now())} ET`);

  return lines.join('\n');
}

// ---------- main loop ----------
let state: ReporterState = loadState();
let lastErrorAt = 0;

async function tick(): Promise<void> {
  try {
    const entries = loadAllEntries();
    const text = buildMessage(entries);

    // Don't bother editing if nothing has changed (Telegram returns an error
    // for "message is not modified" anyway).
    if (text === state.lastText && state.messageId) return;

    if (state.messageId) {
      try {
        await editMessage(state.messageId, text);
        state.lastText = text;
        saveState(state);
        return;
      } catch (err) {
        const msg = (err as Error).message || '';
        if (/message is not modified/i.test(msg)) {
          state.lastText = text;
          saveState(state);
          return;
        }
        if (
          /message to edit not found/i.test(msg) ||
          /chat not found/i.test(msg) ||
          /MESSAGE_ID_INVALID/i.test(msg)
        ) {
          // Old message gone — fall through to send a fresh one
          state.messageId = undefined;
        } else {
          throw err;
        }
      }
    }

    const newId = await sendMessage(text);
    state = { chatId: CHAT_ID, messageId: newId, lastText: text };
    saveState(state);
    console.log(`[profits] posted new live message id=${newId} to chat ${CHAT_ID}`);
  } catch (err) {
    const now = Date.now();
    if (now - lastErrorAt > 60_000) {
      console.error('[profits] tick failed:', (err as Error).message);
      lastErrorAt = now;
    }
  }
}

async function main(): Promise<void> {
  console.log('[profits] starting live profit reporter');
  console.log(`[profits] chat=${CHAT_ID}  refresh=${REFRESH_MS}ms  paperDir=${PAPER_DIR}`);

  if (!fs.existsSync(PAPER_DIR)) {
    console.warn(`[profits] paper directory does not exist yet: ${PAPER_DIR}`);
  }

  await tick();
  setInterval(tick, REFRESH_MS);
}

process.on('SIGINT', () => {
  console.log('\n[profits] stopped.');
  process.exit(0);
});

main().catch((err) => {
  console.error('[profits] fatal:', err);
  process.exit(1);
});
