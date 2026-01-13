/**
 * BETABOT Web Dashboard Server
 * Serves static files and broadcasts real-time dashboard updates via WebSocket
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import { dashboardDataCollector } from './dashboardData';
import { ClientMessage, ExternalBotData, BotSummary } from './types';
import { externalWalletTracker } from './externalWalletTracker';

// Simple API key for external bot connections
// Set via DASHBOARD_API_KEY env var or use default
const API_KEY = process.env.DASHBOARD_API_KEY || 'betabot-dashboard-key';

// MIME types for static file serving
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export class AppServer {
  private httpServer: ReturnType<typeof createServer>;
  private wss: WebSocketServer;
  private clients: Set<WebSocket> = new Set();
  private updateInterval: NodeJS.Timeout | null = null;
  private port: number;
  private publicDir: string;

  // External bot data storage
  private externalBots: Map<string, {
    data: ExternalBotData;
    lastUpdate: number;
  }> = new Map();

  // Pending reset targets ('main', 'external', 'all')
  private pendingResets: Set<string> = new Set();

  // Callback for when reset is triggered
  private onResetCallback: ((target: string) => void) | null = null;

  constructor(port: number = 3000) {
    this.port = port;
    this.publicDir = path.join(__dirname, '..', 'public');

    // Create HTTP server for static files
    this.httpServer = createServer((req, res) => {
      this.handleHttpRequest(req, res);
    });

    // Create WebSocket server attached to HTTP server
    this.wss = new WebSocketServer({ server: this.httpServer });
    this.setupWebSocket();
  }

  /**
   * Start the server
   */
  start(): void {
    this.httpServer.listen(this.port, () => {
      console.log(`[APP] Dashboard available at http://localhost:${this.port}`);
      console.log(`[APP] External bots can POST to http://localhost:${this.port}/api/bot`);
      console.log(`[APP] API Key: ${API_KEY}`);
    });

    // Start tracking gabagool22 wallet for balance injection (not shown as separate bot)
    const gabagoolWallet = '0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d';
    externalWalletTracker.startTracking([gabagoolWallet], 5000); // Update every 5 seconds
    console.log(`[APP] Tracking gabagool22 wallet for balance data`);

    // Connect external bots getter to data collector (injects wallet balance into gabagool22)
    dashboardDataCollector.setExternalBotsGetter(() => this.getMergedExternalBots());

    // Start broadcasting updates every 1.5 seconds
    this.startBroadcasting();
  }

  /**
   * Get external bots with wallet balance injection
   * Uses gabagool22's submitted data but injects real wallet balance from Polymarket API
   */
  private getMergedExternalBots(): Map<string, { data: ExternalBotData; lastUpdate: number }> {
    const merged = new Map(this.externalBots);

    // Get wallet data for balance injection
    const walletBots = externalWalletTracker.getExternalBotData();

    // Inject real wallet balance into gabagool22's data
    for (const [botId, entry] of merged.entries()) {
      // Check if this bot has a linked wallet address
      const walletAddress = this.getLinkedWalletAddress(entry.data.botName);
      if (walletAddress) {
        const walletData = walletBots.get(walletAddress.toLowerCase());
        if (walletData) {
          // Inject the real balance from wallet tracker
          entry.data.portfolio.balance = walletData.data.portfolio.balance;
        }
      }
    }

    return merged;
  }

  /**
   * Get linked wallet address for a bot name
   */
  private getLinkedWalletAddress(botName: string): string | null {
    // Map bot names to their wallet addresses
    const walletMap: Record<string, string> = {
      'gabagool22': '0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d',
      'EdgeBotPro': '0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d',
      'edgebotpro': '0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d',
    };
    return walletMap[botName] || walletMap[botName.toLowerCase()] || null;
  }

  /**
   * Stop the server
   */
  stop(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }

    // Stop wallet tracker
    externalWalletTracker.stopTracking();

    // Close all client connections
    for (const client of this.clients) {
      client.close();
    }
    this.clients.clear();

    this.wss.close();
    this.httpServer.close();
    console.log('[APP] Dashboard server stopped');
  }

  /**
   * Get the data collector for external configuration
   */
  getDataCollector() {
    return dashboardDataCollector;
  }

  /**
   * Handle HTTP requests for static files and API
   */
  private handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url || '/', `http://localhost:${this.port}`);
    const filePath = url.pathname;

    // Debug logging for API requests
    if (filePath.startsWith('/api')) {
      console.log(`[APP] API Request: ${req.method} ${filePath}`);
    }

    // Handle API endpoints
    if (filePath === '/api/bot' && req.method === 'POST') {
      this.handleBotDataSubmission(req, res);
      return;
    }

    if (filePath === '/api/bots' && req.method === 'GET') {
      this.handleGetBots(res);
      return;
    }

    // Enable CORS for API
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
      });
      res.end();
      return;
    }

    // Default to index.html for root
    let staticPath = filePath;
    if (staticPath === '/') {
      staticPath = '/index.html';
    }

    // Security: prevent directory traversal
    const safePath = path.normalize(staticPath).replace(/^(\.\.[\/\\])+/, '');
    const fullPath = path.join(this.publicDir, safePath);

    // Ensure path is within public directory
    if (!fullPath.startsWith(this.publicDir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    // Get file extension and MIME type
    const ext = path.extname(fullPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    // Read and serve the file
    fs.readFile(fullPath, (err, data) => {
      if (err) {
        if (err.code === 'ENOENT') {
          res.writeHead(404);
          res.end('Not Found');
        } else {
          res.writeHead(500);
          res.end('Internal Server Error');
        }
        return;
      }

      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    });
  }

  /**
   * Handle external bot data submission
   */
  private handleBotDataSubmission(req: IncomingMessage, res: ServerResponse): void {
    let body = '';

    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        const data: ExternalBotData = JSON.parse(body);

        // Validate API key
        if (data.apiKey !== API_KEY) {
          res.writeHead(401, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(JSON.stringify({ error: 'Invalid API key' }));
          return;
        }

        // Validate required fields
        if (!data.botId || !data.botName) {
          res.writeHead(400, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(JSON.stringify({ error: 'Missing botId or botName' }));
          return;
        }

        // Store the bot data
        this.externalBots.set(data.botId, {
          data,
          lastUpdate: Date.now(),
        });

        console.log(`[APP] Received data from external bot: ${data.botName} (${data.botId})`);

        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({ success: true, message: 'Data received' }));
      } catch (e) {
        res.writeHead(400, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
  }

  /**
   * Handle GET request for bot list
   */
  private handleGetBots(res: ServerResponse): void {
    // Use the dashboard data collector which already has full bot info
    const bots = dashboardDataCollector.getBotSummaries();

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ bots }));
  }

  /**
   * Get external bots data for dashboard
   */
  getExternalBots(): Map<string, { data: ExternalBotData; lastUpdate: number }> {
    return this.externalBots;
  }

  /**
   * Set up WebSocket server event handlers
   */
  private setupWebSocket(): void {
    this.wss.on('connection', (ws: WebSocket) => {
      this.clients.add(ws);
      console.log(`[APP] Client connected (${this.clients.size} total)`);

      // Send immediate update on connection
      this.sendUpdate(ws);

      // Handle client disconnect
      ws.on('close', () => {
        this.clients.delete(ws);
        console.log(`[APP] Client disconnected (${this.clients.size} remaining)`);
      });

      // Handle client messages
      ws.on('message', (data: Buffer) => {
        try {
          const msg: ClientMessage = JSON.parse(data.toString());
          this.handleClientMessage(ws, msg);
        } catch (e) {
          // Ignore invalid JSON
        }
      });

      // Handle errors
      ws.on('error', (err) => {
        console.error('[APP] WebSocket error:', err.message);
        this.clients.delete(ws);
      });
    });
  }

  /**
   * Handle incoming client messages
   */
  private handleClientMessage(ws: WebSocket, msg: ClientMessage): void {
    switch (msg.type) {
      case 'refresh':
        this.sendUpdate(ws);
        break;
      case 'ping':
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        }
        break;
      case 'schedule_reset':
        this.handleScheduleReset(ws, (msg as any).target);
        break;
      case 'cancel_reset':
        this.handleCancelReset(ws, (msg as any).target);
        break;
    }
  }

  /**
   * Handle schedule reset request from client
   */
  private handleScheduleReset(ws: WebSocket, target: string): void {
    if (!['main', 'external', 'all'].includes(target)) {
      console.log(`[APP] Invalid reset target: ${target}`);
      return;
    }

    this.pendingResets.add(target);
    console.log(`[APP] Reset scheduled for: ${target}`);

    // Notify all clients of pending reset
    this.broadcastResetStatus();

    // Trigger reset callback if registered
    if (this.onResetCallback) {
      this.onResetCallback(target);
    }
  }

  /**
   * Handle cancel reset request from client
   */
  private handleCancelReset(ws: WebSocket, target: string): void {
    if (target === 'all') {
      this.pendingResets.clear();
    } else {
      this.pendingResets.delete(target);
    }

    console.log(`[APP] Reset cancelled for: ${target}`);
    this.broadcastResetStatus();
  }

  /**
   * Broadcast reset status to all clients
   */
  private broadcastResetStatus(): void {
    const status = {
      type: 'reset_status',
      pending: Array.from(this.pendingResets),
      timestamp: Date.now(),
    };

    const message = JSON.stringify(status);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }

  /**
   * Set callback for when reset is triggered
   */
  setOnReset(callback: (target: string) => void): void {
    this.onResetCallback = callback;
  }

  /**
   * Get pending resets
   */
  getPendingResets(): Set<string> {
    return this.pendingResets;
  }

  /**
   * Clear a pending reset (called after reset is executed)
   */
  clearPendingReset(target: string): void {
    if (target === 'all') {
      this.pendingResets.clear();
    } else {
      this.pendingResets.delete(target);
    }
    this.broadcastResetStatus();
  }

  /**
   * Start the broadcast loop
   */
  private startBroadcasting(): void {
    this.updateInterval = setInterval(() => {
      this.broadcast();
    }, 1500); // 1.5 second refresh
  }

  /**
   * Broadcast dashboard update to all connected clients
   */
  private async broadcast(): Promise<void> {
    if (this.clients.size === 0) return;

    try {
      const update = await dashboardDataCollector.getDashboardUpdate();
      const message = JSON.stringify(update);

      for (const client of this.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message);
        }
      }
    } catch (err) {
      console.error('[APP] Error broadcasting update:', err);
    }
  }

  /**
   * Send update to a specific client
   */
  private async sendUpdate(ws: WebSocket): Promise<void> {
    if (ws.readyState !== WebSocket.OPEN) return;

    try {
      const update = await dashboardDataCollector.getDashboardUpdate();
      ws.send(JSON.stringify(update));
    } catch (err) {
      console.error('[APP] Error sending update:', err);
    }
  }
}

// Export for use in main bot
export { dashboardDataCollector } from './dashboardData';
