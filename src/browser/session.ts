import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../logging-config.js';
import { uuid7str } from '../utils.js';
import type { Browser, BrowserContext, Page, Locator } from './types.js';
import { BrowserProfile, type BrowserProfileOptions, DEFAULT_BROWSER_PROFILE } from './profile.js';
import { BrowserStateSummary, type TabInfo, BrowserError } from './views.js';
import { DOMElementNode, DOMState, type SelectorMap } from '../dom/views.js';
import { normalize_url } from './utils.js';
import { DomService } from '../dom/service.js';

export interface BrowserSessionInit {
	id?: string;
	browser_profile?: BrowserProfile;
	profile?: Partial<BrowserProfileOptions>;
	browser?: Browser | null;
	browser_context?: BrowserContext | null;
	page?: Page | null;
	title?: string | null;
	url?: string | null;
	wss_url?: string | null;
	cdp_url?: string | null;
	browser_pid?: number | null;
	playwright?: unknown;
	downloaded_files?: string[];
}

const createEmptyDomState = (): DOMState => {
	const root = new DOMElementNode(true, null, 'html', '/html[1]', {}, []);
	return new DOMState(root, {} as SelectorMap);
};

export interface BrowserStateOptions {
	cache_clickable_elements_hashes?: boolean;
	include_screenshot?: boolean;
}

export class BrowserSession {
	readonly id: string;
	readonly browser_profile: BrowserProfile;
	browser: Browser | null;
	browser_context: BrowserContext | null;
	agent_current_page: Page | null;
	human_current_page: Page | null;
	initialized = false;
	wss_url: string | null;
	cdp_url: string | null;
	browser_pid: number | null;
	playwright: unknown;
	private cachedBrowserState: BrowserStateSummary | null = null;
	private currentUrl: string;
	private currentTitle: string;
	private _logger: ReturnType<typeof createLogger> | null = null;
	private _tabCounter = 0;
	private _tabs: TabInfo[] = [];
	private currentTabIndex = 0;
	private historyStack: string[] = [];
	downloaded_files: string[] = [];
	private ownsBrowserResources = true;
	private _autoDownloadPdfs = true;
	private tabPages = new Map<number, Page | null>();
	private currentPageLoadingStatus: string | null = null;

	constructor(init: BrowserSessionInit = {}) {
		this.browser_profile = init.browser_profile ?? new BrowserProfile(init.profile ?? {});
		this.id = init.id ?? uuid7str();
		this.browser = init.browser ?? null;
		this.browser_context = init.browser_context ?? null;
		this.agent_current_page = init.page ?? null;
		this.human_current_page = init.page ?? null;
		this.currentUrl = normalize_url(init.url ?? 'about:blank');
		this.currentTitle = init.title ?? '';
		this.wss_url = init.wss_url ?? null;
		this.cdp_url = init.cdp_url ?? null;
		this.browser_pid = init.browser_pid ?? null;
		this.playwright = init.playwright ?? null;
		this.downloaded_files = Array.isArray(init.downloaded_files) ? [...init.downloaded_files] : [];
		if (typeof (init as any)?.auto_download_pdfs === 'boolean') {
			this._autoDownloadPdfs = Boolean((init as any).auto_download_pdfs);
		}
		this._tabs = [
			{
				page_id: this._tabCounter++,
				url: this.currentUrl,
				title: this.currentTitle || this.currentUrl,
				parent_page_id: null,
			},
		];
		this.historyStack.push(this.currentUrl);
		this.ownsBrowserResources = this._determineOwnership();
		this.tabPages.set(this._tabs[0].page_id, this.agent_current_page ?? null);
	}

	private async _waitForStableNetwork(page: Page) {
		const pending = new Set<any>();
		let lastActivity = Date.now() / 1000;

		const relevantResourceTypes = new Set(['document', 'stylesheet', 'image', 'font', 'script', 'iframe']);
		const ignoredTypes = new Set(['websocket', 'media', 'eventsource', 'manifest', 'other']);
		const ignoredUrlPatterns = ['analytics', 'tracking', 'telemetry', 'beacon', 'metrics', 'doubleclick', 'adsystem', 'adserver', 'advertising'];

		const onRequest = (request: any) => {
			if (!relevantResourceTypes.has(request.resourceType())) return;
			if (ignoredTypes.has(request.resourceType())) return;
			const url = request.url().toLowerCase();
			if (ignoredUrlPatterns.some((pattern) => url.includes(pattern))) return;
			if (url.startsWith('data:') || url.startsWith('blob:')) return;
			pending.add(request);
			lastActivity = Date.now() / 1000;
		};

		const onResponse = (response: any) => {
			const request = response.request();
			if (!pending.has(request)) return;
			pending.delete(request);
			lastActivity = Date.now() / 1000;
		};

		page.on('request', onRequest);
		page.on('response', onResponse);

		const waitForIdle = async () => {
			const start = Date.now() / 1000;
			while (true) {
				await new Promise((resolve) => setTimeout(resolve, 100));
				const now = Date.now() / 1000;
				if (pending.size === 0 && now - lastActivity >= 0.5) {
					this.currentPageLoadingStatus = null;
					break;
				}
				if (now - start > 5) {
					this.currentPageLoadingStatus = `Page loading was aborted after 5 seconds with ${pending.size} pending network requests. You may want to use the wait action to allow more time for the page to fully load.`;
					break;
				}
			}
		};

		try {
			await waitForIdle();
		} finally {
			page.off('request', onRequest);
			page.off('response', onResponse);
		}
	}

