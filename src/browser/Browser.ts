/**
 * Browser management class that handles browser process lifecycle
 */

import {
  chromium,
  firefox,
  webkit,
  Browser as PlaywrightBrowser,
  BrowserType,
} from 'playwright';
import type { BrowserConfig } from '../types/browser';
import { getLogger } from '../services/logging';

/**
 * Browser class for managing Playwright browser instances
 */
export class Browser {
  private config: BrowserConfig;
  private browser: PlaywrightBrowser | null = null;
  private browserType: BrowserType;
  private logger = getLogger();

  constructor(config: BrowserConfig) {
    this.config = config;

    // Select browser type based on configuration
    switch (config.browserType) {
      case 'firefox':
        this.browserType = firefox;
        break;
      case 'webkit':
        this.browserType = webkit;
        break;
      case 'chromium':
      default:
        this.browserType = chromium;
        break;
    }
  }

  /**
   * Launch the browser instance
   */
  async launch(): Promise<PlaywrightBrowser> {
    if (this.browser) {
      this.logger.warn('Browser is already launched');
      return this.browser;
    }

    try {
      this.logger.info('Launching browser', {
        browserType: this.config.browserType,
        headless: this.config.headless,
      });

      const launchOptions = {
        headless: this.config.headless,
        args: this.config.args,
        executablePath: this.config.executablePath,
        timeout: this.config.timeout,
      };

      this.browser = await this.browserType.launch(launchOptions);

      this.logger.info('Browser launched successfully');
      return this.browser;
    } catch (error) {
      this.logger.error('Failed to launch browser', error as Error);
      throw error;
    }
  }

  /**
   * Close the browser instance
   */
  async close(): Promise<void> {
    if (!this.browser) {
      this.logger.warn('Browser is not launched');
      return;
    }

    try {
      this.logger.info('Closing browser');
      await this.browser.close();
      this.browser = null;
      this.logger.info('Browser closed successfully');
    } catch (error) {
      this.logger.error('Failed to close browser', error as Error);
      throw error;
    }
  }

  /**
   * Get the current browser instance
   */
  getBrowser(): PlaywrightBrowser | null {
    return this.browser;
  }

  /**
   * Check if browser is launched and connected
   */
  async isConnected(): Promise<boolean> {
    if (!this.browser) {
      return false;
    }

    try {
      // Try to get browser version to check if still connected
      await this.browser.version();
      return true;
    } catch (error) {
      this.logger.warn('Browser connection lost', {
        error: (error as Error).message,
      });
      return false;
    }
  }

  /**
   * Restart the browser (close and launch again)
   */
  async restart(): Promise<PlaywrightBrowser> {
    this.logger.info('Restarting browser');

    if (this.browser) {
      await this.close();
    }

    return await this.launch();
  }

  /**
   * Update browser configuration
   */
  updateConfig(config: Partial<BrowserConfig>): void {
    this.config = { ...this.config, ...config };
    this.logger.debug('Browser configuration updated', { config: this.config });
  }

  /**
   * Get current browser configuration
   */
  getConfig(): BrowserConfig {
    return { ...this.config };
  }
}
