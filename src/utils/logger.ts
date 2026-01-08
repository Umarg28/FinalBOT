import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";
import { getRunId } from "./runId";

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

let currentLogLevel = LogLevel.INFO;
let logFileStream: fs.WriteStream | null = null;
let logFilePath: string | null = null;

/**
 * Initialize log file for this run
 */
function initializeLogFile(): void {
  if (logFileStream) {
    return; // Already initialized
  }

  try {
    const logsDir = path.join(process.cwd(), "logs");
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    const runId = getRunId();
    logFilePath = path.join(logsDir, `run-${runId}.log`);
    logFileStream = fs.createWriteStream(logFilePath, { flags: 'a' });

    // Write header
    const header = `\n${'='.repeat(80)}\nBot Run Started: ${new Date().toISOString()}\nRun ID: ${runId}\n${'='.repeat(80)}\n\n`;
    logFileStream.write(header);

    // Log initialization
    writeToFile(`[${timestamp()}] [INFO] Log file initialized: ${logFilePath}\n`);
  } catch (error) {
    console.error("Failed to initialize log file:", error);
  }
}

/**
 * Write to log file (without colors)
 */
function writeToFile(message: string): void {
  if (!logFileStream) {
    initializeLogFile();
  }
  
  if (logFileStream) {
    try {
      // Strip ANSI color codes for file output
      const cleanMessage = message.replace(/\x1B\[[0-9;]*[mG]/g, '');
      logFileStream.write(cleanMessage);
    } catch (error) {
      // Silently fail if file write fails
    }
  }
}

/**
 * Format arguments for file logging (convert objects to strings)
 */
function formatArgs(args: unknown[]): string {
  return args.map(arg => {
    if (typeof arg === 'object' && arg !== null) {
      try {
        return JSON.stringify(arg, null, 2);
      } catch {
        return String(arg);
      }
    }
    return String(arg);
  }).join(' ');
}

export function setLogLevel(level: LogLevel): void {
  currentLogLevel = level;
}

function timestamp(): string {
  return new Date().toISOString();
}

export function debug(...args: unknown[]): void {
  if (currentLogLevel <= LogLevel.DEBUG) {
    const message = `[${timestamp()}] [DEBUG] ${formatArgs(args)}\n`;
    console.log(chalk.gray(`[${timestamp()}] [DEBUG]`), ...args);
    writeToFile(message);
  }
}

export function info(...args: unknown[]): void {
  if (currentLogLevel <= LogLevel.INFO) {
    const message = `[${timestamp()}] [INFO] ${formatArgs(args)}\n`;
    console.log(chalk.blue(`[${timestamp()}] [INFO]`), ...args);
    writeToFile(message);
  }
}

export function success(...args: unknown[]): void {
  if (currentLogLevel <= LogLevel.INFO) {
    const message = `[${timestamp()}] [SUCCESS] ${formatArgs(args)}\n`;
    console.log(chalk.green(`[${timestamp()}] [SUCCESS]`), ...args);
    writeToFile(message);
  }
}

export function warn(...args: unknown[]): void {
  if (currentLogLevel <= LogLevel.WARN) {
    const message = `[${timestamp()}] [WARN] ${formatArgs(args)}\n`;
    console.log(chalk.yellow(`[${timestamp()}] [WARN]`), ...args);
    writeToFile(message);
  }
}

export function error(...args: unknown[]): void {
  if (currentLogLevel <= LogLevel.ERROR) {
    const message = `[${timestamp()}] [ERROR] ${formatArgs(args)}\n`;
    console.log(chalk.red(`[${timestamp()}] [ERROR]`), ...args);
    writeToFile(message);
  }
}

export function trade(side: "BUY" | "SELL", ...args: unknown[]): void {
  const color = side === "BUY" ? chalk.green : chalk.red;
  const message = `[${timestamp()}] [TRADE] [${side}] ${formatArgs(args)}\n`;
  console.log(color(`[${timestamp()}] [TRADE] [${side}]`), ...args);
  writeToFile(message);
}

export function paper(...args: unknown[]): void {
  const message = `[${timestamp()}] [PAPER] ${formatArgs(args)}\n`;
  console.log(chalk.magenta(`[${timestamp()}] [PAPER]`), ...args);
  writeToFile(message);
}

/**
 * Get the current log file path
 */
export function getLogFilePath(): string | null {
  return logFilePath;
}

/**
 * Close log file stream (called on shutdown)
 */
export function closeLogFile(): void {
  if (logFileStream) {
    try {
      const footer = `\n${'='.repeat(80)}\nBot Run Ended: ${new Date().toISOString()}\n${'='.repeat(80)}\n\n`;
      logFileStream.write(footer);
      logFileStream.end();
      logFileStream = null;
    } catch (error) {
      console.error("Error closing log file:", error);
    }
  }
}

export default {
  debug,
  info,
  success,
  warn,
  error,
  trade,
  paper,
  setLogLevel,
  getLogFilePath,
  closeLogFile,
};
