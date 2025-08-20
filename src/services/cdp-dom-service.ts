/**
 * CDP-based DOM Service for high-performance DOM state capture
 */
import { Page } from 'playwright';
import type { CDPSession } from 'playwright';
import { getLogger } from './logging';
import type {
  DOMProcessingOptions,
  DOMState,
  SelectorMap,
  DOMResult,
} from '../types/dom';

// Essential computed styles for interactivity and visibility detection
const REQUIRED_COMPUTED_STYLES = [
  // Essential for visibility
  'display',
  'visibility',
  'opacity',
  'position',
  'z-index',
  'pointer-events',
  'cursor',
  'overflow',
  'overflow-x',
  'overflow-y',
  'width',
  'height',
  'top',
  'left',
  'right',
  'bottom',
  'transform',
  'clip',
  'clip-path',
  'user-select',
  'background-color',
  'color',
  'border',
  'margin',
  'padding',
];

interface CDPDOMSnapshot {
  documents: Array<{
    nodes: {
      nodeType: number[];
      nodeName: string[];
      nodeValue: string[];
      backendNodeId: number[];
      attributes: Array<string[]>;
      parentIndex?: number[];
      isClickable?: {
        index: number[];
      };
    };
    layout: {
      nodeIndex: number[];
      bounds: number[][];
      styles: number[][];
      paintOrders?: number[];
      clientRects?: number[][];
      scrollRects?: number[][];
    };
  }>;
  strings: string[];
}

interface EnhancedDOMNode {
  backendNodeId: number;
  tagName: string;
  xpath: string;
  attributes: Record<string, string>;
  isVisible: boolean;
  isInteractive: boolean;
  isTopElement: boolean;
  isInViewport: boolean;
  highlightIndex?: number;
  bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  computedStyles?: Record<string, string>;
  isClickable?: boolean;
  cursorStyle?: string;
  // Scroll-related properties
  isScrollable?: boolean;
  isActuallyScrollable?: boolean;
  shouldShowScrollInfo?: boolean;
  scrollInfo?: {
    scrollRects?: number[];
    clientRects?: number[];
    scrollHeight?: number;
    scrollWidth?: number;
    clientHeight?: number;
    clientWidth?: number;
    scrollTop?: number;
    scrollLeft?: number;
  };
}

/**
 * High-performance CDP-based DOM Service
 */
export class CDPDOMService {
  private logger = getLogger();
  private cache: Map<string, { domState: DOMState; timestamp: number }> =
    new Map();
  private cacheTimeout: number = 3000; // 3 seconds cache timeout
  private lastSignature: string = '';
  private lastDomState: DOMState | null = null;

  constructor() {}

