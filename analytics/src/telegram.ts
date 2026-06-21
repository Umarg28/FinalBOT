/**
 * Minimal Telegram notifier - sends the rotating dashboard link (no inline
 * buttons / no listener process, per the chosen design). Uses the Bot API over
 * https with zero dependencies. Disabled automatically if token/chat are unset.
 */

import https from "https";
import CONFIG from "./config";

function post(method: string, payload: Record<string, unknown>): Promise<boolean> {
  return new Promise((resolve) => {
    const data = JSON.stringify(payload);
    const req = https.request(
      `https://api.telegram.org/bot${CONFIG.telegram.botToken}/${method}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );
    req.on("error", () => resolve(false));
    req.write(data);
    req.end();
  });
}

export async function sendDashboardLink(url: string, note = ""): Promise<void> {
  if (!CONFIG.telegram.enabled) return;
  const text =
    `📊 <b>BetaBot Analytics Dashboard</b>\n\n` +
    `🌐 <a href="${url}">${url}</a>\n` +
    (note ? `\n<i>${note}</i>\n` : "") +
    `\n<i>Quick tunnels rotate periodically — this link updates automatically when it changes.</i>`;
  await post("sendMessage", {
    chat_id: CONFIG.telegram.chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}

export async function sendMessage(text: string): Promise<void> {
  if (!CONFIG.telegram.enabled) return;
  await post("sendMessage", { chat_id: CONFIG.telegram.chatId, text, parse_mode: "HTML" });
}
