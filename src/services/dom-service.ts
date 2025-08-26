/**
 * DOM Service for analyzing and processing web pages for AI agents
 */

import { BrowserContext, Page } from 'playwright';
import { promises as fs } from 'fs';
import { resolve as pathResolve } from 'path';
import type {
  PageView,
  DOMProcessingOptions,
  DOMState,
  DOMBaseNode,
  DOMTextNode,
  DOMElementNode,
  ViewportInfo,
  SelectorMap,
  DOMResult,
  PageInfo,
  TabsInfo,
} from '../types/dom';
import type { BrowserConfig } from '../config/schema';
import { getLogger } from './logging';
import { DOMTreeSerializer } from './dom-tree-serializer';
import { DOMTreeAdapter } from './dom-tree-adapter';

/**
 * DOM Service class for processing and analyzing web page content
 */
export class DOMService {
  private logger = getLogger();
  private cache: Map<string, { view: PageView; timestamp: number }> = new Map();
  private cacheTimeout: number = 5000; // 5 seconds cache timeout
  private buildDomTreeScript: string | null = null;
  private static computeStringHash(input: string): string {
    // Simple 32-bit hash
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      hash = (hash << 5) - hash + input.charCodeAt(i);
      hash |= 0;
    }
    // convert to unsigned hex
    return (hash >>> 0).toString(16);
  }

  constructor() {}

  /**
   * Create DOMProcessingOptions from BrowserConfig
   */
  private createDOMOptionsFromBrowserConfig(
    browserConfig: BrowserConfig,
    overrides: DOMProcessingOptions = {}
  ): DOMProcessingOptions {
    return {
      viewportExpansion: browserConfig.viewportExpansion,
      markInteractive: browserConfig.highlightElements,
      includeHidden: browserConfig.includeHiddenElements,
      maxTextLength: browserConfig.maxTextLength,
      removeScripts: browserConfig.removeScripts,
      removeStyles: browserConfig.removeStyles,
      removeComments: browserConfig.removeComments,
      ...overrides, // Allow explicit overrides
    };
  }

  /**
   * Get a processed view of the current page
   */
  async getPageView(
    page: Page,
    browserContext: BrowserContext,
    options: DOMProcessingOptions = {},
    forceRefresh: boolean = false,
    browserConfig?: BrowserConfig
  ): Promise<PageView> {
    // If browserConfig is provided, merge its DOM settings with options
    if (browserConfig) {
      const browserDOMOptions = this.createDOMOptionsFromBrowserConfig(
        browserConfig,
        options
      );
      options = browserDOMOptions;
    }
    const url = page.url();
    const cacheKey = `${url}_${JSON.stringify(options)}`;

    // Check cache first unless force refresh requested
    if (!forceRefresh) {
      const cached = this.cache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
        this.logger.debug('Returning cached page view', { url });
        return cached.view;
      }
    }

    try {
      this.logger.debug('Processing page view', { url });

      // Use injected buildDomTree.js to get structured DOM state and interactive elements
      const [title, pageInfo, tabsInfo, isLoading, domResult, isPdfViewer] =
        await Promise.all([
          page.title(),
          this.getPageInfo(page),
          this.getTabsInfo(page, browserContext),
          this.isPageLoading(page),
          this.buildDomState(page, options),
          this.isPdfViewer(page),
        ]);

      // Determine browser errors based on DOM processing results
      const browserErrors: string[] = [];

      // Check if this is a minimal fallback state (empty selector map indicates fallback)
      if (
        !domResult.selectorMap ||
        Object.keys(domResult.selectorMap).length === 0
      ) {
        browserErrors.push(
          `DOM processing timed out for ${url} - using minimal state. Basic navigation still available via go_to_url, scroll, and search actions.`
        );
      }

      const pageView: PageView = {
        html: this.serializeDOMState(domResult),
        url,
        title,
        isLoading,
        timestamp: Date.now(),
        domState: domResult,
        pageInfo,
        tabsInfo,
        browserErrors,
        isPdfViewer,
      };

      // Cache the result
      this.cache.set(cacheKey, { view: pageView, timestamp: Date.now() });

      this.logger.debug('Page view processed successfully', {
        url,
      });

      return pageView;
    } catch (error) {
      this.logger.error('Failed to process page view', error as Error, { url });

      // Create minimal fallback pageView with browser errors for failed state retrieval
      try {
        const [title, pageInfo, tabsInfo] = await Promise.all([
          page.title().catch(() => 'Title unavailable'),
          this.getPageInfo(page).catch(() => ({
            viewportWidth: 0,
            viewportHeight: 0,
            pageWidth: 0,
            pageHeight: 0,
            scrollX: 0,
            scrollY: 0,
            pixelsAbove: 0,
            pixelsBelow: 0,
            pixelsLeft: 0,
            pixelsRight: 0,
          })),
          this.getTabsInfo(page, browserContext).catch(() => []),
        ]);

        const fallbackPageView: PageView = {
          html: '',
          url,
          title,
          isLoading: false,
          timestamp: Date.now(),
          domState: {
            map: {},
            selectorMap: {},
          },
          pageInfo,
          tabsInfo,
          browserErrors: [
            `Page state retrieval failed, minimal recovery applied for ${url}`,
          ],
          isPdfViewer: false,
        };

        // Cache the fallback result
        this.cache.set(cacheKey, {
          view: fallbackPageView,
          timestamp: Date.now(),
        });

        return fallbackPageView;
      } catch (fallbackError) {
        this.logger.error(
          'Failed to create fallback page view',
          fallbackError as Error,
          { url }
        );
        throw error; // Re-throw original error
      }
    }
  }

  private async isPdfViewer(page: Page): Promise<boolean> {
    try {
      const isPdfViewer = await page.evaluate(() => {
        // Check for Chrome's built-in PDF viewer (updated selector)
        const pdfEmbed =
          document.querySelector(
            'embed[type="application/x-google-chrome-pdf"]'
          ) || document.querySelector('embed[type="application/pdf"]');
        const isPdfViewer = !!pdfEmbed;

        // Also check if the URL ends with .pdf or has PDF content-type
        const url = window.location.href;
        const isPdfUrl =
          url.toLowerCase().includes('.pdf') ||
          document.contentType === 'application/pdf';

        return isPdfViewer || isPdfUrl;
      });
      return isPdfViewer;
    } catch (error) {
      this.logger.debug('Failed to check if page is a PDF viewer', {
        error: (error as Error).message,
      });
      return false;
    }
  }

  /**
   * Check if a URL is a new tab page (about:blank or chrome://new-tab-page).
   */
  private isNewTabPage(url: string): boolean {
    return (
      url === 'about:blank' ||
      url === 'chrome://new-tab-page/' ||
      url === 'chrome://new-tab-page'
    );
  }

  async getTabsInfo(
    page: Page,
    browserContext: BrowserContext
  ): Promise<TabsInfo[]> {
    const tabsInfo: TabsInfo[] = [];
    const pages = browserContext.pages();

    for (const [pageIndex, currentPage] of pages.entries()) {
      const url = currentPage.url();

      // Skip JS execution for chrome:// pages and new tab pages
      if (this.isNewTabPage(url) || url.startsWith('chrome://')) {
        // Use URL as title for chrome pages, or mark new tabs as unusable
        let title: string;
        if (this.isNewTabPage(url)) {
          title = 'ignore this tab and do not use it';
        } else {
          // For chrome:// pages, use the URL itself as the title
          title = url;
        }

        tabsInfo.push({
          pageId: pageIndex,
          url,
          title,
          parentPageId: null, // No parent page concept in this implementation
        });
        continue;
      }

      // Normal pages - try to get title with timeout
      try {
        // Create a timeout promise for page.title()
        const titlePromise = currentPage.title();
        const timeoutPromise = new Promise<never>((_, reject) => {
          // todo: make this configurable
          setTimeout(() => reject(new Error('Title timeout')), 10 * 1000);
        });

        const title = await Promise.race([titlePromise, timeoutPromise]);
        tabsInfo.push({
          pageId: pageIndex,
          url,
          title,
          parentPageId: null, // No parent page concept in this implementation
        });
      } catch (error) {
        // page.title() can hang forever on tabs that are crashed/disappeared/about:blank
        // but we should preserve the real URL and not mislead the LLM about tab availability
        this.logger.debug(
          `⚠️ Failed to get tab info for tab #${pageIndex}: ${url} (using fallback title)`,
          { error: (error as Error).message }
        );

        // Only mark as unusable if it's actually a new tab page, otherwise preserve the real URL
        if (this.isNewTabPage(url)) {
          tabsInfo.push({
            pageId: pageIndex,
            url,
            title: 'ignore this tab and do not use it',
            parentPageId: null,
          });
        } else {
          // harsh but good, just close the page here because if we can't get the title
          // then we certainly can't do anything else useful with it, no point keeping it open
          try {
            await currentPage.close();
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

  async getPageInfo(page: Page): Promise<PageInfo> {
    const pageInfo = await page.evaluate(() => {
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

    return {
      viewportWidth: pageInfo.viewport_width,
      viewportHeight: pageInfo.viewport_height,
      pageWidth: pageInfo.page_width,
      pageHeight: pageInfo.page_height,
      scrollX: pageInfo.scroll_x,
      scrollY: pageInfo.scroll_y,
      pixelsAbove: pageInfo.scroll_y,
      pixelsBelow: Math.max(
        0,
        pageInfo.page_height - (pageInfo.scroll_y + pageInfo.viewport_height)
      ),
      pixelsLeft: pageInfo.scroll_x,
      pixelsRight: Math.max(
        0,
        pageInfo.page_width - (pageInfo.scroll_x + pageInfo.viewport_width)
      ),
    };
  }

  /**
   * Compute a compact signature for current DOM state to detect changes
   */
  async getDomSignature(
    page: Page,
    options: DOMProcessingOptions = {}
  ): Promise<string> {
    try {
      const dom = await this.buildDomState(page, options);
      const serializedDom = this.serializeDOMState(dom);
      const signature = DOMService.computeStringHash(serializedDom);
      return signature;
    } catch (error) {
      this.logger.debug('Failed to compute DOM signature', {
        error: (error as Error).message,
      });
      return '';
    }
  }

  /**
   * Process HTML content to make it more suitable for LLM consumption
   */
  // Build DOM in browser context using provided buildDomTree.js and return DOMState
  private async buildDomState(
    page: Page,
    options: DOMProcessingOptions
  ): Promise<DOMState> {
    if (!this.buildDomTreeScript) {
      const scriptPath = pathResolve(process.cwd(), 'src/dom/buildDomTree.js');
      try {
        this.buildDomTreeScript = await fs.readFile(scriptPath, 'utf-8');
      } catch {
        this.logger.warn(
          'buildDomTree.js not found; returning raw HTML as fallback'
        );
        return {
          elementTree: undefined,
          map: {},
          selectorMap: { root: 'html' },
        };
      }
    }
    let result: DOMResult;
    try {
      result = await page.evaluate(
        (payload: { script: string; args: any }) =>
          new Function(`return ${payload.script}`)()(payload.args),
        {
          script: this.buildDomTreeScript,
          args: {
            doHighlightElements: options.markInteractive ?? true,
            viewportExpansion: options.viewportExpansion ?? 500, // Default to Python version value
            debugMode: false,
            ...options,
          },
        }
      );
    } catch (primaryError) {
      // Try a secondary path once more
      try {
        result = await page.evaluate(
          (payload: { script: string; args: any }) =>
            new Function(`return ${payload.script}`)()(payload.args),
          {
            script: this.buildDomTreeScript!,
            args: {
              doHighlightElements: options.markInteractive ?? true,
              viewportExpansion: options.viewportExpansion ?? 500, // Default to Python version value
              debugMode: false,
              ...options,
            },
          }
        );
      } catch (secondaryError) {
        // If both attempts fail (e.g., due to strict CSP disallowing eval/new Function),
        // return a minimal fallback DOM state so the agent can continue.
        this.logger.warn(
          'Falling back to minimal DOM state due to evaluation failure',
          {
            error: (secondaryError as Error).message,
            primaryError: (primaryError as Error).message,
          }
        );
        return {
          elementTree: undefined,
          map: {},
          selectorMap: { root: 'html' },
        } as DOMState;
      }
    }

    // Construct DOM tree using the new logic
    try {
      const { elementTree, selectorMap: domSelectorMap } =
        this.constructDomTree(result);

      // Convert DOM selector map to string selector map for backward compatibility
      const selectorMap: Record<string, string> = {};
      for (const [highlightIndex, elementNode] of Object.entries(
        domSelectorMap
      )) {
        if (elementNode.xpath) {
          selectorMap[highlightIndex] = `xpath=/${elementNode.xpath}`;
        } else if (elementNode.tagName) {
          selectorMap[highlightIndex] = elementNode.tagName;
        }
      }

      const domState: DOMState = {
        elementTree,
        map: result?.map || {},
        selectorMap,
      };
      return domState;
    } catch (error) {
      this.logger.warn(
        'Failed to construct DOM tree, falling back to original format',
        {
          error: (error as Error).message,
        }
      );

      // Fallback to original logic if DOM tree construction fails
      const map: Record<string, any> = result?.map || {};
      const selectorMap: Record<string, string> = {};
      for (const id of Object.keys(map)) {
        const node = map[id];
        if (node?.xpath) selectorMap[id] = `xpath=/${node.xpath}`;
        else if (node?.tagName) selectorMap[id] = node.tagName;
      }
      const domState: DOMState = {
        elementTree: undefined,
        map,
        selectorMap,
      };
      return domState;
    }
  }

  /**
   * Check if page is still loading
   */
  private async isPageLoading(page: Page): Promise<boolean> {
    try {
      const loadState = await page.evaluate(() => document.readyState);
      return loadState !== 'complete';
    } catch {
      return false;
    }
  }

  /**
   * Remove elements by selector
   */
  private removeElements(document: Document, selector: string): void {
    const elements = document.querySelectorAll(selector);
    elements.forEach((element) => element.remove());
  }

  /**
   * Remove HTML comments
   */
  private removeComments(document: Document): void {
    const walker = document.createTreeWalker(
      document.documentElement,
      8 // NodeFilter.SHOW_COMMENT
    );

    const comments: Node[] = [];
    let node = walker.nextNode();
    while (node) {
      comments.push(node);
      node = walker.nextNode();
    }

    comments.forEach((comment) => {
      if (comment.parentNode) {
        comment.parentNode.removeChild(comment);
      }
    });
  }

  /**
   * Remove hidden elements that are not visible to users
   */
  private async removeHiddenElements(
    page: Page,
    document: Document
  ): Promise<void> {
    try {
      // Get list of hidden elements from the actual page
      const hiddenSelectors = await page.$$eval('*', (elements) => {
        return elements
          .map((el, index) => {
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();

            if (
              style.display === 'none' ||
              style.visibility === 'hidden' ||
              style.opacity === '0' ||
              (rect.width === 0 && rect.height === 0)
            ) {
              return `[data-element-index="${index}"]`;
            }
            return null;
          })
          .filter(Boolean);
      });

      // Mark elements in original page for identification
      await page.$$eval('*', (elements) => {
        elements.forEach((el, index) => {
          (el as HTMLElement).setAttribute(
            'data-element-index',
            index.toString()
          );
        });
      });

      // Remove corresponding elements from JSDOM document
      hiddenSelectors.forEach((selector) => {
        if (selector) {
          const elements = document.querySelectorAll(selector);
          elements.forEach((el) => {
            if (el.parentNode) {
              el.parentNode.removeChild(el);
            }
          });
        }
      });
    } catch (error) {
      this.logger.debug('Could not remove hidden elements', {
        error: (error as Error).message,
      });
    }
  }

  /**
   * Mark interactive elements with special attributes
   */
  private async markInteractiveElements(
    page: Page,
    document: Document
  ): Promise<void> {
    try {
      // Add interactive IDs to elements in the JSDOM document
      const interactiveSelectors = [
        'button',
        'a',
        'input',
        'textarea',
        'select',
        '[role="button"]',
        '[onclick]',
        '[tabindex]',
      ];

      interactiveSelectors.forEach((selector) => {
        const elements = document.querySelectorAll(selector);
        elements.forEach((element, index) => {
          (element as HTMLElement).setAttribute(
            'data-interactive-id',
            `${selector}_${index}`
          );
        });
      });
    } catch (error) {
      this.logger.debug('Could not mark interactive elements', {
        error: (error as Error).message,
      });
    }
  }

  /**
   * Simplify content by removing unnecessary attributes and shortening text
   */
  private simplifyContent(
    document: Document,
    options: DOMProcessingOptions
  ): void {
    // Remove unnecessary attributes
    const elementsWithAttributes = document.querySelectorAll('*');
    elementsWithAttributes.forEach((element) => {
      const attributesToKeep = [
        'id',
        'class',
        'href',
        'src',
        'alt',
        'title',
        'type',
        'name',
        'value',
        'placeholder',
        'role',
        'aria-label',
        'data-interactive-id',
      ];

      const attributesToRemove: string[] = [];
      Array.from(element.attributes).forEach((attr) => {
        if (!attributesToKeep.includes(attr.name)) {
          attributesToRemove.push(attr.name);
        }
      });

      attributesToRemove.forEach((attrName) => {
        element.removeAttribute(attrName);
      });
    });

    // Shorten long text content
    if (options.maxTextLength) {
      const textElements = document.querySelectorAll('*');
      textElements.forEach((element) => {
        Array.from(element.childNodes).forEach((node) => {
          if (node.nodeType === 3 && node.textContent) {
            // Text node
            const text = node.textContent.trim();
            if (text.length > options.maxTextLength!) {
              node.textContent =
                text.substring(0, options.maxTextLength!) + '...';
            }
          }
        });
      });
    }
  }

  /**
   * Generate a reliable CSS selector for an element
   */
  private generateSelector(element: Element): string {
    // Try ID first
    if (element.id) {
      const esc =
        (globalThis as any).CSS?.escape ||
        ((s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '\\$&'));
      return `#${esc(element.id)}`;
    }

    // Try combination of tag and classes
    let selector = element.tagName.toLowerCase();

    if (element.className && typeof element.className === 'string') {
      const classes = element.className.split(' ').filter(Boolean);
      if (classes.length > 0) {
        selector += '.' + classes.map((cls) => CSS.escape(cls)).join('.');
      }
    }

    // Add position if needed to make selector unique
    const parent = element.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(
        (sibling) => sibling.tagName === element.tagName
      );

      if (siblings.length > 1) {
        const index = siblings.indexOf(element);
        selector += `:nth-of-type(${index + 1})`;
      }
    }

    return selector;
  }

  /**
   * Parse a node from JavaScript evaluation result
   */
  private parseNode(nodeData: any): {
    node: DOMBaseNode | null;
    childrenIds: number[];
  } {
    if (!nodeData) {
      return { node: null, childrenIds: [] };
    }

    // Process text nodes immediately
    if (nodeData.type === 'TEXT_NODE') {
      const textNode: DOMTextNode = {
        text: nodeData.text,
        isVisible: nodeData.isVisible,
        parent: null,
        type: 'TEXT_NODE',
      };
      return { node: textNode, childrenIds: [] };
    }

    // Process viewport info if it exists for element nodes
    let viewportInfo: ViewportInfo | null = null;
    if (nodeData.viewport) {
      viewportInfo = {
        width: nodeData.pageInfo.width,
        height: nodeData.pageInfo.height,
      };
    }

    const elementNode: DOMElementNode = {
      tagName: nodeData.tagName,
      xpath: nodeData.xpath,
      attributes: nodeData.attributes || {},
      children: [],
      isVisible: nodeData.isVisible || false,
      isInteractive: nodeData.isInteractive || false,
      isTopElement: nodeData.isTopElement || false,
      isInViewport: nodeData.isInViewport || false,
      highlightIndex: nodeData.highlightIndex ?? null,
      shadowRoot: nodeData.shadowRoot || false,
      parent: null,
      viewportInfo,
    };

    const childrenIds = nodeData.children || [];

    return { node: elementNode, childrenIds };
  }

  /**
   * Serialize DOM state to JSON string, handling circular references
   */
  private serializeDOMState(domState: DOMState): string {
    try {
      return JSON.stringify(domState, (key, value) => {
        // Skip parent property to avoid circular references
        if (key === 'parent') {
          return undefined;
        }
        return value;
      });
    } catch (error) {
      this.logger.warn('Failed to serialize DOM state', {
        error: (error as Error).message,
      });
      // Fallback to a simplified representation
      return JSON.stringify({
        elementTree: domState.elementTree ? '[DOM Tree Available]' : undefined,
        map: '[DOM Map Available]',
        selectorMap: domState.selectorMap,
      });
    }
  }

  /**
   * Construct DOM tree from JavaScript evaluation result
   */
  private constructDomTree(evalPage: DOMResult): {
    elementTree: DOMElementNode;
    selectorMap: SelectorMap;
  } {
    const jsNodeMap = evalPage.map;
    const jsRootId = evalPage.rootId;

    const selectorMap: SelectorMap = {};
    const nodeMap: Record<string, DOMBaseNode> = {};
    const nodeChildrenMap: Record<string, number[]> = {};

    // Parse all nodes first
    for (const [id, nodeData] of Object.entries(jsNodeMap)) {
      const { node, childrenIds } = this.parseNode(nodeData);
      if (node === null) {
        continue;
      }

      nodeMap[id] = node;
      nodeChildrenMap[id] = childrenIds;

      // Build selector map for elements with highlight index
      if (
        node.type !== 'TEXT_NODE' &&
        (node as DOMElementNode).highlightIndex !== null
      ) {
        const elementNode = node as DOMElementNode;
        selectorMap[elementNode.highlightIndex!] = elementNode;
      }
    }

    // Build parent-child relationships after all nodes are parsed
    for (const [id, childrenIds] of Object.entries(nodeChildrenMap)) {
      const node = nodeMap[id];
      if (!node || node.type === 'TEXT_NODE') {
        continue;
      }

      const elementNode = node as DOMElementNode;
      for (const childId of childrenIds) {
        if (!(childId.toString() in nodeMap)) {
          continue;
        }

        const childNode = nodeMap[childId.toString()];
        childNode.parent = elementNode;
        elementNode.children.push(childNode);
      }
    }

    const htmlToDict = nodeMap[jsRootId.toString()];

    if (!htmlToDict || htmlToDict.type === 'TEXT_NODE') {
      throw new Error('Failed to parse HTML to dictionary');
    }

    return {
      elementTree: htmlToDict as DOMElementNode,
      selectorMap,
    };
  }

  /**
   * Get enhanced clickable elements string using the new DOMTreeSerializer
   * with bounding box filtering and improved element detection
   */
  async getEnhancedClickableElementsString(
    page: Page,
    options: DOMProcessingOptions = {},
    includeAttributes: string[] = [
      'title',
      'type',
      'checked',
      'name',
      'role',
      'value',
      'placeholder',
      'data-date-format',
      'alt',
      'aria-label',
      'aria-expanded',
      'data-state',
      'aria-checked',
      // Accessibility properties from ax_node (ordered by importance for automation)
      'checked',
      'selected',
      'expanded',
      'pressed',
      'disabled',
      // 'invalid',
      'valuenow',
      'keyshortcuts',
      'haspopup',
      'multiselectable',
      // Less commonly needed (uncomment if required):
      // 'readonly',
      'required',
      'valuetext',
      'level',
      'busy',
      'live',
      // Accessibility name (contains text content for StaticText elements)
      'ax_name',
    ]
  ): Promise<{ html: string; timing: any }> {
    try {
      // Get DOM result from buildDomTree.js
      const domResult = await this.buildDomState(page, options);

      // Convert to enhanced format
      const enhancedRoot = DOMTreeAdapter.convertToEnhancedDOMTree({
        rootId: 'root',
        map: domResult.map,
      });

      if (!enhancedRoot) {
        this.logger.warn('Failed to convert DOM result to enhanced format');
        return { html: '', timing: {} };
      }

      // Use the new serializer
      const serializer = new DOMTreeSerializer(
        enhancedRoot,
        undefined, // no previous state
        true, // enable bbox filtering
        0.99 // containment threshold
      );

      const { state, timing } = serializer.serializeAccessibleElements();

      // Serialize to string
      const html = state.root
        ? DOMTreeSerializer.serializeTree(state.root, includeAttributes)
        : '';

      this.logger.debug('Enhanced DOM serialization completed', {
        timing,
        htmlLength: html.length,
        selectorMapSize: Object.keys(state.selectorMap).length,
      });

      return { html, timing };
    } catch (error) {
      this.logger.error(
        'Failed to generate enhanced clickable elements string',
        error as Error
      );
      return { html: '', timing: {} };
    }
  }

  /**
   * Clear the DOM cache
   */
  clearCache(): void {
    this.cache.clear();
    this.logger.debug('DOM cache cleared');
  }

  /**
   * Set cache timeout
   */
  setCacheTimeout(timeout: number): void {
    this.cacheTimeout = timeout;
    this.logger.debug('DOM cache timeout updated', { timeout });
  }
}
