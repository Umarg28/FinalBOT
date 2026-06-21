/**
 * Cloudflare quick-tunnel manager.
 *
 * Spawns `cloudflared tunnel --url http://localhost:PORT` and only publishes the
 * trycloudflare URL once the tunnel is actually CONNECTED to Cloudflare's edge —
 * detected from cloudflared's own "Registered tunnel connection" log. cloudflared
 * prints the URL before the edge route is ready, so announcing it immediately
 * gives a dead link; waiting for the connection log is the reliable signal and,
 * unlike an HTTP self-probe, it isn't defeated by router hairpin-NAT or firewalls.
 *
 * The published link is pushed to listeners (Telegram / dashboard) exactly once
 * per URL. If cloudflared exits, we respawn. Optional time-based rotation only.
 */

import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import CONFIG from "./config";

/**
 * Resolve the cloudflared binary. When launched from a GUI / non-login shell the
 * PATH often omits Homebrew dirs, so `spawn("cloudflared")` fails with ENOENT and
 * the tunnel silently never starts. Try common install locations explicitly.
 */
function resolveCloudflared(): string {
  const candidates = [
    process.env.CLOUDFLARED_PATH,
    "/opt/homebrew/bin/cloudflared",
    "/usr/local/bin/cloudflared",
    "/usr/bin/cloudflared",
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return "cloudflared"; // fall back to PATH lookup
}

type UrlListener = (url: string, verified: boolean) => void;
export type TunnelStatus = "disabled" | "starting" | "validating" | "live" | "down";

export class TunnelManager {
  private proc: ChildProcess | null = null;
  private currentUrl: string | null = null; // published (connected) URL
  private pendingUrl: string | null = null; // parsed, awaiting connection
  private connectionRegistered = false;
  private status: TunnelStatus = "starting";
  private listeners: UrlListener[] = [];
  private rotateTimer: NodeJS.Timeout | null = null;
  private fallbackTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  // If cloudflared never logs a connection within this window, fall back to a
  // single HTTP probe and then publish best-effort so the user still gets a link.
  private static readonly CONNECT_FALLBACK_MS = 25_000;
  private static readonly PROBE_TIMEOUT_MS = 8000;

  constructor(private port: number) {}

  getUrl(): string | null {
    return this.currentUrl;
  }

  getStatus(): TunnelStatus {
    return CONFIG.tunnel.disabled ? "disabled" : this.status;
  }

  onUrl(listener: UrlListener): void {
    this.listeners.push(listener);
  }

  start(): void {
    if (CONFIG.tunnel.disabled) {
      this.status = "disabled";
      console.log("[tunnel] disabled via DISABLE_CLOUDFLARE_TUNNEL");
      return;
    }
    this.stopped = false;
    this.spawnProcess();
    if (CONFIG.tunnel.rotateMinutes > 0) {
      this.rotateTimer = setInterval(
        () => this.rotate("scheduled rotation"),
        CONFIG.tunnel.rotateMinutes * 60_000
      );
    }
  }

  /** One-shot HTTP reachability probe (best-effort fallback only). */
  private async probe(url: string): Promise<boolean> {
    if (typeof fetch !== "function") return false;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), TunnelManager.PROBE_TIMEOUT_MS);
      const res = await fetch(`${url}/api/tunnel`, { signal: ctrl.signal, redirect: "follow" });
      clearTimeout(t);
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Publish a URL: set it live, notify listeners (Telegram / dashboard) once. */
  private publish(url: string, verified: boolean): void {
    if (this.currentUrl === url) return; // already published
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    this.currentUrl = url;
    this.pendingUrl = null;
    this.status = "live";
    console.log(`[tunnel] ${verified ? "✅ live & connected" : "⚠️ published best-effort (no connection log seen)"}: ${url}`);
    for (const l of this.listeners) {
      try {
        l(url, verified);
      } catch (e) {
        console.warn(`[tunnel] listener error: ${(e as Error).message}`);
      }
    }
  }

  /** Manual or scheduled rotation: kill the current tunnel and start a fresh one. */
  rotate(reason = "manual rotation"): void {
    if (CONFIG.tunnel.disabled) return;
    console.log(`[tunnel] rotating (${reason})`);
    this.resetState();
    if (this.proc) {
      this.proc.removeAllListeners("exit");
      this.proc.kill();
      this.proc = null;
    }
    this.spawnProcess();
  }

  stop(): void {
    this.stopped = true;
    if (this.rotateTimer) clearInterval(this.rotateTimer);
    if (this.fallbackTimer) clearTimeout(this.fallbackTimer);
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }

  private resetState(): void {
    this.currentUrl = null;
    this.pendingUrl = null;
    this.connectionRegistered = false;
    this.status = "starting";
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
  }

  private maybePublish(): void {
    if (this.pendingUrl && this.connectionRegistered && this.currentUrl !== this.pendingUrl) {
      this.publish(this.pendingUrl, true);
    }
  }

  private spawnProcess(): void {
    let proc: ChildProcess;
    this.status = "starting";
    const bin = resolveCloudflared();
    try {
      proc = spawn(bin, ["tunnel", "--url", `http://localhost:${this.port}`], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      this.status = "down";
      console.warn(`[tunnel] failed to spawn cloudflared (${bin}): ${(err as Error).message}. Install it: brew install cloudflared`);
      return;
    }
    this.proc = proc;

    const onData = (buf: Buffer) => {
      const text = buf.toString();

      // 1. Capture the public URL.
      const url = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i)?.[0];
      if (url && url !== this.currentUrl && url !== this.pendingUrl) {
        this.pendingUrl = url;
        this.connectionRegistered = false;
        this.status = "validating";
        console.log(`[tunnel] URL reported: ${url} — waiting for edge connection before publishing`);

        // Fallback: if no connection log appears, probe once then publish best-effort.
        if (this.fallbackTimer) clearTimeout(this.fallbackTimer);
        this.fallbackTimer = setTimeout(async () => {
          if (this.stopped || this.pendingUrl !== url || this.currentUrl === url) return;
          const ok = await this.probe(url);
          if (this.pendingUrl === url && this.currentUrl !== url) {
            this.publish(url, ok);
          }
        }, TunnelManager.CONNECT_FALLBACK_MS);
        this.maybePublish();
      }

      // 2. Detect the edge connection being registered (the reliable "it's live" signal).
      if (/registered tunnel connection|Connection [0-9a-fz-]+ registered|connection established/i.test(text)) {
        if (!this.connectionRegistered) {
          this.connectionRegistered = true;
          console.log(`[tunnel] edge connection registered`);
        }
        this.maybePublish();
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData); // cloudflared logs to stderr

    proc.on("error", (err) => {
      this.status = "down";
      console.warn(`[tunnel] process error: ${err.message}`);
    });
    proc.on("exit", (code) => {
      this.resetState();
      if (this.stopped) return;
      this.status = "down";
      console.warn(`[tunnel] cloudflared exited (code ${code}); respawning in 3s`);
      setTimeout(() => {
        if (!this.stopped) this.spawnProcess();
      }, 3000);
    });
  }
}

export default TunnelManager;