	private _setActivePage(page: Page | null) {
		const currentTab = this._tabs[this.currentTabIndex];
		if (currentTab) {
			this.tabPages.set(currentTab.page_id, page ?? null);
		}
		this.agent_current_page = page ?? null;
	}

	get tabs() {
		return this._tabs.slice();
	}

	get active_tab_index() {
		return this.currentTabIndex;
	}

	get active_tab() {
		return this._tabs[this.currentTabIndex] ?? null;
	}

	describe() {
		return this.toString();
	}

	private _determineOwnership() {
		if (this.cdp_url || this.wss_url || this.browser || this.browser_context) {
			return false;
		}
		return true;
	}

	private _connectionDescriptor() {
		const source = this.cdp_url || this.wss_url || (this.browser_pid ? String(this.browser_pid) : 'playwright');
		const tail = source.split('/').pop() ?? source;
		const port = tail.includes(':') ? tail.split(':').pop() : tail;
		return `${this.id.slice(-4)}:${port}`;
	}

	toString() {
		const ownershipFlag = this.ownsBrowserResources ? '#' : '©';
		return `BrowserSession🆂 ${this._connectionDescriptor()} ${ownershipFlag}${String(this.id).slice(-2)}`;
	}

	private get logger() {
		if (!this._logger) {
			this._logger = createLogger(`browser_use.browser.session.${this.id.slice(-4)}`);
		}
		return this._logger;
	}

	async start() {
		this.initialized = true;
		this.logger.debug(`Started ${this.describe()} with profile ${this.browser_profile.toString()}`);
		return this;
	}

	async close() {
		this.initialized = false;
		this.browser = null;
		this.browser_context = null;
		this.agent_current_page = null;
		this.human_current_page = null;
		this.cachedBrowserState = null;
		this._tabs = [];
		this.downloaded_files = [];
	}

	async get_browser_state_with_recovery(options: BrowserStateOptions = {}) {
		if (!this.initialized) {
			await this.start();
		}
		const page = await this.get_current_page();
		this.cachedBrowserState = null;
		let domState: DOMState;

		if (!page) {
			domState = createEmptyDomState();
		} else {
			try {
				const domService = new DomService(page, this.logger);
				domState = await domService.get_clickable_elements();
			} catch (error) {
				this.logger.debug(`Failed to build DOM tree: ${(error as Error).message}`);
				domState = createEmptyDomState();
			}
		}

		let screenshot: string | null = null;
		if (options.include_screenshot && page?.screenshot) {
			try {
				const image = await page.screenshot({ type: 'png', encoding: 'base64', fullPage: true });
				screenshot = typeof image === 'string' ? image : Buffer.from(image).toString('base64');
			} catch (error) {
				this.logger.debug(`Failed to capture screenshot: ${(error as Error).message}`);
			}
		}

		let pageInfo = null;
		let pixelsAbove = 0;
		let pixelsBelow = 0;
		let pixelsLeft = 0;
		let pixelsRight = 0;
		if (page) {
			try {
				const metrics = await page.evaluate(() => {
					const doc = document.documentElement;
					const body = document.body;
					const width = Math.max(doc?.scrollWidth ?? 0, body?.scrollWidth ?? 0, doc?.clientWidth ?? 0);
					const height = Math.max(doc?.scrollHeight ?? 0, body?.scrollHeight ?? 0, doc?.clientHeight ?? 0);
					return {
						viewportWidth: window.innerWidth,
						viewportHeight: window.innerHeight,
						scrollX: window.scrollX,
						scrollY: window.scrollY,
						pageWidth: width,
						pageHeight: height,
					};
				});
				pixelsAbove = Math.max(metrics.scrollY ?? 0, 0);
				const viewportHeight = metrics.viewportHeight ?? 0;
				const viewportWidth = metrics.viewportWidth ?? 0;
				pixelsBelow = Math.max((metrics.pageHeight ?? 0) - (metrics.scrollY + viewportHeight), 0);
				pixelsLeft = Math.max(metrics.scrollX ?? 0, 0);
				pixelsRight = Math.max((metrics.pageWidth ?? 0) - (metrics.scrollX + viewportWidth), 0);
				pageInfo = {
					viewport_width: viewportWidth,
					viewport_height: viewportHeight,
					page_width: metrics.pageWidth ?? viewportWidth,
					page_height: metrics.pageHeight ?? viewportHeight,
					scroll_x: metrics.scrollX ?? 0,
					scroll_y: metrics.scrollY ?? 0,
					pixels_above: pixelsAbove,
					pixels_below: pixelsBelow,
					pixels_left: pixelsLeft,
					pixels_right: pixelsRight,
				};
			} catch (error) {
				this.logger.debug(`Failed to compute page metrics: ${(error as Error).message}`);
			}
		}

		const summary = new BrowserStateSummary(domState, {
			url: this.currentUrl,
			title: this.currentTitle || this.currentUrl,
			tabs: this._buildTabs(),
			screenshot,
			page_info: pageInfo,
			pixels_above: pixelsAbove,
			pixels_below: pixelsBelow,
			browser_errors: this.currentPageLoadingStatus ? [this.currentPageLoadingStatus] : [],
			is_pdf_viewer: Boolean(this.currentUrl?.toLowerCase().endsWith('.pdf')),
			loading_status: this.currentPageLoadingStatus,
		});
		this.cachedBrowserState = summary;
		return summary;
	}

