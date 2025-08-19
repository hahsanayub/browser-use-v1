/**
 * Smart DOM Cache with signature-based optimization
 * Reduces unnecessary DOM state rebuilding by implementing intelligent caching
 */

import { getLogger } from './logging';
import type { DOMProcessingOptions, DOMState } from '../types/dom';
import { CDPDOMService } from './cdp-dom-service';
import { DOMService } from './dom-service';
import { Page } from 'playwright';

interface CacheEntry {
  signature: string;
  domState: DOMState;
  timestamp: number;
  hitCount: number;
}

interface DOMChangeEvent {
  timestamp: number;
  reason: 'navigation' | 'action' | 'mutation' | 'timeout';
  signature: string;
}

/**
 * Smart DOM Cache that manages DOM state efficiently
 */
export class SmartDOMCache {
  private logger = getLogger();
  private cdpService: CDPDOMService;
  private fallbackService: DOMService;
  private cache = new Map<string, CacheEntry>();
  private signatureHistory: DOMChangeEvent[] = [];
  private lastKnownSignature: string = '';
  private cacheTimeout: number = 5000; // 5 seconds
  private maxCacheSize: number = 10;
  private isMonitoring: boolean = false;

  // Performance tracking
  private stats = {
    cacheHits: 0,
    cacheMisses: 0,
    cdpFallbacks: 0,
    totalRequests: 0,
    avgProcessingTime: 0,
  };

  constructor() {
    this.cdpService = new CDPDOMService();
    this.fallbackService = new DOMService();
  }

  /**
   * Get DOM signature with smart caching
   */
  async getDomSignature(page: Page, options: DOMProcessingOptions = {}): Promise<string> {
    const startTime = performance.now();
    this.stats.totalRequests++;

    try {
      // Use CDP service for fast signature computation
      const signature = await this.cdpService.getDomSignature(page, options);

      // Track signature changes
      if (signature !== this.lastKnownSignature) {
        this.recordSignatureChange(signature, 'mutation');
        this.lastKnownSignature = signature;
      }

      const endTime = performance.now();
      this.updatePerformanceStats(endTime - startTime);

      return signature;
    } catch (error) {
      this.logger.warn('CDP signature failed, using fallback', {
        error: (error as Error).message
      });

      // Fallback to original method
      const signature = await this.fallbackService.getDomSignature(page, options);

      if (signature !== this.lastKnownSignature) {
        this.recordSignatureChange(signature, 'mutation');
        this.lastKnownSignature = signature;
      }

      const endTime = performance.now();
      this.updatePerformanceStats(endTime - startTime);

      return signature;
    }
  }

  /**
   * Get DOM state with intelligent caching and optimizations
   */
  async getDomState(page: Page, options: DOMProcessingOptions = {}): Promise<DOMState> {
    const startTime = performance.now();
    const cacheKey = this.generateCacheKey(page.url(), options);

    // Check cache first
    const cached = this.cache.get(cacheKey);
    if (cached && this.isCacheValid(cached)) {
      this.stats.cacheHits++;
      cached.hitCount++;

      this.logger.debug('Using cached DOM state', {
        url: page.url(),
        hitCount: cached.hitCount,
        age: Date.now() - cached.timestamp,
      });

      return cached.domState;
    }

    this.stats.cacheMisses++;

    try {
      // Use CDP service as primary method
      const domState = await this.cdpService.buildDomState(page, options);
      const signature = await this.cdpService.getDomSignature(page, options);

      // Cache the result
      this.setCacheEntry(cacheKey, signature, domState);

      const endTime = performance.now();
      this.updatePerformanceStats(endTime - startTime);

      this.logger.debug('CDP DOM state generated and cached', {
        url: page.url(),
        duration: `${(endTime - startTime).toFixed(2)}ms`,
        elementsCount: Object.keys(domState.selectorMap).length,
      });

      return domState;
    } catch (error) {
      this.logger.warn('CDP failed, using fallback DOM service', {
        error: (error as Error).message,
      });
      this.stats.cdpFallbacks++;

      // Fallback to the original service
      const pageView = await this.fallbackService.getPageView(page, page.context(), options, true);
      const domState = pageView.domState;
      const signature = await this.fallbackService.getDomSignature(page, options);

      // Cache the fallback result too
      this.setCacheEntry(cacheKey, signature, domState);

      const endTime = performance.now();
      this.updatePerformanceStats(endTime - startTime);

      return domState;
    }
  }

  /**
   * Check if DOM has changed since last check
   */
  async hasChanged(page: Page, lastSignature: string, options: DOMProcessingOptions = {}): Promise<boolean> {
    try {
      const currentSignature = await this.getDomSignature(page, options);
      return currentSignature !== lastSignature;
    } catch (error) {
      this.logger.warn('DOM change detection failed', { error: (error as Error).message });
      // Assume changed if we can't detect
      return true;
    }
  }

