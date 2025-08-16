/**
 * BrowserSession provides unified session management with step-level state caching
 * and robust health check/recovery mechanisms
 */

import type {
  Browser as PlaywrightBrowser,
  BrowserContext as PlaywrightContext,
  Page,
  ElementHandle,
} from 'playwright';
import { chromium } from 'playwright';
import { DOMService } from '../services/dom-service';
import { ensureHealthyPage, withHealthCheck } from '../services/health-check';
import type { PageView, DOMState } from '../types/dom';
import type { BrowserSessionConfig } from '../types/browser';
import { getLogger } from '../services/logging';
import { promises as fs } from 'fs';
import { ChildProcess } from 'child_process';
import path from 'path';

/**
 * Custom error for when a URL is not allowed
 */
export class URLNotAllowedError extends Error {
  constructor(url: string, allowedDomains: string[]) {
    super(
      `URL not allowed: ${url}. Allowed domains: ${allowedDomains.join(', ')}`
    );
    this.name = 'URLNotAllowedError';
  }
}

export interface BrowserStateSummary extends PageView {
  /** Map from highlight index to the full element node returned by in-page DOM build */
  selectorMap: Map<number, any>;
}

export interface DOMElementNode {
  xpath?: string;
  selector?: string;
  tagName: string;
  attributes?: Record<string, string>;
  highlightIndex?: number;
  isInteractive?: boolean;
  [key: string]: any;
}

export interface TabInfo {
  id: string;
  title: string;
  url: string;
  isActive: boolean;
}

/**
 * Check if a URL is a new tab page (about:blank or chrome://new-tab-page).
 */
function isNewTabPage(url: string): boolean {
  return (
    url === 'about:blank' ||
    url === 'chrome://new-tab-page/' ||
    url === 'chrome://new-tab-page' ||
    url === 'edge://newtab' ||
    url === 'chrome://newtab' ||
    url.startsWith('chrome-extension://')
  );
}

/**
 * Match URL with domain pattern supporting wildcards
 */
function matchUrlWithDomainPattern(url: string, pattern: string): boolean {
  if (isNewTabPage(url)) {
    return true;
  }

  try {
    const urlObj = new URL(url);

    // If pattern includes protocol, match the whole URL
    if (pattern.includes('://')) {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      return regex.test(url);
    }

    // Otherwise, match just the hostname
    const hostname = urlObj.hostname.toLowerCase();
    const patternLower = pattern.toLowerCase();

    // Simple wildcard matching
    if (patternLower.includes('*')) {
      const regex = new RegExp('^' + patternLower.replace(/\*/g, '.*') + '$');
      return regex.test(hostname);
    }

    // Exact match or subdomain match
    return hostname === patternLower || hostname.endsWith('.' + patternLower);
  } catch {
    return false;
  }
}

/**
 * Enhanced BrowserSession class
 */
export class BrowserSession {
  private id: string;
  private config: BrowserSessionConfig;
  private logger = getLogger();

  // Connection parameters
  private wssUrl?: string;
  private cdpUrl?: string;
  private browserPid?: number;
  private playwrightBrowser?: PlaywrightBrowser;
  private playwrightContext?: PlaywrightContext;
  private passedPage?: Page;

  // Runtime state
  private browser?: PlaywrightBrowser;
  private context?: PlaywrightContext;
  private domService: DOMService;
  private initialized = false;
  private currentPage?: Page;
  private humanCurrentPage?: Page;

  // Caching
  private _cachedBrowserStateSummary: BrowserStateSummary | null = null;
  private _cachedElementHashes: Set<string> | null = null;

  // Resource management
  private _ownsResources = true;
  private _keepAlive = false;
  private _downloadedFiles: string[] = [];
  private _subprocess?: ChildProcess;
  private _recordingDir?: string;
  private _currentPageLoadingStatus: string | null = null;

