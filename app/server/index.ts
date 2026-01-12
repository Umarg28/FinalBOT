/**
 * BETABOT Web Dashboard Server
 * Serves static files and broadcasts real-time dashboard updates via WebSocket
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import { dashboardDataCollector } from './dashboardData';
import { ClientMessage } from './types';

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
    });

    // Start broadcasting updates every 1.5 seconds
    this.startBroadcasting();
  }

  /**
   * Stop the server
   */
  stop(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }

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
   * Handle HTTP requests for static files
   */
  private handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    let filePath = req.url || '/';

    // Default to index.html
    if (filePath === '/') {
      filePath = '/index.html';
    }

    // Security: prevent directory traversal
    const safePath = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, '');
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
    }
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
  private broadcast(): void {
    if (this.clients.size === 0) return;

    try {
      const update = dashboardDataCollector.getDashboardUpdate();
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
  private sendUpdate(ws: WebSocket): void {
    if (ws.readyState !== WebSocket.OPEN) return;

    try {
      const update = dashboardDataCollector.getDashboardUpdate();
      ws.send(JSON.stringify(update));
    } catch (err) {
      console.error('[APP] Error sending update:', err);
    }
  }
}

// Export for use in main bot
export { dashboardDataCollector } from './dashboardData';
