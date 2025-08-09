/**
 * Signal and process manager for graceful shutdown handling
 */

import { getLogger } from './logging';

export type CleanupFunction = () => Promise<void> | void;

export interface SignalHandlerConfig {
  /** Cleanup function to run on shutdown */
  cleanup?: CleanupFunction;
  /** Timeout for cleanup operations in milliseconds */
  cleanupTimeout?: number;
  /** Whether to log shutdown events */
  verbose?: boolean;
}

/**
 * Signal handler class for managing graceful application shutdown
 */
export class SignalHandler {
  private config: SignalHandlerConfig;
  private cleanupFunctions: CleanupFunction[] = [];
  private isShuttingDown: boolean = false;
  private logger = getLogger();

  constructor(config: SignalHandlerConfig = {}) {
    this.config = {
      cleanupTimeout: 10000, // 10 seconds default
      verbose: true,
      ...config,
    };

    if (config.cleanup) {
      this.cleanupFunctions.push(config.cleanup);
    }
  }

  /**
   * Add a cleanup function to be called on shutdown
   */
  addCleanupFunction(cleanup: CleanupFunction): void {
    this.cleanupFunctions.push(cleanup);
  }

  /**
   * Remove a cleanup function
   */
  removeCleanupFunction(cleanup: CleanupFunction): void {
    const index = this.cleanupFunctions.indexOf(cleanup);
    if (index > -1) {
      this.cleanupFunctions.splice(index, 1);
    }
  }

  /**
   * Execute all cleanup functions with timeout
   */
  private async executeCleanup(): Promise<void> {
    if (this.cleanupFunctions.length === 0) {
      return;
    }

    const cleanupPromises = this.cleanupFunctions.map(
      async (cleanup, index) => {
        try {
          await cleanup();
          if (this.config.verbose) {
            this.logger.debug(
              `Cleanup function ${index + 1} completed successfully`
            );
          }
        } catch (error) {
          this.logger.error(
            `Cleanup function ${index + 1} failed`,
            error as Error
          );
        }
      }
    );

    // Run cleanup with timeout
    try {
      await Promise.race([
        Promise.all(cleanupPromises),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('Cleanup timeout')),
            this.config.cleanupTimeout
          )
        ),
      ]);
    } catch (error) {
      this.logger.error(
        'Cleanup operations timed out or failed',
        error as Error
      );
    }
  }

  /**
   * Handle shutdown signals
   */
  private async handleShutdown(signal: string): Promise<void> {
    if (this.isShuttingDown) {
      if (this.config.verbose) {
        this.logger.warn(`Received ${signal} during shutdown, forcing exit`);
      }
      process.exit(1);
    }

    this.isShuttingDown = true;

    if (this.config.verbose) {
      this.logger.info(`Received ${signal}, shutting down gracefully...`);
    }

    try {
      await this.executeCleanup();

      if (this.config.verbose) {
        this.logger.info('Graceful shutdown completed');
      }

      process.exit(0);
    } catch (error) {
      this.logger.error('Error during graceful shutdown', error as Error);
      process.exit(1);
    }
  }

  /**
   * Register signal handlers for graceful shutdown
   */
  register(): void {
    // Handle SIGINT (Ctrl+C)
    process.on('SIGINT', () => {
      void this.handleShutdown('SIGINT');
    });

    // Handle SIGTERM (termination signal)
    process.on('SIGTERM', () => {
      void this.handleShutdown('SIGTERM');
    });

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      this.logger.error('Uncaught exception', error);
      void this.handleShutdown('uncaughtException');
    });

    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
      this.logger.error(
        'Unhandled promise rejection',
        new Error(String(reason)),
        {
          promise: promise.toString(),
          reason: String(reason),
        }
      );
      void this.handleShutdown('unhandledRejection');
    });

    if (this.config.verbose) {
      this.logger.debug('Signal handlers registered');
    }
  }

  /**
   * Unregister signal handlers
   */
  unregister(): void {
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('uncaughtException');
    process.removeAllListeners('unhandledRejection');

    if (this.config.verbose) {
      this.logger.debug('Signal handlers unregistered');
    }
  }

  /**
   * Manually trigger shutdown
   */
  async shutdown(): Promise<void> {
    await this.handleShutdown('manual');
  }

  /**
   * Check if currently shutting down
   */
  get shuttingDown(): boolean {
    return this.isShuttingDown;
  }
}

/**
 * Global signal handler instance
 */
let signalHandlerInstance: SignalHandler | null = null;

/**
 * Initialize the global signal handler
 */
export function initializeSignalHandler(
  config?: SignalHandlerConfig
): SignalHandler {
  signalHandlerInstance = new SignalHandler(config);
  signalHandlerInstance.register();
  return signalHandlerInstance;
}

/**
 * Get the global signal handler instance
 */
export function getSignalHandler(): SignalHandler {
  if (!signalHandlerInstance) {
    throw new Error(
      'Signal handler not initialized. Call initializeSignalHandler() first.'
    );
  }
  return signalHandlerInstance;
}

/**
 * Add a cleanup function to the global signal handler
 */
export function addCleanupFunction(cleanup: CleanupFunction): void {
  const handler = getSignalHandler();
  handler.addCleanupFunction(cleanup);
}

/**
 * Create a new signal handler instance
 */
export function createSignalHandler(
  config?: SignalHandlerConfig
): SignalHandler {
  return new SignalHandler(config);
}
