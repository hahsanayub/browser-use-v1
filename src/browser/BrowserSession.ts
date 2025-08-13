/**
 * BrowserSession provides a unified session abstraction with step-level state caching
 */

import type {
  Browser as PlaywrightBrowser,
  BrowserContext as PlaywrightContext,
  Page,
} from 'playwright';
import { DOMService } from '../services/dom-service';
import type { PageView, DOMState } from '../types/dom';

export interface BrowserStateSummary extends PageView {
  /** Map from highlight index to the full element node returned by in-page DOM build */
  selectorMap: Map<number, any>;
}

export class BrowserSession {
  private browser: PlaywrightBrowser;
  private context: PlaywrightContext;
  private domService: DOMService;
  private _cachedBrowserStateSummary: BrowserStateSummary | null = null;

  constructor(browser: PlaywrightBrowser, context: PlaywrightContext) {
    this.browser = browser;
    this.context = context;
    this.domService = new DOMService();
  }

  /** Get current active page or create one if none exists */
  private async getOrCreateActivePage(): Promise<Page> {
    const pages = this.context.pages();
    if (pages.length > 0) return pages[pages.length - 1]!;
    return await this.context.newPage();
  }

  /** Get a stable state snapshot for the current step. Force refresh to recompute. */
  async getStateSummary(
    forceRefresh: boolean = false
  ): Promise<BrowserStateSummary> {
    if (this._cachedBrowserStateSummary && !forceRefresh) {
      return this._cachedBrowserStateSummary;
    }

    const page = await this.getOrCreateActivePage();
    const pageView = await this.domService.getPageView(page, {}, true);
    const selectorMap = this.buildSelectorMap(pageView.domState);

    this._cachedBrowserStateSummary = {
      ...pageView,
      selectorMap,
    };
    return this._cachedBrowserStateSummary;
  }

  /** Invalidate the cached state snapshot */
  invalidateCache(): void {
    this._cachedBrowserStateSummary = null;
    this.domService.clearCache();
  }

  /** Lightweight DOM signature useful for change detection within a step */
  async getDomSignature(): Promise<string> {
    const page = await this.getOrCreateActivePage();
    return await this.domService.getDomSignature(page);
  }

  /** Navigate and invalidate cached state */
  async goto(url: string): Promise<void> {
    const page = await this.getOrCreateActivePage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    this.invalidateCache();
  }

  /** Click an element by highlight index from the cached selector map */
  async clickByIndex(index: number): Promise<void> {
    const page = await this.getOrCreateActivePage();
    if (!this._cachedBrowserStateSummary) {
      await this.getStateSummary(true);
    }
    const node = this._cachedBrowserStateSummary!.selectorMap.get(index);
    if (!node) throw new Error(`Element with index ${index} not found`);
    const selector = node.xpath
      ? `xpath=/${node.xpath}`
      : node.selector || node.tagName;
    await page.click(selector);
    this.invalidateCache();
  }

  /** Type text into an element by highlight index */
  async typeByIndex(index: number, text: string): Promise<void> {
    const page = await this.getOrCreateActivePage();
    if (!this._cachedBrowserStateSummary) {
      await this.getStateSummary(true);
    }
    const node = this._cachedBrowserStateSummary!.selectorMap.get(index);
    if (!node) throw new Error(`Element with index ${index} not found`);
    const selector = node.xpath
      ? `xpath=/${node.xpath}`
      : node.selector || node.tagName;
    try {
      await page.fill(selector, '');
    } catch {
      // ignore non-fillable element
    }
    await page.type(selector, text, { delay: 30 });
    this.invalidateCache();
  }

  /** Expose underlying playwright objects when absolutely needed */
  getBrowser(): PlaywrightBrowser {
    return this.browser;
  }
  getContext(): PlaywrightContext {
    return this.context;
  }

  private buildSelectorMap(domState?: DOMState): Map<number, any> {
    const map = new Map<number, any>();
    if (!domState || !domState.map) return map;
    for (const id of Object.keys(domState.map)) {
      const node = (domState.map as Record<string, any>)[id];
      if (node && typeof node.highlightIndex === 'number') {
        map.set(node.highlightIndex, {
          ...node,
          selector: node.xpath ? `xpath=/${node.xpath}` : node.tagName,
        });
      }
    }
    return map;
  }
}
