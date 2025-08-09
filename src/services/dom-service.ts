/**
 * DOM Service for analyzing and processing web pages for AI agents
 */

import { Page } from 'playwright';
import { JSDOM } from 'jsdom';
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

      // Get page content and metadata
      const [html, title, viewport, isLoading] = await Promise.all([
        page.content(),
        page.title(),
        page.viewportSize(),
        this.isPageLoading(page),
      ]);

      // Process HTML content
      const processedHTML = await this.processHTML(page, html, options);

      // Extract interactive elements
      const interactiveElements = await this.extractInteractiveElements(
        page,
        options
      );

      const pageView: PageView = {
        html: processedHTML,
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
   * Process HTML content to make it more suitable for LLM consumption
   */
  private async processHTML(
    page: Page,
    html: string,
    options: DOMProcessingOptions
  ): Promise<string> {
    const defaultOptions: DOMProcessingOptions = {
      removeScripts: true,
      removeStyles: true,
      removeComments: true,
      markInteractive: true,
      maxTextLength: 200,
      includeHidden: false,
      ...options,
    };

    try {
      // Create JSDOM instance
      const dom = new JSDOM(html);
      const document = dom.window.document;

      // Remove unwanted elements
      if (defaultOptions.removeScripts) {
        this.removeElements(document, 'script');
      }

      if (defaultOptions.removeStyles) {
        this.removeElements(document, 'style');
        this.removeElements(document, 'link[rel="stylesheet"]');
      }

      if (defaultOptions.removeComments) {
        this.removeComments(document);
      }

      // Remove hidden elements if not including them
      if (!defaultOptions.includeHidden) {
        await this.removeHiddenElements(page, document);
      }

      // Mark interactive elements
      if (defaultOptions.markInteractive) {
        await this.markInteractiveElements(page, document);
      }

      // Simplify and clean up content
      this.simplifyContent(document, defaultOptions);

      return document.documentElement.outerHTML;
    } catch (error) {
      this.logger.warn('Failed to process HTML, returning original', {
        error: (error as Error).message,
      });
      return html;
    }
  }

  /**
   * Extract interactive elements from the page
   */
  private async extractInteractiveElements(
    page: Page,
    options: DOMProcessingOptions
  ): Promise<InteractiveElement[]> {
    try {
      const elements = await page.$$eval(
        'button, a, input, textarea, select, [role="button"], [onclick], [tabindex]',
        (elements) => {
          return elements
            .map((element, index) => {
              const rect = element.getBoundingClientRect();
              const isVisible =
                rect.width > 0 &&
                rect.height > 0 &&
                window.getComputedStyle(element).visibility !== 'hidden' &&
                window.getComputedStyle(element).display !== 'none';

              if (!isVisible) return null;

              // Generate unique selector
              const selector = this.generateSelector(element);

              return {
                id: `interactive_${index}`,
                tagName: element.tagName.toLowerCase(),
                type:
                  element.getAttribute('type') || element.tagName.toLowerCase(),
                text: element.textContent?.trim().substring(0, 100) || '',
                attributes: Array.from(element.attributes).reduce(
                  (acc, attr) => {
                    acc[attr.name] = attr.value;
                    return acc;
                  },
                  {} as Record<string, string>
                ),
                selector,
                boundingBox: {
                  x: Math.round(rect.x),
                  y: Math.round(rect.y),
                  width: Math.round(rect.width),
                  height: Math.round(rect.height),
                },
              };
            })
            .filter(Boolean);
        }
      );

      return elements.filter(
        (el): el is NonNullable<typeof el> => el !== null
      ) as InteractiveElement[];
    } catch (error) {
      this.logger.warn('Failed to extract interactive elements', {
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
      return `#${CSS.escape(element.id)}`;
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
