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
  DOMState,
  DOMBaseNode,
  DOMTextNode,
  DOMElementNode,
  ViewportInfo,
  SelectorMap,
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
    options: DOMProcessingOptions = {},
    forceRefresh: boolean = false
  ): Promise<PageView> {
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
      const [title, viewport, isLoading, domResult, interactiveElements] =
        await Promise.all([
          page.title(),
          page.viewportSize(),
          this.isPageLoading(page),
          this.buildDomState(page, options),
          this.extractInteractiveElementsFromBuild(page),
        ]);

      const pageView: PageView = {
        html: this.serializeDOMState(domResult),
        interactiveElements,
        url,
        title,
        isLoading,
        viewport: viewport || { width: 1280, height: 720 },
        timestamp: Date.now(),
        domState: domResult,
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
  async getDomSignature(
    page: Page,
    options: DOMProcessingOptions = {}
  ): Promise<string> {
    try {
      const dom = await this.buildDomState(page, options);
      const serializedDom = this.serializeDOMState(dom);
      return DOMService.computeStringHash(serializedDom);
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
    let result: any;
    try {
      result = await page.evaluate(
        (payload: { script: string; args: any }) =>
          new Function(`return ${payload.script}`)()(payload.args),
        {
          script: this.buildDomTreeScript,
          args: {
            doHighlightElements: false,
            // Expand viewport to include all to ensure highlightIndex stability
            viewportExpansion: -1,
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
              doHighlightElements: false,
              viewportExpansion: -1,
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
   * Extract interactive elements from the page
   */
  private async extractInteractiveElementsFromBuild(
    page: Page
  ): Promise<InteractiveElement[]> {
    if (!this.buildDomTreeScript) {
      const scriptPath = pathResolve(process.cwd(), 'src/dom/buildDomTree.js');
      try {
        this.buildDomTreeScript = await fs.readFile(scriptPath, 'utf-8');
      } catch {
        // Fallback to a lightweight query when script missing
        const elements = await page.$$eval(
          'a, button, input, textarea, select, [role="button"]',
          (els) =>
            els.map((el, i) => ({
              id: `interactive_${i}`,
              tagName: el.tagName.toLowerCase(),
              type: el.getAttribute('type') || el.tagName.toLowerCase(),
              attributes: Array.from(el.attributes).reduce(
                (acc, a) => {
                  acc[a.name] = a.value;
                  return acc;
                },
                {} as Record<string, string>
              ),
              selector: el.id ? `#${el.id}` : el.tagName.toLowerCase(),
            }))
        );
        return elements as unknown as InteractiveElement[];
      }
    }
    try {
      const domState: any = await page.evaluate(
        (payload: { script: string; args: any }) =>
          new Function(`return ${payload.script}`)()(payload.args),
        {
          script: this.buildDomTreeScript!,
          args: {
            doHighlightElements: false,
            viewportExpansion: -1,
            debugMode: false,
          },
        }
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
    } catch (e) {
      // Fallback to basic querySelectorAll extraction when script execution is blocked by CSP
      this.logger.warn('Failed to build interactive elements from script', {
        error: (e as Error).message,
      });
      const elements = await page.$$eval(
        'a, button, input, textarea, select, [role="button"]',
        (els) =>
          els.map((el, i) => ({
            id: `interactive_${i}`,
            tagName: el.tagName.toLowerCase(),
            type: el.getAttribute('type') || el.tagName.toLowerCase(),
            attributes: Array.from(el.attributes).reduce(
              (acc, a) => {
                acc[a.name] = a.value;
                return acc;
              },
              {} as Record<string, string>
            ),
            selector: el.id ? `#${el.id}` : el.tagName.toLowerCase(),
          }))
      );
      return elements as unknown as InteractiveElement[];
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
   * Parse a node from JavaScript evaluation result, equivalent to Python _parse_node
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
        width: nodeData.viewport.width,
        height: nodeData.viewport.height,
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
   * Construct DOM tree from JavaScript evaluation result, equivalent to Python _construct_dom_tree
   */
  private constructDomTree(evalPage: any): {
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
