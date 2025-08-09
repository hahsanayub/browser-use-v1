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
