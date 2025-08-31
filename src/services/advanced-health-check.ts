/**
 * Advanced Health Check Service - Node.js Implementation
 *
 * This module provides robust browser and page health monitoring capabilities
 * that are critical for reliable automation in production environments.
 *
 * Features:
 * - Page responsiveness detection
 * - Automatic page recovery mechanisms
 * - Browser process monitoring
 * - Recursive recovery protection
 * - CDP-based page operations
 */

import type { Page, BrowserContext } from 'playwright';
import { getLogger } from './logging';

let logger: ReturnType<typeof getLogger>;

/**
 * Interface for browser process information
 */
interface BrowserProcessInfo {
  pid?: number;
  isAlive?: boolean;
  status?: string;
}

/**
 * Advanced Health Check Service
 * Provides comprehensive browser and page health monitoring
 */
export class AdvancedHealthCheckService {
  private _inRecovery = false; // Prevent recursive recovery
  private browserProcessInfo: BrowserProcessInfo = {};
  private context: BrowserContext | null = null;

  constructor(context?: BrowserContext) {
    this.context = context || null;

    // Initialize logger if not already done
    if (!logger) {
      logger = getLogger();
    }
  }

  /**
   * Check if a page is responsive by trying to evaluate simple JavaScript
   *
   * @param page - The page to check
   * @param timeout - Timeout in milliseconds (default 5000ms)
   * @returns Promise<boolean> - True if page is responsive
   */
  async isPageResponsive(page: Page, timeout: number = 5000): Promise<boolean> {
    if (!page || page.isClosed()) {
      logger.debug('❌ Page is closed or null, not responsive');
      return false;
    }

    try {
      // Create a promise that will evaluate simple JavaScript
      const evalPromise = page.evaluate(() => 1);

      // Race the evaluation against a timeout
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Timeout')), timeout)
      );

      await Promise.race([evalPromise, timeoutPromise]);

      logger.debug('✅ Page responsiveness check passed');
      return true;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      if (errorMessage.includes('Timeout')) {
        logger.debug(`⏰ Page responsiveness timeout after ${timeout}ms`);
      } else {
        logger.debug(`❌ Page responsiveness check failed: ${errorMessage}`);
      }

      return false;
    }
  }

  /**
   * Check if browser process is still alive
   *
   * @returns Promise<boolean> - True if browser process is alive
   */
  async isBrowserProcessAlive(): Promise<boolean> {
    try {
      // In Node.js, we can check browser connection status
      if (this.context && !this.context.browser()?.isConnected()) {
        logger.error(
          '❌ Browser connection lost - browser process may have crashed'
        );
        return false;
      }

      // Additional check: try to get browser version (lightweight operation)
      if (this.context?.browser()) {
        await this.context.browser()!.version();
        return true;
      }

      return true;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(`❌ Browser process check failed: ${errorMessage}`);
      return false;
    }
  }

  /**
   * Force close a page using CDP (Chrome DevTools Protocol)
   *
   * @param page - The page to close
   * @returns Promise<boolean> - True if successfully closed
   */
  async forceClosePageViaCDP(page: Page): Promise<boolean> {
    try {
      if (page.isClosed()) {
        logger.debug('🪓 Page already closed');
        return true;
      }

      // Get CDP session for direct control
      const cdpSession = await page.context().newCDPSession(page);

      try {
        // Force close the page via CDP
        await cdpSession.send('Page.close');
        logger.debug('🪓 Successfully force-closed page via CDP');

        // Wait a moment for the close to take effect
        await new Promise((resolve) => setTimeout(resolve, 100));

        return true;
      } finally {
        try {
          await cdpSession.detach();
        } catch {
          // Ignore detach errors
        }
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(`❌ Failed to force close page via CDP: ${errorMessage}`);
      return false;
    }
  }

  /**
   * Try to reopen a URL with timeout
   *
   * @param url - The URL to reopen
   * @param timeoutMs - Navigation timeout in milliseconds
   * @returns Promise<Page | null> - New page if successful, null if failed
   */
  async tryReopenUrl(
    url: string,
    timeoutMs: number = 5000
  ): Promise<Page | null> {
    if (!this.context) {
      logger.error('❌ No browser context available for reopening URL');
      return null;
    }

    try {
      logger.debug(`🍼 Attempting to reopen URL: ${url}`);

      // Create new page
      const newPage = await this.context.newPage();

      try {
        // Navigate with timeout
        await newPage.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: timeoutMs,
        });

        // Verify the new page is responsive
        const isResponsive = await this.isPageResponsive(newPage, 2000);

        if (isResponsive) {
          logger.info(`✅ Successfully reopened and verified URL: ${url}`);
          return newPage;
        } else {
          logger.warn(`⚠️ Reopened page ${url} is still unresponsive`);

          // Close the unresponsive page
          try {
            await this.forceClosePageViaCDP(newPage);
          } catch {
            // Ignore close errors
          }

          return null;
        }
      } catch (navigationError) {
        // Navigation failed, close the page
        try {
          await this.forceClosePageViaCDP(newPage);
        } catch {
          // Ignore close errors
        }
        throw navigationError;
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(`❌ Failed to reopen URL ${url}: ${errorMessage}`);
      return null;
    }
  }

  /**
   * Create a blank fallback page when recovery fails
   *
   * @param originalUrl - The original URL that failed
   * @returns Promise<Page | null> - Blank page if successful
   */
  async createBlankFallbackPage(originalUrl: string): Promise<Page | null> {
    if (!this.context) {
      logger.error('❌ No browser context available for creating blank page');
      return null;
    }

    try {
      logger.debug(
        `🏠 Creating blank fallback page (original URL: ${originalUrl})`
      );

      const blankPage = await this.context.newPage();

      // Navigate to about:blank
      await blankPage.goto('about:blank', { waitUntil: 'load', timeout: 3000 });

      // Verify the blank page is responsive
      const isResponsive = await this.isPageResponsive(blankPage, 1000);

      if (!isResponsive) {
        throw new Error(
          'Browser is unable to load any new about:blank pages (something is very wrong or browser is extremely overloaded)'
        );
      }

      logger.info('✅ Successfully created blank fallback page');
      return blankPage;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(`❌ Failed to create blank fallback page: ${errorMessage}`);
      throw error;
    }
  }

  /**
   * Recover from an unresponsive page by closing and reopening it
   *
   * @param page - The unresponsive page
   * @param callingMethod - Name of the method that triggered recovery
   * @param timeoutMs - Recovery timeout in milliseconds
   * @returns Promise<Page | null> - New page if successful, null if failed
   */
  async recoverUnresponsivePage(
    page: Page,
    callingMethod: string,
    timeoutMs: number = 5000
  ): Promise<Page | null> {
    if (this._inRecovery) {
      logger.debug('Already in recovery, skipping to prevent recursion');
      return null;
    }

    logger.warn(
      `⚠️ Page JS engine became unresponsive in ${callingMethod}(), attempting recovery...`
    );

    // Limit timeout to reasonable bounds
    const actualTimeout = Math.min(3000, timeoutMs);

    // Check if browser process is still alive before attempting recovery
    if (!(await this.isBrowserProcessAlive())) {
      throw new Error(
        'Browser process has crashed - cannot recover unresponsive page'
      );
    }

    // Prevent re-entrance
    this._inRecovery = true;

    try {
      // Get current URL before recovery
      const currentUrl = page.url();
      logger.debug(`Current URL: ${currentUrl}`);

      // Step 1: Force-close the crashed page via CDP
      logger.debug(
        '🪓 Page Recovery Step 1/3: Force-closing crashed page via CDP...'
      );
      await this.forceClosePageViaCDP(page);

      // Step 2: Try to reopen the URL (in case blocking was transient)
      logger.debug(
        '🍼 Page Recovery Step 2/3: Trying to reopen the URL again...'
      );
      const reopenedPage = await this.tryReopenUrl(currentUrl, actualTimeout);

      if (reopenedPage) {
        logger.debug(
          '✅ Page Recovery Step 3/3: Page loading succeeded after 2nd attempt!'
        );
        return reopenedPage;
      }

      // Step 3: If that failed, fall back to blank page
      logger.debug(
        '❌ Page Recovery Step 3/3: Loading the page a 2nd time failed as well, browser seems unable to load this URL without getting stuck, retreating to a safe page...'
      );

      return await this.createBlankFallbackPage(currentUrl);
    } finally {
      // Always clear recovery flag
      this._inRecovery = false;
    }
  }

  /**
   * Check if a URL is a new tab page (about:blank, etc.)
   * Helper method for skipping responsiveness checks on safe pages
   *
   * @param url - The URL to check
   * @returns boolean - True if it's a new tab page
   */
  static isNewTabPage(url: string): boolean {
    return (
      !url ||
      url === 'about:blank' ||
      url.startsWith('chrome://') ||
      url.startsWith('edge://') ||
      url.startsWith('safari://') ||
      url.startsWith('moz-extension://')
    );
  }

  /**
   * Update browser context reference
   * @param context - New browser context
   */
  updateContext(context: BrowserContext): void {
    this.context = context;
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.context = null;
    this._inRecovery = false;
    this.browserProcessInfo = {};
  }
}

