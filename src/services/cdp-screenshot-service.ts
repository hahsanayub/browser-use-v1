/**
 * Enhanced screenshot service using Chrome DevTools Protocol (CDP)
 */
import { CDPSession, Page } from 'playwright';
import { getLogger } from './logging';

export interface ScreenshotOptions {
  /** Whether to capture beyond viewport (full page). Default: false (viewport only) */
  captureBeyondViewport?: boolean;
  /** Image format. Default: 'png' */
  format?: 'png' | 'jpeg';
  /** JPEG quality (0-100). Only applies when format is 'jpeg' */
  quality?: number;
  /** Whether to capture from surface. Default: true */
  fromSurface?: boolean;
}

export interface ScreenshotResult {
  /** Base64 encoded screenshot data */
  data: string;
  /** Image format used */
  format: 'png' | 'jpeg';
  /** File size in bytes (estimated from base64 length) */
  estimatedSize: number;
}

/**
 * CDP-based screenshot service for improved performance
 * Uses Chrome DevTools Protocol directly instead of Playwright's high-level API
 */
export class CDPScreenshotService {
  private logger = getLogger();
  private cdpSession: CDPSession | null = null;

  constructor(private page: Page) {}

  /**
   * Initialize CDP session for the current page
   */
  private async ensureCDPSession(): Promise<CDPSession> {
    if (!this.cdpSession) {
      this.logger.debug('Creating new CDP session for screenshot');
      this.cdpSession = await this.page.context().newCDPSession(this.page);
    }
    return this.cdpSession;
  }

  /**
   * Take screenshot using CDP for better performance
   *
   * @param options Screenshot options
   * @returns Promise resolving to ScreenshotResult
   */
  async takeScreenshot(
    options: ScreenshotOptions = {}
  ): Promise<ScreenshotResult> {
    const {
      captureBeyondViewport = false, // Default to viewport-only for better performance
      format = 'png',
      quality,
      fromSurface = true,
    } = options;

    try {
      // Check if page is valid
      if (this.page.isClosed()) {
        throw new Error('Page is closed');
      }

      const currentUrl = this.page.url();
      const isNewTabPage =
        currentUrl === 'about:blank' ||
        currentUrl === 'chrome://newtab/' ||
        currentUrl.startsWith('chrome://') ||
        currentUrl.startsWith('about:');

      if (isNewTabPage) {
        this.logger.debug('Skipping screenshot for new tab page', {
          url: currentUrl,
        });
        throw new Error('Cannot take screenshot of new tab page');
      }

      // Get CDP session
      const cdpSession = await this.ensureCDPSession();

      // Prepare CDP parameters
      const params: any = {
        captureBeyondViewport,
        fromSurface,
        format,
      };

      // Add quality parameter for JPEG
      if (format === 'jpeg' && quality !== undefined) {
        params.quality = Math.max(0, Math.min(100, quality));
      }

      this.logger.debug('Taking screenshot via CDP', {
        url: currentUrl,
        captureBeyondViewport,
        format,
        quality: params.quality,
      });

      // Take screenshot using CDP
      const startTime = Date.now();
      const result = await cdpSession.send('Page.captureScreenshot', params);
      const duration = Date.now() - startTime;

      if (!result || !result.data) {
        throw new Error('Screenshot result missing data');
      }

      const estimatedSize = Math.ceil((result.data.length * 3) / 4); // Base64 to bytes estimation

      this.logger.debug('Screenshot taken successfully via CDP', {
        format,
        duration: `${duration}ms`,
        estimatedSize,
        captureBeyondViewport,
      });

      return {
        data: result.data,
        format,
        estimatedSize,
      };
    } catch (error) {
      this.logger.error('CDP screenshot failed', error as Error);
      throw error;
    }
  }

  /**
   * Take viewport-only screenshot (best performance)
   */
  async takeViewportScreenshot(
    format: 'png' | 'jpeg' = 'png',
    quality?: number
  ): Promise<ScreenshotResult> {
    return this.takeScreenshot({
      captureBeyondViewport: false,
      format,
      quality,
    });
  }

  /**
   * Take full page screenshot (slower but complete)
   */
  async takeFullPageScreenshot(
    format: 'png' | 'jpeg' = 'png',
    quality?: number
  ): Promise<ScreenshotResult> {
    return this.takeScreenshot({
      captureBeyondViewport: true,
      format,
      quality,
    });
  }

  /**
   * Take JPEG screenshot with specified quality for best performance
   */
  async takeJPEGScreenshot(
    quality: number = 80,
    captureBeyondViewport: boolean = false
  ): Promise<ScreenshotResult> {
    return this.takeScreenshot({
      captureBeyondViewport,
      format: 'jpeg',
      quality,
    });
  }

  /**
   * Cleanup CDP session
   */
  async cleanup(): Promise<void> {
    if (this.cdpSession) {
      try {
        await this.cdpSession.detach();
        this.logger.debug('CDP session detached');
      } catch (error) {
        this.logger.warn('Error detaching CDP session', { error });
      }
    }
    this.cdpSession = null;
  }
}

/**
 * Create CDP screenshot service for a page
 */
export function createCDPScreenshotService(page: Page): CDPScreenshotService {
  return new CDPScreenshotService(page);
}