  constructor(
    options: {
      config?: BrowserSessionConfig;
      browser?: PlaywrightBrowser;
      context?: PlaywrightContext;
      page?: Page;
      wssUrl?: string;
      cdpUrl?: string;
      browserPid?: number;
    } = {}
  ) {
    this.id = this.generateId();
    this.config = {
      keepAlive: false,
      saveState: true,
      autoDownloadPDFs: true,
      headless: true,
      timeout: 30000,
      viewport: { width: 1280, height: 720 },
      // Page load timing defaults (match Python version)
      minimumWaitPageLoadTime: 0.25,
      waitForNetworkIdlePageLoadTime: 0.5,
      maximumWaitPageLoadTime: 5.0,
      waitBetweenActions: 0.5,
      ...options.config,
    };

    // Connection parameters
    this.wssUrl = options.wssUrl;
    this.cdpUrl = options.cdpUrl;
    this.browserPid = options.browserPid;
    this.playwrightBrowser = options.browser;
    this.playwrightContext = options.context;
    this.passedPage = options.page;

    this.domService = new DOMService();

    // Set ownership based on what was passed in
    this._ownsResources = !options.browser && !options.context;
    this._keepAlive = this.config.keepAlive || false;

    this.logger.debug('BrowserSession created', { id: this.id });
  }

  /**
   * Unified start method - handles all connection scenarios
   */
  async start(): Promise<BrowserSession> {
    if (this.initialized) {
      this.logger.warn('BrowserSession already initialized');
      return this;
    }

    try {
      this.logger.info('Starting BrowserSession', {
        id: this.id,
        connectionMethod: this.getConnectionMethod(),
      });

      if (this.playwrightBrowser || this.playwrightContext || this.passedPage) {
        await this.setupFromPassedObjects();
      } else if (this.browserPid) {
        await this.setupFromBrowserPid();
      } else if (this.wssUrl) {
        await this.setupFromWssUrl();
      } else if (this.cdpUrl) {
        await this.setupFromCdpUrl();
      } else {
        await this.launchNewBrowser();
      }

      await this.setupContext();
      await this.setupCurrentPage();
      await this.setupRecording();

      this.initialized = true;
      this.logger.info('BrowserSession started successfully', { id: this.id });
      return this;
    } catch (error) {
      this.logger.error('Failed to start BrowserSession', error as Error);
      throw error;
    }
  }

  /**
   * Get stable state snapshot for current step (with caching)
   */
  async getStateSummary(
    forceRefresh: boolean = false
  ): Promise<BrowserStateSummary> {
    if (this._cachedBrowserStateSummary && !forceRefresh) {
      return this._cachedBrowserStateSummary;
    }

    const page = await this.getCurrentPage();
    const { page: healthyPage } = await ensureHealthyPage(page);
    if (healthyPage !== page) {
      this.currentPage = healthyPage;
    }

    await this.waitForPageAndFramesLoad(page);

    const pageView = await this.domService.getPageView(
      healthyPage,
      this.context!,
      {},
      true
    );
    const selectorMap = this.buildSelectorMap(pageView.domState);

    this._cachedBrowserStateSummary = {
      ...pageView,
      selectorMap,
    };

    this.logger.debug('State summary cached', {
      url: pageView.url,
      elements: selectorMap.size,
    });

    return this._cachedBrowserStateSummary;
  }

