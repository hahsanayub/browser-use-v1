import type {
	Browser as PlaywrightBrowser,
	BrowserContext as PlaywrightBrowserContext,
	ElementHandle as PlaywrightElementHandle,
	FrameLocator as PlaywrightFrameLocator,
	Page as PlaywrightPage,
} from 'playwright';
import type { BrowserContextOptions, LaunchOptions } from 'playwright-core';

export type Browser = PlaywrightBrowser;
export type BrowserContext = PlaywrightBrowserContext;
export type Page = PlaywrightPage;
export type ElementHandle<T = unknown> = PlaywrightElementHandle<T>;
export type FrameLocator = PlaywrightFrameLocator;

export type PlaywrightModule = typeof import('playwright');

export type Playwright = PlaywrightModule;
export type Patchright = PlaywrightModule;
export type PlaywrightOrPatchright = PlaywrightModule;

export const async_playwright = async () => import('playwright');
export const async_patchright = async_playwright;

export type ProxySettings = NonNullable<LaunchOptions['proxy']>;
export type HttpCredentials = NonNullable<BrowserContextOptions['httpCredentials']>;
export type Geolocation = NonNullable<BrowserContextOptions['geolocation']>;
export type ViewportSize = NonNullable<BrowserContextOptions['viewport']>;
export type StorageState = Exclude<BrowserContextOptions['storageState'], undefined>;
export type ClientCertificate = NonNullable<NonNullable<BrowserContextOptions['clientCertificates']>[number]>;
