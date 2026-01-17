/**
 * Bot Spawner Service
 * Creates new bot instances from config received via API
 * Polls external webapp for pending bot commands (create, stop, delete)
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess, execSync } from 'child_process';
import ENV from '../../src/config/env';

interface SpawnedBot {
  id: string;
  name: string;
  configFile: string;
  process: ChildProcess | null;
  startedAt: number;
  status: 'running' | 'stopped' | 'error';
}

// Command types from webapp
interface BotCommand {
  id: string;
  type: 'create' | 'stop' | 'delete' | 'restart';
  botId?: string;
  config?: string;
  name?: string;
  timestamp: number;
}

class BotSpawner {
  private spawnedBots: Map<string, SpawnedBot> = new Map();
  private nextBotNumber: number = 3; // Start from Bot 3
  private projectRoot: string;
  private pollInterval: NodeJS.Timeout | null = null;
  private processedCommands: Set<string> = new Set(); // Track processed command IDs
  private lastDebugLog: number = 0; // For throttling debug output

  constructor() {
    this.projectRoot = process.cwd();
    this.initNextBotNumber();
  }

  /**
   * Initialize the next bot number by scanning existing config files
   */
  private initNextBotNumber(): void {
    try {
      const files = fs.readdirSync(this.projectRoot);
      const configFiles = files.filter(f =>
        f.startsWith('inventory-rebalance-config') && f.endsWith('.yaml')
      );

      let maxNumber = 2; // Start checking from 3
      for (const file of configFiles) {
        // Extract number from filename like inventory-rebalance-config-3.yaml
        const match = file.match(/inventory-rebalance-config-(\d+)\.yaml/);
        if (match) {
          const num = parseInt(match[1], 10);
          if (num > maxNumber) {
            maxNumber = num;
          }
        }
      }
      this.nextBotNumber = maxNumber + 1;
      console.log(`[SPAWNER] Next bot number will be: ${this.nextBotNumber}`);
    } catch (err) {
      console.error('[SPAWNER] Error scanning config files:', err);
    }
  }

  /**
   * Create a new bot from YAML config string
   */
  createBot(yamlConfig: string, customName?: string): { success: boolean; botId?: string; botName?: string; error?: string } {
    try {
      const botNumber = this.nextBotNumber;
      const botId = String(botNumber);
      const botName = customName || `Bot ${botNumber}`;
      const configFileName = `inventory-rebalance-config-${botNumber}.yaml`;
      const configPath = path.join(this.projectRoot, configFileName);

      // Write the config file
      fs.writeFileSync(configPath, yamlConfig, 'utf8');
      console.log(`[SPAWNER] Created config file: ${configFileName}`);

      // Create logs directory for this bot
      const logsDir = path.join(this.projectRoot, 'logs', 'paper');
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }

      // Spawn the bot process
      const botProcess = this.spawnBotProcess(botId, botName, configFileName);

      // Track the bot
      this.spawnedBots.set(botId, {
        id: botId,
        name: botName,
        configFile: configFileName,
        process: botProcess,
        startedAt: Date.now(),
        status: botProcess ? 'running' : 'error',
      });

      this.nextBotNumber++;

      return {
        success: true,
        botId,
        botName,
      };
    } catch (err: any) {
      console.error('[SPAWNER] Error creating bot:', err);
      return {
        success: false,
        error: err.message,
      };
    }
  }

  /**
   * Spawn a bot process with environment variables
   */
  private spawnBotProcess(botId: string, botName: string, configFile: string): ChildProcess | null {
    try {
      const distPath = path.join(this.projectRoot, 'dist', 'src', 'index.js');

      // Check if built
      if (!fs.existsSync(distPath)) {
        console.error('[SPAWNER] Bot not built. Run npm run build first.');
        return null;
      }

      const env = {
        ...process.env,
        BOT_ID: botId,
        BOT_NAME: botName,
        CONFIG_FILE: configFile,
        // Enable dashboard so spawned bot forwards data to webapp
        ENABLE_WEB_DASHBOARD: 'true',
        // Each spawned bot gets a unique port (auto-retry will handle conflicts)
        WEB_DASHBOARD_PORT: String(3010 + parseInt(botId, 10) || 3010),
        // Ensure external webapp forwarding is enabled
        EXTERNAL_WEBAPP_ENABLED: process.env.EXTERNAL_WEBAPP_ENABLED || 'true',
        EXTERNAL_WEBAPP_URL: process.env.EXTERNAL_WEBAPP_URL || ENV.EXTERNAL_WEBAPP_URL || '',
      };

      const child = spawn('node', [distPath], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });

      // Log output
      child.stdout?.on('data', (data) => {
        const lines = data.toString().split('\n').filter((l: string) => l.trim());
        for (const line of lines) {
          console.log(`[${botName}] ${line}`);
        }
      });

      child.stderr?.on('data', (data) => {
        const lines = data.toString().split('\n').filter((l: string) => l.trim());
        for (const line of lines) {
          console.error(`[${botName}] ${line}`);
        }
      });

      child.on('exit', (code) => {
        console.log(`[SPAWNER] ${botName} exited with code ${code}`);
        const bot = this.spawnedBots.get(botId);
        if (bot) {
          bot.status = 'stopped';
          bot.process = null;
        }
      });

      child.on('error', (err) => {
        console.error(`[SPAWNER] ${botName} error:`, err);
        const bot = this.spawnedBots.get(botId);
        if (bot) {
          bot.status = 'error';
        }
      });

      console.log(`[SPAWNER] Started ${botName} (PID: ${child.pid})`);
      return child;
    } catch (err) {
      console.error('[SPAWNER] Failed to spawn bot process:', err);
      return null;
    }
  }

  /**
   * Stop a bot by ID
   */
  stopBot(botId: string): boolean {
    const bot = this.spawnedBots.get(botId);
    if (!bot) {
      return false;
    }

    if (bot.process) {
      bot.process.kill('SIGTERM');
      bot.status = 'stopped';
      bot.process = null;
      console.log(`[SPAWNER] Stopped ${bot.name}`);
      return true;
    }

    return false;
  }

  /**
   * Restart a bot by ID
   */
  restartBot(botId: string): boolean {
    const bot = this.spawnedBots.get(botId);
    if (!bot) {
      return false;
    }

    // Stop if running
    if (bot.process) {
      bot.process.kill('SIGTERM');
    }

    // Respawn
    const newProcess = this.spawnBotProcess(bot.id, bot.name, bot.configFile);
    bot.process = newProcess;
    bot.status = newProcess ? 'running' : 'error';
    bot.startedAt = Date.now();

    return bot.status === 'running';
  }

  /**
   * Delete a bot completely (stop process, remove config, remove logs)
   */
  deleteBot(botId: string, deleteFiles: boolean = true): { success: boolean; deletedFiles: string[] } {
    const bot = this.spawnedBots.get(botId);
    const deletedFiles: string[] = [];

    // Stop the process if running (spawned by this service)
    if (bot?.process) {
      bot.process.kill('SIGTERM');
      console.log(`[SPAWNER] Stopped ${bot.name}`);
    } else {
      // Try to find and kill process started externally (e.g., via run-all-bots.sh)
      this.killExternalBotProcess(botId);
    }

    if (deleteFiles) {
      // Delete config file
      const configFileName = bot?.configFile || `inventory-rebalance-config-${botId}.yaml`;
      const configPath = path.join(this.projectRoot, configFileName);
      if (fs.existsSync(configPath)) {
        fs.unlinkSync(configPath);
        deletedFiles.push(configFileName);
        console.log(`[SPAWNER] Deleted config: ${configFileName}`);
      }

      // Delete log files for this bot
      const logsDir = path.join(this.projectRoot, 'logs', 'paper');
      if (fs.existsSync(logsDir)) {
        const logFiles = fs.readdirSync(logsDir);
        for (const file of logFiles) {
          // Match files like pnl_history_3.json, Paper Trades_3_*.csv
          if (file.includes(`_${botId}.`) || file.includes(`_${botId}_`)) {
            const filePath = path.join(logsDir, file);
            fs.unlinkSync(filePath);
            deletedFiles.push(`logs/paper/${file}`);
            console.log(`[SPAWNER] Deleted log: ${file}`);
          }
        }
      }
    }

    // Remove from tracking
    if (bot) {
      this.spawnedBots.delete(botId);
    }

    console.log(`[SPAWNER] Bot ${botId} fully deleted. Files removed: ${deletedFiles.length}`);
    return { success: true, deletedFiles };
  }

  /**
   * Get list of all spawned bots
   */
  getSpawnedBots(): Array<{
    id: string;
    name: string;
    configFile: string;
    status: string;
    startedAt: number;
    uptime: number;
  }> {
    const now = Date.now();
    return Array.from(this.spawnedBots.values()).map(bot => ({
      id: bot.id,
      name: bot.name,
      configFile: bot.configFile,
      status: bot.status,
      startedAt: bot.startedAt,
      uptime: bot.status === 'running' ? now - bot.startedAt : 0,
    }));
  }

  /**
   * Get the default config template
   */
  getConfigTemplate(): string {
    const templatePath = path.join(this.projectRoot, 'inventory-rebalance-config.yaml');
    if (fs.existsSync(templatePath)) {
      return fs.readFileSync(templatePath, 'utf8');
    }
    return '';
  }

  /**
   * Stop all spawned bots (for cleanup)
   */
  stopAll(): void {
    for (const [botId, bot] of this.spawnedBots) {
      if (bot.process) {
        bot.process.kill('SIGTERM');
        console.log(`[SPAWNER] Stopped ${bot.name}`);
      }
    }
  }

  /**
   * Kill a bot process that was started externally (e.g., via run-all-bots.sh)
   * Uses multiple methods to find and kill the process
   */
  private killExternalBotProcess(botId: string): boolean {
    const configFile = `inventory-rebalance-config-${botId}.yaml`;
    let killed = false;

    console.log(`[SPAWNER] Looking for external bot process with botId: ${botId}, config: ${configFile}`);

    // Method 1: Find by port (spawned bots use port 3010 + botId)
    const expectedPort = 3010 + parseInt(botId, 10);
    if (!isNaN(expectedPort)) {
      try {
        const lsofPort = execSync(
          `lsof -i :${expectedPort} -t 2>/dev/null`,
          { encoding: 'utf8' }
        ).trim();

        if (lsofPort) {
          const pids = lsofPort.split('\n').filter(p => p.trim());
          for (const pid of pids) {
            try {
              process.kill(parseInt(pid, 10), 'SIGTERM');
              console.log(`[SPAWNER] Killed process PID ${pid} on port ${expectedPort} for bot ${botId}`);
              killed = true;
            } catch (killErr: any) {
              if (killErr.code !== 'ESRCH') {
                console.error(`[SPAWNER] Failed to kill PID ${pid}:`, killErr.message);
              }
            }
          }
        }
      } catch (err) {
        // Port not in use or lsof failed
      }
    }

    // Method 2: Find node processes and check their environment
    // On macOS, we can use ps with environment info
    try {
      // Get all node processes
      const psResult = execSync(
        `ps -eo pid,command | grep "node.*dist/src/index" | grep -v grep`,
        { encoding: 'utf8' }
      ).trim();

      if (psResult) {
        const lines = psResult.split('\n').filter(l => l.trim());
        console.log(`[SPAWNER] Found ${lines.length} node processes running`);

        for (const line of lines) {
          const match = line.trim().match(/^(\d+)/);
          if (match) {
            const pid = parseInt(match[1], 10);

            // Check this process's environment for BOT_ID or CONFIG_FILE
            try {
              // On macOS, use ps -E to get environment
              const envResult = execSync(
                `ps -p ${pid} -E 2>/dev/null || ps eww -p ${pid} 2>/dev/null`,
                { encoding: 'utf8' }
              );

              const hasBotId = envResult.includes(`BOT_ID=${botId}`) ||
                               envResult.includes(`BOT_ID=${botId} `);
              const hasConfigFile = envResult.includes(configFile);

              if (hasBotId || hasConfigFile) {
                try {
                  process.kill(pid, 'SIGTERM');
                  console.log(`[SPAWNER] Killed process PID ${pid} (matched BOT_ID=${botId} or ${configFile})`);
                  killed = true;
                } catch (killErr: any) {
                  if (killErr.code !== 'ESRCH') {
                    console.error(`[SPAWNER] Failed to kill PID ${pid}:`, killErr.message);
                  }
                }
              }
            } catch (envErr) {
              // Couldn't read environment, skip
            }
          }
        }
      }
    } catch (err) {
      // ps failed
    }

    // Method 3: Try to find by config file being open (lsof)
    if (!killed) {
      try {
        const lsofResult = execSync(
          `lsof 2>/dev/null | grep "${configFile}" | awk '{print $2}' | sort -u`,
          { encoding: 'utf8' }
        ).trim();

        if (lsofResult) {
          const pids = lsofResult.split('\n').filter(p => p.trim() && /^\d+$/.test(p.trim()));
          for (const pid of pids) {
            try {
              process.kill(parseInt(pid, 10), 'SIGTERM');
              console.log(`[SPAWNER] Killed process PID ${pid} (had ${configFile} open)`);
              killed = true;
            } catch (killErr: any) {
              if (killErr.code !== 'ESRCH') {
                console.error(`[SPAWNER] Failed to kill PID ${pid}:`, killErr.message);
              }
            }
          }
        }
      } catch (err) {
        // lsof failed
      }
    }

    if (!killed) {
      console.log(`[SPAWNER] No external process found for bot ${botId}`);
    }

    return killed;
  }

  /**
   * Start polling webapp for pending bot commands
   */
  startPolling(intervalMs: number = 5000): void {
    if (this.pollInterval) {
      return; // Already polling
    }

    // Only poll if external webapp is enabled
    if (!ENV.EXTERNAL_WEBAPP_ENABLED || !ENV.EXTERNAL_WEBAPP_URL) {
      console.log('[SPAWNER] External webapp not configured, skipping command polling');
      return;
    }

    // Derive the commands endpoint from the update URL
    // e.g., https://webapp.com/api/update -> https://webapp.com/api/bot-commands
    const baseUrl = ENV.EXTERNAL_WEBAPP_URL.replace(/\/api\/update$/, '');
    const commandsUrl = `${baseUrl}/api/bot-commands`;

    console.log(`[SPAWNER] Starting to poll for bot commands: ${commandsUrl}`);

    this.pollInterval = setInterval(async () => {
      await this.pollForCommands(commandsUrl);
    }, intervalMs);

    // Also poll immediately
    this.pollForCommands(commandsUrl);
  }

  /**
   * Stop polling for commands
   */
  stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
      console.log('[SPAWNER] Stopped polling for bot commands');
    }
  }

  /**
   * Poll webapp for pending commands and execute them
   */
  private async pollForCommands(commandsUrl: string): Promise<void> {
    try {
      const response = await fetch(commandsUrl, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(ENV.EXTERNAL_WEBAPP_API_KEY && { 'X-API-Key': ENV.EXTERNAL_WEBAPP_API_KEY }),
        },
      });

      // Log every poll attempt status
      const now = Date.now();
      if (!this.lastDebugLog || now - this.lastDebugLog > 10000) {
        console.log(`[SPAWNER] Polling ${commandsUrl} - Status: ${response.status}`);
        this.lastDebugLog = now;
      }

      if (!response.ok) {
        if (response.status !== 404) {
          console.error(`[SPAWNER] Failed to fetch commands: ${response.status}`);
        } else {
          // Log 404 once
          if (!this.lastDebugLog || now - this.lastDebugLog > 60000) {
            console.log(`[SPAWNER] Endpoint ${commandsUrl} returned 404 - not implemented on webapp`);
          }
        }
        return;
      }

      const data = await response.json() as { commands?: BotCommand[] };

      // Always log the response for debugging
      console.log(`[SPAWNER] Poll response:`, JSON.stringify(data));

      const commands: BotCommand[] = data.commands || [];

      // Debug: Log when we receive commands
      if (commands.length > 0) {
        console.log(`[SPAWNER] Received ${commands.length} command(s) from webapp:`, JSON.stringify(commands, null, 2));
      }

      for (const cmd of commands) {
        // Skip already processed commands
        if (this.processedCommands.has(cmd.id)) {
          continue;
        }

        console.log(`[SPAWNER] Processing command: ${cmd.type} (ID: ${cmd.id})`);
        let result: any = { success: false };

        switch (cmd.type) {
          case 'create':
            if (cmd.config) {
              result = this.createBot(cmd.config, cmd.name);
            }
            break;
          case 'stop':
            if (cmd.botId) {
              result = { success: this.stopBot(cmd.botId) };
            }
            break;
          case 'delete':
            if (cmd.botId) {
              console.log(`[SPAWNER] Executing DELETE for bot ${cmd.botId}`);
              result = this.deleteBot(cmd.botId, true);
              console.log(`[SPAWNER] Delete result:`, JSON.stringify(result));
            }
            break;
          case 'restart':
            if (cmd.botId) {
              result = { success: this.restartBot(cmd.botId) };
            }
            break;
        }

        // Mark as processed
        this.processedCommands.add(cmd.id);

        // Report result back to webapp
        await this.reportCommandResult(cmd.id, result);

        // Clean up old processed commands (keep last 100)
        if (this.processedCommands.size > 100) {
          const oldest = Array.from(this.processedCommands).slice(0, 50);
          oldest.forEach(id => this.processedCommands.delete(id));
        }
      }
    } catch (err: any) {
      // Log actual errors (but not too frequently)
      console.error(`[SPAWNER] Error polling for commands:`, err.message);
    }
  }

  /**
   * Report command execution result back to webapp
   */
  private async reportCommandResult(commandId: string, result: any): Promise<void> {
    try {
      const baseUrl = ENV.EXTERNAL_WEBAPP_URL?.replace(/\/api\/update$/, '');
      if (!baseUrl) return;

      const resultUrl = `${baseUrl}/api/bot-command-result`;

      await fetch(resultUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(ENV.EXTERNAL_WEBAPP_API_KEY && { 'X-API-Key': ENV.EXTERNAL_WEBAPP_API_KEY }),
        },
        body: JSON.stringify({
          commandId,
          result,
          timestamp: Date.now(),
        }),
      });
    } catch (err) {
      // Silent fail
    }
  }
}

// Singleton instance
export const botSpawner = new BotSpawner();
