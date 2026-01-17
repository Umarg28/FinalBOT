/**
 * Multi-Bot Terminal Dashboard
 * Provides a clean, stable terminal view for monitoring multiple bots
 * Handles 100+ bots without log spam
 */

import { execSync } from 'child_process';

interface BotStatus {
  id: string;
  name: string;
  port: number;
  pid: number | null;
  status: 'running' | 'stopped' | 'error' | 'starting';
  uptime: number;
  pnl: number;
  trades: number;
  positions: number;
  lastUpdate: number;
  configFile: string;
  error?: string;
}

interface DashboardConfig {
  refreshInterval: number;  // ms between refreshes
  maxBotsPerPage: number;   // for pagination
  showDetailedView: boolean;
}

class MultiBotDashboard {
  private bots: Map<string, BotStatus> = new Map();
  private refreshInterval: NodeJS.Timeout | null = null;
  private config: DashboardConfig = {
    refreshInterval: 2000,
    maxBotsPerPage: 20,
    showDetailedView: false,
  };
  private currentPage: number = 0;
  private startTime: number = Date.now();
  private lastRender: string = '';

  /**
   * Register a bot with the dashboard
   */
  registerBot(id: string, name: string, port: number, configFile: string, pid?: number): void {
    this.bots.set(id, {
      id,
      name,
      port,
      pid: pid || null,
      status: 'starting',
      uptime: 0,
      pnl: 0,
      trades: 0,
      positions: 0,
      lastUpdate: Date.now(),
      configFile,
    });
  }

  /**
   * Update bot metrics
   */
  updateBot(id: string, updates: Partial<BotStatus>): void {
    const bot = this.bots.get(id);
    if (bot) {
      Object.assign(bot, updates, { lastUpdate: Date.now() });
    }
  }

  /**
   * Remove a bot from dashboard
   */
  removeBot(id: string): void {
    this.bots.delete(id);
  }

  /**
   * Start the dashboard refresh loop
   */
  start(): void {
    if (this.refreshInterval) return;

    // Clear screen and hide cursor
    process.stdout.write('\x1B[?25l'); // Hide cursor
    process.stdout.write('\x1B[2J');   // Clear screen

    this.refreshInterval = setInterval(() => {
      this.render();
    }, this.config.refreshInterval);

    // Initial render
    this.render();

    // Handle resize
    process.stdout.on('resize', () => this.render());

    // Cleanup on exit
    process.on('SIGINT', () => this.stop());
    process.on('SIGTERM', () => this.stop());
  }

  /**
   * Stop the dashboard
   */
  stop(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
    // Show cursor again
    process.stdout.write('\x1B[?25h');
    console.log('\n\nDashboard stopped.');
  }

  /**
   * Scan for running bot processes
   */
  scanRunningBots(): void {
    try {
      const result = execSync(
        `ps -eo pid,command | grep "node.*dist/src/index" | grep -v grep`,
        { encoding: 'utf8' }
      ).trim();

      if (!result) return;

      const lines = result.split('\n');
      for (const line of lines) {
        const pidMatch = line.match(/^\s*(\d+)/);
        if (!pidMatch) continue;

        const pid = parseInt(pidMatch[1], 10);

        // Get environment info for this process
        try {
          const envResult = execSync(`ps -p ${pid} -E 2>/dev/null`, { encoding: 'utf8' });

          const botIdMatch = envResult.match(/BOT_ID=(\S+)/);
          const botNameMatch = envResult.match(/BOT_NAME=(\S+)/);
          const portMatch = envResult.match(/WEB_DASHBOARD_PORT=(\d+)/);
          const configMatch = envResult.match(/CONFIG_FILE=(\S+)/);

          if (botIdMatch) {
            const id = botIdMatch[1];
            const name = botNameMatch ? botNameMatch[1] : `Bot ${id}`;
            const port = portMatch ? parseInt(portMatch[1], 10) : 3010;
            const configFile = configMatch ? configMatch[1] : '';

            if (!this.bots.has(id)) {
              this.registerBot(id, name, port, configFile, pid);
            }
            this.updateBot(id, { pid, status: 'running' });
          }
        } catch (e) {
          // Couldn't read environment
        }
      }
    } catch (e) {
      // No processes found
    }
  }

