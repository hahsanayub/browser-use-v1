/**
 * Browser-related type definitions
 */

export interface ViewportSize {
  width: number;
  height: number;
}

export interface ExtensionConfig {
  /** Extension ID (for Chrome Web Store extensions) */
  id?: string;
  /** Local path to unpacked extension directory */
  path?: string;
  /** Extension name for identification */
  name?: string;
  /** Whether to enable this extension */
  enabled?: boolean;
}

// BrowserConfig is now exported from config/schema.ts to maintain single source of truth
// Import it from there: import { BrowserConfig } from '../config/schema'

export interface BrowserContextConfig {
  /** User data directory for this specific context */
  userDataDir?: string;
  /** Whether to run in headless mode */
  headless?: boolean;
  /** List of allowed domains for security */
  allowedDomains?: string[];
  /** Browser launch arguments */
  args?: string[];
  /** Custom user agent */
  userAgent?: string;
  /** Timeout settings */
  timeout?: number;
  /** Viewport configuration */
  viewport?: ViewportSize;
}

export interface BrowserSessionConfig {
  /** Whether to keep browser alive after session ends */
  keepAlive?: boolean;
  /** Whether to save cookies/storage state */
  saveState?: boolean;
  /** Directory to save recordings/traces */
  recordingDir?: string;
  /** Whether to record video */
  recordVideo?: boolean;
  /** Whether to record traces for debugging */
  recordTrace?: boolean;
  /** Whether to auto-download PDFs */
  autoDownloadPDFs?: boolean;
  /** Custom user data directory */
  userDataDir?: string;
  /** Custom viewport size */
  viewport?: ViewportSize;
  /** Browser launch arguments */
  args?: string[];
  /** Whether to run in headless mode */
  headless?: boolean;
  /** Custom user agent */
  userAgent?: string;
  /** List of allowed domains for security */
  allowedDomains?: string[];
  /** Global timeout for operations */
  timeout?: number;

  // Page load timing configuration
  /** Minimum time to wait before capturing page state (seconds) */
  minimumWaitPageLoadTime?: number;
  /** Time to wait for network idle (seconds) */
  waitForNetworkIdlePageLoadTime?: number;
  /** Maximum time to wait for page load (seconds) */
  maximumWaitPageLoadTime?: number;
  /** Time to wait between actions (seconds) */
  waitBetweenActions?: number;

  // Screenshot configuration
  /** Default screenshot format */
  defaultScreenshotFormat?: 'png' | 'jpeg';
  /** Default JPEG quality when using JPEG format */
  defaultJpegQuality?: number;
  /** Whether to use viewport-only screenshots by default for better performance */
  defaultViewportScreenshots?: boolean;

  // DOM processing configuration (aligned with Python version)
  /** Viewport expansion in pixels (-1 for all elements) */
  viewportExpansion?: number;
  /** Whether to highlight interactive elements */
  highlightElements?: boolean;
  /** Whether to include hidden elements */
  includeHiddenElements?: boolean;
  /** Maximum text length for elements */
  maxTextLength?: number;
  /** Whether to remove script tags */
  removeScripts?: boolean;
  /** Whether to remove style tags */
  removeStyles?: boolean;
  /** Whether to remove comments */
  removeComments?: boolean;
}
