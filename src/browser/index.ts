export * from './profile.js';
export * from './views.js';
export * from './utils.js';
export * from './session.js';
export * from './extensions.js';
export * from './dvd-screensaver.js';
export * from './playwright-manager.js';
export * from './events.js';

// Export from context.ts (primary aliases for Browser/BrowserContext)
export type {
  Browser,
  BrowserConfig,
  BrowserContext,
  BrowserContextConfig,
} from './context.js';

// Export Playwright types separately to avoid conflicts with context.ts
export type {
  Browser as PlaywrightBrowser,
  BrowserContext as PlaywrightBrowserContext,
  Page,
  Locator,
  FrameLocator,
  ElementHandle,
  Playwright,
  PlaywrightOrPatchright,
  ClientCertificate,
  Geolocation,
  HttpCredentials,
  ProxySettings,
  StorageState,
  ViewportSize,
} from './types.js';

// Re-export the async playwright loader
export { async_playwright } from './types.js';
