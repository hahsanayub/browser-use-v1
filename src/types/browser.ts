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
  viewport?: ViewportSize;

  // Enhanced configuration options
  /** Use optimized Chrome arguments for automation */
  useOptimizedArgs?: boolean;
  /** Enable stealth mode to avoid detection */
  enableStealth?: boolean;
  /** Disable security features for testing */
  disableSecurity?: boolean;
  /** Enable deterministic rendering for consistent screenshots */
  enableDeterministicRendering?: boolean;
  /** Enable default automation-optimized extensions */
  enableDefaultExtensions?: boolean;
  /** Custom extensions to load */
  customExtensions?: ExtensionConfig[];
  /** List of allowed domains for navigation */
  allowedDomains?: string[];
  /** Window size for non-headless mode */
  windowSize?: ViewportSize;
  /** Window position for non-headless mode */
  windowPosition?: ViewportSize;
  /** Whether to keep browser alive after session ends */
  keepAlive?: boolean;
  /** Profile directory name (e.g., 'Default', 'Profile 1') */
  profileDirectory?: string;
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
}
