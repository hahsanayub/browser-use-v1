/**
 * Structured logging service with multiple output formats and levels
 */

import { promises as fs } from 'fs';
import { dirname } from 'path';
import type { LoggingConfig } from '../config/schema';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: Record<string, any>;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

/**
 * Logger class that supports both console and file output with structured formatting
 */
export class Logger {
  private config: LoggingConfig;
  private logLevels: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
  };

  constructor(config: LoggingConfig) {
    this.config = config;
  }

  /**
   * Check if a log level should be output based on current configuration
   */
  private shouldLog(level: LogLevel): boolean {
    return this.logLevels[level] >= this.logLevels[this.config.level];
  }

  /**
   * Format log entry for output
   */
  private formatLogEntry(entry: LogEntry): string {
    if (this.config.json) {
      return JSON.stringify(entry);
    }

    const timestamp = entry.timestamp;
    const level = entry.level.toUpperCase().padEnd(5);
    let message = `[${timestamp}] ${level} ${entry.message}`;

    if (entry.context && Object.keys(entry.context).length > 0) {
      message += ` ${JSON.stringify(entry.context)}`;
    }

    if (entry.error) {
      message += `\n  Error: ${entry.error.name}: ${entry.error.message}`;
      if (entry.error.stack) {
        message += `\n  Stack: ${entry.error.stack}`;
      }
    }

    return message;
  }

  /**
   * Create a log entry
   */
  private createLogEntry(
    level: LogLevel,
    message: string,
    context?: Record<string, any>,
    error?: Error
  ): LogEntry {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
    };

    if (context) {
      entry.context = context;
    }

    if (error) {
      entry.error = {
        name: error.name,
        message: error.message,
        stack: error.stack,
      };
    }

    return entry;
  }

  /**
   * Output log entry to configured destinations
   */
  private async outputLog(entry: LogEntry): Promise<void> {
    const formattedMessage = this.formatLogEntry(entry);

    // Console output
    if (this.config.console) {
      switch (entry.level) {
        case 'debug':
          console.debug(formattedMessage);
          break;
        case 'info':
          console.info(formattedMessage);
          break;
        case 'warn':
          console.warn(formattedMessage);
          break;
        case 'error':
          console.error(formattedMessage);
          break;
      }
    }

    // File output
    if (this.config.file) {
      try {
        // Ensure directory exists
        await fs.mkdir(dirname(this.config.file), { recursive: true });

        // Append to file
        await fs.appendFile(this.config.file, formattedMessage + '\n', 'utf-8');
      } catch (error) {
        // Fallback to console if file writing fails
        console.error(`Failed to write to log file: ${error}`);
      }
    }
  }

  /**
   * Log a debug message
   */
  async debug(message: string, context?: Record<string, any>): Promise<void> {
    if (!this.shouldLog('debug')) return;

    const entry = this.createLogEntry('debug', message, context);
    await this.outputLog(entry);
  }

  /**
   * Log an info message
   */
  async info(message: string, context?: Record<string, any>): Promise<void> {
    if (!this.shouldLog('info')) return;

    const entry = this.createLogEntry('info', message, context);
    await this.outputLog(entry);
  }

  /**
   * Log a warning message
   */
  async warn(message: string, context?: Record<string, any>): Promise<void> {
    if (!this.shouldLog('warn')) return;

    const entry = this.createLogEntry('warn', message, context);
    await this.outputLog(entry);
  }

  /**
   * Log an error message
   */
  async error(
    message: string,
    error?: Error,
    context?: Record<string, any>
  ): Promise<void> {
    if (!this.shouldLog('error')) return;

    const entry = this.createLogEntry('error', message, context, error);
    await this.outputLog(entry);
  }

  /**
   * Update logger configuration
   */
  updateConfig(config: LoggingConfig): void {
    this.config = config;
  }
}

/**
 * Global logger instance
 */
let loggerInstance: Logger | null = null;

/**
 * Initialize the global logger with configuration
 */
export function initializeLogger(config: LoggingConfig): Logger {
  loggerInstance = new Logger(config);
  return loggerInstance;
}

/**
 * Get the global logger instance
 */
export function getLogger(): Logger {
  if (!loggerInstance) {
    throw new Error('Logger not initialized. Call initializeLogger() first.');
  }
  return loggerInstance;
}

/**
 * Create a new logger instance with custom configuration
 */
export function createLogger(config: LoggingConfig): Logger {
  return new Logger(config);
}
