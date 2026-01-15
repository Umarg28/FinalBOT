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
import ENV from '../../src/config/env';

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
    this.tryListen(this.port);
  }

  /**
   * Try to listen on a port, automatically try next port if in use
   */
  private tryListen(port: number, maxRetries: number = 10): void {
    const server = this.httpServer;

    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && maxRetries > 0) {
        console.log(`[APP] Port ${port} in use, trying ${port + 1}...`);
        server.removeListener('error', onError);
        this.tryListen(port + 1, maxRetries - 1);
      } else {
        console.error(`[APP] Failed to start server: ${err.message}`);
      }
    };

    server.once('error', onError);

    server.listen(port, () => {
      this.port = port; // Update to actual port
      console.log(`[APP] Dashboard available at http://localhost:${this.port}`);
      console.log(`[APP] External bots can POST to http://localhost:${this.port}/api/bot`);
      console.log(`[APP] API Key: ${API_KEY}`);

      // Log external webapp forwarding status
      if (ENV.EXTERNAL_WEBAPP_ENABLED && ENV.EXTERNAL_WEBAPP_URL) {
        console.log(`[APP] External webapp forwarding ENABLED -> ${ENV.EXTERNAL_WEBAPP_URL}`);
      }

      this.onServerStarted();
    });
  }

  /**
   * Called after server successfully starts listening
   */
  private onServerStarted(): void {
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

    // Handle reset request from external webapp
    if (filePath === '/api/reset' && req.method === 'POST') {
      this.handleResetRequest(req, res);
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
   * Handle reset request from external webapp
   */
  private handleResetRequest(req: IncomingMessage, res: ServerResponse): void {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const target = data.target;

        if (!['main', 'external', 'all'].includes(target)) {
          res.writeHead(400, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(JSON.stringify({ error: 'Invalid reset target' }));
          return;
        }

        console.log(`[APP] Reset requested from external webapp: ${target}`);

        // Add to pending resets and trigger callback
        this.pendingResets.add(target);
        this.broadcastResetStatus();

        // Trigger reset callback if registered
        if (this.onResetCallback) {
          this.onResetCallback(target);
        }

        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({ success: true, message: `Reset triggered for ${target}` }));
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
    try {
      const update = await dashboardDataCollector.getDashboardUpdate();
      const message = JSON.stringify(update);

      // Send to local WebSocket clients
      if (this.clients.size > 0) {
        for (const client of this.clients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(message);
          }
        }
      }

      // Forward to external webapp if enabled
      if (ENV.EXTERNAL_WEBAPP_ENABLED && ENV.EXTERNAL_WEBAPP_URL) {
        this.forwardToExternalWebapp(update);
      }
    } catch (err) {
      console.error('[APP] Error broadcasting update:', err);
    }
  }

  /**
   * Forward dashboard data to external webapp
   * Transforms BETABOT data format to WEBAPP expected format
   */
  private async forwardToExternalWebapp(update: any): Promise<void> {
    try {
      const data = update.data || {};
      const portfolio = data.portfolio || {};
      const pnlHistory = data.pnlHistory || [];
      // Use allCurrentMarkets (full list) instead of sliced currentMarkets
      const allMarkets = data.allCurrentMarkets || data.currentMarkets || [];
      // Get upcoming markets
      const upcomingMarketsRaw = data.upcomingMarkets || [];

      const now = Date.now();

      // Get portfolio values with correct field names
      const totalInvested = portfolio.totalInvested ?? portfolio.totalCostBasis ?? portfolio.invested ?? 0;
      const totalValue = portfolio.totalValue ?? portfolio.value ?? totalInvested;
      const totalPnL = portfolio.totalPnL ?? portfolio.pnl ?? (totalValue - totalInvested);
      const totalPnLPercent = portfolio.totalPnLPercent ?? portfolio.pnlPercent ?? (totalInvested > 0 ? (totalPnL / totalInvested) * 100 : 0);

      // Helper to map market data
      const mapMarket = (m: any) => ({
        marketKey: m.marketKey || m.conditionId || m.marketName,
        marketName: m.marketName || 'Unknown Market',
        category: m.category || '',
        endDate: m.endDate || null,
        timeRemaining: m.timeRemaining || 'Live',
        isExpired: m.isExpired || false,
        priceUp: m.priceUp ?? m.currentPriceUp ?? null,
        priceDown: m.priceDown ?? m.currentPriceDown ?? null,
        sharesUp: m.sharesUp ?? 0,
        sharesDown: m.sharesDown ?? 0,
        investedUp: m.investedUp ?? m.totalCostUp ?? 0,
        investedDown: m.investedDown ?? m.totalCostDown ?? 0,
        currentValueUp: m.currentValueUp ?? ((m.sharesUp ?? 0) * (m.priceUp ?? m.currentPriceUp ?? 0)),
        currentValueDown: m.currentValueDown ?? ((m.sharesDown ?? 0) * (m.priceDown ?? m.currentPriceDown ?? 0)),
        pnlUp: m.pnlUp ?? 0,
        pnlDown: m.pnlDown ?? 0,
        pnlUpPercent: m.pnlUpPercent ?? 0,
        pnlDownPercent: m.pnlDownPercent ?? 0,
        totalPnL: m.totalPnL ?? 0,
        totalPnLPercent: m.totalPnLPercent ?? 0,
        tradesUp: m.tradesUp ?? 0,
        tradesDown: m.tradesDown ?? 0,
        upPercent: m.upPercent ?? 50,
        downPercent: m.downPercent ?? 50,
      });

      // Build marketSummaries from current markets
      const marketSummaries = allMarkets.map(mapMarket);

      // Build upcomingMarkets
      const upcomingMarkets = upcomingMarketsRaw.map(mapMarket);

      // Build payload in WEBAPP expected format
      const payload = {
        botId: 'main',
        reason: 'heartbeat',
        runtimeMode: data.mode === 'PAPER' ? 'TRADING' : (data.mode || 'TRADING'),

        payload: {
          botName: 'BETABOT',
          updatedAt: now,

          myPortfolio: {
            wallet: process.env.USER_ADDRESS || '0x0',
            openPositions: allMarkets.length,
            investedValue: totalInvested,
            currentValue: totalValue,
            availableCash: portfolio.balance ?? 0,
            overallPnl: totalPnLPercent,
            totalPnL: totalPnL,
            totalPnLPercent: totalPnLPercent,
            totalTrades: portfolio.totalTrades ?? pnlHistory.length,
            pnl5m: portfolio.pnl5m ?? 0,
            pnl5mPercent: portfolio.pnl5mPercent ?? 0,
            trades5m: portfolio.trades5m ?? 0,
            pnl15m: portfolio.pnl15m ?? 0,
            pnl15mPercent: portfolio.pnl15mPercent ?? 0,
            trades15m: portfolio.trades15m ?? 0,
            pnl1h: portfolio.pnl1h ?? 0,
            pnl1hPercent: portfolio.pnl1hPercent ?? 0,
            trades1h: portfolio.trades1h ?? 0,
            updatedAt: now,
          },

          // Include marketSummaries for current markets display
          marketSummaries,

          // Include upcoming markets
          upcomingMarkets,

          traders: [
            { address: process.env.USER_ADDRESS || '0x0', notes: 'main bot' }
          ],

          // PnL history for resolved markets - this populates the History tab
          pnlHistory: pnlHistory.map((entry: any) => ({
            marketName: entry.marketName || 'Unknown Market',
            conditionId: entry.conditionId || '',
            totalPnl: entry.totalPnl ?? entry.totalPnL ?? entry.pnl ?? 0,
            pnlPercent: entry.pnlPercent ?? 0,
            priceUp: entry.priceUp ?? entry.exitPriceUp ?? 0,
            priceDown: entry.priceDown ?? entry.exitPriceDown ?? 0,
            sharesUp: entry.sharesUp ?? 0,
            sharesDown: entry.sharesDown ?? 0,
            timestamp: entry.timestamp ?? entry.exitTime ?? now,
            outcome: entry.outcome ?? (entry.won === true ? 'WIN' : entry.won === false ? 'LOSS' : 'UNKNOWN'),
            marketType: entry.marketType ?? (entry.marketName?.includes('15m') || entry.marketName?.includes('15-min') ? '15m' : '1h'),
          })),

          trades: pnlHistory.slice(-20).map((trade: any) => ({
            trader: process.env.USER_ADDRESS || '0x0',
            action: trade.side || 'BUY',
            asset: trade.marketName || trade.conditionId || 'Unknown',
            side: trade.side || 'BUY',
            amount: `$${(trade.invested || 0).toFixed(2)}`,
            price: trade.entryPrice || 0,
            market: `https://polymarket.com/event/${trade.conditionId || ''}`,
            tx: '',
            timestamp: trade.timestamp || trade.exitTime || now,
          })),

          executions: [],
          health: {},
        },
      };

      const response = await fetch(ENV.EXTERNAL_WEBAPP_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(ENV.EXTERNAL_WEBAPP_API_KEY && { 'X-API-Key': ENV.EXTERNAL_WEBAPP_API_KEY }),
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        console.error(`[APP] External webapp error: ${response.status} ${response.statusText}`);
      }
    } catch (err: any) {
      // Log error but don't spam - only log occasionally
      if (!this.lastExternalWebappError || Date.now() - this.lastExternalWebappError > 30000) {
        console.error(`[APP] Failed to forward to external webapp: ${err.message}`);
        this.lastExternalWebappError = Date.now();
      }
    }
  }

  private lastExternalWebappError: number = 0;

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