  /**
   * Render the dashboard
   */
  private render(): void {
    // Scan for running bots
    this.scanRunningBots();

    const width = process.stdout.columns || 120;
    const height = process.stdout.rows || 40;

    const lines: string[] = [];

    // Header
    lines.push(this.renderHeader(width));
    lines.push(this.renderDivider(width, '═'));

    // Summary stats
    lines.push(this.renderSummary(width));
    lines.push(this.renderDivider(width, '─'));

    // Bot list header
    lines.push(this.renderBotHeader(width));
    lines.push(this.renderDivider(width, '─'));

    // Bot rows
    const sortedBots = Array.from(this.bots.values())
      .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));

    const startIdx = this.currentPage * this.config.maxBotsPerPage;
    const endIdx = Math.min(startIdx + this.config.maxBotsPerPage, sortedBots.length);
    const visibleBots = sortedBots.slice(startIdx, endIdx);

    for (const bot of visibleBots) {
      lines.push(this.renderBotRow(bot, width));
    }

    // Fill remaining space
    const usedLines = lines.length;
    const remainingLines = height - usedLines - 3; // Leave room for footer
    for (let i = 0; i < remainingLines && i < 50; i++) {
      lines.push(' '.repeat(width));
    }

    // Footer
    lines.push(this.renderDivider(width, '─'));
    lines.push(this.renderFooter(width, sortedBots.length));

    // Build output
    const output = lines.join('\n');

    // Only update if changed (reduces flicker)
    if (output !== this.lastRender) {
      // Move to top-left and render
      process.stdout.write('\x1B[H'); // Move to home
      process.stdout.write(output);
      this.lastRender = output;
    }
  }

  private renderHeader(width: number): string {
    const title = '  BETABOT MULTI-BOT DASHBOARD  ';
    const time = new Date().toLocaleTimeString();
    const uptime = this.formatUptime(Date.now() - this.startTime);

    const left = ` 🤖 ${title}`;
    const right = `⏱ ${uptime}  🕐 ${time} `;
    const padding = width - left.length - right.length;

    return `\x1B[44m\x1B[97m${left}${' '.repeat(Math.max(0, padding))}${right}\x1B[0m`;
  }

  private renderSummary(width: number): string {
    const bots = Array.from(this.bots.values());
    const running = bots.filter(b => b.status === 'running').length;
    const stopped = bots.filter(b => b.status === 'stopped').length;
    const errors = bots.filter(b => b.status === 'error').length;
    const totalPnl = bots.reduce((sum, b) => sum + b.pnl, 0);
    const totalTrades = bots.reduce((sum, b) => sum + b.trades, 0);
    const totalPositions = bots.reduce((sum, b) => sum + b.positions, 0);

    const pnlColor = totalPnl >= 0 ? '\x1B[32m' : '\x1B[31m';
    const pnlSign = totalPnl >= 0 ? '+' : '';

    const stats = [
      `\x1B[97mBots:\x1B[0m ${bots.length}`,
      `\x1B[32m●\x1B[0m ${running}`,
      `\x1B[33m●\x1B[0m ${stopped}`,
      `\x1B[31m●\x1B[0m ${errors}`,
      `│`,
      `\x1B[97mTotal PnL:\x1B[0m ${pnlColor}${pnlSign}$${totalPnl.toFixed(2)}\x1B[0m`,
      `\x1B[97mTrades:\x1B[0m ${totalTrades}`,
      `\x1B[97mPositions:\x1B[0m ${totalPositions}`,
    ].join('  ');

    return ` ${stats}${' '.repeat(Math.max(0, width - stats.length - 20))}`;
  }

  private renderBotHeader(width: number): string {
    const cols = [
      { label: 'ID', width: 6 },
      { label: 'NAME', width: 15 },
      { label: 'STATUS', width: 10 },
      { label: 'PORT', width: 6 },
      { label: 'PID', width: 8 },
      { label: 'UPTIME', width: 10 },
      { label: 'PNL', width: 12 },
      { label: 'TRADES', width: 8 },
      { label: 'POS', width: 5 },
      { label: 'LAST UPDATE', width: 12 },
    ];

    let header = ' ';
    for (const col of cols) {
      header += col.label.padEnd(col.width) + ' ';
    }

    return `\x1B[100m\x1B[97m${header.padEnd(width)}\x1B[0m`;
  }

  private renderBotRow(bot: BotStatus, width: number): string {
    const statusColors: Record<string, string> = {
      running: '\x1B[32m● RUN   \x1B[0m',
      stopped: '\x1B[33m○ STOP  \x1B[0m',
      error: '\x1B[31m✖ ERROR \x1B[0m',
      starting: '\x1B[36m◐ START \x1B[0m',
    };

    const pnlColor = bot.pnl >= 0 ? '\x1B[32m' : '\x1B[31m';
    const pnlSign = bot.pnl >= 0 ? '+' : '';
    const pnlStr = `${pnlColor}${pnlSign}$${bot.pnl.toFixed(2)}\x1B[0m`;

    const age = Date.now() - bot.lastUpdate;
    const ageStr = age < 5000 ? '\x1B[32mnow\x1B[0m' :
                   age < 30000 ? `${Math.floor(age / 1000)}s ago` :
                   '\x1B[31mstale\x1B[0m';

    const cols = [
      bot.id.padEnd(6).slice(0, 6),
      bot.name.padEnd(15).slice(0, 15),
      statusColors[bot.status] || bot.status.padEnd(10),
      String(bot.port).padEnd(6),
      (bot.pid ? String(bot.pid) : '-').padEnd(8),
      this.formatUptime(bot.uptime).padEnd(10),
      pnlStr.padEnd(22), // Extra for color codes
      String(bot.trades).padEnd(8),
      String(bot.positions).padEnd(5),
      ageStr,
    ];

    return ` ${cols.join(' ')}`;
  }

  private renderDivider(width: number, char: string): string {
    return char.repeat(width);
  }

  private renderFooter(width: number, totalBots: number): string {
    const totalPages = Math.ceil(totalBots / this.config.maxBotsPerPage);
    const pageInfo = totalPages > 1 ?
      `Page ${this.currentPage + 1}/${totalPages}  ` : '';

    const commands = '[Q]uit  [R]efresh  [←/→] Pages  [D]etail';
    const left = ` ${pageInfo}${commands}`;
    const right = `BETABOT v1.0 `;

    return `\x1B[100m${left}${' '.repeat(Math.max(0, width - left.length - right.length))}${right}\x1B[0m`;
  }

  private formatUptime(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  /**
   * Get all bot statuses for external use
   */
  getAllBots(): BotStatus[] {
    return Array.from(this.bots.values());
  }

  /**
   * Get bot count
   */
  getBotCount(): number {
    return this.bots.size;
  }
}

// Singleton instance
export const multiBotDashboard = new MultiBotDashboard();
