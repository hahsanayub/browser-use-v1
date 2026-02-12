import type {
  Browser as PlaywrightBrowser,
  BrowserContextOptions,
  BrowserContext as PlaywrightBrowserContext,
  ElementHandle as PlaywrightElementHandle,
  FrameLocator as PlaywrightFrameLocator,
  LaunchOptions,
  Page as PlaywrightPage,
  Locator as PlaywrightLocator,
} from 'playwright';

// Export Playwright types directly
export type Browser = PlaywrightBrowser;
export type BrowserContext = PlaywrightBrowserContext;
export type Page = PlaywrightPage;
export type ElementHandle<T = unknown> = PlaywrightElementHandle<T>;
export type FrameLocator = PlaywrightFrameLocator;
export type Locator = PlaywrightLocator;

export type PlaywrightModule = typeof import('playwright');

export type Playwright = PlaywrightModule;
export type PlaywrightOrPatchright = PlaywrightModule;

export const async_playwright = async () => import('playwright');

export type ProxySettings = NonNullable<LaunchOptions['proxy']>;
export type HttpCredentials = NonNullable<
  BrowserContextOptions['httpCredentials']
>;
export type Geolocation = NonNullable<BrowserContextOptions['geolocation']>;
export type ViewportSize = NonNullable<BrowserContextOptions['viewport']>;
export type StorageState = Exclude<
  BrowserContextOptions['storageState'],
  undefined
>;
export type ClientCertificate = NonNullable<
  NonNullable<BrowserContextOptions['clientCertificates']>[number]
>;
