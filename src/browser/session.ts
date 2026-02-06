import fs from 'node:fs';
import path from 'node:path';
import { spawn, exec, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '../logging-config.js';
import { match_url_with_domain_pattern, uuid7str } from '../utils.js';
import type { Browser, BrowserContext, Page, Locator } from './types.js';
import {
  BrowserProfile,
  type BrowserProfileOptions,
  DEFAULT_BROWSER_PROFILE,
} from './profile.js';
import { BrowserStateSummary, type TabInfo, BrowserError } from './views.js';
import { DOMElementNode, DOMState, type SelectorMap } from '../dom/views.js';
import { normalize_url } from './utils.js';
import { DomService } from '../dom/service.js';
import {
  showDVDScreensaver,
  showSpinner,
  withDVDScreensaver,
} from './dvd-screensaver.js';

const execAsync = promisify(exec);

export interface BrowserSessionInit {
  id?: string;
  browser_profile?: BrowserProfile;
  profile?: Partial<BrowserProfileOptions>;
  browser?: Browser | null;
  browser_context?: BrowserContext | null;
  page?: Page | null;
  title?: string | null;
  url?: string | null;
  wss_url?: string | null;
  cdp_url?: string | null;
  browser_pid?: number | null;
  playwright?: unknown;
  downloaded_files?: string[];
}

const createEmptyDomState = (): DOMState => {
  const root = new DOMElementNode(true, null, 'html', '/html[1]', {}, []);
  return new DOMState(root, {} as SelectorMap);
};

/**
 * Cached clickable elements hashes for the last state
 * Used to reduce token usage by tracking which elements are new
 */
interface CachedClickableElementHashes {
  url: string;
  hashes: Set<string>;
}

export interface BrowserStateOptions {
  cache_clickable_elements_hashes?: boolean;
  include_screenshot?: boolean;
}

export class BrowserSession {
  readonly id: string;
  readonly browser_profile: BrowserProfile;
  browser: Browser | null;
  browser_context: BrowserContext | null;
  agent_current_page: Page | null;
  human_current_page: Page | null;
  initialized = false;
  wss_url: string | null;
  cdp_url: string | null;
  browser_pid: number | null;
  playwright: unknown;
  private cachedBrowserState: BrowserStateSummary | null = null;
  private _cachedClickableElementHashes: CachedClickableElementHashes | null =
    null;
  private currentUrl: string;
  private currentTitle: string;
  private _logger: ReturnType<typeof createLogger> | null = null;
  private _tabCounter = 0;
  private _tabs: TabInfo[] = [];
  private currentTabIndex = 0;
  private historyStack: string[] = [];
  downloaded_files: string[] = [];
  private ownsBrowserResources = true;
  private _autoDownloadPdfs = true;
  private tabPages = new Map<number, Page | null>();
  private currentPageLoadingStatus: string | null = null;
  private _subprocess: ChildProcess | null = null;
  private _childProcesses: Set<number> = new Set();

  constructor(init: BrowserSessionInit = {}) {
    this.browser_profile =
      init.browser_profile ?? new BrowserProfile(init.profile ?? {});
    this.id = init.id ?? uuid7str();
    this.browser = init.browser ?? null;
    this.browser_context = init.browser_context ?? null;
    this.agent_current_page = init.page ?? null;
    this.human_current_page = init.page ?? null;
    this.currentUrl = normalize_url(init.url ?? 'about:blank');
    this.currentTitle = init.title ?? '';
    this.wss_url = init.wss_url ?? null;
    this.cdp_url = init.cdp_url ?? null;
    this.browser_pid = init.browser_pid ?? null;
    this.playwright = init.playwright ?? null;
    this.downloaded_files = Array.isArray(init.downloaded_files)
      ? [...init.downloaded_files]
      : [];
    if (typeof (init as any)?.auto_download_pdfs === 'boolean') {
      this._autoDownloadPdfs = Boolean((init as any).auto_download_pdfs);
    }
    this._tabs = [
      {
        page_id: this._tabCounter++,
        url: this.currentUrl,
        title: this.currentTitle || this.currentUrl,
        parent_page_id: null,
      },
    ];
    this.historyStack.push(this.currentUrl);
    this.ownsBrowserResources = this._determineOwnership();
    this.tabPages.set(this._tabs[0].page_id, this.agent_current_page ?? null);
  }

  private async _waitForStableNetwork(page: Page) {
    const pendingRequests = new Set<any>();
    let lastActivity = Date.now() / 1000;

    // Relevant resource types that indicate page loading progress
    const relevantResourceTypes = new Set([
      'document',
      'stylesheet',
      'image',
      'font',
      'script',
      'iframe',
    ]);
    const ignoredResourceTypes = new Set([
      'websocket',
      'media',
      'eventsource',
      'manifest',
      'other',
    ]);

    // Expanded URL pattern filters - more comprehensive blocking
    const ignoredUrlPatterns = [
      'analytics',
      'tracking',
      'telemetry',
      'beacon',
      'metrics',
      'doubleclick',
      'adsystem',
      'adserver',
      'advertising',
      'facebook.com/plugins',
      'platform.twitter',
      'linkedin.com/embed',
      'livechat',
      'zendesk',
      'intercom',
      'crisp.chat',
      'hotjar',
      'push-notifications',
      'onesignal',
      'pushwoosh',
      'heartbeat',
      'ping',
      'alive',
      'webrtc',
      'rtmp://',
      'wss://',
      'cloudfront.net/assets',
      'fastly.net',
    ];

    // Content types that should be filtered
    const relevantContentTypes = new Set([
      'text/html',
      'text/css',
      'application/javascript',
      'application/x-javascript',
      'text/javascript',
      'image/png',
      'image/jpeg',
      'image/gif',
      'image/webp',
      'image/svg+xml',
      'font/woff',
      'font/woff2',
      'application/font-woff',
      'application/font-woff2',
    ]);

    // Streaming media content types to ignore
    const streamingContentTypes = new Set([
      'video/',
      'audio/',
      'application/octet-stream',
      'application/x-mpegurl',
      'application/vnd.apple.mpegurl',
    ]);

    // Max response size to track (5MB)
    const maxResponseSize = 5 * 1024 * 1024;

    const onRequest = (request: any) => {
      const resourceType = request.resourceType?.() ?? request.resourceType;
      if (!resourceType || !relevantResourceTypes.has(resourceType)) {
        return;
      }
      if (ignoredResourceTypes.has(resourceType)) {
        return;
      }

      const url =
        request.url?.().toLowerCase?.() ?? request.url?.toLowerCase?.() ?? '';

      // Filter data URLs and blob URLs
      if (url.startsWith('data:') || url.startsWith('blob:')) {
        return;
      }

      // Filter by URL patterns
      if (
        ignoredUrlPatterns.some((pattern) =>
          url.includes(pattern.toLowerCase())
        )
      ) {
        return;
      }

      // Filter prefetch requests
      const headers = request.headers?.() ?? request.headers ?? {};
      const purpose = headers['purpose'] || headers['sec-fetch-dest'];
      if (purpose === 'prefetch' || headers['x-moz'] === 'prefetch') {
        return;
      }

      pendingRequests.add(request);
      lastActivity = Date.now() / 1000;
    };

    const onResponse = async (response: any) => {
      const request = response.request?.() ?? response.request;
      if (!pendingRequests.has(request)) {
        return;
      }

      try {
        // Check Content-Type header
        const headers = response.headers?.() ?? response.headers ?? {};
        const contentType =
          headers['content-type'] || headers['Content-Type'] || '';

        // Filter streaming media
        if (streamingContentTypes.has(contentType.split(';')[0].trim())) {
          pendingRequests.delete(request);
          return;
        }

        // Check if content type is relevant
        const baseContentType = contentType.split(';')[0].trim();
        const isRelevant = Array.from(relevantContentTypes).some(
          (ct) =>
            baseContentType.startsWith(ct) || ct.startsWith(baseContentType)
        );

        if (contentType && !isRelevant) {
          // Unknown content type, still track but log it
          this.logger.debug(
            `Tracking unknown content type: ${baseContentType}`
          );
        }

        // Check response size (if available)
        const contentLength =
          headers['content-length'] || headers['Content-Length'];
        if (contentLength && parseInt(contentLength, 10) > maxResponseSize) {
          this.logger.debug(
            `Skipping large response (${contentLength} bytes): ${request.url?.().substring?.(0, 50) ?? ''}`
          );
          pendingRequests.delete(request);
          return;
        }
      } catch (error) {
        // If header inspection fails, still process the response
        this.logger.debug(
          `Error inspecting response headers: ${(error as Error).message}`
        );
      }

      pendingRequests.delete(request);
      lastActivity = Date.now() / 1000;
    };

    const waitForIdle = async () => {
      const startTime = Date.now() / 1000;
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const now = Date.now() / 1000;
        if (
          pendingRequests.size === 0 &&
          now - lastActivity >=
            (this.browser_profile.wait_for_network_idle_page_load_time ?? 0.5)
        ) {
          this.currentPageLoadingStatus = null;
          break;
        }
        if (
          now - startTime >
          (this.browser_profile.maximum_wait_page_load_time ?? 5)
        ) {
          this.currentPageLoadingStatus = `Page loading was aborted after ${this.browser_profile.maximum_wait_page_load_time ?? 5}s with ${pendingRequests.size} pending network requests. You may want to use the wait action to allow more time for the page to fully load.`;
          break;
        }
      }
    };

    if (typeof page?.on === 'function' && typeof page?.off === 'function') {
      page.on('request', onRequest);
      page.on('response', onResponse);
      try {
        await waitForIdle();
      } finally {
        page.off('request', onRequest);
        page.off('response', onResponse);
      }
    } else {
      this.currentPageLoadingStatus = null;
    }
  }

  private _setActivePage(page: Page | null) {
    const currentTab = this._tabs[this.currentTabIndex];
    if (currentTab) {
      this.tabPages.set(currentTab.page_id, page ?? null);
    }
    this.agent_current_page = page ?? null;
  }

  get tabs() {
    return this._tabs.slice();
  }

  get active_tab_index() {
    return this.currentTabIndex;
  }

  get active_tab() {
    return this._tabs[this.currentTabIndex] ?? null;
  }

  describe() {
    return this.toString();
  }

  private _determineOwnership() {
    if (this.cdp_url || this.wss_url || this.browser || this.browser_context) {
      return false;
    }
    return true;
  }

  private _connectionDescriptor() {
    const source =
      this.cdp_url ||
      this.wss_url ||
      (this.browser_pid ? String(this.browser_pid) : 'playwright');
    const tail = source.split('/').pop() ?? source;
    const port = tail.includes(':') ? tail.split(':').pop() : tail;
    return `${this.id.slice(-4)}:${port}`;
  }

  toString() {
    const ownershipFlag = this.ownsBrowserResources ? '#' : '©';
    return `BrowserSession🆂 ${this._connectionDescriptor()} ${ownershipFlag}${String(this.id).slice(-2)}`;
  }

  private get logger() {
    if (!this._logger) {
      this._logger = createLogger(
        `browser_use.browser.session.${this.id.slice(-4)}`
      );
    }
    return this._logger;
  }

  async start() {
    this.initialized = true;
    this.logger.debug(
      `Started ${this.describe()} with profile ${this.browser_profile.toString()}`
    );
    return this;
  }

  /**
   * Setup browser session by connecting to an existing browser process via PID
   * Useful for debugging or connecting to manually launched browsers
   * @param browserPid - Process ID of the browser to connect to
   * @param cdpUrl - Optional CDP URL (will be discovered if not provided)
   */
  async setupBrowserViaBrowserPid(
    browserPid: number,
    cdpUrl?: string
  ): Promise<void> {
    this.logger.info(`Connecting to existing browser with PID ${browserPid}`);

    this.browser_pid = browserPid;

    // If CDP URL not provided, try to discover it
    if (!cdpUrl) {
      cdpUrl = (await this._discoverCdpUrl(browserPid)) ?? undefined;
    }

    if (!cdpUrl) {
      throw new Error(
        `Could not discover CDP URL for browser PID ${browserPid}`
      );
    }

    this.cdp_url = cdpUrl;
    this.logger.info(`Discovered CDP URL: ${cdpUrl}`);

    // Connect to browser via CDP
    try {
      const playwright = await import('playwright');
      const browser = await playwright.chromium.connectOverCDP(cdpUrl);

      this.browser = browser as any;
      this.playwright = playwright;

      // Get or create context
      const contexts = browser.contexts();
      if (contexts.length > 0) {
        this.browser_context = contexts[0] as any;
      } else {
        this.browser_context = (await browser.newContext()) as any;
      }

      // Get or create page
      if (!this.browser_context) {
        throw new Error('Browser context not available');
      }
      const pages = this.browser_context.pages();
      if (pages.length > 0) {
        this.agent_current_page = pages[0] as any;
        this.human_current_page = pages[0] as any;
      } else {
        const page = await this.browser_context.newPage();
        this.agent_current_page = page as any;
        this.human_current_page = page as any;
      }

      // We don't own this browser since we're connecting to existing one
      this.ownsBrowserResources = false;

      this.initialized = true;
      this.logger.info(`Successfully connected to browser PID ${browserPid}`);
    } catch (error) {
      throw new Error(
        `Failed to connect to browser PID ${browserPid}: ${(error as Error).message}`
      );
    }
  }

  /**
   * Discover CDP URL from browser PID
   * Tries common ports and checks for debugging endpoints
   */
  private async _discoverCdpUrl(browserPid: number): Promise<string | null> {
    const commonPorts = [9222, 9223, 9224, 9225];

    for (const port of commonPorts) {
      try {
        const response = await fetch(`http://localhost:${port}/json/version`);
        if (response.ok) {
          const data = await response.json();
          if (data.webSocketDebuggerUrl) {
            this.logger.debug(`Found CDP endpoint on port ${port}`);
            return data.webSocketDebuggerUrl;
          }
        }
      } catch {
        // Port not accessible, try next
        continue;
      }
    }

    this.logger.warning(
      `Could not discover CDP URL for PID ${browserPid} on common ports`
    );
    return null;
  }

  async close() {
    this.initialized = false;

    // Kill child processes first
    await this._killChildProcesses();

    // If we own the browser resources, terminate the browser process
    if (this.ownsBrowserResources && this.browser_pid) {
      await this._terminateBrowserProcess();
    }

    this.browser = null;
    this.browser_context = null;
    this.agent_current_page = null;
    this.human_current_page = null;
    this.cachedBrowserState = null;
    this._tabs = [];
    this.downloaded_files = [];
  }

  async get_browser_state_with_recovery(options: BrowserStateOptions = {}) {
    if (!this.initialized) {
      await this.start();
    }
    const page = await this.get_current_page();
    this.cachedBrowserState = null;
    let domState: DOMState;

    if (!page) {
      domState = createEmptyDomState();
    } else {
      try {
        const domService = new DomService(page, this.logger);
        domState = await domService.get_clickable_elements();
      } catch (error) {
        this.logger.debug(
          `Failed to build DOM tree: ${(error as Error).message}`
        );
        domState = createEmptyDomState();
      }
    }

    let screenshot: string | null = null;
    if (options.include_screenshot && page?.screenshot) {
      try {
        const image = await page.screenshot({
          type: 'png',
          fullPage: true,
        });
        screenshot =
          typeof image === 'string'
            ? image
            : Buffer.from(image).toString('base64');
      } catch (error) {
        this.logger.debug(
          `Failed to capture screenshot: ${(error as Error).message}`
        );
      }
    }

    let pageInfo = null;
    let pixelsAbove = 0;
    let pixelsBelow = 0;
    let pixelsLeft = 0;
    let pixelsRight = 0;
    if (page) {
      try {
        const metrics = await page.evaluate(() => {
          const doc = document.documentElement;
          const body = document.body;
          const width = Math.max(
            doc?.scrollWidth ?? 0,
            body?.scrollWidth ?? 0,
            doc?.clientWidth ?? 0
          );
          const height = Math.max(
            doc?.scrollHeight ?? 0,
            body?.scrollHeight ?? 0,
            doc?.clientHeight ?? 0
          );
          return {
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
            scrollX: window.scrollX,
            scrollY: window.scrollY,
            pageWidth: width,
            pageHeight: height,
          };
        });
        pixelsAbove = Math.max(metrics.scrollY ?? 0, 0);
        const viewportHeight = metrics.viewportHeight ?? 0;
        const viewportWidth = metrics.viewportWidth ?? 0;
        pixelsBelow = Math.max(
          (metrics.pageHeight ?? 0) - (metrics.scrollY + viewportHeight),
          0
        );
        pixelsLeft = Math.max(metrics.scrollX ?? 0, 0);
        pixelsRight = Math.max(
          (metrics.pageWidth ?? 0) - (metrics.scrollX + viewportWidth),
          0
        );
        pageInfo = {
          viewport_width: viewportWidth,
          viewport_height: viewportHeight,
          page_width: metrics.pageWidth ?? viewportWidth,
          page_height: metrics.pageHeight ?? viewportHeight,
          scroll_x: metrics.scrollX ?? 0,
          scroll_y: metrics.scrollY ?? 0,
          pixels_above: pixelsAbove,
          pixels_below: pixelsBelow,
          pixels_left: pixelsLeft,
          pixels_right: pixelsRight,
        };
      } catch (error) {
        this.logger.debug(
          `Failed to compute page metrics: ${(error as Error).message}`
        );
      }
    }

    const summary = new BrowserStateSummary(domState, {
      url: this.currentUrl,
      title: this.currentTitle || this.currentUrl,
      tabs: this._buildTabs(),
      screenshot,
      page_info: pageInfo,
      pixels_above: pixelsAbove,
      pixels_below: pixelsBelow,
      browser_errors: this.currentPageLoadingStatus
        ? [this.currentPageLoadingStatus]
        : [],
      is_pdf_viewer: Boolean(this.currentUrl?.toLowerCase().endsWith('.pdf')),
      loading_status: this.currentPageLoadingStatus,
    });

    // Implement clickable element hash caching to detect new elements
    if (options.cache_clickable_elements_hashes && page) {
      const currentUrl = page.url();
      const currentHashes = this._computeElementHashes(domState.selector_map);

      // Mark new elements if we have cached hashes for this URL
      if (
        this._cachedClickableElementHashes &&
        this._cachedClickableElementHashes.url === currentUrl
      ) {
        this._markNewElements(
          domState.selector_map,
          this._cachedClickableElementHashes.hashes
        );
      }

      // Update cache with current hashes
      this._cachedClickableElementHashes = {
        url: currentUrl,
        hashes: currentHashes,
      };
    }

    this.cachedBrowserState = summary;
    return summary;
  }

  async get_current_page() {
    if (this.agent_current_page) {
      return this.agent_current_page;
    }
    const currentTab = this._tabs[this.currentTabIndex];
    if (currentTab) {
      const tabPage = this.tabPages.get(currentTab.page_id) ?? null;
      if (tabPage) {
        this._setActivePage(tabPage);
        return tabPage;
      }
    }
    const fallback = this.browser_context?.pages()?.[0] ?? null;
    this._setActivePage(fallback ?? null);
    return fallback;
  }

  update_current_page(
    page: Page | null,
    title?: string | null,
    url?: string | null
  ) {
    this._setActivePage(page);
    this.human_current_page = this.human_current_page ?? page;
    if (url) {
      this.currentUrl = normalize_url(url);
    }
    if (title) {
      this.currentTitle = title;
    }
  }

  private _buildTabs(): TabInfo[] {
    if (!this._tabs.length) {
      this._tabs.push({
        page_id: this._tabCounter++,
        url: this.currentUrl,
        title: this.currentTitle || this.currentUrl,
        parent_page_id: null,
      });
    } else {
      const tab = this._tabs[this.currentTabIndex];
      tab.url = this.currentUrl;
      tab.title = this.currentTitle || this.currentUrl;
    }
    return this._tabs.slice();
  }

  async navigate_to(url: string) {
    const normalized = normalize_url(url);
    const page = await this.get_current_page();
    if (page?.goto) {
      try {
        this.currentPageLoadingStatus = null;
        await page.goto(normalized, { waitUntil: 'domcontentloaded' });
        await this._waitForStableNetwork(page);
      } catch (error) {
        const message = (error as Error).message ?? 'Navigation failed';
        throw new BrowserError(message);
      }
    }
    this.currentUrl = normalized;
    this.currentTitle = normalized;
    this.historyStack.push(normalized);
    if (this._tabs[this.currentTabIndex]) {
      this._tabs[this.currentTabIndex].url = normalized;
      this._tabs[this.currentTabIndex].title = normalized;
    }
    this._setActivePage(page ?? null);
    this.cachedBrowserState = null;
    return this.agent_current_page;
  }

  async create_new_tab(url: string) {
    const normalized = normalize_url(url);
    const newTab: TabInfo = {
      page_id: this._tabCounter++,
      url: normalized,
      title: normalized,
      parent_page_id: null,
    };
    this._tabs.push(newTab);
    this.currentTabIndex = this._tabs.length - 1;
    this.currentUrl = normalized;
    this.currentTitle = normalized;
    this.historyStack.push(normalized);
    let page: Page | null = null;
    try {
      page = (await this.browser_context?.newPage?.()) ?? null;
      if (page) {
        this.currentPageLoadingStatus = null;
        await page.goto(normalized, { waitUntil: 'domcontentloaded' });
        await this._waitForStableNetwork(page);
      }
    } catch (error) {
      this.logger.debug(
        `Failed to open new tab via Playwright: ${(error as Error).message}`
      );
    }
    this.tabPages.set(newTab.page_id, page);
    this._setActivePage(page);
    this.currentPageLoadingStatus = null;
    if (!this.human_current_page) {
      this.human_current_page = page;
    }
    this.cachedBrowserState = null;
    return this.agent_current_page;
  }

  private _resolveTabIndex(identifier: number) {
    if (identifier === -1) {
      return Math.max(0, this._tabs.length - 1);
    }
    const byId = this._tabs.findIndex((tab) => tab.page_id === identifier);
    if (byId !== -1) {
      return byId;
    }
    if (identifier >= 0 && identifier < this._tabs.length) {
      return identifier;
    }
    return -1;
  }

  async switch_to_tab(identifier: number) {
    const index = this._resolveTabIndex(identifier);
    const tab = index >= 0 ? (this._tabs[index] ?? null) : null;
    if (!tab) {
      throw new Error(`Tab index ${identifier} does not exist`);
    }
    this.currentTabIndex = index;
    this.currentUrl = tab.url;
    this.currentTitle = tab.title;
    const page = this.tabPages.get(tab.page_id) ?? null;
    this._setActivePage(page);
    if (page?.bringToFront) {
      try {
        await page.bringToFront();
      } catch (error) {
        this.logger.debug(`Failed to focus tab: ${(error as Error).message}`);
      }
    }
    await this._waitForLoad(page);
    this.cachedBrowserState = null;
    return page;
  }

  async close_tab(identifier: number) {
    const index = this._resolveTabIndex(identifier);
    if (index < 0 || index >= this._tabs.length) {
      throw new Error(`Tab index ${identifier} does not exist`);
    }
    const closingTab = this._tabs[index];
    const closingPage = this.tabPages.get(closingTab.page_id) ?? null;
    if (closingPage?.close) {
      try {
        await closingPage.close();
      } catch (error) {
        this.logger.debug(`Failed to close page: ${(error as Error).message}`);
      }
    }
    this.tabPages.delete(closingTab.page_id);
    this._tabs.splice(index, 1);
    if (this.currentTabIndex >= this._tabs.length) {
      this.currentTabIndex = Math.max(0, this._tabs.length - 1);
    }
    const tab = this._tabs[this.currentTabIndex] ?? null;
    const current = tab ? (this.tabPages.get(tab.page_id) ?? null) : null;
    this._setActivePage(current);
    this.currentPageLoadingStatus = null;
    this.cachedBrowserState = null;
    if (this._tabs.length) {
      const tab = this._tabs[this.currentTabIndex];
      this.currentUrl = tab.url;
      this.currentTitle = tab.title;
    } else {
      this.currentUrl = 'about:blank';
      this.currentTitle = 'about:blank';
      this._setActivePage(null);
    }
  }

  async go_back() {
    if (this.historyStack.length <= 1) {
      return;
    }
    const page = await this.get_current_page();
    if (page?.goBack) {
      try {
        await page.goBack();
      } catch (error) {
        this.logger.debug(
          `Failed to navigate back: ${(error as Error).message}`
        );
      }
    }
    this.historyStack.pop();
    const previous = this.historyStack[this.historyStack.length - 1];
    this.currentUrl = previous;
    this.currentTitle = previous;
    if (this._tabs[this.currentTabIndex]) {
      this._tabs[this.currentTabIndex].url = previous;
      this._tabs[this.currentTabIndex].title = previous;
    }
  }

  async get_dom_element_by_index(_index: number) {
    const selectorMap = await this.get_selector_map();
    return selectorMap?.[_index] ?? null;
  }

  set_downloaded_files(files: string[]) {
    if (!Array.isArray(files)) {
      return;
    }
    this.downloaded_files = [...files];
  }

  add_downloaded_file(filePath: string) {
    if (!filePath) {
      return;
    }
    if (!this.downloaded_files.includes(filePath)) {
      this.downloaded_files = [...this.downloaded_files, filePath];
      this.logger.info(
        `📁 Added download to session tracking (total: ${this.downloaded_files.length} files)`
      );
    }
  }

  get_downloaded_files() {
    this.logger.debug(
      `📁 Retrieved ${this.downloaded_files.length} downloaded files from session tracking`
    );
    return [...this.downloaded_files];
  }

  set_auto_download_pdfs(enabled: boolean) {
    this._autoDownloadPdfs = Boolean(enabled);
    this.logger.info(
      `📄 PDF auto-download ${this._autoDownloadPdfs ? 'enabled' : 'disabled'}`
    );
  }

  auto_download_pdfs() {
    return this._autoDownloadPdfs;
  }

  static async get_unique_filename(directory: string, filename: string) {
    const resolvedDir = path.resolve(directory);
    const parsed = path.parse(filename);
    let candidate = filename;
    let counter = 1;
    while (fs.existsSync(path.join(resolvedDir, candidate))) {
      candidate = `${parsed.name} (${counter})${parsed.ext}`;
      counter += 1;
    }
    return candidate;
  }

  async get_selector_map() {
    if (!this.cachedBrowserState) {
      await this.get_browser_state_with_recovery({
        cache_clickable_elements_hashes: true,
        include_screenshot: false,
      });
    }
    return this.cachedBrowserState?.selector_map ?? {};
  }

  static is_file_input(node: DOMElementNode | null) {
    if (!node) {
      return false;
    }
    return (
      node.tag_name?.toLowerCase() === 'input' &&
      (node.attributes?.type ?? '').toLowerCase() === 'file'
    );
  }

  is_file_input(node: DOMElementNode | null) {
    return BrowserSession.is_file_input(node);
  }

  async find_file_upload_element_by_index(
    index: number,
    maxHeight = 3,
    maxDescendantDepth = 3
  ) {
    const selectorMap = await this.get_selector_map();
    const root = selectorMap[index];
    if (!root) {
      return null;
    }

    const findInDescendants = (
      node: DOMElementNode,
      depth: number
    ): DOMElementNode | null => {
      if (depth < 0) {
        return null;
      }
      if (BrowserSession.is_file_input(node)) {
        return node;
      }
      for (const child of node.children) {
        if (child instanceof DOMElementNode) {
          const found = findInDescendants(child, depth - 1);
          if (found) {
            return found;
          }
        }
      }
      return null;
    };

    let current: DOMElementNode | null = root;
    let remainingHeight = maxHeight;
    while (current && remainingHeight >= 0) {
      const direct = findInDescendants(current, maxDescendantDepth);
      if (direct) {
        return direct;
      }

      if (current.parent) {
        for (const sibling of current.parent.children) {
          if (sibling instanceof DOMElementNode && sibling !== current) {
            const fromSibling = findInDescendants(sibling, maxDescendantDepth);
            if (fromSibling) {
              return fromSibling;
            }
          }
        }
      }

      current = current.parent;
      remainingHeight -= 1;
    }

    return null;
  }

  async get_locate_element(node: DOMElementNode): Promise<Locator | null> {
    const page = await this.get_current_page();
    if (!page || !node?.xpath) {
      return null;
    }
    try {
      const locator = page.locator(`xpath=${node.xpath}`);
      const count = await locator.count();
      if (count === 0) {
        return null;
      }
      return locator;
    } catch (error) {
      this.logger.debug(
        `Failed to locate element via xpath ${node.xpath}: ${(error as Error).message}`
      );
      return null;
    }
  }

  async _input_text_element_node(node: DOMElementNode, text: string) {
    const locator = await this.get_locate_element(node);
    if (!locator) {
      throw new Error('Element not found');
    }
    await locator.click({ timeout: 5000 });
    await locator.fill(text, { timeout: 5000 });
  }

  async _click_element_node(node: DOMElementNode) {
    const locator = await this.get_locate_element(node);
    if (!locator) {
      throw new Error('Element not found');
    }
    const page = await this.get_current_page();
    const performClick = async () => {
      await locator.click({ timeout: 5000 });
    };

    const downloadsDir = this.browser_profile.downloads_path;
    if (downloadsDir && page?.waitForEvent) {
      const downloadPromise = page.waitForEvent('download', { timeout: 5000 });
      await performClick();
      try {
        const download = await downloadPromise;
        const suggested =
          typeof download.suggestedFilename === 'function'
            ? download.suggestedFilename()
            : 'download';
        const uniqueFilename = await BrowserSession.get_unique_filename(
          downloadsDir,
          suggested
        );
        const downloadPath = path.join(downloadsDir, uniqueFilename);
        if (typeof download.saveAs === 'function') {
          await download.saveAs(downloadPath);
        }
        this.add_downloaded_file(downloadPath);
        return downloadPath;
      } catch (error) {
        this.logger.debug(
          `No download triggered within timeout: ${(error as Error).message}`
        );
      }
    } else {
      await performClick();
    }

    await this._waitForLoad(page);
    return null;
  }

  private async _waitForLoad(page: Page | null, timeout = 5000) {
    if (!page || typeof page.waitForLoadState !== 'function') {
      return;
    }
    try {
      await page.waitForLoadState('domcontentloaded', { timeout });
    } catch (error) {
      this.logger.debug(`waitForLoadState failed: ${(error as Error).message}`);
    }
  }

  // ==================== Cookie Management ====================

  /**
   * Get all cookies from the current browser context
   */
  async get_cookies(): Promise<Array<Record<string, any>>> {
    if (this.browser_context?.cookies) {
      return await this.browser_context.cookies();
    }
    return [];
  }

  /**
   * Save cookies to a file (deprecated, use save_storage_state instead)
   * @deprecated Use save_storage_state() instead
   */
  async save_cookies(...args: any[]): Promise<void> {
    return this.save_storage_state(...args);
  }

  /**
   * Load cookies from a file (deprecated, use load_storage_state instead)
   * @deprecated Use load_storage_state() instead
   */
  async load_cookies_from_file(...args: any[]): Promise<void> {
    return this.load_storage_state(...args);
  }

  /**
   * Save the current storage state (cookies, localStorage, sessionStorage) to a file
   */
  async save_storage_state(filePath?: string): Promise<void> {
    if (!this.browser_context) {
      this.logger.warning(
        'Cannot save storage state: browser context not initialized'
      );
      return;
    }

    const targetPath = filePath || this.browser_profile.cookies_file;
    if (!targetPath) {
      return;
    }

    try {
      const resolvedPath = path.resolve(targetPath);
      const dirPath = path.dirname(resolvedPath);

      // Create directory if it doesn't exist
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }

      // Get storage state from browser context
      const storageState = await this.browser_context.storageState();

      // Write to temporary file first
      const tempPath = `${resolvedPath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(storageState, null, 2));

      // Backup existing file if present
      if (fs.existsSync(resolvedPath)) {
        const backupPath = `${resolvedPath}.bak`;
        try {
          fs.renameSync(resolvedPath, backupPath);
        } catch (error) {
          // Ignore backup errors
        }
      }

      // Move temp file to target
      fs.renameSync(tempPath, resolvedPath);

      const cookieCount = storageState.cookies?.length || 0;
      this.logger.info(
        `🍪 Saved ${cookieCount} cookies to ${path.basename(resolvedPath)}`
      );
    } catch (error) {
      this.logger.warning(
        `❌ Failed to save storage state: ${(error as Error).message}`
      );
    }
  }

  /**
   * Load storage state (cookies, localStorage, sessionStorage) from a file
   */
  async load_storage_state(filePath?: string): Promise<void> {
    const targetPath = filePath || this.browser_profile.cookies_file;
    if (!targetPath) {
      return;
    }

    try {
      const resolvedPath = path.resolve(targetPath);

      if (!fs.existsSync(resolvedPath)) {
        this.logger.warning(`Storage state file not found: ${resolvedPath}`);
        return;
      }

      const storageStateContent = fs.readFileSync(resolvedPath, 'utf-8');
      const storageState = JSON.parse(storageStateContent);

      if (this.browser_context?.addCookies) {
        // Add cookies to context
        if (storageState.cookies && Array.isArray(storageState.cookies)) {
          await this.browser_context.addCookies(storageState.cookies);
          this.logger.info(
            `🍪 Loaded ${storageState.cookies.length} cookies from ${path.basename(resolvedPath)}`
          );
        }
      }
    } catch (error) {
      this.logger.warning(
        `❌ Failed to load storage state: ${(error as Error).message}`
      );
    }
  }

  // ==================== JavaScript Execution ====================

  /**
   * Execute JavaScript in the current page context
   */
  async execute_javascript(script: string): Promise<any> {
    const page = await this.get_current_page();
    if (!page) {
      throw new Error('No page available to execute JavaScript');
    }
    return await page.evaluate(script);
  }

  // ==================== Page Information ====================

  /**
   * Get comprehensive page information (size, scroll position, etc.)
   */
  async get_page_info(page?: Page): Promise<any> {
    const targetPage = page || (await this.get_current_page());
    if (!targetPage) {
      return null;
    }

    const pageData = await targetPage.evaluate(() => {
      return {
        // Current viewport dimensions
        viewport_width: window.innerWidth,
        viewport_height: window.innerHeight,

        // Total page dimensions
        page_width: Math.max(
          document.documentElement.scrollWidth,
          document.body.scrollWidth || 0
        ),
        page_height: Math.max(
          document.documentElement.scrollHeight,
          document.body.scrollHeight || 0
        ),

        // Current scroll position
        scroll_x:
          window.scrollX ||
          window.pageXOffset ||
          document.documentElement.scrollLeft ||
          0,
        scroll_y:
          window.scrollY ||
          window.pageYOffset ||
          document.documentElement.scrollTop ||
          0,
      };
    });

    // Calculate derived values
    const viewport_width = Math.floor(pageData.viewport_width);
    const viewport_height = Math.floor(pageData.viewport_height);
    const page_width = Math.floor(pageData.page_width);
    const page_height = Math.floor(pageData.page_height);
    const scroll_x = Math.floor(pageData.scroll_x);
    const scroll_y = Math.floor(pageData.scroll_y);

    // Calculate scroll information
    const pixels_above = scroll_y;
    const pixels_below = Math.max(
      0,
      page_height - (scroll_y + viewport_height)
    );
    const pixels_left = scroll_x;
    const pixels_right = Math.max(0, page_width - (scroll_x + viewport_width));

    return {
      viewport_width,
      viewport_height,
      page_width,
      page_height,
      scroll_x,
      scroll_y,
      pixels_above,
      pixels_below,
      pixels_left,
      pixels_right,
    };
  }

  /**
   * Get the HTML content of the current page
   */
  async get_page_html(): Promise<string> {
    const page = await this.get_current_page();
    if (!page) {
      return '';
    }
    return await page.content();
  }

  /**
   * Get a debug view of the page structure including iframes
   */
  async get_page_structure(): Promise<string> {
    const page = await this.get_current_page();
    if (!page) {
      return '';
    }

    const debug_script = `(() => {
			function getPageStructure(element = document, depth = 0, maxDepth = 10) {
				if (depth >= maxDepth) return '';

				const indent = '  '.repeat(depth);
				let structure = '';

				// Skip certain elements that clutter the output
				const skipTags = new Set(['script', 'style', 'link', 'meta', 'noscript']);

				// Add current element info if it's not the document
				if (element !== document) {
					const tagName = element.tagName.toLowerCase();

					// Skip uninteresting elements
					if (skipTags.has(tagName)) return '';

					const id = element.id ? \`#\${element.id}\` : '';
					const classes = element.className && typeof element.className === 'string' ?
						\`.\${element.className.split(' ').filter(c => c).join('.')}\` : '';

					// Get additional useful attributes
					const attrs = [];
					if (element.getAttribute('role')) attrs.push(\`role="\${element.getAttribute('role')}"\`);
					if (element.getAttribute('aria-label')) attrs.push(\`aria-label="\${element.getAttribute('aria-label')}"\`);
					if (element.getAttribute('type')) attrs.push(\`type="\${element.getAttribute('type')}"\`);
					if (element.getAttribute('name')) attrs.push(\`name="\${element.getAttribute('name')}"\`);
					if (element.getAttribute('src')) {
						const src = element.getAttribute('src');
						attrs.push(\`src="\${src.substring(0, 50)}\${src.length > 50 ? '...' : ''}"\`);
					}

					// Add element info
					structure += \`\${indent}\${tagName}\${id}\${classes}\${attrs.length ? ' [' + attrs.join(', ') + ']' : ''}\\n\`;

					// Handle iframes specially
					if (tagName === 'iframe') {
						try {
							const iframeDoc = element.contentDocument || element.contentWindow?.document;
							if (iframeDoc) {
								structure += \`\${indent}  [IFRAME CONTENT]:\\n\`;
								structure += getPageStructure(iframeDoc, depth + 2, maxDepth);
							} else {
								structure += \`\${indent}  [CROSS-ORIGIN IFRAME - Cannot access]\\n\`;
							}
						} catch (e) {
							structure += \`\${indent}  [IFRAME - Access denied]\\n\`;
						}
						return structure;
					}
				}

				// Process children
				const children = element.children || element.documentElement?.children || [];
				for (let i = 0; i < children.length; i++) {
					structure += getPageStructure(children[i], depth + 1, maxDepth);
				}

				return structure;
			}

			return getPageStructure();
		})()`;

    return await page.evaluate(debug_script);
  }

  // ==================== Navigation & History ====================

  /**
   * Navigate forward in browser history
   */
  async go_forward(): Promise<void> {
    try {
      const page = await this.get_current_page();
      if (page?.goForward) {
        await page.goForward({ timeout: 10000, waitUntil: 'load' });
      }
    } catch (error) {
      this.logger.debug(
        `⏭️ Error during go_forward: ${(error as Error).message}`
      );
      // Verify page is still usable after navigation error
      if ((error as Error).message.toLowerCase().includes('timeout')) {
        const page = await this.get_current_page();
        try {
          await page?.evaluate('1');
        } catch (evalError) {
          this.logger.error(
            `❌ Page crashed after go_forward timeout: ${(evalError as Error).message}`
          );
        }
      }
    }
  }

  /**
   * Refresh the current page
   */
  async refresh(): Promise<void> {
    try {
      const page = await this.get_current_page();
      if (page?.reload) {
        this.currentPageLoadingStatus = null;
        await page.reload({ waitUntil: 'domcontentloaded' });
        await this._waitForStableNetwork(page);
      }
    } catch (error) {
      this.logger.debug(`🔄 Error during refresh: ${(error as Error).message}`);
    }
  }

  // ==================== Element Waiting ====================

  /**
   * Wait for an element to appear on the page
   */
  async wait_for_element(
    selector: string,
    timeout: number = 10000
  ): Promise<void> {
    const page = await this.get_current_page();
    if (!page) {
      throw new Error('No page available');
    }
    await page.waitForSelector(selector, { state: 'visible', timeout });
  }

  // ==================== Screenshots ====================

  /**
   * Take a screenshot of the current page
   * @param full_page Whether to capture the full scrollable page
   * @returns Base64 encoded PNG screenshot
   */
  async take_screenshot(full_page: boolean = false): Promise<string | null> {
    const page = await this.get_current_page();
    if (!page) {
      throw new Error('No page available for screenshot');
    }

    if (!this.browser_context) {
      throw new Error('Browser context is not set');
    }

    // Check if it's a new tab page
    const url = page.url();
    if (
      url === 'about:blank' ||
      url === 'chrome://newtab/' ||
      url === 'edge://newtab/'
    ) {
      this.logger.warning(`▫️ Skipping screenshot of empty page: ${url}`);
      // Return a 4px placeholder
      return 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAD0lEQVQIHWP8//8/AxYMACgtBP9g8jqYAAAAAElFTkSuQmCC';
    }

    // Bring page to front before rendering
    try {
      await page.bringToFront();
    } catch (error) {
      // Ignore errors
    }

    // Take screenshot using CDP for better performance
    let cdp_session: any = null;
    try {
      this.logger.debug(
        `📸 Taking ${full_page ? 'full-page' : 'viewport'} PNG screenshot via CDP: ${url}`
      );

      // Create CDP session for the screenshot
      cdp_session = await (this.browser_context as any).newCDPSession(page);

      // Capture screenshot via CDP
      const screenshot_response = await cdp_session.send(
        'Page.captureScreenshot',
        {
          captureBeyondViewport: false,
          fromSurface: true,
          format: 'png',
        }
      );

      const screenshot_b64 = screenshot_response.data;
      if (!screenshot_b64) {
        throw new Error(`CDP returned empty screenshot data for page ${url}`);
      }

      return screenshot_b64;
    } catch (error) {
      const error_str = (error as Error).message || String(error);
      if (error_str.toLowerCase().includes('timeout')) {
        this.logger.warning(
          `⏱️ Screenshot timed out on page ${url}: ${error_str}`
        );
      } else {
        this.logger.error(`❌ Screenshot failed on page ${url}: ${error_str}`);
      }
      throw error;
    } finally {
      if (cdp_session) {
        try {
          await cdp_session.detach();
        } catch (error) {
          // Ignore detach errors
        }
      }
    }
  }

  // ==================== Event Listeners ====================

  /**
   * Add a request event listener to the current page
   */
  async on_request(
    callback: (request: any) => void | Promise<void>
  ): Promise<void> {
    const page = await this.get_current_page();
    if (page && typeof page.on === 'function') {
      page.on('request', callback);
    }
  }

  /**
   * Add a response event listener to the current page
   */
  async on_response(
    callback: (response: any) => void | Promise<void>
  ): Promise<void> {
    const page = await this.get_current_page();
    if (page && typeof page.on === 'function') {
      page.on('response', callback);
    }
  }

  /**
   * Remove a request event listener from the current page
   */
  async off_request(
    callback: (request: any) => void | Promise<void>
  ): Promise<void> {
    const page = await this.get_current_page();
    if (page && typeof page.off === 'function') {
      page.off('request', callback);
    }
  }

  /**
   * Remove a response event listener from the current page
   */
  async off_response(
    callback: (response: any) => void | Promise<void>
  ): Promise<void> {
    const page = await this.get_current_page();
    if (page && typeof page.off === 'function') {
      page.off('response', callback);
    }
  }

  // ==================== P2 Additional Functions ====================

  /**
   * Get information about all open tabs
   * @returns Array of tab information including page_id, url, and title
   */
  async get_tabs_info(): Promise<
    Array<{ page_id: number; url: string; title: string }>
  > {
    if (!this.browser_context) {
      return [];
    }

    const tabs_info: Array<{ page_id: number; url: string; title: string }> =
      [];
    const pages = this.browser_context.pages();

    for (let page_id = 0; page_id < pages.length; page_id++) {
      const page = pages[page_id];

      // Skip chrome:// pages and new tab pages
      const isNewTab =
        page.url() === 'about:blank' ||
        page.url().startsWith('chrome://newtab');
      if (isNewTab || page.url().startsWith('chrome://')) {
        if (isNewTab) {
          tabs_info.push({
            page_id,
            url: page.url(),
            title: 'ignore this tab and do not use it',
          });
        } else {
          tabs_info.push({
            page_id,
            url: page.url(),
            title: page.url(),
          });
        }
        continue;
      }

      // Normal pages - try to get title with timeout
      try {
        const titlePromise = page.title();
        const timeoutPromise = new Promise<string>((_, reject) => {
          setTimeout(() => reject(new Error('timeout')), 2000);
        });

        const title = await Promise.race([titlePromise, timeoutPromise]);
        tabs_info.push({ page_id, url: page.url(), title });
      } catch (error) {
        this.logger.debug(
          `⚠️ Failed to get tab info for tab #${page_id}: ${page.url()} (using fallback title)`
        );

        if (isNewTab) {
          tabs_info.push({
            page_id,
            url: page.url(),
            title: 'ignore this tab and do not use it',
          });
        } else {
          tabs_info.push({
            page_id,
            url: page.url(),
            title: page.url(), // Use URL as fallback title
          });
        }
      }
    }

    return tabs_info;
  }

  /**
   * Check if a page is responsive by trying to evaluate simple JavaScript
   * @param page - The page to check
   * @param timeout - Timeout in seconds (default: 5)
   * @returns True if page is responsive, false otherwise
   */
  async _is_page_responsive(
    page: any,
    timeout: number = 5.0
  ): Promise<boolean> {
    try {
      const evalPromise = page.evaluate('1');
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('timeout')), timeout * 1000);
      });

      await Promise.race([evalPromise, timeoutPromise]);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get scroll information for the current page
   * @returns Object with scroll position and page dimensions
   */
  async get_scroll_info(): Promise<{
    scroll_x: number;
    scroll_y: number;
    page_width: number;
    page_height: number;
    viewport_width: number;
    viewport_height: number;
  }> {
    const page = await this.get_current_page();
    if (!page) {
      return {
        scroll_x: 0,
        scroll_y: 0,
        page_width: 0,
        page_height: 0,
        viewport_width: 0,
        viewport_height: 0,
      };
    }

    return await page.evaluate(() => {
      return {
        scroll_x:
          window.scrollX ||
          window.pageXOffset ||
          document.documentElement.scrollLeft ||
          0,
        scroll_y:
          window.scrollY ||
          window.pageYOffset ||
          document.documentElement.scrollTop ||
          0,
        page_width: Math.max(
          document.documentElement.scrollWidth,
          document.body.scrollWidth || 0
        ),
        page_height: Math.max(
          document.documentElement.scrollHeight,
          document.body.scrollHeight || 0
        ),
        viewport_width: window.innerWidth,
        viewport_height: window.innerHeight,
      };
    });
  }

  /**
   * Get a summary of the current browser state
   * @param cache_clickable_elements_hashes - Cache clickable element hashes to detect new elements
   * @param include_screenshot - Include screenshot in state summary
   * @returns BrowserStateSummary with current page state
   */
  async get_state_summary(
    cache_clickable_elements_hashes: boolean = true,
    include_screenshot: boolean = true
  ): Promise<BrowserStateSummary> {
    this.logger.debug('🔄 Starting get_state_summary...');

    const updated_state = await this._get_updated_state(-1, include_screenshot);

    // Implement clickable element hash caching to detect new elements
    if (cache_clickable_elements_hashes) {
      const page = await this.get_current_page();
      if (page) {
        const currentUrl = page.url();
        const currentHashes = this._computeElementHashes(
          updated_state.selector_map
        );

        // Mark new elements if we have cached hashes for this URL
        if (
          this._cachedClickableElementHashes &&
          this._cachedClickableElementHashes.url === currentUrl
        ) {
          this._markNewElements(
            updated_state.selector_map,
            this._cachedClickableElementHashes.hashes
          );
        }

        // Update cache with current hashes
        this._cachedClickableElementHashes = {
          url: currentUrl,
          hashes: currentHashes,
        };
      }
    }

    this.cachedBrowserState = updated_state;
    return this.cachedBrowserState;
  }

  /**
   * Get minimal state summary without DOM processing, but with screenshot
   * Used when page is in error state or unresponsive
   */
  async get_minimal_state_summary(): Promise<BrowserStateSummary> {
    try {
      const page = await this.get_current_page();
      const url = page ? page.url() : 'unknown';

      // Try to get title safely
      let title = 'Page Load Error';
      try {
        if (page) {
          const titlePromise = page.title();
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), 2000)
          );
          title = await Promise.race([titlePromise, timeoutPromise]);
        }
      } catch (error) {
        // Keep default title
      }

      // Try to get tabs info safely
      let tabs_info: TabInfo[] = [];
      try {
        const tabsPromise = this.get_tabs_info();
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 2000)
        );
        tabs_info = await Promise.race([tabsPromise, timeoutPromise]);
      } catch (error) {
        // Keep empty tabs
      }

      // Create minimal DOM element for error state
      const minimal_element_tree = new DOMElementNode(
        true,
        null,
        'body',
        '/body',
        {},
        []
      );

      // Try to get screenshot
      let screenshot_b64: string | null = null;
      try {
        screenshot_b64 = await this.take_screenshot();
      } catch (error) {
        this.logger.debug(
          `Screenshot failed in minimal state: ${(error as Error).message}`
        );
      }

      // Use default viewport dimensions
      const viewport = this.browser_profile.viewport || {
        width: 1280,
        height: 720,
      };

      const dom_state = new DOMState(minimal_element_tree, {});
      return new BrowserStateSummary(dom_state, {
        url,
        title,
        tabs: tabs_info,
        screenshot: screenshot_b64,
        page_info: {
          viewport_width: viewport.width,
          viewport_height: viewport.height,
          page_width: viewport.width,
          page_height: viewport.height,
          scroll_x: 0,
          scroll_y: 0,
          pixels_above: 0,
          pixels_below: 0,
          pixels_left: 0,
          pixels_right: 0,
        },
        pixels_above: 0,
        pixels_below: 0,
        browser_errors: ['Page in error state - minimal navigation available'],
        is_pdf_viewer: false,
        loading_status: this.currentPageLoadingStatus,
      });
    } catch (error) {
      this.logger.error(
        `Failed to get minimal state summary: ${(error as Error).message}`
      );
      throw error;
    }
  }

  /**
   * Internal method to get updated browser state with DOM processing
   * @param focus_element - Element index to focus on (default: -1)
   * @param include_screenshot - Whether to include screenshot
   */
  private async _get_updated_state(
    focus_element: number = -1,
    include_screenshot: boolean = true
  ): Promise<BrowserStateSummary> {
    const page = await this.get_current_page();
    if (!page) {
      throw new Error('No current page available');
    }

    const page_url = page.url();

    // Check for new tab or chrome:// pages - fast path
    const is_empty_page =
      this._is_new_tab_page(page_url) || page_url.startsWith('chrome://');

    if (is_empty_page) {
      this.logger.debug(`⚡ Fast path for empty page: ${page_url}`);

      // Create minimal DOM state
      const minimal_element_tree = new DOMElementNode(
        false,
        null,
        'body',
        '',
        {},
        []
      );

      const tabs_info = await this.get_tabs_info();
      const viewport = this.browser_profile.viewport || {
        width: 1280,
        height: 720,
      };

      const dom_state = new DOMState(minimal_element_tree, {});
      return new BrowserStateSummary(dom_state, {
        url: page_url,
        title: this._is_new_tab_page(page_url) ? 'New Tab' : 'Chrome Page',
        tabs: tabs_info,
        screenshot: null,
        page_info: {
          viewport_width: viewport.width,
          viewport_height: viewport.height,
          page_width: viewport.width,
          page_height: viewport.height,
          scroll_x: 0,
          scroll_y: 0,
          pixels_above: 0,
          pixels_below: 0,
          pixels_left: 0,
          pixels_right: 0,
        },
        pixels_above: 0,
        pixels_below: 0,
        browser_errors: [],
        is_pdf_viewer: false,
        loading_status: this.currentPageLoadingStatus,
      });
    }

    // Normal path for regular pages
    this.logger.debug('🧹 Removing highlights...');
    try {
      await this.remove_highlights();
    } catch (error) {
      this.logger.debug('Timeout removing highlights');
    }

    // Check for PDF and auto-download if needed
    try {
      const pdf_path = await this._auto_download_pdf_if_needed(page);
      if (pdf_path) {
        this.logger.info(`📄 PDF auto-downloaded: ${pdf_path}`);
      }
    } catch (error) {
      this.logger.debug(
        `PDF auto-download check failed: ${(error as Error).message}`
      );
    }

    // DOM processing
    this.logger.debug('🌳 Starting DOM processing...');
    const dom_service = new DomService(page, this.logger);

    let content: DOMState;
    try {
      const domPromise = dom_service.get_clickable_elements(
        this.browser_profile.highlight_elements,
        focus_element,
        this.browser_profile.viewport_expansion
      );
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('DOM processing timeout')), 45000)
      );

      content = await Promise.race([domPromise, timeoutPromise]);
      this.logger.debug('✅ DOM processing completed');
    } catch (error) {
      this.logger.warning(`DOM processing timed out for ${page_url}`);
      this.logger.warning('🔄 Falling back to minimal DOM state...');

      // Create minimal DOM state for fallback
      const minimal_element_tree = new DOMElementNode(
        true,
        null,
        'body',
        '/body',
        {},
        []
      );
      content = new DOMState(minimal_element_tree, {});
    }

    // Get tabs info
    this.logger.debug('📋 Getting tabs info...');
    const tabs_info = await this.get_tabs_info();
    this.logger.debug('✅ Tabs info completed');

    // Screenshot
    let screenshot_b64: string | null = null;
    if (include_screenshot) {
      try {
        this.logger.debug('📸 Capturing screenshot...');
        screenshot_b64 = await this.take_screenshot();
      } catch (error) {
        this.logger.warning(
          `❌ Screenshot failed for ${page_url}: ${(error as Error).message}`
        );
      }
    }

    // Get page info and scroll info
    const page_info = await this.get_page_info(page);

    let pixels_above = 0;
    let pixels_below = 0;
    try {
      this.logger.debug('📏 Getting scroll info...');
      const scroll_info = await Promise.race([
        this.get_scroll_info(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 5000)
        ),
      ]);

      // Calculate pixels above/below viewport
      pixels_above = Math.max(0, scroll_info.scroll_y);
      const viewport_bottom =
        scroll_info.scroll_y + scroll_info.viewport_height;
      pixels_below = Math.max(0, scroll_info.page_height - viewport_bottom);

      this.logger.debug('✅ Scroll info completed');
    } catch (error) {
      this.logger.warning(
        `Failed to get scroll info: ${(error as Error).message}`
      );
    }

    // Get title
    let title = 'Title unavailable';
    try {
      const titlePromise = page.title();
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 3000)
      );
      title = await Promise.race([titlePromise, timeoutPromise]);
    } catch (error) {
      // Keep default title
    }

    // Check for errors
    const browser_errors: string[] = [];
    if (Object.keys(content.selector_map).length === 0) {
      browser_errors.push(
        `DOM processing timed out for ${page_url} - using minimal state. Basic navigation still available.`
      );
    }

    // Check if PDF viewer
    const is_pdf_viewer = await this._is_pdf_viewer(page);

    const browser_state = new BrowserStateSummary(content, {
      url: page_url,
      title,
      tabs: tabs_info,
      screenshot: screenshot_b64,
      page_info,
      pixels_above,
      pixels_below,
      browser_errors,
      is_pdf_viewer,
      loading_status: this.currentPageLoadingStatus,
    });

    this.logger.debug('✅ get_state_summary completed successfully');
    return browser_state;
  }

  /**
   * Check if a URL is a new tab page
   */
  private _is_new_tab_page(url: string): boolean {
    return (
      url === 'about:blank' ||
      url === 'about:newtab' ||
      url === 'chrome://newtab/'
    );
  }

  /**
   * Check if page is displaying a PDF
   */
  private async _is_pdf_viewer(page: Page): Promise<boolean> {
    try {
      const url = page.url();
      if (url.endsWith('.pdf') || url.includes('.pdf?')) {
        return true;
      }

      // Check for PDF viewer in page content
      const is_pdf = await page.evaluate(() => {
        return (
          document.querySelector('embed[type="application/pdf"]') !== null ||
          document.querySelector('object[type="application/pdf"]') !== null
        );
      });

      return is_pdf;
    } catch (error) {
      return false;
    }
  }

  /**
   * Auto-download PDF if detected and auto-download is enabled
   */
  private async _auto_download_pdf_if_needed(
    page: Page
  ): Promise<string | null> {
    if (!this._autoDownloadPdfs) {
      return null;
    }

    try {
      const is_pdf = await this._is_pdf_viewer(page);
      if (!is_pdf) {
        return null;
      }

      const url = page.url();
      this.logger.info(`📄 PDF detected: ${url}`);

      // TODO: Implement actual PDF download logic
      // This would involve:
      // 1. Getting the PDF URL
      // 2. Downloading it to a temp directory
      // 3. Adding to downloaded_files list
      // 4. Returning the file path

      return null;
    } catch (error) {
      this.logger.debug(`PDF detection failed: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Check if an element is visible on the page
   */
  private async _is_visible(element: any): Promise<boolean> {
    try {
      const is_hidden = await element.isHidden();
      const bbox = await element.boundingBox();

      return !is_hidden && bbox !== null && bbox.width > 0 && bbox.height > 0;
    } catch (error) {
      return false;
    }
  }

  /**
   * Locate an element by XPath
   */
  async get_locate_element_by_xpath(xpath: string): Promise<any> {
    const page = await this.get_current_page();
    if (!page) {
      return null;
    }

    try {
      // Use XPath to locate the element
      const element_handle = await page
        .locator(`xpath=${xpath}`)
        .elementHandle();
      if (element_handle) {
        const is_visible = await this._is_visible(element_handle);
        if (is_visible) {
          await element_handle.scrollIntoViewIfNeeded({ timeout: 1000 });
        }
        return element_handle;
      }
      return null;
    } catch (error) {
      this.logger.error(
        `❌ Failed to locate xpath ${xpath}: ${(error as Error).message}`
      );
      return null;
    }
  }

  /**
   * Locate an element by CSS selector
   */
  async get_locate_element_by_css_selector(css_selector: string): Promise<any> {
    const page = await this.get_current_page();
    if (!page) {
      return null;
    }

    try {
      // Use CSS selector to locate the element
      const element_handle = await page.locator(css_selector).elementHandle();
      if (element_handle) {
        const is_visible = await this._is_visible(element_handle);
        if (is_visible) {
          await element_handle.scrollIntoViewIfNeeded({ timeout: 1000 });
        }
        return element_handle;
      }
      return null;
    } catch (error) {
      this.logger.error(
        `❌ Failed to locate element ${css_selector}: ${(error as Error).message}`
      );
      return null;
    }
  }

  /**
   * Locate an element by text content
   * @param text - Text to search for
   * @param nth - Which matching element to return (0-based index)
   * @param element_type - Optional tag name to filter by (e.g., 'button', 'span')
   */
  async get_locate_element_by_text(
    text: string,
    nth: number = 0,
    element_type: string | null = null
  ): Promise<any> {
    const page = await this.get_current_page();
    if (!page) {
      return null;
    }

    try {
      // Build selector: filter by element type and text
      const selector = element_type
        ? `${element_type}:text("${text}")`
        : `:text("${text}")`;

      // Get all matching elements
      const locator = page.locator(selector);
      const count = await locator.count();

      if (count === 0) {
        this.logger.error(`❌ No element with text '${text}' found`);
        return null;
      }

      // Filter visible elements
      const visible_elements: any[] = [];
      for (let i = 0; i < count; i++) {
        const element_handle = await locator.nth(i).elementHandle();
        if (element_handle && (await this._is_visible(element_handle))) {
          visible_elements.push(element_handle);
        }
      }

      if (visible_elements.length === 0) {
        this.logger.error(`❌ No visible element with text '${text}' found`);
        return null;
      }

      if (nth >= visible_elements.length) {
        this.logger.error(
          `❌ Element with text '${text}' not found at index #${nth}`
        );
        return null;
      }

      const element_handle = visible_elements[nth];
      const is_visible = await this._is_visible(element_handle);
      if (is_visible) {
        await element_handle.scrollIntoViewIfNeeded({ timeout: 1000 });
      }

      return element_handle;
    } catch (error) {
      this.logger.error(
        `❌ Failed to locate element by text '${text}': ${(error as Error).message}`
      );
      return null;
    }
  }

  /**
   * Check if browser session is connected and has valid browser/context objects
   * @param restart - If true, attempt to create a new tab if no pages exist
   */
  async is_connected(restart: boolean = true): Promise<boolean> {
    if (!this.browser_context) {
      return false;
    }

    try {
      // Check if browser is connected
      if (this.browser && !(this.browser as any).isConnected()) {
        return false;
      }

      // Check if browser context's browser is connected (context may reference a different browser object)
      const context_browser = (this.browser_context as any).browser?.();
      if (context_browser && !(context_browser as any).isConnected()) {
        return false;
      }

      // Check if context has at least one page
      const pages = this.browser_context.pages();
      if (pages.length === 0) {
        if (restart) {
          // Try to create a new page to keep context alive
          try {
            await this.browser_context.newPage();
          } catch (error) {
            return false;
          }
        } else {
          return false;
        }
      }

      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Check if a URL is allowed based on allowed_domains configuration
   * @param url - URL to check
   */
  private _is_url_allowed(url: string): boolean {
    if (
      !this.browser_profile.allowed_domains ||
      this.browser_profile.allowed_domains.length === 0
    ) {
      return true; // No restrictions if allowed_domains not configured
    }

    // Always allow new tab pages
    if (this._is_new_tab_page(url)) {
      return true;
    }

    // Check against allowed domains
    for (const allowed_domain of this.browser_profile.allowed_domains) {
      try {
        if (
          match_url_with_domain_pattern(url, allowed_domain, true)
        ) {
          return true;
        }
      } catch (error) {
        this.logger.warning(`Invalid domain pattern: ${allowed_domain}`);
      }
    }

    return false;
  }

  /**
   * Navigate helper with URL validation
   */
  async navigate(url: string): Promise<void> {
    // Validate URL is allowed
    if (!this._is_url_allowed(url)) {
      throw new Error(
        `URL ${url} is not in allowed_domains. ` +
          `Current allowed_domains: ${JSON.stringify(this.browser_profile.allowed_domains)}`
      );
    }

    await this.navigate_to(url);
  }

  /**
   * Kill the browser session (force close even if keep_alive=true)
   */
  async kill(): Promise<void> {
    this.logger.info('💀 Force killing browser session...');

    // Temporarily disable keep_alive to ensure browser closes
    const original_keep_alive = this.browser_profile.keep_alive;
    this.browser_profile.keep_alive = false;

    try {
      await this.close();
    } finally {
      // Restore original keep_alive setting
      this.browser_profile.keep_alive = original_keep_alive;
    }
  }

  /**
   * Alias for close() to match Python API
   */
  async stop(): Promise<void> {
    await this.close();
  }

  /**
   * Perform a click action with download and navigation handling
   * @param element_node - DOM element to click
   */
  async perform_click(element_node: DOMElementNode): Promise<string | null> {
    const page = await this.get_current_page();
    if (!page) {
      throw new Error('No current page available');
    }

    const element_handle = await this.get_locate_element(element_node);
    if (!element_handle) {
      throw new Error(`Element not found: ${JSON.stringify(element_node)}`);
    }

    // Check if downloads are enabled
    const downloads_path = this.browser_profile.downloads_path;
    if (downloads_path) {
      try {
        // Try to detect file download
        const download_promise = page.waitForEvent('download', {
          timeout: 5000,
        });

        // Perform the click
        await element_handle.click();

        // Wait for download or timeout
        const download = await download_promise;

        // Save the downloaded file
        const suggested_filename = download.suggestedFilename();
        const download_path = path.join(downloads_path, suggested_filename);

        await download.saveAs(download_path);
        this.logger.info(`⬇️ Downloaded file to: ${download_path}`);

        // Track the downloaded file
        this.downloaded_files.push(download_path);
        this.logger.info(
          `📁 Added download to session tracking (total: ${this.downloaded_files.length} files)`
        );

        return download_path;
      } catch (error) {
        // No download triggered, treat as normal click
        this.logger.debug(
          'No download triggered within timeout. Checking navigation...'
        );
        try {
          await page.waitForLoadState();
        } catch (e) {
          this.logger.warning(
            `Navigation check failed: ${(e as Error).message}`
          );
        }
      }
    } else {
      // No downloads path configured, just click
      await element_handle.click();
    }

    return null;
  }

  /**
   * Remove all highlights from the current page
   */
  async remove_highlights(): Promise<void> {
    const page = await this.get_current_page();
    if (!page) {
      return;
    }

    try {
      await page.evaluate(() => {
        // Remove all elements with browser-use highlight class
        const highlights = document.querySelectorAll('.browser-use-highlight');
        highlights.forEach((el) => el.remove());

        // Remove inline highlight styles
        const styled = document.querySelectorAll('[style*="browser-use"]');
        styled.forEach((el: any) => {
          if (el.style) {
            el.style.outline = '';
            el.style.border = '';
          }
        });
      });
    } catch (error) {
      this.logger.debug(
        `Failed to remove highlights: ${(error as Error).message}`
      );
    }
  }

  // region - Trace Recording

  /**
   * Start tracing on browser context if traces_dir is configured
   * Note: Currently optional as it may cause performance issues in some cases
   */
  private async _startContextTracing(): Promise<void> {
    if (this.browser_profile.traces_dir && this.browser_context) {
      try {
        this.logger.debug(
          `📽️ Starting tracing (will save to: ${this.browser_profile.traces_dir})`
        );
        await this.browser_context.tracing.start({
          screenshots: true,
          snapshots: true,
          sources: false, // Reduce trace size
        });
      } catch (error) {
        this.logger.warning(
          `Failed to start tracing: ${(error as Error).message}`
        );
      }
    }
  }

  /**
   * Save browser trace recording
   */
  private async _saveTraceRecording(): Promise<void> {
    if (this.browser_profile.traces_dir && this.browser_context) {
      try {
        const tracesPath = this.browser_profile.traces_dir;
        let finalTracePath: string;

        // Check if path has extension
        if (path.extname(tracesPath)) {
          // Path has extension, use as-is (user specified exact file path)
          finalTracePath = tracesPath;
        } else {
          // Path has no extension, treat as directory and create filename
          const traceFilename = `BrowserSession_${this.id}.zip`;
          finalTracePath = path.join(tracesPath, traceFilename);
        }

        this.logger.info(
          `🎥 Saving browser_context trace to ${finalTracePath}...`
        );
        await this.browser_context.tracing.stop({ path: finalTracePath });
      } catch (error) {
        this.logger.warning(
          `Failed to save trace recording: ${(error as Error).message}`
        );
      }
    }
  }

  // endregion

  // region - CDP Advanced Integration

  /**
   * Scroll using CDP Input.synthesizeScrollGesture for universal compatibility
   * @param page - The page to scroll
   * @param pixels - Number of pixels to scroll (positive = up, negative = down)
   * @returns true if successful, false if failed
   */
  private async _scrollWithCdpGesture(
    page: Page,
    pixels: number
  ): Promise<boolean> {
    try {
      // Use CDP to synthesize scroll gesture - works in all contexts including PDFs
      const cdpSession = await this.browser_context!.newCDPSession(page);

      // Get viewport center for scroll origin
      const viewport = await page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      }));

      const centerX = Math.floor(viewport.width / 2);
      const centerY = Math.floor(viewport.height / 2);

      await cdpSession.send('Input.synthesizeScrollGesture', {
        x: centerX,
        y: centerY,
        xDistance: 0,
        yDistance: -pixels, // Negative = scroll down, Positive = scroll up
        gestureSourceType: 'mouse', // Use mouse gestures for better compatibility
        speed: 3000, // Pixels per second
      });

      try {
        await Promise.race([
          cdpSession.detach(),
          new Promise<void>((resolve) => setTimeout(resolve, 1000)),
        ]);
      } catch {
        // Ignore detach errors
      }

      this.logger.debug(
        `📄 Scrolled via CDP Input.synthesizeScrollGesture: ${pixels}px`
      );
      return true;
    } catch (error) {
      this.logger.warning(
        `❌ Scrolling via CDP Input.synthesizeScrollGesture failed: ${(error as Error).message}`
      );
      return false;
    }
  }

  /**
   * Scroll the current page container
   * @param pixels - Number of pixels to scroll (positive = up, negative = down)
   */
  private async _scrollContainer(pixels: number): Promise<void> {
    const page = await this.getCurrentPage();
    if (!page) {
      throw new Error('No active page available for scrolling');
    }

    // Try CDP scroll gesture first (works universally including PDFs)
    if (await this._scrollWithCdpGesture(page, pixels)) {
      return;
    }

    // Fallback to JavaScript for older browsers or when CDP fails
    this.logger.debug('Falling back to JavaScript scrolling');
    const SMART_SCROLL_JS = `(dy) => {
			const bigEnough = el => el.clientHeight >= window.innerHeight * 0.5;
			const canScroll = el =>
				el &&
				/(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY) &&
				el.scrollHeight > el.clientHeight &&
				bigEnough(el);

			let el = document.activeElement;
			while (el && !canScroll(el) && el !== document.body) el = el.parentElement;

			el = canScroll(el)
					? el
					: [...document.querySelectorAll('*')].find(canScroll)
					|| document.scrollingElement
					|| document.documentElement;

			if (el === document.scrollingElement ||
				el === document.documentElement ||
				el === document.body) {
				window.scrollBy(0, dy);
			} else {
				el.scrollBy(0, dy);
			}
		}`;

    await page.evaluate(SMART_SCROLL_JS, pixels);
  }

  /**
   * Compute hashes for all clickable elements in the selector map
   * @param selectorMap - Selector map from DOM state
   * @returns Set of element hashes
   */
  private _computeElementHashes(selectorMap: SelectorMap): Set<string> {
    const hashes = new Set<string>();

    for (const [index, element] of Object.entries(selectorMap)) {
      if (element instanceof DOMElementNode) {
        // Create hash from element's xpath and key attributes
        const hashParts = [
          element.xpath || '',
          element.tag_name || '',
          JSON.stringify(element.attributes || {}),
        ];
        const hash = hashParts.join('|');
        hashes.add(hash);
      }
    }

    return hashes;
  }

  /**
   * Mark elements in the selector map as new if they weren't in the cached hashes
   * @param selectorMap - Selector map to update
   * @param cachedHashes - Previously cached element hashes
   */
  private _markNewElements(
    selectorMap: SelectorMap,
    cachedHashes: Set<string>
  ): void {
    for (const [index, element] of Object.entries(selectorMap)) {
      if (element instanceof DOMElementNode) {
        // Create hash for current element
        const hashParts = [
          element.xpath || '',
          element.tag_name || '',
          JSON.stringify(element.attributes || {}),
        ];
        const hash = hashParts.join('|');

        // Mark as new if not in cached hashes
        if (!cachedHashes.has(hash)) {
          // Add a marker to the element's attributes to indicate it's new
          element.attributes = element.attributes || {};
          (element.attributes as any)['__browser_use_new_element'] = true;
        }
      }
    }
  }

  /**
   * Helper to get a safe method name from the calling context
   * Used for recovery error messages
   */
  private _getCurrentMethodName(): string {
    try {
      const stack = new Error().stack;
      if (!stack) return 'unknown';

      const lines = stack.split('\n');
      // Skip first 3 lines: Error, this method, and the caller
      const callerLine = lines[3] || '';
      const match = callerLine.match(/at (?:BrowserSession\.)?(\w+)/);
      return match ? match[1] : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /**
   * Get current page with fallback logic
   * Alias for compatibility with Python API
   */
  async getCurrentPage(): Promise<Page | null> {
    return await this.get_current_page();
  }

  /**
   * Log warning about unsafe glob patterns
   * @param pattern - The glob pattern being used
   */
  private _logGlobWarning(pattern: string): void {
    const unsafePatterns = [
      '**/*',
      '**/.*',
      '~/*',
      '/etc/*',
      '/sys/*',
      '/proc/*',
    ];
    const isUnsafe = unsafePatterns.some(
      (unsafe) =>
        pattern.includes(unsafe) ||
        pattern.startsWith(unsafe.replace('**/', ''))
    );

    if (isUnsafe) {
      this.logger.warning(
        `⚠️ Potentially unsafe glob pattern detected: "${pattern}". ` +
          `This could access system files or expose sensitive data.`
      );
    }
  }

  /**
   * Create a shallow copy of the browser session
   * Note: This doesn't copy the actual browser instance, just the session metadata
   * @returns A new BrowserSession instance with copied state
   */
  modelCopy(): BrowserSession {
    return new BrowserSession({
      id: this.id,
      browser_profile: this.browser_profile,
      browser: this.browser,
      browser_context: this.browser_context,
      page: this.agent_current_page,
      title: this.currentTitle,
      url: this.currentUrl,
      wss_url: this.wss_url,
      cdp_url: this.cdp_url,
      browser_pid: this.browser_pid,
      playwright: this.playwright,
      downloaded_files: [...this.downloaded_files],
    });
  }

  // endregion

  // region - Page Health Check and Recovery

  private _inRecovery = false;

  /**
   * Check if a page is responsive by trying to evaluate simple JavaScript
   * @param page - The page to check
   * @param timeout - Timeout in seconds (default: 5.0)
   * @returns true if page is responsive, false otherwise
   */
  private async _isPageResponsive(
    page: Page,
    timeout: number = 5.0
  ): Promise<boolean> {
    try {
      const timeoutMs = timeout * 1000;
      await Promise.race([
        page.evaluate('1'),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Timeout')), timeoutMs)
        ),
      ]);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Force close a crashed page using CDP from a clean temporary page
   * @param pageUrl - The URL of the page to force close
   * @returns true if successful, false otherwise
   */
  private async _forceClosePageViaCdp(pageUrl: string): Promise<boolean> {
    try {
      if (!this.browser_context) {
        throw new Error('Browser context is not set up yet');
      }

      // Create a clean page for CDP operations
      const tempPage = await Promise.race([
        this.browser_context.newPage(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('Timeout creating temp page')),
            5000
          )
        ),
      ]);

      await Promise.race([
        tempPage.goto('about:blank'),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('Timeout navigating to blank')),
            2000
          )
        ),
      ]);

      try {
        // Create CDP session from the clean page
        const cdpSession = await Promise.race([
          this.browser_context.newCDPSession(tempPage),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error('Timeout creating CDP session')),
              5000
            )
          ),
        ]);

        try {
          // Get all browser targets
          const targets = (await Promise.race([
            cdpSession.send('Target.getTargets'),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error('Timeout getting targets')),
                2000
              )
            ),
          ])) as any;

          // Find the crashed page target
          let blockedTargetId: string | null = null;
          const targetInfos = targets.targetInfos || [];
          for (const target of targetInfos) {
            if (target.type === 'page' && target.url === pageUrl) {
              blockedTargetId = target.targetId;
              break;
            }
          }

          if (blockedTargetId) {
            // Force close the target
            this.logger.warning(
              `🪓 Force-closing crashed page target_id=${blockedTargetId} via CDP: ${pageUrl.substring(0, 50)}...`
            );
            await Promise.race([
              cdpSession.send('Target.closeTarget', {
                targetId: blockedTargetId,
              }),
              new Promise<never>((_, reject) =>
                setTimeout(
                  () => reject(new Error('Timeout closing target')),
                  2000
                )
              ),
            ]);
            return true;
          } else {
            this.logger.debug(
              `❌ Could not find CDP page target_id to force-close: ${pageUrl.substring(0, 50)} (concurrency issues?)`
            );
            return false;
          }
        } finally {
          try {
            await Promise.race([
              cdpSession.detach(),
              new Promise<void>((resolve) => setTimeout(resolve, 1000)),
            ]);
          } catch {
            // Ignore detach errors
          }
        }
      } finally {
        await tempPage.close();
      }
    } catch (error) {
      this.logger.error(
        `❌ Using raw CDP to force-close crashed page failed: ${(error as Error).message}`
      );
      return false;
    }
  }

  /**
   * Try to reopen a URL in a new page and check if it's responsive
   * @param url - The URL to reopen
   * @param timeoutMs - Navigation timeout in milliseconds
   * @returns true if successful and responsive, false otherwise
   */
  private async _tryReopenUrl(
    url: string,
    timeoutMs?: number
  ): Promise<boolean> {
    if (
      !url ||
      url.startsWith('about:') ||
      url.startsWith('chrome://') ||
      url.startsWith('edge://')
    ) {
      return false;
    }

    const timeout =
      timeoutMs || this.browser_profile.default_navigation_timeout || 6000;

    try {
      this.logger.debug(
        `🔄 Attempting to reload URL that crashed: ${url.substring(0, 50)}`
      );

      if (!this.browser_context) {
        throw new Error('Browser context is not set');
      }

      // Create new page directly to avoid circular dependency
      const newPage = await this.browser_context.newPage();
      this.agent_current_page = newPage;

      // Update human tab reference if there is no human tab yet
      if (!this.human_current_page || this.human_current_page.isClosed()) {
        this.human_current_page = newPage;
      }

      // Set viewport for new tab
      if (this.browser_profile.window_size) {
        await newPage.setViewportSize(this.browser_profile.window_size);
      }

      // Navigate with timeout
      try {
        await Promise.race([
          newPage.goto(url, { waitUntil: 'load', timeout }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error('Navigation timeout')),
              timeout + 500
            )
          ),
        ]);
      } catch (error) {
        this.logger.debug(
          `⚠️ Attempting to reload previously crashed URL ${url.substring(0, 50)} failed again: ${(error as Error).name}`
        );
      }

      // Wait a bit for any transient blocking to resolve
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Check if the reopened page is responsive
      const isResponsive = await this._isPageResponsive(newPage, 2.0);

      if (isResponsive) {
        this.logger.info(
          `✅ Page recovered and is now responsive after reopening on: ${url.substring(0, 50)}`
        );
        return true;
      } else {
        this.logger.warning(
          `⚠️ Reopened page ${url.substring(0, 50)} is still unresponsive`
        );
        // Close the unresponsive page before returning
        try {
          await this._forceClosePageViaCdp(newPage.url());
        } catch (error) {
          this.logger.error(
            `❌ Failed to close crashed page ${url.substring(0, 50)} via CDP: ${(error as Error).message} (something is very wrong or system is extremely overloaded)`
          );
        }
        this.agent_current_page = null; // Clear reference to closed page
        return false;
      }
    } catch (error) {
      this.logger.error(
        `❌ Retrying crashed page ${url.substring(0, 50)} failed: ${(error as Error).message}`
      );
      return false;
    }
  }

  /**
   * Create a new blank page as a fallback when recovery fails
   * @param url - The original URL that failed
   */
  private async _createBlankFallbackPage(url: string): Promise<void> {
    this.logger.warning(
      `⚠️ Resetting to about:blank as fallback because browser is unable to load the original URL without crashing: ${url.substring(0, 50)}`
    );

    // Close any existing broken page
    if (this.agent_current_page && !this.agent_current_page.isClosed()) {
      try {
        await this.agent_current_page.close();
      } catch {
        // Ignore close errors
      }
    }

    if (!this.browser_context) {
      throw new Error('Browser context is not set');
    }

    // Create fresh page directly (avoid decorated methods to prevent circular dependency)
    const newPage = await this.browser_context.newPage();
    this.agent_current_page = newPage;

    // Update human tab reference if there is no human tab yet
    if (!this.human_current_page || this.human_current_page.isClosed()) {
      this.human_current_page = newPage;
    }

    // Set viewport for new tab
    if (this.browser_profile.window_size) {
      await newPage.setViewportSize(this.browser_profile.window_size);
    }

    // Navigate to blank
    try {
      await newPage.goto('about:blank', { waitUntil: 'load', timeout: 5000 });
    } catch (error) {
      this.logger.error(
        `❌ Failed to navigate to about:blank: ${(error as Error).message} (something is very wrong or system is extremely overloaded)`
      );
      throw error;
    }

    // Verify it's responsive
    if (!(await this._isPageResponsive(newPage, 1.0))) {
      throw new BrowserError(
        'Browser is unable to load any new about:blank pages (something is very wrong or browser is extremely overloaded)'
      );
    }
  }

  /**
   * Recover from an unresponsive page by closing and reopening it
   * @param callingMethod - The name of the method that detected the unresponsive page
   * @param timeoutMs - Navigation timeout in milliseconds
   */
  private async _recoverUnresponsivePage(
    callingMethod: string,
    timeoutMs?: number
  ): Promise<void> {
    this.logger.warning(
      `⚠️ Page JS engine became unresponsive in ${callingMethod}(), attempting recovery...`
    );
    const timeout = Math.min(
      3000,
      timeoutMs || this.browser_profile.default_navigation_timeout || 5000
    );

    // Check if browser connection is still alive
    if (this.browser && !this.browser.isConnected()) {
      this.logger.error(
        '❌ Browser connection lost - browser process may have crashed'
      );
      throw new Error(
        'Browser connection lost - cannot recover unresponsive page'
      );
    }

    // Prevent re-entrance
    if (this._inRecovery) {
      this.logger.debug(
        'Already in recovery, skipping nested recovery attempt'
      );
      return;
    }

    this._inRecovery = true;
    try {
      // Get current URL before recovery
      if (!this.agent_current_page) {
        throw new Error('Agent current page is not set');
      }
      const currentUrl = this.agent_current_page.url();

      // Clear page references
      const blockedPage = this.agent_current_page;
      this.agent_current_page = null;
      if (blockedPage === this.human_current_page) {
        this.human_current_page = null;
      }

      // Force-close the crashed page via CDP
      this.logger.debug(
        '🪓 Page Recovery Step 1/3: Force-closing crashed page via CDP...'
      );
      await this._forceClosePageViaCdp(currentUrl);

      // Remove the closed page from browser_context.pages by forcing a refresh
      if (this.browser_context && this.browser_context.pages()) {
        for (const page of this.browser_context.pages().slice()) {
          const pageUrl = page.url();
          if (
            pageUrl === currentUrl &&
            !page.isClosed() &&
            !pageUrl.startsWith('about:') &&
            !pageUrl.startsWith('chrome://') &&
            !pageUrl.startsWith('edge://')
          ) {
            try {
              await page.close();
              this.logger.debug(
                `🪓 Closed page because it has a known crash-causing URL: ${pageUrl.substring(0, 50)}`
              );
            } catch {
              // Page might already be closed via CDP
            }
          }
        }
      }

      // Try to reopen the URL (in case blocking was transient)
      this.logger.debug(
        '🍼 Page Recovery Step 2/3: Trying to reopen the URL again...'
      );
      if (await this._tryReopenUrl(currentUrl, timeout)) {
        this.logger.debug(
          '✅ Page Recovery Step 3/3: Page loading succeeded after 2nd attempt!'
        );
        return; // Success!
      }

      // If that failed, fall back to blank page
      this.logger.debug(
        '❌ Page Recovery Step 3/3: Loading the page a 2nd time failed as well, browser seems unable to load this URL without getting stuck, retreating to a safe page...'
      );
      await this._createBlankFallbackPage(currentUrl);
    } finally {
      // Always clear recovery flag
      this._inRecovery = false;
    }
  }

  // endregion

  // region - Enhanced CSS Selector Generation

  /**
   * Generate enhanced CSS selector for an element
   * Handles special characters and provides fallback strategies
   * @param xpath - XPath of the element
   * @param element - Optional element node for additional context
   * @returns Enhanced CSS selector string
   */
  private _enhancedCssSelectorForElement(
    xpath: string,
    element?: DOMElementNode
  ): string {
    // Try to convert XPath to CSS selector
    const cssSelector = this._xpathToCss(xpath);

    if (cssSelector) {
      return cssSelector;
    }

    // Fallback: use element attributes if available
    if (element) {
      const selectors: string[] = [];

      // Try ID first (most specific)
      if (element.attributes?.id) {
        const id = this._escapeSelector(element.attributes.id as string);
        selectors.push(`#${id}`);
      }

      // Try class names
      if (element.attributes?.class) {
        const classes = (element.attributes.class as string)
          .split(/\s+/)
          .filter((c) => c.length > 0)
          .map((c) => `.${this._escapeSelector(c)}`)
          .join('');
        if (classes) {
          selectors.push(`${element.tag_name}${classes}`);
        }
      }

      // Try name attribute
      if (element.attributes?.name) {
        const name = this._escapeSelector(element.attributes.name as string);
        selectors.push(`${element.tag_name}[name="${name}"]`);
      }

      // Try data attributes
      for (const [key, value] of Object.entries(element.attributes || {})) {
        if (key.startsWith('data-')) {
          const escaped = this._escapeSelector(String(value));
          selectors.push(`${element.tag_name}[${key}="${escaped}"]`);
        }
      }

      if (selectors.length > 0) {
        return selectors[0];
      }

      // Last resort: just the tag name
      return element.tag_name || 'div';
    }

    // Ultimate fallback
    return 'body';
  }

  /**
   * Convert XPath to CSS selector
   * Handles simple XPath expressions
   */
  private _xpathToCss(xpath: string): string | null {
    try {
      // Remove leading slashes
      let path = xpath.replace(/^\/+/, '');

      // Handle simple cases like /html/body/div[1]/span[2]
      const parts = path.split('/');
      const cssparts: string[] = [];

      for (const part of parts) {
        // Extract tag and index: div[1] -> {tag: 'div', index: 1}
        const match = part.match(/^([a-zA-Z0-9_-]+)(?:\[(\d+)\])?$/);
        if (match) {
          const [, tag, index] = match;
          if (index) {
            // CSS uses nth-of-type (1-indexed like XPath)
            cssparts.push(`${tag}:nth-of-type(${index})`);
          } else {
            cssparts.push(tag);
          }
        } else {
          // Complex XPath, can't convert
          return null;
        }
      }

      return cssparts.join(' > ');
    } catch {
      return null;
    }
  }

  /**
   * Escape special characters in CSS selectors
   * Handles characters that need escaping in CSS
   */
  private _escapeSelector(selector: string): string {
    // Escape special CSS characters
    return selector.replace(/[!"#$%&'()*+,.\/:;<=>?@\[\\\]^`{|}~]/g, '\\$&');
  }

  // endregion

  // region - User Data Directory Management

  /**
   * Prepare user data directory for browser profile
   * Handles singleton lock conflicts and creates temp profiles if needed
   */
  async prepareUserDataDir(userDataDir?: string): Promise<string> {
    if (!userDataDir) {
      // Use profile's user data dir or create temp one
      userDataDir =
        this.browser_profile.user_data_dir ||
        (await this._createTempUserDataDir());
    }

    // Check for singleton lock conflicts
    const hasConflict = await this._checkForSingletonLockConflict(userDataDir);
    if (hasConflict) {
      this.logger.warning(
        `Singleton lock detected in ${userDataDir}, falling back to temp profile`
      );
      userDataDir = await this._fallbackToTempProfile();
    }

    // Ensure directory exists
    if (!fs.existsSync(userDataDir)) {
      fs.mkdirSync(userDataDir, { recursive: true });
      this.logger.debug(`Created user data directory: ${userDataDir}`);
    }

    return userDataDir;
  }

  /**
   * Check if user data directory has a singleton lock
   * This happens when another Chrome instance is using the profile
   */
  private async _checkForSingletonLockConflict(
    userDataDir: string
  ): Promise<boolean> {
    try {
      const singletonLockFile = path.join(userDataDir, 'SingletonLock');
      const singletonSocketFile = path.join(userDataDir, 'SingletonSocket');
      const singletonCookieFile = path.join(userDataDir, 'SingletonCookie');

      // Check if any singleton lock files exist
      if (
        fs.existsSync(singletonLockFile) ||
        fs.existsSync(singletonSocketFile) ||
        fs.existsSync(singletonCookieFile)
      ) {
        // Try to detect if process is still alive (Unix-like systems)
        if (process.platform !== 'win32' && fs.existsSync(singletonLockFile)) {
          try {
            // Try to read the lock file to get PID
            const lockContent = fs.readFileSync(singletonLockFile, 'utf-8');
            const pidMatch = lockContent.match(/(\d+)/);
            if (pidMatch) {
              const pid = parseInt(pidMatch[1], 10);
              try {
                // Check if process exists (signal 0 doesn't kill, just checks)
                process.kill(pid, 0);
                return true; // Process exists, lock is valid
              } catch {
                // Process doesn't exist, stale lock
                this.logger.debug(`Stale singleton lock detected, removing`);
                fs.unlinkSync(singletonLockFile);
                return false;
              }
            }
          } catch {
            // Couldn't read lock file
          }
        }
        return true;
      }
      return false;
    } catch (error) {
      this.logger.debug(
        `Error checking singleton lock: ${(error as Error).message}`
      );
      return false;
    }
  }

  /**
   * Fallback to a temporary profile when the primary one is locked
   */
  private async _fallbackToTempProfile(): Promise<string> {
    const tempDir = await this._createTempUserDataDir();
    this.logger.info(`Using temporary profile: ${tempDir}`);
    return tempDir;
  }

  /**
   * Create a temporary user data directory
   */
  private async _createTempUserDataDir(): Promise<string> {
    const osTempDir = require('os').tmpdir();
    const tempDir = path.join(
      osTempDir,
      `browser-use-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    fs.mkdirSync(tempDir, { recursive: true });
    return tempDir;
  }

  // endregion

  // region - Page Visibility Listeners

  /**
   * Setup listeners for page visibility changes
   * Tracks when user switches tabs to update human_current_page
   */
  private async _setupCurrentPageChangeListeners(): Promise<void> {
    if (!this.browser_context) {
      return;
    }

    // Listen for page events to track which page the user is viewing
    this.browser_context.on?.('page', (page: Page) => {
      this.logger.debug(`New page created: ${page.url?.() || 'about:blank'}`);

      // Note: 'visibilitychange' is not a standard Playwright page event
      // Visibility tracking would need to be implemented differently
      // (e.g., through page.evaluate polling or browser context events)

      // Track new page
      if (page.url && !page.url().startsWith('about:')) {
        this.human_current_page = page;
      }
    });
  }

  /**
   * Callback when tab visibility changes
   * Updates human_current_page to reflect which tab the user is viewing
   */
  private _onTabVisibilityChange(page: Page): void {
    try {
      // Check if page is visible
      page
        .evaluate?.(() => document.visibilityState === 'visible')
        .then((isVisible: boolean) => {
          if (isVisible) {
            this.logger.debug(
              `Tab became visible: ${page.url?.() || 'unknown'}`
            );
            this.human_current_page = page;
          }
        })
        .catch(() => {
          // Ignore errors from closed pages
        });
    } catch {
      // Ignore errors
    }
  }

  // endregion

  // region - Process Management

  /**
   * Kill all child processes spawned by this browser session
   */
  private async _killChildProcesses(): Promise<void> {
    if (this._childProcesses.size === 0) {
      return;
    }

    this.logger.debug(`Killing ${this._childProcesses.size} child processes`);

    for (const pid of this._childProcesses) {
      try {
        // Try to kill the process
        process.kill(pid, 'SIGTERM');
        this.logger.debug(`Sent SIGTERM to process ${pid}`);

        // Wait briefly and check if still alive
        await new Promise((resolve) => setTimeout(resolve, 500));

        try {
          // Check if process still exists
          process.kill(pid, 0);
          // If we get here, process is still alive, force kill
          process.kill(pid, 'SIGKILL');
          this.logger.debug(`Sent SIGKILL to process ${pid}`);
        } catch {
          // Process is dead, ignore
        }
      } catch (error) {
        // Process doesn't exist or we don't have permission
        this.logger.debug(
          `Could not kill process ${pid}: ${(error as Error).message}`
        );
      }
    }

    this._childProcesses.clear();
  }

  /**
   * Terminate the browser process and all its children
   */
  private async _terminateBrowserProcess(): Promise<void> {
    if (!this.browser_pid) {
      return;
    }

    try {
      this.logger.debug(`Terminating browser process ${this.browser_pid}`);

      // Platform-specific process tree termination
      if (process.platform === 'win32') {
        // Windows: use taskkill to kill process tree
        await execAsync(`taskkill /PID ${this.browser_pid} /T /F`).catch(() => {
          // Ignore errors if process already dead
        });
      } else {
        // Unix-like: kill process group
        try {
          // Try to kill the process group
          process.kill(-this.browser_pid, 'SIGTERM');
          await new Promise((resolve) => setTimeout(resolve, 1000));

          // Check if still alive and force kill if needed
          try {
            process.kill(-this.browser_pid, 0);
            process.kill(-this.browser_pid, 'SIGKILL');
          } catch {
            // Process is dead
          }
        } catch {
          // Fallback to killing just the process
          try {
            process.kill(this.browser_pid, 'SIGTERM');
            await new Promise((resolve) => setTimeout(resolve, 1000));
            process.kill(this.browser_pid, 'SIGKILL');
          } catch {
            // Process doesn't exist
          }
        }
      }
    } catch (error) {
      this.logger.debug(
        `Error terminating browser process: ${(error as Error).message}`
      );
    }
  }

  /**
   * Get child processes of a given PID
   * Cross-platform implementation using ps on Unix-like systems and WMIC on Windows
   */
  private async _getChildProcesses(pid: number): Promise<number[]> {
    try {
      if (process.platform === 'win32') {
        // Windows: use WMIC
        const { stdout } = await execAsync(
          `wmic process where (ParentProcessId=${pid}) get ProcessId`
        );
        const pids = stdout
          .split('\n')
          .slice(1) // Skip header
          .map((line) => parseInt(line.trim(), 10))
          .filter((p) => !isNaN(p));
        return pids;
      } else {
        // Unix-like: use ps
        const { stdout } = await execAsync(`ps -o pid= --ppid ${pid}`);
        const pids = stdout
          .split('\n')
          .map((line) => parseInt(line.trim(), 10))
          .filter((p) => !isNaN(p));
        return pids;
      }
    } catch {
      return [];
    }
  }

  /**
   * Track a child process
   */
  private _trackChildProcess(pid: number): void {
    this._childProcesses.add(pid);
  }

  /**
   * Untrack a child process
   */
  private _untrackChildProcess(pid: number): void {
    this._childProcesses.delete(pid);
  }

  // region: Loading Animations

  /**
   * Show DVD screensaver loading animation
   * Returns a function to stop the animation
   *
   * @param message - Message to display (default: 'Loading...')
   * @param fps - Frames per second (default: 10)
   * @returns Function to stop the animation
   *
   * @example
   * const stopAnimation = this._showDvdScreensaverLoadingAnimation('Loading page...');
   * await someLongOperation();
   * stopAnimation();
   */
  _showDvdScreensaverLoadingAnimation(
    message: string = 'Loading...',
    fps: number = 10
  ): () => void {
    return showDVDScreensaver(message, fps);
  }

  /**
   * Show simple spinner loading animation
   * Returns a function to stop the animation
   *
   * @param message - Message to display (default: 'Loading...')
   * @param fps - Frames per second (default: 10)
   * @returns Function to stop the animation
   *
   * @example
   * const stopSpinner = this._showSpinnerLoadingAnimation('Processing...');
   * await someLongOperation();
   * stopSpinner();
   */
  _showSpinnerLoadingAnimation(
    message: string = 'Loading...',
    fps: number = 10
  ): () => void {
    return showSpinner(message, fps);
  }

  /**
   * Execute an async operation with DVD screensaver animation
   *
   * @param operation - Async operation to execute
   * @param message - Message to display during operation
   * @returns Result of the operation
   *
   * @example
   * const page = await this._withDvdScreensaver(
   *   async () => await this.browser_context!.newPage(),
   *   'Opening new page...'
   * );
   */
  async _withDvdScreensaver<T>(
    operation: () => Promise<T>,
    message: string = 'Loading...'
  ): Promise<T> {
    return withDVDScreensaver(operation, message);
  }

  // endregion: Loading Animations

  // endregion
}

export { DEFAULT_BROWSER_PROFILE };
