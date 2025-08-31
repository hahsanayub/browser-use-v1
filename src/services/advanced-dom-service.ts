/**
 * Advanced DOM Service - Node.js Implementation
 *
 * This module provides enhanced DOM processing capabilities that improve
 * performance, stability, and accuracy for browser automation.
 *
 * Features:
 * - Cross-origin iframe detection and filtering
 * - XPath query caching system
 * - Ad and tracking element filtering
 * - Performance metrics collection
 * - DOM processing optimization
 */

import type { Page, BrowserContext } from 'playwright';
import { URL } from 'url';
import { getLogger } from './logging';

let logger: ReturnType<typeof getLogger>;

/**
 * Interface for frame information
 */
interface FrameInfo {
  url: string;
  name?: string;
  origin: string;
  isVisible: boolean;
  isAd: boolean;
}

/**
 * Interface for performance metrics
 */
interface DOMPerformanceMetrics {
  nodeMetrics: {
    totalNodes: number;
    processedNodes: number;
    filteredNodes: number;
    interactiveNodes: number;
  };
  timingMetrics: {
    domTreeBuildTime: number;
    xpathCacheHits: number;
    xpathCacheMisses: number;
    adFilteringTime: number;
  };
  memoryMetrics: {
    cacheSize: number;
    avgProcessingTime: number;
  };
}

/**
 * Advanced DOM Service
 */
export class AdvancedDOMService {
  private xpathCache = new Map<Element, string>();
  private performanceMetrics: DOMPerformanceMetrics;
  private adDomainPatterns: RegExp[];
  private context: BrowserContext | null = null;

  // Known ad and tracking domains
  private readonly AD_DOMAINS = [
    'doubleclick.net',
    'adroll.com',
    'googletagmanager.com',
    'googlesyndication.com',
    'amazon-adsystem.com',
    'facebook.com/tr',
    'analytics.google.com',
    'google-analytics.com',
    'hotjar.com',
    'fullstory.com',
    'segment.com',
    'mixpanel.com',
    'intercom.io',
    'zendesk.com',
    'salesforce.com',
    'marketo.com',
  ];

  constructor(context?: BrowserContext) {
    this.context = context || null;
    this.performanceMetrics = this.initializeMetrics();
    this.adDomainPatterns = this.AD_DOMAINS.map(
      (domain) => new RegExp(domain.replace(/\./g, '\\.'), 'i')
    );

    // Initialize logger if not already done
    if (!logger) {
      logger = getLogger();
    }
  }

  /**
   * Get cross-origin iframes with intelligent filtering
   *
   * @param page - The page to analyze
   * @returns Promise<FrameInfo[]> - Array of cross-origin frame information
   */
  async getCrossOriginIframes(page: Page): Promise<FrameInfo[]> {
    const startTime = performance.now();

    try {
      logger.debug('🔍 Starting cross-origin iframe analysis...');

      // Get all frames on the page
      const frames = page.frames();
      const mainOrigin = this.getOriginFromUrl(page.url());

      // Get hidden iframe URLs to filter out ads and trackers
      const hiddenFrameUrls = await this.getHiddenFrameUrls(page);

      const crossOriginFrames: FrameInfo[] = [];

      for (const frame of frames) {
        const frameUrl = frame.url();

        // Skip empty or data URLs
        if (
          !frameUrl ||
          frameUrl.startsWith('data:') ||
          frameUrl === 'about:blank'
        ) {
          continue;
        }

        const frameOrigin = this.getOriginFromUrl(frameUrl);

        // Skip same-origin frames
        if (frameOrigin === mainOrigin) {
          continue;
        }

        // Check if frame is hidden (likely ad or tracker)
        const isHidden = hiddenFrameUrls.includes(frameUrl);

        // Check if frame URL matches ad patterns
        const isAd = this.isAdUrl(frameUrl);

        const frameInfo: FrameInfo = {
          url: frameUrl,
          name: frame.name() || undefined,
          origin: frameOrigin,
          isVisible: !isHidden,
          isAd: isAd,
        };

        // Only include visible, non-ad frames
        if (!isHidden && !isAd) {
          crossOriginFrames.push(frameInfo);
        }

        logger.debug(
          `📱 Frame analyzed: ${frameUrl.slice(0, 50)}... (visible: ${!isHidden}, ad: ${isAd})`
        );
      }

      const processingTime = performance.now() - startTime;
      this.performanceMetrics.timingMetrics.adFilteringTime += processingTime;

      logger.info(
        `✅ Cross-origin iframe analysis completed: found ${crossOriginFrames.length} valid frames (${processingTime.toFixed(2)}ms)`
      );

      return crossOriginFrames;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(
        `❌ Failed to analyze cross-origin iframes: ${errorMessage}`
      );
      return [];
    }
  }

