/**
 * DOM Service for analyzing and processing web pages for AI agents
 */

import { Page } from 'playwright';
import { promises as fs } from 'fs';
import { resolve as pathResolve } from 'path';
import type {
  PageView,
  InteractiveElement,
  DOMProcessingOptions,
} from '../types/dom';
import { getLogger } from './logging';

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
   * Get a processed view of the current page
   */
  async getPageView(
    page: Page,
    options: DOMProcessingOptions = {}
  ): Promise<PageView> {
    const url = page.url();
    const cacheKey = `${url}_${JSON.stringify(options)}`;

    // Check cache first
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
      this.logger.debug('Returning cached page view', { url });
      return cached.view;
    }

    try {
      this.logger.debug('Processing page view', { url });

      // Use injected buildDomTree.js to get structured DOM state and interactive elements
      const [title, viewport, isLoading, domHtml, interactiveElements] =
        await Promise.all([
          page.title(),
          page.viewportSize(),
          this.isPageLoading(page),
          this.buildAndSerializeDom(page, options),
          this.extractInteractiveElementsFromBuild(page, options),
        ]);

      const pageView: PageView = {
        html: domHtml,
        interactiveElements,
        url,
        title,
        isLoading,
        viewport: viewport || { width: 1280, height: 720 },
        timestamp: Date.now(),
      };

      // Cache the result
      this.cache.set(cacheKey, { view: pageView, timestamp: Date.now() });

      this.logger.debug('Page view processed successfully', {
        url,
        interactiveElementsCount: interactiveElements.length,
      });

      return pageView;
    } catch (error) {
      this.logger.error('Failed to process page view', error as Error, { url });
      throw error;
    }
  }

  /**
   * Compute a compact signature for current DOM state to detect changes
   */
  async getDomSignature(page: Page, options: DOMProcessingOptions = {}): Promise<string> {
    try {
      const dom = await this.buildAndSerializeDom(page, options);
      return DOMService.computeStringHash(dom);
    } catch (error) {
      this.logger.debug('Failed to compute DOM signature', { error: (error as Error).message });
      return '';
    }
  }

  /**
   * Process HTML content to make it more suitable for LLM consumption
   */
  // Build DOM in browser context using provided buildDomTree.js and return compact HTML representation
  private async buildAndSerializeDom(page: Page, options: DOMProcessingOptions): Promise<string> {
    if (!this.buildDomTreeScript) {
      const scriptPath = pathResolve(process.cwd(), 'src/dom/buildDomTree.js');
      this.buildDomTreeScript = await fs.readFile(scriptPath, 'utf-8');
    }
    const result: any = await page
      .evaluate(
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore - dynamic function body for browser context
        (payload: { script: string; args: any }) => {
          // eslint-disable-next-line no-new-func
          const fn = new Function('args', `return (${payload.script})(args);`);
          return fn(payload.args);
        },
        { script: this.buildDomTreeScript, args: { doHighlightElements: false, viewportExpansion: 0, debugMode: false, ...options } }
      )
      .catch(async () => {
      // Fallback evaluate path to avoid double wrapping
        const domState: any = await page.evaluate(
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          (payload: { script: string; args: any }) => {
            // eslint-disable-next-line no-new-func
            const fn = new Function('args', `return (${payload.script})(args);`);
            return fn(payload.args);
          },
          { script: this.buildDomTreeScript!, args: { doHighlightElements: false, viewportExpansion: 0, debugMode: false, ...options } }
        );
        return domState;
      });

    // If above wrapper succeeded, it returned { result }, reconstruct minimal html
    try {
      // Best-effort: stringify dom state structure
      return JSON.stringify(result);
    } catch {
      return '';
    }
  }

  /**
   * Extract interactive elements from the page
   */
  private async extractInteractiveElementsFromBuild(
    page: Page,
    _options: DOMProcessingOptions
  ): Promise<InteractiveElement[]> {
    if (!this.buildDomTreeScript) {
      const scriptPath = pathResolve(process.cwd(), 'src/dom/buildDomTree.js');
      this.buildDomTreeScript = await fs.readFile(scriptPath, 'utf-8');
    }
    try {
      const domState: any = await page.evaluate(
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        (payload: { script: string; args: any }) => {
          // eslint-disable-next-line no-new-func
          const fn = new Function('args', `return (${payload.script})(args);`);
          return fn(payload.args);
        },
        { script: this.buildDomTreeScript!, args: { doHighlightElements: false, viewportExpansion: 0, debugMode: false } }
      );

      // Walk domState.map to gather interactive nodes with highlightIndex or attributes heuristics
      const elements: InteractiveElement[] = [];
      const map: Record<string, any> = domState?.map || {};
      for (const id of Object.keys(map)) {
        const node = map[id];
        if (!node || typeof node !== 'object') continue;
        if (!node.isInteractive) continue;
        const selector = node.xpath ? `xpath=/${node.xpath}` : node.tagName;
        elements.push({
          id,
          tagName: node.tagName || 'node',
          type: node.tagName || 'node',
          text: undefined,
          attributes: (node.attributes as Record<string, string>) || {},
          selector,
        });
      }
      return elements;
    } catch (error) {
      this.logger.warn('Failed to build interactive elements from script', {
        error: (error as Error).message,
      });
      return [];
    }
  }

  /**
   * Check if page is still loading
   */
  private async isPageLoading(page: Page): Promise<boolean> {
    try {
      const loadState = await page.evaluate(() => document.readyState);
      return loadState !== 'complete';
    } catch (error) {
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
      const esc = (globalThis as any).CSS?.escape || ((s: string) => s.replace(/([#.:\[\],>+~ ])/g, '\\$1'));
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