  /**
   * Compute a compact signature for current DOM state using CDP
   */
  async getDomSignature(
    page: Page,
    options: DOMProcessingOptions = {}
  ): Promise<string> {
    try {
      const startTime = performance.now();

      // Use cached signature if DOM hasn't changed significantly
      const currentUrl = page.url();
      const cacheKey = `${currentUrl}_signature`;
      const cached = this.cache.get(cacheKey);

      if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
        this.logger.debug('Using cached DOM signature', { url: currentUrl });
        return this.lastSignature;
      }

      // Get lightweight snapshot for signature generation
      const cdp = await page.context().newCDPSession(page);

      try {
        // Lightweight snapshot - only essential data for signature
        const snapshot = await cdp.send('DOMSnapshot.captureSnapshot', {
          computedStyles: ['display', 'visibility', 'opacity'], // Minimal styles for signature
          includePaintOrder: false,
          includeDOMRects: false,
          includeBlendedBackgroundColors: false,
          includeTextColorOpacities: false,
        });

        // Generate simple signature from node structure and essential styles
        const signatureData = {
          nodeCount:
            snapshot.documents?.reduce(
              (sum, doc) => sum + (doc.nodes?.nodeName?.length || 0),
              0
            ) || 0,
          styles: snapshot.strings?.slice(0, 50), // First 50 strings for signature
          url: currentUrl,
        };

        const signature = this.computeStringHash(JSON.stringify(signatureData));
        this.lastSignature = signature;

        // Cache the signature
        this.cache.set(cacheKey, {
          domState: this.lastDomState || {
            elementTree: undefined,
            map: {},
            selectorMap: {},
          },
          timestamp: Date.now(),
        });

        const endTime = performance.now();
        this.logger.debug('CDP DOM signature computed', {
          duration: `${(endTime - startTime).toFixed(2)}ms`,
          nodeCount: signatureData.nodeCount,
        });

        return signature;
      } finally {
        await cdp.detach();
      }
    } catch (error) {
      this.logger.warn('Failed to compute CDP DOM signature, falling back', {
        error: (error as Error).message,
      });
      // Fallback to simple URL-based signature
      return this.computeStringHash(page.url() + Date.now());
    }
  }

  /**
   * Build DOM state using CDP DOMSnapshot for high performance
   */
  async buildDomState(
    page: Page,
    options: DOMProcessingOptions = {}
  ): Promise<DOMState> {
    const startTime = performance.now();

    try {
      // Check cache first
      const currentUrl = page.url();
      const cacheKey = `${currentUrl}_${JSON.stringify(options)}`;
      const cached = this.cache.get(cacheKey);

      if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
        this.logger.debug('Using cached DOM state', { url: currentUrl });
        return cached.domState;
      }

      const cdp = await page.context().newCDPSession(page);

      try {
        // Get comprehensive DOM snapshot with all required data
        const [snapshot, document, viewportMetrics] = await Promise.all([
          cdp.send('DOMSnapshot.captureSnapshot', {
            computedStyles: REQUIRED_COMPUTED_STYLES,
            includePaintOrder: true,
            includeDOMRects: true,
            includeBlendedBackgroundColors: false,
            includeTextColorOpacities: false,
          }),
          cdp.send('DOM.getDocument', { depth: -1, pierce: true }),
          cdp.send('Page.getLayoutMetrics'),
        ]);

        // Process the snapshot data
        const domState = await this.processSnapshotToDOMState(
          snapshot as any, // Type assertion to handle CDP interface variations
          document,
          viewportMetrics,
          options
        );

        // Cache the result
        this.cache.set(cacheKey, { domState, timestamp: Date.now() });
        this.lastDomState = domState;

        const endTime = performance.now();
        this.logger.debug('CDP DOM state built successfully', {
          duration: `${(endTime - startTime).toFixed(2)}ms`,
          elementsCount: Object.keys(domState.selectorMap).length,
        });

        return domState;
      } finally {
        await cdp.detach();
      }
    } catch (error) {
      this.logger.error(
        'CDP DOM state building failed, falling back to JavaScript approach',
        error as Error
      );

      // Fallback to the original buildDomTree.js approach if CDP fails
      return this.fallbackToBuildDomTree(page, options);
    }
  }

  /**
   * Process CDP snapshot data into DOMState format
   */
  private async processSnapshotToDOMState(
    snapshot: any, // Use any to handle CDP interface variations
    document: any,
    viewportMetrics: any,
    options: DOMProcessingOptions
  ): Promise<DOMState> {
    const startTime = performance.now();

    if (!snapshot.documents || snapshot.documents.length === 0) {
      return { elementTree: undefined, map: {}, selectorMap: {} };
    }

    const enhancedNodes = new Map<number, EnhancedDOMNode>();
    const selectorMap: Record<string, string> = {};
    let highlightIndex = 0;

    // Get viewport info for visibility calculations
    const viewport = viewportMetrics.visualViewport || {};
    const viewportWidth = viewport.clientWidth || 1920;
    const viewportHeight = viewport.clientHeight || 1080;

    // Process each document in the snapshot
    for (const doc of snapshot.documents) {
      const { nodes, layout } = doc;

      if (!nodes.nodeName || !layout.nodeIndex) continue;

      // Build layout lookup
      const layoutLookup = new Map<
        number,
        {
          bounds?: number[];
          styles?: number[];
          paintOrder?: number;
          scrollRects?: number[];
          clientRects?: number[];
        }
      >();

      for (let i = 0; i < layout.nodeIndex.length; i++) {
        const nodeIndex = layout.nodeIndex[i];
        layoutLookup.set(nodeIndex, {
          bounds: layout.bounds?.[i],
          styles: layout.styles?.[i],
          paintOrder: layout.paintOrders?.[i],
          scrollRects: layout.scrollRects?.[i],
          clientRects: layout.clientRects?.[i],
        });
      }

      // Process each node
      for (let nodeIndex = 0; nodeIndex < nodes.nodeName.length; nodeIndex++) {
        const backendNodeId = nodes.backendNodeId?.[nodeIndex];
        if (!backendNodeId) continue;

        const nodeType = nodes.nodeType[nodeIndex];
        const nodeName = nodes.nodeName[nodeIndex];

        // Only process element nodes
        if (nodeType !== 1) continue; // Node.ELEMENT_NODE

        const tagName = nodeName.toLowerCase();

        // Build attributes
        const attributes: Record<string, string> = {};
        const nodeAttrs = nodes.attributes?.[nodeIndex] || [];
        for (let i = 0; i < nodeAttrs.length; i += 2) {
          if (nodeAttrs[i] && nodeAttrs[i + 1] !== undefined) {
            attributes[nodeAttrs[i]] = nodeAttrs[i + 1];
          }
        }

        // Get layout data
        const layoutData = layoutLookup.get(nodeIndex);
        const bounds = layoutData?.bounds;

        let computedStyles: Record<string, string> = {};
        if (layoutData?.styles) {
          for (
            let i = 0;
            i <
            Math.min(layoutData.styles.length, REQUIRED_COMPUTED_STYLES.length);
            i++
          ) {
            const styleIndex = layoutData.styles[i];
            if (styleIndex >= 0 && styleIndex < snapshot.strings.length) {
              computedStyles[REQUIRED_COMPUTED_STYLES[i]] =
                snapshot.strings[styleIndex];
            }
          }
        }

        // Calculate visibility and interactivity
        const isVisible = this.isElementVisible(
          bounds,
          computedStyles,
          viewportWidth,
          viewportHeight
        );
        const isClickable =
          nodes.isClickable?.index.includes(nodeIndex) || false;
        const isInteractive = this.isElementInteractive(
          tagName,
          attributes,
          computedStyles,
          isClickable
        );
        // Calculate scroll properties
        const scrollRects = layoutData?.scrollRects;
        const clientRects = layoutData?.clientRects;
        const isScrollable =
          scrollRects &&
          clientRects &&
          (scrollRects[3] > clientRects[3] || scrollRects[2] > clientRects[2]); // Basic scroll detection
        const isActuallyScrollable = this.calculateIsScrollable(
          scrollRects,
          clientRects,
          computedStyles
        );
        const shouldShowScrollInfo = this.calculateShouldShowScrollInfo(
          tagName,
          isScrollable || false,
          isActuallyScrollable
        );

        // Generate XPath
        const xpath = this.generateXPath(nodeIndex, nodes, nodeIndex);

        const enhancedNode: EnhancedDOMNode = {
          backendNodeId,
          tagName,
          xpath,
          attributes,
          isVisible,
          isInteractive,
          isTopElement: isVisible, // Simplified for now
          isInViewport: this.isInViewport(
            bounds,
            viewportWidth,
            viewportHeight,
            options.viewportExpansion
          ),
          bounds: bounds
            ? {
                x: bounds[0],
                y: bounds[1],
                width: bounds[2],
                height: bounds[3],
              }
            : undefined,
          computedStyles,
          isClickable,
          cursorStyle: computedStyles.cursor,
          // Scroll properties
          isScrollable: isScrollable || false,
          isActuallyScrollable,
          shouldShowScrollInfo,
          scrollInfo:
            scrollRects && clientRects
              ? {
                  scrollRects,
                  clientRects,
                  scrollHeight: scrollRects[3],
                  scrollWidth: scrollRects[2],
                  clientHeight: clientRects[3],
                  clientWidth: clientRects[2],
                  scrollTop: 0, // CDP doesn't provide current scroll position
                  scrollLeft: 0, // CDP doesn't provide current scroll position
                }
              : undefined,
        };

        // Assign highlight index for interactive and visible elements, OR scrollable elements
        // where scrollable elements need indices for scroll actions
        if (
          (isInteractive || shouldShowScrollInfo) &&
          isVisible &&
          (enhancedNode.isInViewport || options.viewportExpansion === -1)
        ) {
          enhancedNode.highlightIndex = highlightIndex;
          selectorMap[highlightIndex.toString()] = `xpath=/${xpath}`;
          highlightIndex++;
        }

        enhancedNodes.set(backendNodeId, enhancedNode);
      }
    }

    // Build the map structure for backward compatibility
    const map: Record<string, any> = {};
    for (const [backendNodeId, node] of enhancedNodes) {
      map[backendNodeId.toString()] = {
        tagName: node.tagName,
        xpath: node.xpath,
        attributes: node.attributes,
        isVisible: node.isVisible,
        isInteractive: node.isInteractive,
        isTopElement: node.isTopElement,
        isInViewport: node.isInViewport,
        highlightIndex: node.highlightIndex,
        bounds: node.bounds,
        // Include scroll properties for compatibility with existing adapters
        isScrollable: node.isScrollable,
        isActuallyScrollable: node.isActuallyScrollable,
        shouldShowScrollInfo: node.shouldShowScrollInfo,
        scrollInfo: node.scrollInfo,
      };
    }

    const endTime = performance.now();
    this.logger.debug('CDP snapshot processed', {
      duration: `${(endTime - startTime).toFixed(2)}ms`,
      processedNodes: enhancedNodes.size,
      interactiveElements: highlightIndex,
    });

    return {
      elementTree: undefined, // Not needed for current implementation
      map,
      selectorMap,
    };
  }

  /**
   * Check if element is visible based on bounds and computed styles
   */
  private isElementVisible(
    bounds: number[] | undefined,
    computedStyles: Record<string, string>,
    viewportWidth: number,
    viewportHeight: number
  ): boolean {
    // Check computed styles for visibility
    const display = computedStyles.display?.toLowerCase();
    const visibility = computedStyles.visibility?.toLowerCase();
    const opacity = parseFloat(computedStyles.opacity || '1');

    if (display === 'none' || visibility === 'hidden' || opacity <= 0) {
      return false;
    }

    // Check bounds
    if (!bounds || bounds.length < 4) {
      return false;
    }

    const [x, y, width, height] = bounds;
    return width > 0 && height > 0;
  }

  /**
   * Check if element is interactive
   */
  private isElementInteractive(
    tagName: string,
    attributes: Record<string, string>,
    computedStyles: Record<string, string>,
    isClickable: boolean
  ): boolean {
    // If CDP says it's clickable, trust it
    if (isClickable) return true;

    // Check interactive tag names
    const interactiveTags = new Set([
      'a',
      'button',
      'input',
      'select',
      'textarea',
      'details',
      'summary',
      'label',
    ]);

    if (interactiveTags.has(tagName)) {
      // Check if not disabled
      return !attributes.disabled && !attributes.readonly;
    }

    // Check for interactive roles or attributes
    const role = attributes.role;
    const interactiveRoles = new Set([
      'button',
      'link',
      'menuitem',
      'tab',
      'switch',
      'checkbox',
      'radio',
    ]);

    if (role && interactiveRoles.has(role)) return true;

    // Check for contenteditable
    if (attributes.contenteditable === 'true') return true;

    // Check for onclick or other event handlers
    if (attributes.onclick || attributes.onmousedown) return true;

    // Check cursor style
    const cursor = computedStyles.cursor;
    const interactiveCursors = new Set(['pointer', 'grab', 'grabbing']);
    if (cursor && interactiveCursors.has(cursor)) return true;

    return false;
  }

  /**
   * Check if element is in viewport
   */
  private isInViewport(
    bounds: number[] | undefined,
    viewportWidth: number,
    viewportHeight: number,
    viewportExpansion: number = 0
  ): boolean {
    if (viewportExpansion === -1) return true;

    if (!bounds || bounds.length < 4) return false;

    const [x, y, width, height] = bounds;

    return !(
      x + width < -viewportExpansion ||
      x > viewportWidth + viewportExpansion ||
      y + height < -viewportExpansion ||
      y > viewportHeight + viewportExpansion
    );
  }

  /**
   * Generate XPath for a node (simplified version)
   */
  private generateXPath(
    nodeIndex: number,
    nodes: any,
    currentIndex: number,
    path: string[] = []
  ): string {
    const tagName = nodes.nodeName[currentIndex].toLowerCase();
    const parentIndex = nodes.parentIndex?.[currentIndex];

    // Add current element to path
    path.unshift(tagName);

    // If we have a parent, recurse
    if (parentIndex !== undefined && parentIndex >= 0) {
      return this.generateXPath(nodeIndex, nodes, parentIndex, path);
    }

    // Return the path
    return path.join('/');
  }

  /**
   * Fallback to the original JavaScript-based approach
   */
  private async fallbackToBuildDomTree(
    page: Page,
    options: DOMProcessingOptions
  ): Promise<DOMState> {
    this.logger.warn('Using fallback JavaScript DOM processing');

    // Import the original DOM service as fallback
    const { DOMService } = await import('./dom-service');
    const fallbackService = new DOMService();

    // Use reflection to access the private buildDomState method
    return (fallbackService as any).buildDomState(page, options);
  }

  /**
   * Simple string hash function
   */
  private computeStringHash(input: string): string {
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      hash = (hash << 5) - hash + input.charCodeAt(i);
      hash |= 0;
    }
    return (hash >>> 0).toString(16);
  }

  /**
   * Clear the cache
   */
  clearCache(): void {
    this.cache.clear();
    this.lastSignature = '';
    this.lastDomState = null;
    this.logger.debug('CDP DOM cache cleared');
  }

  /**
   * Set cache timeout
   */
  setCacheTimeout(timeout: number): void {
    this.cacheTimeout = timeout;
    this.logger.debug('CDP DOM cache timeout updated', { timeout });
  }

  /**
   * Calculate if element is scrollable based on scroll/client rects and CSS
   */
  private calculateIsScrollable(
    scrollRects: number[] | undefined,
    clientRects: number[] | undefined,
    computedStyles: Record<string, string>
  ): boolean {
    if (
      !scrollRects ||
      !clientRects ||
      scrollRects.length < 4 ||
      clientRects.length < 4
    ) {
      return false;
    }

    // Check if content is larger than visible area
    // scrollRects format: [x, y, width, height]
    // clientRects format: [x, y, width, height]
    const hasVerticalScroll = scrollRects[3] > clientRects[3] + 1; // height (+1 for rounding)
    const hasHorizontalScroll = scrollRects[2] > clientRects[2] + 1; // width (+1 for rounding)

    if (!hasVerticalScroll && !hasHorizontalScroll) {
      return false;
    }

    // Check CSS overflow properties
    const overflow = computedStyles.overflow?.toLowerCase() || 'visible';
    const overflowX = computedStyles['overflow-x']?.toLowerCase() || overflow;
    const overflowY = computedStyles['overflow-y']?.toLowerCase() || overflow;

    // Only allow scrolling if overflow is explicitly set to auto, scroll, or overlay
    const allowsScroll =
      ['auto', 'scroll', 'overlay'].includes(overflow) ||
      ['auto', 'scroll', 'overlay'].includes(overflowX) ||
      ['auto', 'scroll', 'overlay'].includes(overflowY);

    return allowsScroll;
  }

  /**
   * Calculate if element should show scroll info
   */
  private calculateShouldShowScrollInfo(
    tagName: string,
    isScrollable: boolean,
    isActuallyScrollable: boolean
  ): boolean {
    // Special case for iframes (always show scroll info)
    if (tagName.toLowerCase() === 'iframe') {
      return true;
    }

    // Must be scrollable first for non-iframe elements
    if (!isScrollable && !isActuallyScrollable) {
      return false;
    }

    // Always show for body/html elements
    if (['body', 'html'].includes(tagName.toLowerCase())) {
      return true;
    }

    // TODO: Check parent scrollability to avoid nested scroll spam
    // For now, show scroll info for all scrollable elements
    return true;
  }

  /**
   * Generate scroll info text similar
   */
  private generateScrollInfoText(
    scrollRects: number[] | undefined,
    clientRects: number[] | undefined,
    tagName: string
  ): string {
    if (
      !scrollRects ||
      !clientRects ||
      scrollRects.length < 4 ||
      clientRects.length < 4
    ) {
      return tagName.toLowerCase() === 'iframe' ? 'scroll' : '';
    }

    const scrollHeight = scrollRects[3];
    const clientHeight = clientRects[3];
    const scrollableHeight = scrollHeight - clientHeight;

    if (scrollableHeight <= 0) {
      return '';
    }

    // Calculate pages above/below (assuming current scroll position is 0 for CDP data)
    const scrollTop = 0; // CDP doesn't provide current scroll position
    const pagesAbove = scrollTop / clientHeight;
    const pagesBelow = (scrollableHeight - scrollTop) / clientHeight;
    const scrollPercentage =
      scrollableHeight > 0
        ? Math.round((scrollTop / scrollableHeight) * 100)
        : 0;

    return `scroll: ${pagesAbove.toFixed(1)}↑ ${pagesBelow.toFixed(1)}↓ ${scrollPercentage}%`;
  }
}