  /**
   * Get cached XPath for an element or compute and cache it
   *
   * @param element - The DOM element
   * @returns string - XPath string
   */
  getCachedXPath(element: Element): string {
    // Check cache first
    if (this.xpathCache.has(element)) {
      this.performanceMetrics.timingMetrics.xpathCacheHits++;
      return this.xpathCache.get(element)!;
    }

    // Compute XPath if not cached
    const xpath = this.computeXPath(element);
    this.xpathCache.set(element, xpath);
    this.performanceMetrics.timingMetrics.xpathCacheMisses++;
    this.performanceMetrics.memoryMetrics.cacheSize = this.xpathCache.size;

    return xpath;
  }

  /**
   * Filter ad and tracking elements from DOM
   *
   * @param page - The page to process
   * @returns Promise<number> - Number of elements filtered
   */
  async filterAdsAndTrackers(page: Page): Promise<number> {
    const startTime = performance.now();

    try {
      logger.debug('🚫 Starting ad and tracker filtering...');

      const filteredCount = await page.evaluate((adPatterns: string[]) => {
        let filtered = 0;
        const adRegexes = adPatterns.map((pattern) => new RegExp(pattern, 'i'));

        // Find elements with ad-related attributes
        const elements = document.querySelectorAll('*');

        elements.forEach((element) => {
          // Check src, href, and data attributes for ad URLs
          const src = element.getAttribute('src');
          const href = element.getAttribute('href');
          const dataSrc = element.getAttribute('data-src');
          const id = element.getAttribute('id');
          const className = element.getAttribute('class');

          const urlsToCheck = [src, href, dataSrc].filter(Boolean) as string[];

          // Check if any URL matches ad patterns
          const isAdElement = urlsToCheck.some((url) =>
            adRegexes.some((regex) => regex.test(url))
          );

          // Check for common ad class names and IDs
          const hasAdIdentifiers = [id, className].some(
            (attr) =>
              attr &&
              /\b(ad|advertisement|banner|sponsor|promo|popup|modal|overlay|tracking|analytics)\b/i.test(
                attr
              )
          );

          if (isAdElement || hasAdIdentifiers) {
            // Mark element as hidden instead of removing to avoid layout shifts
            (element as HTMLElement).style.display = 'none';
            (element as HTMLElement).style.visibility = 'hidden';
            element.setAttribute('data-filtered-ad', 'true');
            filtered++;
          }
        });

        return filtered;
      }, this.AD_DOMAINS);

      const processingTime = performance.now() - startTime;
      this.performanceMetrics.timingMetrics.adFilteringTime += processingTime;
      this.performanceMetrics.nodeMetrics.filteredNodes += filteredCount;

      logger.info(
        `✅ Ad filtering completed: filtered ${filteredCount} elements (${processingTime.toFixed(2)}ms)`
      );

      return filteredCount;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(`❌ Failed to filter ads and trackers: ${errorMessage}`);
      return 0;
    }
  }

