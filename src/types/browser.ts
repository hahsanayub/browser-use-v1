/**
 * Browser-related type definitions
 */

export interface BrowserConfig {
  /** Browser type to use (chromium, firefox, webkit) */
  browserType?: 'chromium' | 'firefox' | 'webkit';
  /** Whether to run browser in headless mode */
  headless?: boolean;
  /** User data directory for persistent browser session */
  userDataDir?: string;
  /** Additional browser launch arguments */
  args?: string[];
  /** Browser executable path (optional) */
  executablePath?: string;
  /** Timeout for browser operations in milliseconds */
  timeout?: number;
  /** Viewport size */
  viewport?: {
    width: number;
    height: number;
  };
}

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
  viewport?: {
    width: number;
    height: number;
  };
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
  viewport?: {
    width: number;
    height: number;
  };
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
}