	async get_current_page() {
		if (this.agent_current_page) {
			return this.agent_current_page;
		}
		const currentTab = this._tabs[this.currentTabIndex];
		if (currentTab) {
			const tabPage = this.tabPages.get(currentTab.page_id) ?? null;
			if (tabPage) {
				this._setActivePage(tabPage);
				return tabPage;
			}
		}
		const fallback = this.browser_context?.pages?.[0] ?? null;
		this._setActivePage(fallback ?? null);
		return fallback;
	}

	update_current_page(page: Page | null, title?: string | null, url?: string | null) {
		this._setActivePage(page);
		this.human_current_page = this.human_current_page ?? page;
		if (url) {
			this.currentUrl = normalize_url(url);
		}
		if (title) {
			this.currentTitle = title;
		}
	}

	private _buildTabs(): TabInfo[] {
		if (!this._tabs.length) {
			this._tabs.push({
				page_id: this._tabCounter++,
				url: this.currentUrl,
				title: this.currentTitle || this.currentUrl,
				parent_page_id: null,
			});
		} else {
			const tab = this._tabs[this.currentTabIndex];
			tab.url = this.currentUrl;
			tab.title = this.currentTitle || this.currentUrl;
		}
		return this._tabs.slice();
	}

	async navigate_to(url: string) {
		const normalized = normalize_url(url);
		const page = await this.get_current_page();
		if (page?.goto) {
			try {
				this.currentPageLoadingStatus = null;
				await page.goto(normalized, { waitUntil: 'domcontentloaded' });
				await this._waitForStableNetwork(page);
			} catch (error) {
				const message = (error as Error).message ?? 'Navigation failed';
				throw new BrowserError(message);
			}
		}
		this.currentUrl = normalized;
		this.currentTitle = normalized;
		this.historyStack.push(normalized);
		if (this._tabs[this.currentTabIndex]) {
			this._tabs[this.currentTabIndex].url = normalized;
			this._tabs[this.currentTabIndex].title = normalized;
		}
		this._setActivePage(page ?? null);
		this.cachedBrowserState = null;
		return this.agent_current_page;
	}

	async create_new_tab(url: string) {
		const normalized = normalize_url(url);
		const newTab: TabInfo = {
			page_id: this._tabCounter++,
			url: normalized,
			title: normalized,
			parent_page_id: null,
		};
		this._tabs.push(newTab);
		this.currentTabIndex = this._tabs.length - 1;
		this.currentUrl = normalized;
		this.currentTitle = normalized;
		this.historyStack.push(normalized);
		let page: Page | null = null;
		try {
			page = (await this.browser_context?.new_page?.()) ?? null;
			if (page) {
				this.currentPageLoadingStatus = null;
				await page.goto(normalized, { waitUntil: 'domcontentloaded' });
				await this._waitForStableNetwork(page);
			}
		} catch (error) {
			this.logger.debug(`Failed to open new tab via Playwright: ${(error as Error).message}`);
		}
		this.tabPages.set(newTab.page_id, page);
		this._setActivePage(page);
		this.currentPageLoadingStatus = null;
		if (!this.human_current_page) {
			this.human_current_page = page;
		}
		this.cachedBrowserState = null;
		return this.agent_current_page;
	}

