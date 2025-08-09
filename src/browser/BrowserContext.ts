/**
 * Browser context management for handling user sessions and page lifecycle
 */

import {
  BrowserContext as PlaywrightContext,
  Page,
  Browser as PlaywrightBrowser,
} from 'playwright';
import type { BrowserContextConfig } from '../types/browser';
import { getLogger } from '../services/logging';

/**
 * BrowserContext class for managing browser contexts and pages
 */
export class BrowserContext {
  private config: BrowserContextConfig;
  private browser: PlaywrightBrowser;
  private context: PlaywrightContext | null = null;
  private activePages: Map<string, Page> = new Map();
  private logger = getLogger();

  constructor(browser: PlaywrightBrowser, config: BrowserContextConfig) {
    this.browser = browser;
    this.config = config;
  }

  /**
   * Launch a new browser context
   */
  async launch(): Promise<PlaywrightContext> {
    if (this.context) {
      this.logger.warn('Browser context is already launched');
      return this.context;
    }

    try {
      this.logger.info('Creating browser context');

      const contextOptions = {
        userAgent: this.config.userAgent,
        viewport: this.config.viewport,
        ignoreHTTPSErrors: true, // For easier testing and automation
        ...(this.config.userDataDir && { storageState: undefined }), // Will be handled separately if needed
      };

      this.context = await this.browser.newContext(contextOptions);

      // Set default timeout
      if (this.config.timeout) {
        this.context.setDefaultTimeout(this.config.timeout);
      }

      // Set up page event handlers
      this.context.on('page', (page) => {
        this.handleNewPage(page);
      });

      this.logger.info('Browser context created successfully');
      return this.context;
    } catch (error) {
      this.logger.error('Failed to create browser context', error as Error);
      throw error;
    }
  }

  /**
   * Close the browser context and all associated pages
   */
  async close(): Promise<void> {
    if (!this.context) {
      this.logger.warn('Browser context is not launched');
      return;
    }

    try {
      this.logger.info('Closing browser context');

      // Close all tracked pages first
      const closePromises = Array.from(this.activePages.values()).map(
        async (page) => {
          try {
            if (!page.isClosed()) {
              await page.close();
            }
          } catch (error) {
            this.logger.warn('Failed to close page', {
              error: (error as Error).message,
            });
          }
        }
      );

      await Promise.all(closePromises);
      this.activePages.clear();

      // Close the context
      await this.context.close();
      this.context = null;

      this.logger.info('Browser context closed successfully');
    } catch (error) {
      this.logger.error('Failed to close browser context', error as Error);
      throw error;
    }
  }

  /**
   * Create a new page in this context
   */
  async newPage(): Promise<Page> {
    if (!this.context) {
      throw new Error('Browser context not launched. Call launch() first.');
    }

    try {
      this.logger.debug('Creating new page');

      const page = await this.context.newPage();

      // Apply security checks if domains are restricted
      if (this.config.allowedDomains && this.config.allowedDomains.length > 0) {
        await this.setupDomainRestrictions(page);
      }

      const pageId = this.generatePageId();
      this.activePages.set(pageId, page);

      this.logger.debug('New page created', { pageId });
      return page;
    } catch (error) {
      this.logger.error('Failed to create new page', error as Error);
      throw error;
    }
  }

  /**
   * Get the currently active page (most recently created or focused)
   */
  getActivePage(): Page | undefined {
    const pages = Array.from(this.activePages.values());
    return pages.length > 0 ? pages[pages.length - 1] : undefined;
  }

  /**
   * Get all pages in this context
   */
  getPages(): Page[] {
    return Array.from(this.activePages.values());
  }

  /**
   * Get a specific page by ID
   */
  getPage(pageId: string): Page | undefined {
    return this.activePages.get(pageId);
  }

  /**
   * Close a specific page
   */
  async closePage(pageId: string): Promise<void> {
    const page = this.activePages.get(pageId);
    if (!page) {
      this.logger.warn('Page not found', { pageId });
      return;
    }

    try {
      if (!page.isClosed()) {
        await page.close();
      }
      this.activePages.delete(pageId);
      this.logger.debug('Page closed', { pageId });
    } catch (error) {
      this.logger.error('Failed to close page', error as Error, { pageId });
      throw error;
    }
  }

  /**
   * Get the underlying Playwright context
   */
  getContext(): PlaywrightContext | null {
    return this.context;
  }

  /**
   * Check if context is still valid and connected
   */
  isValid(): boolean {
    return this.context !== null && Boolean(this.context.browser()?.isConnected());
  }

  /**
   * Update context configuration
   */
  updateConfig(config: Partial<BrowserContextConfig>): void {
    this.config = { ...this.config, ...config };
    this.logger.debug('Browser context configuration updated', {
      config: this.config,
    });
  }

  /**
   * Handle new page creation (from context events)
   */
  private handleNewPage(page: Page): void {
    const pageId = this.generatePageId();
    this.activePages.set(pageId, page);

    // Set up page event handlers
    page.on('close', () => {
      this.activePages.delete(pageId);
      this.logger.debug('Page closed by event', { pageId });
    });

    page.on('crash', () => {
      this.activePages.delete(pageId);
      this.logger.warn('Page crashed', { pageId });
    });

    this.logger.debug('New page tracked', { pageId });
  }

  /**
   * Set up domain restrictions for security
   */
  private async setupDomainRestrictions(page: Page): Promise<void> {
    if (
      !this.config.allowedDomains ||
      this.config.allowedDomains.length === 0
    ) {
      return;
    }

    const allowedDomains = this.config.allowedDomains;

    await page.route('**/*', (route, request) => {
      const url = new URL(request.url());
      const domain = url.hostname;

      const isAllowed = allowedDomains.some((allowedDomain) => {
        // Support wildcard matching
        if (allowedDomain.startsWith('*.')) {
          const baseDomain = allowedDomain.slice(2);
          return domain === baseDomain || domain.endsWith('.' + baseDomain);
        }
        return domain === allowedDomain;
      });

      if (isAllowed) {
        route.continue();
      } else {
        this.logger.warn('Blocked navigation to disallowed domain', {
          domain,
          url: request.url(),
          allowedDomains,
        });
        route.abort('failed');
      }
    });
  }

  /**
   * Generate a unique page ID
   */
  private generatePageId(): string {
    return `page_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}