  /**
   * Intelligently determine if DOM check is necessary
   */
  shouldCheckDom(reason: 'step_start' | 'before_action' | 'after_action' | 'multi_action'): boolean {
    const recentHistory = this.signatureHistory.slice(-5);

    switch (reason) {
      case 'step_start':
        // Always check at step start
        return true;

      case 'before_action':
        // Skip if we just checked recently (within 1 second)
        const lastCheck = recentHistory[recentHistory.length - 1];
        if (lastCheck && Date.now() - lastCheck.timestamp < 1000) {
          this.logger.debug('Skipping redundant DOM check before action');
          return false;
        }
        return true;

      case 'after_action':
        // Only check after actions that are likely to change DOM
        return true;

      case 'multi_action':
        // For multi-action sequences, check less frequently
        const recentChanges = recentHistory.filter(h => Date.now() - h.timestamp < 2000);
        if (recentChanges.length > 3) {
          this.logger.debug('Throttling DOM checks during rapid multi-action sequence');
          return false;
        }
        return true;

      default:
        return true;
    }
  }

  /**
   * Record a signature change event
   */
  private recordSignatureChange(signature: string, reason: DOMChangeEvent['reason']): void {
    const event: DOMChangeEvent = {
      timestamp: Date.now(),
      reason,
      signature,
    };

    this.signatureHistory.push(event);

    // Keep only recent history
    this.signatureHistory = this.signatureHistory.slice(-20);

    this.logger.debug('DOM signature changed', { reason, signature: signature.slice(0, 8) });
  }

  /**
   * Generate cache key for a page and options
   */
  private generateCacheKey(url: string, options: DOMProcessingOptions): string {
    return `${url}_${JSON.stringify(options)}`;
  }

  /**
   * Check if cache entry is still valid
   */
  private isCacheValid(entry: CacheEntry): boolean {
    const age = Date.now() - entry.timestamp;
    return age < this.cacheTimeout;
  }

  /**
   * Set cache entry with cleanup
   */
  private setCacheEntry(key: string, signature: string, domState: DOMState): void {
    // Clean up old entries if cache is full
    if (this.cache.size >= this.maxCacheSize) {
      const oldestKey = Array.from(this.cache.entries())
        .sort(([, a], [, b]) => a.timestamp - b.timestamp)[0][0];
      this.cache.delete(oldestKey);
    }

    this.cache.set(key, {
      signature,
      domState,
      timestamp: Date.now(),
      hitCount: 0,
    });
  }

  /**
   * Update performance statistics
   */
  private updatePerformanceStats(duration: number): void {
    this.stats.avgProcessingTime =
      (this.stats.avgProcessingTime * (this.stats.totalRequests - 1) + duration) /
      this.stats.totalRequests;
  }

  /**
   * Get performance statistics
   */
  getStats() {
    const cacheHitRate = this.stats.totalRequests > 0
      ? (this.stats.cacheHits / this.stats.totalRequests * 100).toFixed(1)
      : '0';

    return {
      ...this.stats,
      cacheHitRate: `${cacheHitRate}%`,
      avgProcessingTime: `${this.stats.avgProcessingTime.toFixed(2)}ms`,
      cacheSize: this.cache.size,
      signatureHistoryLength: this.signatureHistory.length,
    };
  }

  /**
   * Invalidate cache for specific URL or all
   */
  invalidateCache(url?: string): void {
    if (url) {
      const keysToDelete = Array.from(this.cache.keys()).filter(key => key.startsWith(url));
      keysToDelete.forEach(key => this.cache.delete(key));
      this.logger.debug('Cache invalidated for URL', { url, keysDeleted: keysToDelete.length });
    } else {
      this.cache.clear();
      this.cdpService.clearCache();
      this.fallbackService.clearCache();
      this.signatureHistory = [];
      this.lastKnownSignature = '';
      this.logger.debug('All caches invalidated');
    }
  }

  /**
   * Configure cache settings
   */
  configure(options: {
    cacheTimeout?: number;
    maxCacheSize?: number;
  }): void {
    if (options.cacheTimeout !== undefined) {
      this.cacheTimeout = options.cacheTimeout;
      this.cdpService.setCacheTimeout(options.cacheTimeout);
      this.fallbackService.setCacheTimeout(options.cacheTimeout);
    }

    if (options.maxCacheSize !== undefined) {
      this.maxCacheSize = options.maxCacheSize;
    }

    this.logger.debug('Smart DOM cache configured', options);
  }

  /**
   * Start monitoring mode for debugging
   */
  startMonitoring(): void {
    this.isMonitoring = true;
    this.logger.info('Smart DOM cache monitoring started');
  }

  /**
   * Stop monitoring and report statistics
   */
  stopMonitoring(): void {
    this.isMonitoring = false;
    const stats = this.getStats();
    this.logger.info('Smart DOM cache monitoring stopped', { stats });
  }
}
