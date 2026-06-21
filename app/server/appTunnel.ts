import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import https from "https";

type UrlListener = (url: string) => void;

function resolveCloudflared(): string {
  const candidates = [
    process.env.CLOUDFLARED_PATH,
    "/opt/homebrew/bin/cloudflared",
    "/usr/local/bin/cloudflared",
    "/usr/bin/cloudflared",
  ].filter(Boolean) as string[];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  return "cloudflared";
}

function sendTelegram(text: string): Promise<boolean> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN || "8392038727:AAEDlzrQ8E1FPY6uh-cu8OEsayTtZQQTE9w";
  const chatId = process.env.TELEGRAM_CHAT_ID || "7914196017";
  if (!botToken || !chatId) return Promise.resolve(false);

  return new Promise((resolve) => {
    const data = JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
    const req = https.request(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
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

export class AppTunnelManager {
  private proc: ChildProcess | null = null;
  private currentUrl: string | null = null;
  private pendingUrl: string | null = null;
  private connectionRegistered = false;
  private validationInFlight: Promise<void> | null = null;
  private listeners: UrlListener[] = [];
  private stopped = false;
  private announcedUrl: string | null = null;

  private static readonly PROBE_ATTEMPTS = 48;
  private static readonly PROBE_DELAY_MS = 5000;
  private static readonly PROBE_TIMEOUT_MS = 8000;

  constructor(private port: number) {}

  getUrl(): string | null {
    return this.currentUrl;
  }

  onUrl(listener: UrlListener): void {
    this.listeners.push(listener);
  }

  start(): void {
    if ((process.env.DISABLE_CLOUDFLARE_TUNNEL || "false").toLowerCase() === "true") {
      console.log("[APP-TUNNEL] disabled via DISABLE_CLOUDFLARE_TUNNEL=true");
      return;
    }
    this.stopped = false;
    this.spawn();
  }

  stop(): void {
    this.stopped = true;
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }

  rotate(reason = "manual rotation"): void {
    console.log(`[APP-TUNNEL] rotating (${reason})`);
    if (this.proc) {
      this.proc.removeAllListeners("exit");
      this.proc.kill();
      this.proc = null;
    }
    this.currentUrl = null;
    this.pendingUrl = null;
    this.connectionRegistered = false;
    this.validationInFlight = null;
    this.spawn();
  }

  private spawn(): void {
    const bin = resolveCloudflared();
    try {
      this.proc = spawn(bin, ["tunnel", "--url", `http://localhost:${this.port}`], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      console.warn(`[APP-TUNNEL] failed to start cloudflared: ${(error as Error).message}`);
      return;
    }

    const onData = (buf: Buffer) => {
      const text = buf.toString();
      const url = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i)?.[0];
      if (url && url !== this.pendingUrl && url !== this.currentUrl) {
        this.pendingUrl = url;
        this.connectionRegistered = false;
        console.log(`[APP-TUNNEL] URL reported: ${url}; validating webapp before sending`);
      }

      if (/registered tunnel connection|Connection [0-9a-fz-]+ registered|connection established/i.test(text)) {
        this.connectionRegistered = true;
        this.validateIfReady();
      }
    };

    this.proc.stdout?.on("data", onData);
    this.proc.stderr?.on("data", onData);
    this.proc.on("error", (error) => console.warn(`[APP-TUNNEL] process error: ${error.message}`));
    this.proc.on("exit", (code) => {
      if (this.stopped) return;
      console.warn(`[APP-TUNNEL] cloudflared exited (${code}); respawning in 5s`);
      setTimeout(() => {
        if (!this.stopped) this.spawn();
      }, 5000);
    });
  }

  private validateIfReady(): void {
    if (!this.pendingUrl || !this.connectionRegistered || this.validationInFlight) return;
    const url = this.pendingUrl;
    this.validationInFlight = (async () => {
      for (let attempt = 1; attempt <= AppTunnelManager.PROBE_ATTEMPTS; attempt++) {
        if (this.stopped || this.pendingUrl !== url) return;
        if (await this.probe(url)) {
          this.publish(url);
          return;
        }
        console.log(`[APP-TUNNEL] webapp probe failed (${attempt}/${AppTunnelManager.PROBE_ATTEMPTS}): ${url}`);
        await this.sleep(AppTunnelManager.PROBE_DELAY_MS);
      }
      console.warn(`[APP-TUNNEL] webapp still unreachable; keeping tunnel alive and retrying: ${url}`);
      this.validationInFlight = null;
      setTimeout(() => this.validateIfReady(), 30_000);
    })().finally(() => {
      if (this.validationInFlight) this.validationInFlight = null;
    });
  }

  private async probe(url: string): Promise<boolean> {
    if (typeof fetch !== "function") return false;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), AppTunnelManager.PROBE_TIMEOUT_MS);
      const response = await fetch(`${url}/api/health`, {
        signal: controller.signal,
        redirect: "follow",
      });
      clearTimeout(timeout);
      return response.ok;
    } catch {
      return false;
    }
  }

  private publish(url: string): void {
    if (this.currentUrl === url) return;
    this.currentUrl = url;
    this.pendingUrl = null;
    console.log(`[APP-TUNNEL] ✅ webapp live: ${url}`);
    for (const listener of this.listeners) {
      try {
        listener(url);
      } catch {
        // ignore listener failures
      }
    }
    if (this.announcedUrl !== url) {
      this.announcedUrl = url;
      void sendTelegram(
        `🌐 <b>BETABOT Webapp</b>\n\n<a href="${url}">${url}</a>\n\n<i>Main dashboard with AI analysis. Link is sent only after the webapp loads.</i>`
      );
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export default AppTunnelManager;