	private _resolveTabIndex(identifier: number) {
		if (identifier === -1) {
			return Math.max(0, this._tabs.length - 1);
		}
		const byId = this._tabs.findIndex((tab) => tab.page_id === identifier);
		if (byId !== -1) {
			return byId;
		}
		if (identifier >= 0 && identifier < this._tabs.length) {
			return identifier;
		}
		return -1;
	}

	async switch_to_tab(identifier: number) {
		const index = this._resolveTabIndex(identifier);
		const tab = index >= 0 ? this._tabs[index] ?? null : null;
		if (!tab) {
			throw new Error(`Tab index ${identifier} does not exist`);
		}
		this.currentTabIndex = index;
		this.currentUrl = tab.url;
		this.currentTitle = tab.title;
		const page = this.tabPages.get(tab.page_id) ?? null;
		this._setActivePage(page);
		if (page?.bringToFront) {
			try {
				await page.bringToFront();
			} catch (error) {
				this.logger.debug(`Failed to focus tab: ${(error as Error).message}`);
			}
		}
		await this._waitForLoad(page);
		this.cachedBrowserState = null;
		return page;
	}

	async close_tab(identifier: number) {
		const index = this._resolveTabIndex(identifier);
		if (index < 0 || index >= this._tabs.length) {
			throw new Error(`Tab index ${identifier} does not exist`);
		}
		const closingTab = this._tabs[index];
		const closingPage = this.tabPages.get(closingTab.page_id) ?? null;
		if (closingPage?.close) {
			try {
				await closingPage.close();
			} catch (error) {
				this.logger.debug(`Failed to close page: ${(error as Error).message}`);
			}
		}
		this.tabPages.delete(closingTab.page_id);
		this._tabs.splice(index, 1);
		if (this.currentTabIndex >= this._tabs.length) {
			this.currentTabIndex = Math.max(0, this._tabs.length - 1);
		}
		const tab = this._tabs[this.currentTabIndex] ?? null;
		const current = tab ? this.tabPages.get(tab.page_id) ?? null : null;
		this._setActivePage(current);
		this.currentPageLoadingStatus = null;
		this.cachedBrowserState = null;
		if (this._tabs.length) {
			const tab = this._tabs[this.currentTabIndex];
			this.currentUrl = tab.url;
			this.currentTitle = tab.title;
		} else {
			this.currentUrl = 'about:blank';
			this.currentTitle = 'about:blank';
			this._setActivePage(null);
		}
	}

	async go_back() {
		if (this.historyStack.length <= 1) {
			return;
		}
		const page = await this.get_current_page();
		if (page?.goBack) {
			try {
				await page.goBack();
			} catch (error) {
				this.logger.debug(`Failed to navigate back: ${(error as Error).message}`);
			}
		}
		this.historyStack.pop();
		const previous = this.historyStack[this.historyStack.length - 1];
		this.currentUrl = previous;
		this.currentTitle = previous;
		if (this._tabs[this.currentTabIndex]) {
			this._tabs[this.currentTabIndex].url = previous;
			this._tabs[this.currentTabIndex].title = previous;
		}
	}

	async get_dom_element_by_index(_index: number) {
		const selectorMap = await this.get_selector_map();
		return selectorMap?.[_index] ?? null;
	}

	set_downloaded_files(files: string[]) {
		if (!Array.isArray(files)) {
			return;
		}
		this.downloaded_files = [...files];
	}

	add_downloaded_file(filePath: string) {
		if (!filePath) {
			return;
		}
		if (!this.downloaded_files.includes(filePath)) {
			this.downloaded_files = [...this.downloaded_files, filePath];
			this.logger.info(`📁 Added download to session tracking (total: ${this.downloaded_files.length} files)`);
		}
	}

	get_downloaded_files() {
		this.logger.debug(`📁 Retrieved ${this.downloaded_files.length} downloaded files from session tracking`);
		return [...this.downloaded_files];
	}

	set_auto_download_pdfs(enabled: boolean) {
		this._autoDownloadPdfs = Boolean(enabled);
		this.logger.info(`📄 PDF auto-download ${this._autoDownloadPdfs ? 'enabled' : 'disabled'}`);
	}

	auto_download_pdfs() {
		return this._autoDownloadPdfs;
	}