  /**
   * Collect performance metrics from DOM processing
   *
   * @param page - The page being processed
   * @param additionalMetrics - Additional metrics to merge
   * @returns DOMPerformanceMetrics - Current performance metrics
   */
  collectPerformanceMetrics(
    page: Page,
    additionalMetrics?: Partial<DOMPerformanceMetrics>
  ): DOMPerformanceMetrics {
    try {
      // Update cache-related metrics
      this.performanceMetrics.memoryMetrics.cacheSize = this.xpathCache.size;

      // Calculate cache hit ratio
      const totalCacheRequests =
        this.performanceMetrics.timingMetrics.xpathCacheHits +
        this.performanceMetrics.timingMetrics.xpathCacheMisses;

      if (totalCacheRequests > 0) {
        const hitRatio =
          this.performanceMetrics.timingMetrics.xpathCacheHits /
          totalCacheRequests;
        logger.debug(
          `📊 XPath cache hit ratio: ${(hitRatio * 100).toFixed(1)}%`
        );
      }

      // Merge additional metrics if provided
      if (additionalMetrics) {
        this.performanceMetrics = this.mergeMetrics(
          this.performanceMetrics,
          additionalMetrics
        );
      }

      // Log summary in debug mode
      logger.debug('📈 DOM Performance Metrics', {
        totalNodes: this.performanceMetrics.nodeMetrics.totalNodes,
        processedNodes: this.performanceMetrics.nodeMetrics.processedNodes,
        filteredNodes: this.performanceMetrics.nodeMetrics.filteredNodes,
        interactiveNodes: this.performanceMetrics.nodeMetrics.interactiveNodes,
        cacheSize: this.performanceMetrics.memoryMetrics.cacheSize,
        cacheHits: this.performanceMetrics.timingMetrics.xpathCacheHits,
        cacheMisses: this.performanceMetrics.timingMetrics.xpathCacheMisses,
      });

      return { ...this.performanceMetrics };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(`❌ Failed to collect performance metrics: ${errorMessage}`);
      return this.performanceMetrics;
    }
  }

  /**
   * Clear XPath cache to prevent memory leaks
   */
  clearXPathCache(): void {
    const cacheSize = this.xpathCache.size;
    this.xpathCache.clear();
    this.performanceMetrics.memoryMetrics.cacheSize = 0;

    logger.debug(`🧹 XPath cache cleared (was ${cacheSize} entries)`);
  }

  /**
   * Update browser context reference
   * @param context - New browser context
   */
  updateContext(context: BrowserContext): void {
    this.context = context;
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.clearXPathCache();
    this.context = null;
    this.performanceMetrics = this.initializeMetrics();
  }

  // Private helper methods

  /**
   * Initialize performance metrics structure
   */
  private initializeMetrics(): DOMPerformanceMetrics {
    return {
      nodeMetrics: {
        totalNodes: 0,
        processedNodes: 0,
        filteredNodes: 0,
        interactiveNodes: 0,
      },
      timingMetrics: {
        domTreeBuildTime: 0,
        xpathCacheHits: 0,
        xpathCacheMisses: 0,
        adFilteringTime: 0,
      },
      memoryMetrics: {
        cacheSize: 0,
        avgProcessingTime: 0,
      },
    };
  }

  /**
   * Get hidden iframe URLs to filter them out
   */
  private async getHiddenFrameUrls(page: Page): Promise<string[]> {
    try {
      return await page.evaluate(() => {
        const iframes = document.querySelectorAll('iframe');
        const hiddenUrls: string[] = [];

        iframes.forEach((iframe) => {
          const style = window.getComputedStyle(iframe);
          const rect = iframe.getBoundingClientRect();

          // Check if iframe is hidden
          const isHidden =
            style.display === 'none' ||
            style.visibility === 'hidden' ||
            style.opacity === '0' ||
            rect.width === 0 ||
            rect.height === 0;

          if (isHidden && iframe.src) {
            hiddenUrls.push(iframe.src);
          }
        });

        return hiddenUrls;
      });
    } catch (error) {
      logger.debug('Failed to get hidden iframe URLs', {
        error: (error as Error).message,
      });
      return [];
    }
  }

  /**
   * Extract origin from URL
   */
  private getOriginFromUrl(url: string): string {
    try {
      const parsedUrl = new URL(url);
      return parsedUrl.origin;
    } catch {
      return '';
    }
  }

  /**
   * Check if URL matches ad patterns
   */
  private isAdUrl(url: string): boolean {
    return this.adDomainPatterns.some((pattern) => pattern.test(url));
  }