/**
 * Decorator function to ensure browser/page health before method execution
 *
 * @param options - Configuration options
 */
export interface RequireHealthyBrowserOptions {
  usablePage?: boolean; // Check page responsiveness (default: true)
  reopenPage?: boolean; // Attempt page recovery if unresponsive (default: true)
}

export function requireHealthyBrowser(
  options: RequireHealthyBrowserOptions = {}
) {
  const { usablePage = true, reopenPage = true } = options;

  return function (
    target: any,
    propertyName: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;

    if (typeof originalMethod !== 'function') {
      throw new Error('@requireHealthyBrowser can only be applied to methods');
    }

    descriptor.value = async function (this: any, ...args: any[]) {
      // Extract page from arguments or context
      const page: Page =
        args.find(
          (arg: any) => arg && typeof arg === 'object' && 'evaluate' in arg
        ) ||
        this.page ||
        this.currentPage;

      if (!page) {
        logger.error('❌ No page found for health check');
        return originalMethod.apply(this, args);
      }

      // Skip health check if page is closed
      if (page.isClosed()) {
        logger.warn('⚠️ Page is closed, skipping health check');
        return originalMethod.apply(this, args);
      }

      // Skip responsiveness check for about:blank pages
      if (AdvancedHealthCheckService.isNewTabPage(page.url())) {
        return originalMethod.apply(this, args);
      }

      // Create health check service
      const healthCheckService = new AdvancedHealthCheckService(page.context());

      if (usablePage) {
        // Check if page is responsive
        const isResponsive = await healthCheckService.isPageResponsive(page);

        if (!isResponsive) {
          if (!reopenPage) {
            logger.warn(
              '⚠️ Page unresponsive but @requireHealthyBrowser(reopenPage=false), attempting to continue anyway...'
            );
          } else {
            try {
              const recoveredPage =
                await healthCheckService.recoverUnresponsivePage(
                  page,
                  propertyName,
                  5000
                );

              if (recoveredPage) {
                logger.debug(
                  `🤕 Crashed page recovery finished, attempting to continue with ${propertyName}()...`
                );

                // Update page reference in arguments if possible
                const pageIndex = args.findIndex(
                  (arg: any) =>
                    arg && typeof arg === 'object' && 'evaluate' in arg
                );

                if (pageIndex >= 0) {
                  args[pageIndex] = recoveredPage;
                }
              } else {
                throw new Error('Page recovery failed');
              }
            } catch (error) {
              const errorMessage =
                error instanceof Error ? error.message : String(error);
              logger.warn(
                `❌ Crashed page recovery failed, could not run ${propertyName}(): ${errorMessage}`
              );
              throw error;
            }
          }
        }
      }

      // Execute the original method
      return originalMethod.apply(this, args);
    };

    return descriptor;
  };
}

// Export factory function for convenience
export const createAdvancedHealthCheck = (context?: BrowserContext) => {
  return new AdvancedHealthCheckService(context);
};