	static async get_unique_filename(directory: string, filename: string) {
		const resolvedDir = path.resolve(directory);
		const parsed = path.parse(filename);
		let candidate = filename;
		let counter = 1;
		while (fs.existsSync(path.join(resolvedDir, candidate))) {
			candidate = `${parsed.name} (${counter})${parsed.ext}`;
			counter += 1;
		}
		return candidate;
	}

	async get_selector_map() {
		if (!this.cachedBrowserState) {
			await this.get_browser_state_with_recovery({ cache_clickable_elements_hashes: true, include_screenshot: false });
		}
		return this.cachedBrowserState?.selector_map ?? {};
	}

	static is_file_input(node: DOMElementNode | null) {
		if (!node) {
			return false;
		}
		return node.tag_name?.toLowerCase() === 'input' && (node.attributes?.type ?? '').toLowerCase() === 'file';
	}

	is_file_input(node: DOMElementNode | null) {
		return BrowserSession.is_file_input(node);
	}

	async find_file_upload_element_by_index(index: number, maxHeight = 3, maxDescendantDepth = 3) {
		const selectorMap = await this.get_selector_map();
		const root = selectorMap[index];
		if (!root) {
			return null;
		}

		const findInDescendants = (node: DOMElementNode, depth: number): DOMElementNode | null => {
			if (depth < 0) {
				return null;
			}
			if (BrowserSession.is_file_input(node)) {
				return node;
			}
			for (const child of node.children) {
				if (child instanceof DOMElementNode) {
					const found = findInDescendants(child, depth - 1);
					if (found) {
						return found;
					}
				}
			}
			return null;
		};

		let current: DOMElementNode | null = root;
		let remainingHeight = maxHeight;
		while (current && remainingHeight >= 0) {
			const direct = findInDescendants(current, maxDescendantDepth);
			if (direct) {
				return direct;
			}

			if (current.parent) {
				for (const sibling of current.parent.children) {
					if (sibling instanceof DOMElementNode && sibling !== current) {
						const fromSibling = findInDescendants(sibling, maxDescendantDepth);
						if (fromSibling) {
							return fromSibling;
						}
					}
				}
			}

			current = current.parent;
			remainingHeight -= 1;
		}

		return null;
	}

	async get_locate_element(node: DOMElementNode): Promise<Locator | null> {
		const page = await this.get_current_page();
		if (!page || !node?.xpath) {
			return null;
		}
		try {
			const locator = page.locator(`xpath=${node.xpath}`);
			const count = await locator.count();
			if (count === 0) {
				return null;
			}
			return locator;
		} catch (error) {
			this.logger.debug(`Failed to locate element via xpath ${node.xpath}: ${(error as Error).message}`);
			return null;
		}
	}

	async _input_text_element_node(node: DOMElementNode, text: string) {
		const locator = await this.get_locate_element(node);
		if (!locator) {
			throw new Error('Element not found');
		}
		await locator.click({ timeout: 5000 });
		await locator.fill(text, { timeout: 5000 });
	}

	async _click_element_node(node: DOMElementNode) {
		const locator = await this.get_locate_element(node);
		if (!locator) {
			throw new Error('Element not found');
		}
		const page = await this.get_current_page();
		const performClick = async () => {
			await locator.click({ timeout: 5000 });
		};

		const downloadsDir = this.browser_profile.downloads_path;
		if (downloadsDir && page?.waitForEvent) {
			const downloadPromise = page.waitForEvent('download', { timeout: 5000 });
			await performClick();
			try {
				const download = await downloadPromise;
				const suggested = typeof download.suggestedFilename === 'function' ? download.suggestedFilename() : 'download';
				const uniqueFilename = await BrowserSession.get_unique_filename(downloadsDir, suggested);
				const downloadPath = path.join(downloadsDir, uniqueFilename);
				if (typeof download.saveAs === 'function') {
					await download.saveAs(downloadPath);
				}
				this.add_downloaded_file(downloadPath);
				return downloadPath;
			} catch (error) {
				this.logger.debug(`No download triggered within timeout: ${(error as Error).message}`);
			}
		} else {
			await performClick();
		}

		await this._waitForLoad(page);
		return null;
	}

	private async _waitForLoad(page: Page | null, timeout = 5000) {
		if (!page || typeof page.waitForLoadState !== 'function') {
			return;
		}
		try {
			await page.waitForLoadState('domcontentloaded', { timeout });
		} catch (error) {
			this.logger.debug(`waitForLoadState failed: ${(error as Error).message}`);
		}
	}

}

export { DEFAULT_BROWSER_PROFILE };