  /**
   * Compute XPath for an element
   */
  private computeXPath(element: Element): string {
    const segments: string[] = [];
    let currentElement: Element | null = element;

    while (currentElement && currentElement.nodeType === Node.ELEMENT_NODE) {
      let segment = currentElement.nodeName.toLowerCase();

      if (currentElement.parentElement) {
        const siblings = Array.from(
          currentElement.parentElement.children
        ).filter((sibling) => sibling.nodeName === currentElement!.nodeName);

        if (siblings.length > 1) {
          const index = siblings.indexOf(currentElement) + 1;
          segment += `[${index}]`;
        }
      }

      segments.unshift(segment);
      currentElement = currentElement.parentElement;
    }

    return '/' + segments.join('/');
  }

  /**
   * Merge performance metrics
   */
  private mergeMetrics(
    base: DOMPerformanceMetrics,
    additional: Partial<DOMPerformanceMetrics>
  ): DOMPerformanceMetrics {
    return {
      nodeMetrics: {
        ...base.nodeMetrics,
        ...additional.nodeMetrics,
      },
      timingMetrics: {
        ...base.timingMetrics,
        ...additional.timingMetrics,
      },
      memoryMetrics: {
        ...base.memoryMetrics,
        ...additional.memoryMetrics,
      },
    };
  }
}

/**
 * Static utility methods for advanced DOM operations
 */
export class AdvancedDOMUtils {
  /**
   * Check if a URL is likely an ad or tracker
   * @param url - URL to check
   * @returns boolean - True if URL appears to be an ad
   */
  static isAdUrl(url: string): boolean {
    const adPatterns = [
      /doubleclick\.net/i,
      /adroll\.com/i,
      /googletagmanager\.com/i,
      /googlesyndication\.com/i,
      /amazon-adsystem\.com/i,
      /facebook\.com\/tr/i,
      /analytics\.google\.com/i,
      /google-analytics\.com/i,
      /hotjar\.com/i,
      /fullstory\.com/i,
      /segment\.com/i,
      /mixpanel\.com/i,
    ];

    return adPatterns.some((pattern) => pattern.test(url));
  }

  /**
   * Check if an element is likely an ad based on its attributes
   * @param element - DOM element to check
   * @returns boolean - True if element appears to be an ad
   */
  static isAdElement(element: Element): boolean {
    const id = element.getAttribute('id');
    const className = element.getAttribute('class');
    const src = element.getAttribute('src');
    const href = element.getAttribute('href');

    // Check for common ad identifiers
    const hasAdIdentifiers = [id, className].some(
      (attr) =>
        attr &&
        /\b(ad|advertisement|banner|sponsor|promo|popup|modal|overlay)\b/i.test(
          attr
        )
    );

    // Check for ad URLs
    const hasAdUrls = [src, href].some(
      (url) => url && AdvancedDOMUtils.isAdUrl(url)
    );

    return hasAdIdentifiers || hasAdUrls;
  }

  /**
   * Get performance-optimized element selector
   * @param element - DOM element
   * @returns string - Optimized selector
   */
  static getOptimizedSelector(element: Element): string {
    // Try ID first (most performant)
    if (element.id) {
      return `#${element.id}`;
    }

    // Try unique class combination
    if (element.className) {
      const classes = element.className.split(' ').filter(Boolean);
      if (classes.length > 0) {
        const classSelector = `.${classes.join('.')}`;
        // Check if this selector is unique in the document
        if (document.querySelectorAll(classSelector).length === 1) {
          return classSelector;
        }
      }
    }

    // Fallback to tag with position
    const tagName = element.tagName.toLowerCase();
    const parent = element.parentElement;

    if (parent) {
      const siblings = Array.from(parent.children).filter(
        (sibling) => sibling.tagName === element.tagName
      );

      if (siblings.length > 1) {
        const index = siblings.indexOf(element) + 1;
        return `${tagName}:nth-of-type(${index})`;
      }
    }

    return tagName;
  }
}

// Export singleton factory function for convenience
export const createAdvancedDOMService = (context?: BrowserContext) => {
  return new AdvancedDOMService(context);
};