  private async waitForPageAndFramesLoad(
    page: Page,
    timeoutOverwrite?: number
  ): Promise<void> {
    /**
     * Ensures page is fully loaded and stable before continuing.
     * Waits for network idle, DOM stability, and minimum WAIT_TIME.
     * Also checks if the loaded URL is allowed.
     *
     * Parameters:
     * -----------
     * page: Page - The page to wait for
     * timeoutOverwrite: number | undefined - Override the minimum wait time
     */

    // Start timing
    const startTime = Date.now() / 1000;

    // Skip network waiting for new tab pages (about:blank, chrome://new-tab-page, etc.)
    // These pages load instantly and don't need network idle time
    if (isNewTabPage(page.url())) {
      this.logger.debug(
        `⚡ Skipping page load wait for new tab page: ${page.url()}`
      );
      return;
    }

    try {
      await this.waitForStableNetwork();

      // Check if the loaded URL is allowed
      await this.checkAndHandleNavigation(page);
    } catch (error) {
      if (error instanceof URLNotAllowedError) {
        throw error;
      }
      this.logger.warn(
        `⚠️ Page load for ${page.url()} failed due to ${error?.constructor?.name || 'Unknown error'}, continuing anyway...`
      );
    }

    // Calculate remaining time to meet minimum WAIT_TIME
    const elapsed = Date.now() / 1000 - startTime;
    const minimumWait =
      timeoutOverwrite ?? this.config.minimumWaitPageLoadTime ?? 0.25;
    const remaining = Math.max(minimumWait - elapsed, 0);

    // Get tab index for logging (try to find it in context pages)
    let tabIdx: string | number = '??';
    try {
      if (this.context?.pages) {
        const pages = this.context.pages();
        tabIdx = pages.indexOf(page);
        if (tabIdx === -1) tabIdx = '??';
      }
    } catch {
      // Ignore errors getting tab index
    }

    let extraDelay = '';
    if (remaining > 0) {
      extraDelay = `, waiting +${remaining.toFixed(2)}s for all frames to finish`;
    }

    // Log the page navigation completion
    this.logger.info(
      `➡️ Page navigation [${tabIdx}] ${this.truncateUrl(page.url(), 40)} took ${elapsed.toFixed(2)}s${extraDelay}`
    );

    // Sleep remaining time if needed
    if (remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, remaining * 1000));
    }
  }

  /**
   * Truncate URL for logging purposes
   */
  private truncateUrl(url: string, maxLength: number): string {
    if (url.length <= maxLength) {
      return url;
    }
    return url.substring(0, maxLength - 3) + '...';
  }

  /**
   * Invalidate cached state (called after actions that change DOM)
   */
  invalidateCache(): void {
    this._cachedBrowserStateSummary = null;
    this._cachedElementHashes = null;
    this.domService.clearCache();
    this.logger.debug('State cache invalidated');
  }

  /**
   * Get DOM signature for change detection
   */
  async getDomSignature(): Promise<string> {
    const page = await this.getCurrentPage();
    return await this.domService.getDomSignature(page);
  }

  /**
   * Navigate with state invalidation
   */
  async navigate(
    url: string,
    newTab: boolean = false,
    timeoutMs?: number
  ): Promise<Page> {
    return withHealthCheck(await this.getCurrentPage(), async (healthyPage) => {
      let targetPage = healthyPage;

      if (newTab) {
        targetPage = await this.context!.newPage();
        this.currentPage = targetPage;
      }

      await targetPage.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs || this.config.timeout,
      });

      // Wait for page and frames to fully load (equivalent to Python version)
      await this.waitForPageAndFramesLoad(targetPage);

      this.invalidateCache();

      this.logger.info('Navigation completed', { url, newTab });
      return { success: true, message: `Navigated to ${url}` };
    }).then(() => this.currentPage!);
  }

  /**
   * Click element by highlight index with robust error handling
   */
  async clickByIndex(index: number): Promise<void> {
    await this.executeWithHealthCheck(async () => {
      if (!this._cachedBrowserStateSummary) {
        await this.getStateSummary(true);
      }

      const node = this._cachedBrowserStateSummary!.selectorMap.get(index);
      if (!node) {
        throw new Error(`Element with index ${index} not found`);
      }

      await this.clickElementNode(node);
      this.invalidateCache();
    });
  }

  /**
   * Type text by index with enhanced input handling
   */
  async typeByIndex(index: number, text: string): Promise<void> {
    await this.executeWithHealthCheck(async () => {
      if (!this._cachedBrowserStateSummary) {
        await this.getStateSummary(true);
      }

      const node = this._cachedBrowserStateSummary!.selectorMap.get(index);
      if (!node) {
        throw new Error(`Element with index ${index} not found`);
      }

      await this.inputTextElementNode(node, text);
      this.invalidateCache();
    });
  }

  /**
   * Enhanced element clicking with fallback strategies
   */
  private async clickElementNode(elementNode: DOMElementNode): Promise<void> {
    const page = await this.getCurrentPage();
    const element = await this.locateElement(elementNode);

    if (!element) {
      throw new Error('Element not found for clicking');
    }

    const strategies = [
      () => element.click({ timeout: 5000 }),
      () => element.click({ force: true, timeout: 5000 }),
      () => this.clickWithJavaScript(element),
      () => this.clickAtCoordinates(element),
    ];

    for (const [index, strategy] of strategies.entries()) {
      try {
        await strategy();
        this.logger.debug(`Click succeeded with strategy ${index + 1}`);
        await page.waitForTimeout(300); // Small delay after click
        return;
      } catch (error) {
        this.logger.debug(`Click strategy ${index + 1} failed`, {
          error: (error as Error).message,
        });
        if (index === strategies.length - 1) {
          throw error;
        }
      }
    }
  }

  /**
   * Enhanced text input with element type detection
   */
  private async inputTextElementNode(
    elementNode: DOMElementNode,
    text: string
  ): Promise<void> {
    const element = await this.locateElement(elementNode);

    if (!element) {
      throw new Error('Element not found for text input');
    }

    // Clear existing content first
    try {
      await element.fill('');
    } catch {
      // Ignore if element is not fillable
    }

    // Type with delay for more natural interaction
    await element.type(text, { delay: 30 });
  }

  /**
   * Robust element location with iframe and shadow DOM support
   */
  private async locateElement(
    elementNode: DOMElementNode
  ): Promise<ElementHandle | null> {
    const page = await this.getCurrentPage();

    // Try XPath first if available
    if (elementNode.xpath) {
      try {
        const xpath = elementNode.xpath.startsWith('/')
          ? elementNode.xpath
          : `/${elementNode.xpath}`;
        const elements = await page.$$(`xpath=${xpath}`);
        if (elements.length > 0) {
          return elements[0];
        }
      } catch (error) {
        this.logger.debug('XPath location failed', {
          xpath: elementNode.xpath,
          error: (error as Error).message,
        });
      }
    }

    // Fallback to CSS selector
    if (elementNode.selector) {
      try {
        const element = await page.$(elementNode.selector);
        if (element) {
          return element;
        }
      } catch (error) {
        this.logger.debug('CSS selector location failed', {
          selector: elementNode.selector,
          error: (error as Error).message,
        });
      }
    }

    // Final fallback to tag name
    if (elementNode.tagName) {
      try {
        const elements = await page.$$(elementNode.tagName);
        if (elements.length > 0) {
          return elements[0];
        }
      } catch (error) {
        this.logger.debug('Tag name location failed', {
          tagName: elementNode.tagName,
          error: (error as Error).message,
        });
      }
    }

    return null;
  }

  /**
   * JavaScript click fallback
   */
  private async clickWithJavaScript(element: ElementHandle): Promise<void> {
    await element.evaluate((el: HTMLElement) => {
      el.click();
      el.dispatchEvent(
        new MouseEvent('click', {
          view: window,
          bubbles: true,
          cancelable: true,
        })
      );
    });
  }

  /**
   * Coordinate-based click fallback
   */
  private async clickAtCoordinates(element: ElementHandle): Promise<void> {
    const page = await this.getCurrentPage();
    const box = await element.boundingBox();

    if (box) {
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await page.mouse.click(x, y);
    }
  }

  /**
   * Get current page with creation if needed
   */
  async getCurrentPage(): Promise<Page> {
    if (!this.initialized) {
      await this.start();
    }

    if (this.currentPage && !this.currentPage.isClosed()) {
      return this.currentPage;
    }

    // Create new page if needed
    if (this.context) {
      this.currentPage = await this.context.newPage();
      return this.currentPage;
    }

    throw new Error('No browser context available');
  }

  /**
   * Get all tabs information
   */
  async getTabsInfo(): Promise<TabInfo[]> {
    if (!this.context) {
      return [];
    }

    const pages = this.context.pages();
    const tabsInfo: TabInfo[] = [];

    for (const [pageIndex, page] of pages.entries()) {
      const url = page.url();

      // Skip JS execution for chrome:// pages and new tab pages
      if (isNewTabPage(url) || url.startsWith('chrome://')) {
        // Use URL as title for chrome pages, or mark new tabs as unusable
        let title: string;
        if (isNewTabPage(url)) {
          title = 'ignore this tab and do not use it';
        } else {
          // For chrome:// pages, use the URL itself as the title
          title = url;
        }

        tabsInfo.push({
          id: `page_${pageIndex}`,
          title,
          url,
          isActive: page === this.currentPage,
        });
        continue;
      }

      // Normal pages - try to get title with timeout
      try {
        // Create a timeout promise for page.title()
        const titlePromise = page.title();
        const timeoutPromise = new Promise<never>((_, reject) => {
          // todo: make this configurable
          setTimeout(() => reject(new Error('Title timeout')), 10 * 1000);
        });

        const title = await Promise.race([titlePromise, timeoutPromise]);
        tabsInfo.push({
          id: `page_${pageIndex}`,
          title,
          url,
          isActive: page === this.currentPage,
        });
      } catch (error) {
        // page.title() can hang forever on tabs that are crashed/disappeared/about:blank
        // but we should preserve the real URL and not mislead the LLM about tab availability
        this.logger.debug(
          `⚠️ Failed to get tab info for tab #${pageIndex}: ${url} (using fallback title)`,
          { error: (error as Error).message }
        );

        // Only mark as unusable if it's actually a new tab page, otherwise preserve the real URL
        if (isNewTabPage(url)) {
          tabsInfo.push({
            id: `page_${pageIndex}`,
            title: 'ignore this tab and do not use it',
            url,
            isActive: page === this.currentPage,
          });
        } else {
          // harsh but good, just close the page here because if we can't get the title
          // then we certainly can't do anything else useful with it, no point keeping it open
          try {
            await page.close();
            this.logger.debug(
              `🪓 Force-closed page because its JS engine is unresponsive: ${url}`
            );
          } catch {
            // Ignore close errors
          }
          // Continue to next page without adding this one to tabsInfo
          continue;
        }
      }
    }

    return tabsInfo;
  }

  /**
   * Switch to tab by index
   */
  async switchTab(tabIndex: number): Promise<Page> {
    return this.executeWithHealthCheck(async () => {
      if (!this.context) {
        throw new Error('No browser context available');
      }

      const pages = this.context.pages();
      if (tabIndex < 0 || tabIndex >= pages.length) {
        throw new Error(`Tab index ${tabIndex} out of range`);
      }

      this.currentPage = pages[tabIndex];
      this.invalidateCache();

      this.logger.debug('Switched to tab', { tabIndex });
      return this.currentPage;
    });
  }

  /**
   * Close tab by index
   */
  async closeTab(tabIndex?: number): Promise<void> {
    if (!this.context) {
      return;
    }

    const pages = this.context.pages();
    const targetIndex = tabIndex ?? pages.indexOf(this.currentPage!);

    if (targetIndex >= 0 && targetIndex < pages.length) {
      const page = pages[targetIndex];
      await page.close();

      // Switch to another page if we closed the current one
      if (page === this.currentPage) {
        const remainingPages = this.context.pages();
        this.currentPage =
          remainingPages.length > 0 ? remainingPages[0] : undefined;
      }
    }
  }

  /**
   * Save storage state (cookies, localStorage, etc.)
   */
  async saveStorageState(filePath?: string): Promise<void> {
    if (!this.context) {
      return;
    }

    const savePath = filePath || this.getDefaultStoragePath();

    try {
      await fs.mkdir(path.dirname(savePath), { recursive: true });
      const storageState = await this.context.storageState();
      await fs.writeFile(savePath, JSON.stringify(storageState, null, 2));

      this.logger.debug('Storage state saved', { path: savePath });
    } catch (error) {
      this.logger.error('Failed to save storage state', error as Error);
    }
  }

  /**
   * Load storage state
   */
  async loadStorageState(filePath?: string): Promise<void> {
    if (!this.context) {
      return;
    }

    const loadPath = filePath || this.getDefaultStoragePath();

    try {
      const storageState = JSON.parse(await fs.readFile(loadPath, 'utf-8'));
      await this.context.clearCookies();
      await this.context.addCookies(storageState.cookies || []);

      this.logger.debug('Storage state loaded', { path: loadPath });
    } catch (error) {
      this.logger.debug('Failed to load storage state', {
        path: loadPath,
        error: (error as Error).message,
      });
    }
  }

  /**
   * Take screenshot
   */
  async takeScreenshot(fullPage: boolean = false): Promise<Buffer | null> {
    return this.executeWithHealthCheck(async (healthyPage) => {
      const screenshot = await healthyPage.screenshot({
        fullPage,
        type: 'png',
      });

      this.logger.debug('Screenshot taken', { fullPage });
      return screenshot;
    });
  }

  /**
   * Get downloaded files list
   */
  getDownloadedFiles(): string[] {
    return [...this._downloadedFiles];
  }

  /**
   * Stop session gracefully
   */
  async stop(): Promise<void> {
    this.logger.info('Stopping BrowserSession', { id: this.id });

    try {
      // Save state if configured
      if (this.config.saveState && this.context) {
        await this.saveStorageState();
      }

      // Stop recording
      await this.stopRecording();

      // Close context if we own it
      if (this._ownsResources && this.context && !this._keepAlive) {
        await this.context.close();
      }

      // Close browser if we own it
      if (this._ownsResources && this.browser && !this._keepAlive) {
        await this.browser.close();
      }

      // Kill subprocess if exists
      if (this._subprocess && !this._keepAlive) {
        this._subprocess.kill('SIGTERM');
      }

      this.initialized = false;
      this.logger.info('BrowserSession stopped', { id: this.id });
    } catch (error) {
      this.logger.error('Error stopping BrowserSession', error as Error);
    }
  }

  /**
   * Force kill browser process
   */
  async kill(): Promise<void> {
    this.logger.warn('Force killing BrowserSession', { id: this.id });

    try {
      if (this.context) {
        await this.context.close();
      }
      if (this.browser) {
        await this.browser.close();
      }
      if (this._subprocess) {
        this._subprocess.kill('SIGKILL');
      }
    } catch (error) {
      this.logger.error('Error killing BrowserSession', error as Error);
    }

    this.initialized = false;
  }

  /**
   * Check if session is connected
   */
  async isConnected(): Promise<boolean> {
    try {
      if (!this.browser) return false;
      await this.browser.version();
      return true;
    } catch {
      return false;
    }
  }

  // Expose underlying objects when needed
  getBrowser(): PlaywrightBrowser | undefined {
    return this.browser;
  }

  getContext(): PlaywrightContext | undefined {
    return this.context;
  }

  // Private helper methods

  private async executeWithHealthCheck<T>(
    fn: (healthyPage: Page) => Promise<T>
  ): Promise<T> {
    const page = await this.getCurrentPage();
    const { page: healthyPage } = await ensureHealthyPage(page);

    if (healthyPage !== page) {
      this.currentPage = healthyPage;
    }

    return await fn(healthyPage);
  }

  private buildSelectorMap(domState?: DOMState): Map<number, any> {
    const map = new Map<number, any>();
    if (!domState?.map) return map;

    for (const [, node] of Object.entries(domState.map)) {
      if (
        node &&
        typeof node === 'object' &&
        typeof node.highlightIndex === 'number'
      ) {
        map.set(node.highlightIndex, {
          ...node,
          selector: node.xpath ? `xpath=/${node.xpath}` : node.tagName,
        });
      }
    }

    return map;
  }

  private getConnectionMethod(): string {
    if (this.playwrightBrowser || this.playwrightContext || this.passedPage)
      return 'passed-objects';
    if (this.browserPid) return 'browser-pid';
    if (this.wssUrl) return 'wss-url';
    if (this.cdpUrl) return 'cdp-url';
    return 'launch-new';
  }

  private generateId(): string {
    return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private getDefaultStoragePath(): string {
    const dir = this._recordingDir || './recordings';
    return path.join(dir, `${this.id}_storage.json`);
  }

  // Setup methods for different connection types

  private async setupFromPassedObjects(): Promise<void> {
    if (this.passedPage) {
      this.currentPage = this.passedPage;
      this.context = this.passedPage.context();
      this.browser = this.context.browser()!;
      this._ownsResources = false;
    } else if (this.playwrightContext) {
      this.context = this.playwrightContext;
      this.browser = this.context.browser()!;
      this._ownsResources = false;
    } else if (this.playwrightBrowser) {
      this.browser = this.playwrightBrowser;
      this._ownsResources = false;
    }
  }

  private async setupFromBrowserPid(): Promise<void> {
    // Connect to existing Chrome instance via CDP
    const cdpUrl = `http://localhost:9222`;
    this.browser = await chromium.connectOverCDP(cdpUrl);
    this._ownsResources = false; // Don't close existing browser
  }

  private async setupFromWssUrl(): Promise<void> {
    if (!this.wssUrl) {
      throw new Error('WSS URL not provided');
    }
    this.browser = await chromium.connect(this.wssUrl);
    this._ownsResources = false;
  }

  private async setupFromCdpUrl(): Promise<void> {
    if (!this.cdpUrl) {
      throw new Error('CDP URL not provided');
    }
    this.browser = await chromium.connectOverCDP(this.cdpUrl);
    this._ownsResources = false;
  }

  private async launchNewBrowser(): Promise<void> {
    const launchOptions = {
      headless: this.config.headless,
      args: this.config.args || [],
      timeout: this.config.timeout,
    };

    if (this.config.userDataDir) {
      (launchOptions as any).userDataDir = this.config.userDataDir;
    }

    this.browser = await chromium.launch(launchOptions);
    this._ownsResources = true;
  }

  private async setupContext(): Promise<void> {
    if (!this.context && this.browser) {
      const contextOptions: any = {
        viewport: this.config.viewport,
        userAgent: this.config.userAgent,
        ignoreHTTPSErrors: true,
      };

      if (this.config.recordVideo && this._recordingDir) {
        contextOptions.recordVideo = {
          dir: this._recordingDir,
          size: this.config.viewport,
        };
      }

      this.context = await this.browser.newContext(contextOptions);

      if (this.config.timeout) {
        this.context.setDefaultTimeout(this.config.timeout);
      }

      // Setup download handling
      this.context.on('page', (page) => {
        page.on('download', (download) => {
          this._downloadedFiles.push(download.suggestedFilename());
        });
      });
    }
  }

  private async setupCurrentPage(): Promise<void> {
    if (!this.currentPage && this.context) {
      this.currentPage = await this.context.newPage();
    }
  }

  private async setupRecording(): Promise<void> {
    if (this.config.recordTrace && this.context) {
      await this.context.tracing.start({
        screenshots: true,
        snapshots: true,
        sources: true,
      });
    }
  }

  private async stopRecording(): Promise<void> {
    if (this.config.recordTrace && this.context) {
      try {
        const tracePath = path.join(
          this._recordingDir || './recordings',
          `${this.id}_trace.zip`
        );
        await fs.mkdir(path.dirname(tracePath), { recursive: true });
        await this.context.tracing.stop({ path: tracePath });
        this.logger.debug('Trace recording saved', { path: tracePath });
      } catch (error) {
        this.logger.error('Failed to save trace recording', error as Error);
      }
    }
  }

  // Cleanup handling
  private cleanupHandlers: (() => Promise<void>)[] = [];

  private async addCleanupHandler(handler: () => Promise<void>): Promise<void> {
    this.cleanupHandlers.push(handler);
  }

  private async runCleanupHandlers(): Promise<void> {
    for (const handler of this.cleanupHandlers) {
      try {
        await handler();
      } catch (error) {
        this.logger.debug('Cleanup handler failed', {
          error: (error as Error).message,
        });
      }
    }
    this.cleanupHandlers = [];
  }

  /**
   * Check if a URL is allowed based on the allowedDomains configuration
   */
  private isUrlAllowed(url: string): boolean {
    if (
      !this.config.allowedDomains ||
      this.config.allowedDomains.length === 0
    ) {
      return true; // No restrictions configured, allow everything
    }

    // Special case: Always allow new tab pages
    if (isNewTabPage(url)) {
      return true;
    }

    for (const allowedDomain of this.config.allowedDomains) {
      try {
        if (matchUrlWithDomainPattern(url, allowedDomain)) {
          // If it's a pattern with wildcards, log warning (similar to Python version)
          if (allowedDomain.includes('*')) {
            try {
              const urlObj = new URL(url);
              const domain = urlObj.hostname.toLowerCase();
              this.logger.warn(
                `Using wildcard pattern '${allowedDomain}' for domain '${domain}'. Consider using specific domains for better security.`
              );
            } catch {
              // Ignore URL parsing errors for warning
            }
          }
          return true;
        }
      } catch {
        // Continue to next pattern if this one fails
        continue;
      }
    }

    return false;
  }

  /**
   * Check if current page URL is allowed and handle if not
   */
  private async checkAndHandleNavigation(page: Page): Promise<void> {
    if (!this.isUrlAllowed(page.url())) {
      throw new URLNotAllowedError(
        page.url(),
        this.config.allowedDomains || []
      );
    }
  }

  /**
   * Wait for stable network activity (equivalent to Python's _wait_for_stable_network)
   */
  private async waitForStableNetwork(): Promise<void> {
    const pendingRequests = new Set<any>();
    let lastActivity = Date.now() / 1000;

    const page = await this.getCurrentPage();

    // Define relevant resource types and content types
    const RELEVANT_RESOURCE_TYPES = new Set([
      'document',
      'stylesheet',
      'image',
      'font',
      'script',
      'iframe',
    ]);

    const RELEVANT_CONTENT_TYPES = [
      'text/html',
      'text/css',
      'application/javascript',
      'image/',
      'font/',
      'application/json',
    ];

    // Additional patterns to filter out
    const IGNORED_URL_PATTERNS = [
      // Analytics and tracking
      'analytics',
      'tracking',
      'telemetry',
      'beacon',
      'metrics',
      // Ad-related
      'doubleclick',
      'adsystem',
      'adserver',
      'advertising',
      // Social media widgets
      'facebook.com/plugins',
      'platform.twitter',
      'linkedin.com/embed',
      // Live chat and support
      'livechat',
      'zendesk',
      'intercom',
      'crisp.chat',
      'hotjar',
      // Push notifications
      'push-notifications',
      'onesignal',
      'pushwoosh',
      // Background sync/heartbeat
      'heartbeat',
      'ping',
      'alive',
      // WebRTC and streaming
      'webrtc',
      'rtmp://',
      'wss://',
      // Common CDNs for dynamic content
      'cloudfront.net',
      'fastly.net',
    ];

    const onRequest = (request: any) => {
      // Filter by resource type
      if (!RELEVANT_RESOURCE_TYPES.has(request.resourceType())) {
        return;
      }

      // Filter out streaming, websocket, and other real-time requests
      if (
        ['websocket', 'media', 'eventsource', 'manifest', 'other'].includes(
          request.resourceType()
        )
      ) {
        return;
      }

      // Filter out by URL patterns
      const url = request.url().toLowerCase();
      if (IGNORED_URL_PATTERNS.some((pattern) => url.includes(pattern))) {
        return;
      }

      // Filter out data URLs and blob URLs
      if (url.startsWith('data:') || url.startsWith('blob:')) {
        return;
      }

      // Filter out requests with certain headers
      const headers = request.headers();
      if (
        headers.purpose === 'prefetch' ||
        ['video', 'audio'].includes(headers['sec-fetch-dest'])
      ) {
        return;
      }

      pendingRequests.add(request);
      lastActivity = Date.now() / 1000;
      // this.logger.debug(`Request started: ${request.url()} (${request.resourceType()})`);
    };

    const onResponse = (response: any) => {
      const request = response.request();
      if (!pendingRequests.has(request)) {
        return;
      }

      // Filter by content type if available
      const contentType = (
        response.headers()['content-type'] || ''
      ).toLowerCase();

      // Skip if content type indicates streaming or real-time data
      const streamingTypes = [
        'streaming',
        'video',
        'audio',
        'webm',
        'mp4',
        'event-stream',
        'websocket',
        'protobuf',
      ];
      if (streamingTypes.some((t) => contentType.includes(t))) {
        pendingRequests.delete(request);
        return;
      }

      // Only process relevant content types
      if (!RELEVANT_CONTENT_TYPES.some((ct) => contentType.includes(ct))) {
        pendingRequests.delete(request);
        return;
      }

      // Skip if response is too large (likely not essential for page load)
      const contentLength = response.headers()['content-length'];
      if (contentLength && parseInt(contentLength) > 5 * 1024 * 1024) {
        // 5MB
        pendingRequests.delete(request);
        return;
      }

      pendingRequests.delete(request);
      lastActivity = Date.now() / 1000;
      // this.logger.debug(`Request resolved: ${request.url()} (${contentType})`);
    };

    // Attach event listeners
    page.on('request', onRequest);
    page.on('response', onResponse);

    const startTime = Date.now() / 1000;
    try {
      // Wait for idle time
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const now = Date.now() / 1000;

        if (
          pendingRequests.size === 0 &&
          now - lastActivity >=
            (this.config.waitForNetworkIdlePageLoadTime || 0.5)
        ) {
          // Clear loading status when page loads successfully
          this._currentPageLoadingStatus = null;
          break;
        }

        if (now - startTime > (this.config.maximumWaitPageLoadTime || 5.0)) {
          const pendingUrls = Array.from(pendingRequests).map((r: any) =>
            r.url()
          );
          this.logger.debug(
            `Network timeout after ${this.config.maximumWaitPageLoadTime}s with ${pendingRequests.size} ` +
              `pending requests: ${pendingUrls}`
          );
          // Set loading status for LLM to see
          this._currentPageLoadingStatus = `Page loading was aborted after ${this.config.maximumWaitPageLoadTime}s with ${pendingRequests.size} pending network requests. You may want to use the wait action to allow more time for the page to fully load.`;
          break;
        }
      }
    } finally {
      // Clean up event listeners
      page.off('request', onRequest);
      page.off('response', onResponse);
    }

    const elapsed = Date.now() / 1000 - startTime;
    if (elapsed > 1) {
      this.logger.debug(
        `💤 Page network traffic calmed down after ${elapsed.toFixed(2)} seconds`
      );
    }
  }

  // Destructor equivalent
  async [Symbol.asyncDispose](): Promise<void> {
    await this.stop();
  }

  // Make compatible with async context managers
  async __aenter__(): Promise<BrowserSession> {
    await this.start();
    return this;
  }

  async __aexit__(): Promise<void> {
    await this.stop();
  }
}
