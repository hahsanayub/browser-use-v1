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
		const pendingRequests = new Set<any>();
		let lastActivity = Date.now() / 1000;
		const relevantResourceTypes = new Set(['document', 'stylesheet', 'image', 'font', 'script', 'iframe']);
		const ignoredResourceTypes = new Set(['websocket', 'media', 'eventsource', 'manifest', 'other']);
		const ignoredUrlPatterns = ['analytics', 'tracking', 'telemetry', 'beacon', 'metrics', 'doubleclick', 'adsystem', 'adserver', 'advertising', 'livechat', 'zendesk'];

		const onRequest = (request: any) => {
			const resourceType = request.resourceType?.() ?? request.resourceType;
			if (!resourceType || !relevantResourceTypes.has(resourceType)) {
				return;
			}
			if (ignoredResourceTypes.has(resourceType)) {
				return;
			}
			const url = request.url?.().toLowerCase?.() ?? request.url?.toLowerCase?.() ?? '';
			if (ignoredUrlPatterns.some((pattern) => url.includes(pattern))) {
				return;
			}
			if (url.startsWith('data:') || url.startsWith('blob:')) {
				return;
			}

			pendingRequests.add(request);
			lastActivity = Date.now() / 1000;
		};

		const onResponse = (response: any) => {
			const request = response.request?.() ?? response.request;
			if (!pendingRequests.has(request)) {
				return;
			}
			pendingRequests.delete(request);
			lastActivity = Date.now() / 1000;
		};

		const waitForIdle = async () => {
			const startTime = Date.now() / 1000;
			while (true) {
				await new Promise((resolve) => setTimeout(resolve, 100));
				const now = Date.now() / 1000;
				if (pendingRequests.size === 0 && now - lastActivity >= (this.browser_profile.wait_for_network_idle_page_load_time ?? 0.5)) {
					this.currentPageLoadingStatus = null;
					break;
				}
				if (now - startTime > (this.browser_profile.maximum_wait_page_load_time ?? 5)) {
					this.currentPageLoadingStatus = `Page loading was aborted after ${this.browser_profile.maximum_wait_page_load_time ?? 5}s with ${pendingRequests.size} pending network requests. You may want to use the wait action to allow more time for the page to fully load.`;
					break;
				}
			}
		};

		if (typeof page?.on === 'function' && typeof page?.off === 'function') {
			page.on('request', onRequest);
			page.on('response', onResponse);
			try {
				await waitForIdle();
			} finally {
				page.off('request', onRequest);
				page.off('response', onResponse);
			}
		} else {
			this.currentPageLoadingStatus = null;
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

	// ==================== Cookie Management ====================

	/**
	 * Get all cookies from the current browser context
	 */
	async get_cookies(): Promise<Array<Record<string, any>>> {
		if (this.browser_context?.cookies) {
			return await this.browser_context.cookies();
		}
		return [];
	}

	/**
	 * Save cookies to a file (deprecated, use save_storage_state instead)
	 * @deprecated Use save_storage_state() instead
	 */
	async save_cookies(...args: any[]): Promise<void> {
		return this.save_storage_state(...args);
	}

	/**
	 * Load cookies from a file (deprecated, use load_storage_state instead)
	 * @deprecated Use load_storage_state() instead
	 */
	async load_cookies_from_file(...args: any[]): Promise<void> {
		return this.load_storage_state(...args);
	}

	/**
	 * Save the current storage state (cookies, localStorage, sessionStorage) to a file
	 */
	async save_storage_state(filePath?: string): Promise<void> {
		if (!this.browser_context) {
			this.logger.warning('Cannot save storage state: browser context not initialized');
			return;
		}

		const targetPath = filePath || this.browser_profile.cookies_file;
		if (!targetPath) {
			return;
		}

		try {
			const resolvedPath = path.resolve(targetPath);
			const dirPath = path.dirname(resolvedPath);

			// Create directory if it doesn't exist
			if (!fs.existsSync(dirPath)) {
				fs.mkdirSync(dirPath, { recursive: true });
			}

			// Get storage state from browser context
			const storageState = await this.browser_context.storageState();

			// Write to temporary file first
			const tempPath = `${resolvedPath}.tmp`;
			fs.writeFileSync(tempPath, JSON.stringify(storageState, null, 2));

			// Backup existing file if present
			if (fs.existsSync(resolvedPath)) {
				const backupPath = `${resolvedPath}.bak`;
				try {
					fs.renameSync(resolvedPath, backupPath);
				} catch (error) {
					// Ignore backup errors
				}
			}

			// Move temp file to target
			fs.renameSync(tempPath, resolvedPath);

			const cookieCount = storageState.cookies?.length || 0;
			this.logger.info(`🍪 Saved ${cookieCount} cookies to ${path.basename(resolvedPath)}`);
		} catch (error) {
			this.logger.warning(`❌ Failed to save storage state: ${(error as Error).message}`);
		}
	}

	/**
	 * Load storage state (cookies, localStorage, sessionStorage) from a file
	 */
	async load_storage_state(filePath?: string): Promise<void> {
		const targetPath = filePath || this.browser_profile.cookies_file;
		if (!targetPath) {
			return;
		}

		try {
			const resolvedPath = path.resolve(targetPath);

			if (!fs.existsSync(resolvedPath)) {
				this.logger.warning(`Storage state file not found: ${resolvedPath}`);
				return;
			}

			const storageStateContent = fs.readFileSync(resolvedPath, 'utf-8');
			const storageState = JSON.parse(storageStateContent);

			if (this.browser_context?.addCookies) {
				// Add cookies to context
				if (storageState.cookies && Array.isArray(storageState.cookies)) {
					await this.browser_context.addCookies(storageState.cookies);
					this.logger.info(`🍪 Loaded ${storageState.cookies.length} cookies from ${path.basename(resolvedPath)}`);
				}
			}
		} catch (error) {
			this.logger.warning(`❌ Failed to load storage state: ${(error as Error).message}`);
		}
	}

	// ==================== JavaScript Execution ====================

	/**
	 * Execute JavaScript in the current page context
	 */
	async execute_javascript(script: string): Promise<any> {
		const page = await this.get_current_page();
		if (!page) {
			throw new Error('No page available to execute JavaScript');
		}
		return await page.evaluate(script);
	}

	// ==================== Page Information ====================

	/**
	 * Get comprehensive page information (size, scroll position, etc.)
	 */
	async get_page_info(page?: Page): Promise<any> {
		const targetPage = page || await this.get_current_page();
		if (!targetPage) {
			return null;
		}

		const pageData = await targetPage.evaluate(() => {
			return {
				// Current viewport dimensions
				viewport_width: window.innerWidth,
				viewport_height: window.innerHeight,

				// Total page dimensions
				page_width: Math.max(
					document.documentElement.scrollWidth,
					document.body.scrollWidth || 0
				),
				page_height: Math.max(
					document.documentElement.scrollHeight,
					document.body.scrollHeight || 0
				),

				// Current scroll position
				scroll_x: window.scrollX || window.pageXOffset || document.documentElement.scrollLeft || 0,
				scroll_y: window.scrollY || window.pageYOffset || document.documentElement.scrollTop || 0
			};
		});

		// Calculate derived values
		const viewport_width = Math.floor(pageData.viewport_width);
		const viewport_height = Math.floor(pageData.viewport_height);
		const page_width = Math.floor(pageData.page_width);
		const page_height = Math.floor(pageData.page_height);
		const scroll_x = Math.floor(pageData.scroll_x);
		const scroll_y = Math.floor(pageData.scroll_y);

		// Calculate scroll information
		const pixels_above = scroll_y;
		const pixels_below = Math.max(0, page_height - (scroll_y + viewport_height));
		const pixels_left = scroll_x;
		const pixels_right = Math.max(0, page_width - (scroll_x + viewport_width));

		return {
			viewport_width,
			viewport_height,
			page_width,
			page_height,
			scroll_x,
			scroll_y,
			pixels_above,
			pixels_below,
			pixels_left,
			pixels_right,
		};
	}

	/**
	 * Get the HTML content of the current page
	 */
	async get_page_html(): Promise<string> {
		const page = await this.get_current_page();
		if (!page) {
			return '';
		}
		return await page.content();
	}

	/**
	 * Get a debug view of the page structure including iframes
	 */
	async get_page_structure(): Promise<string> {
		const page = await this.get_current_page();
		if (!page) {
			return '';
		}

		const debug_script = `(() => {
			function getPageStructure(element = document, depth = 0, maxDepth = 10) {
				if (depth >= maxDepth) return '';

				const indent = '  '.repeat(depth);
				let structure = '';

				// Skip certain elements that clutter the output
				const skipTags = new Set(['script', 'style', 'link', 'meta', 'noscript']);

				// Add current element info if it's not the document
				if (element !== document) {
					const tagName = element.tagName.toLowerCase();

					// Skip uninteresting elements
					if (skipTags.has(tagName)) return '';

					const id = element.id ? \`#\${element.id}\` : '';
					const classes = element.className && typeof element.className === 'string' ?
						\`.\${element.className.split(' ').filter(c => c).join('.')}\` : '';

					// Get additional useful attributes
					const attrs = [];
					if (element.getAttribute('role')) attrs.push(\`role="\${element.getAttribute('role')}"\`);
					if (element.getAttribute('aria-label')) attrs.push(\`aria-label="\${element.getAttribute('aria-label')}"\`);
					if (element.getAttribute('type')) attrs.push(\`type="\${element.getAttribute('type')}"\`);
					if (element.getAttribute('name')) attrs.push(\`name="\${element.getAttribute('name')}"\`);
					if (element.getAttribute('src')) {
						const src = element.getAttribute('src');
						attrs.push(\`src="\${src.substring(0, 50)}\${src.length > 50 ? '...' : ''}"\`);
					}

					// Add element info
					structure += \`\${indent}\${tagName}\${id}\${classes}\${attrs.length ? ' [' + attrs.join(', ') + ']' : ''}\\n\`;

					// Handle iframes specially
					if (tagName === 'iframe') {
						try {
							const iframeDoc = element.contentDocument || element.contentWindow?.document;
							if (iframeDoc) {
								structure += \`\${indent}  [IFRAME CONTENT]:\\n\`;
								structure += getPageStructure(iframeDoc, depth + 2, maxDepth);
							} else {
								structure += \`\${indent}  [CROSS-ORIGIN IFRAME - Cannot access]\\n\`;
							}
						} catch (e) {
							structure += \`\${indent}  [IFRAME - Access denied]\\n\`;
						}
						return structure;
					}
				}

				// Process children
				const children = element.children || element.documentElement?.children || [];
				for (let i = 0; i < children.length; i++) {
					structure += getPageStructure(children[i], depth + 1, maxDepth);
				}

				return structure;
			}

			return getPageStructure();
		})()`;

		return await page.evaluate(debug_script);
	}

	// ==================== Navigation & History ====================

	/**
	 * Navigate forward in browser history
	 */
	async go_forward(): Promise<void> {
		try {
			const page = await this.get_current_page();
			if (page?.goForward) {
				await page.goForward({ timeout: 10000, waitUntil: 'load' });
			}
		} catch (error) {
			this.logger.debug(`⏭️ Error during go_forward: ${(error as Error).message}`);
			// Verify page is still usable after navigation error
			if ((error as Error).message.toLowerCase().includes('timeout')) {
				const page = await this.get_current_page();
				try {
					await page?.evaluate('1');
				} catch (evalError) {
					this.logger.error(`❌ Page crashed after go_forward timeout: ${(evalError as Error).message}`);
				}
			}
		}
	}

	/**
	 * Refresh the current page
	 */
	async refresh(): Promise<void> {
		try {
			const page = await this.get_current_page();
			if (page?.reload) {
				this.currentPageLoadingStatus = null;
				await page.reload({ waitUntil: 'domcontentloaded' });
				await this._waitForStableNetwork(page);
			}
		} catch (error) {
			this.logger.debug(`🔄 Error during refresh: ${(error as Error).message}`);
		}
	}

	// ==================== Element Waiting ====================

	/**
	 * Wait for an element to appear on the page
	 */
	async wait_for_element(selector: string, timeout: number = 10000): Promise<void> {
		const page = await this.get_current_page();
		if (!page) {
			throw new Error('No page available');
		}
		await page.waitForSelector(selector, { state: 'visible', timeout });
	}

	// ==================== Screenshots ====================

	/**
	 * Take a screenshot of the current page
	 * @param full_page Whether to capture the full scrollable page
	 * @returns Base64 encoded PNG screenshot
	 */
	async take_screenshot(full_page: boolean = false): Promise<string | null> {
		const page = await this.get_current_page();
		if (!page) {
			throw new Error('No page available for screenshot');
		}

		if (!this.browser_context) {
			throw new Error('Browser context is not set');
		}

		// Check if it's a new tab page
		const url = page.url();
		if (url === 'about:blank' || url === 'chrome://newtab/' || url === 'edge://newtab/') {
			this.logger.warning(`▫️ Skipping screenshot of empty page: ${url}`);
			// Return a 4px placeholder
			return 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAD0lEQVQIHWP8//8/AxYMACgtBP9g8jqYAAAAAElFTkSuQmCC';
		}

		// Bring page to front before rendering
		try {
			await page.bringToFront();
		} catch (error) {
			// Ignore errors
		}

		// Take screenshot using CDP for better performance
		let cdp_session: any = null;
		try {
			this.logger.debug(`📸 Taking ${full_page ? 'full-page' : 'viewport'} PNG screenshot via CDP: ${url}`);

			// Create CDP session for the screenshot
			cdp_session = await (this.browser_context as any).newCDPSession(page);

			// Capture screenshot via CDP
			const screenshot_response = await cdp_session.send('Page.captureScreenshot', {
				captureBeyondViewport: false,
				fromSurface: true,
				format: 'png',
			});

			const screenshot_b64 = screenshot_response.data;
			if (!screenshot_b64) {
				throw new Error(`CDP returned empty screenshot data for page ${url}`);
			}

			return screenshot_b64;

		} catch (error) {
			const error_str = (error as Error).message || String(error);
			if (error_str.toLowerCase().includes('timeout')) {
				this.logger.warning(`⏱️ Screenshot timed out on page ${url}: ${error_str}`);
			} else {
				this.logger.error(`❌ Screenshot failed on page ${url}: ${error_str}`);
			}
			throw error;
		} finally {
			if (cdp_session) {
				try {
					await cdp_session.detach();
				} catch (error) {
					// Ignore detach errors
				}
			}
		}
	}

	// ==================== Event Listeners ====================

	/**
	 * Add a request event listener to the current page
	 */
	async on_request(callback: (request: any) => void | Promise<void>): Promise<void> {
		const page = await this.get_current_page();
		if (page && typeof page.on === 'function') {
			page.on('request', callback);
		}
	}

	/**
	 * Add a response event listener to the current page
	 */
	async on_response(callback: (response: any) => void | Promise<void>): Promise<void> {
		const page = await this.get_current_page();
		if (page && typeof page.on === 'function') {
			page.on('response', callback);
		}
	}

	/**
	 * Remove a request event listener from the current page
	 */
	async off_request(callback: (request: any) => void | Promise<void>): Promise<void> {
		const page = await this.get_current_page();
		if (page && typeof page.off === 'function') {
			page.off('request', callback);
		}
	}

	/**
	 * Remove a response event listener from the current page
	 */
	async off_response(callback: (response: any) => void | Promise<void>): Promise<void> {
		const page = await this.get_current_page();
		if (page && typeof page.off === 'function') {
			page.off('response', callback);
		}
	}

	// ==================== P2 Additional Functions ====================

	/**
	 * Get information about all open tabs
	 * @returns Array of tab information including page_id, url, and title
	 */
	async get_tabs_info(): Promise<Array<{ page_id: number; url: string; title: string }>> {
		if (!this.browser_context) {
			return [];
		}

		const tabs_info: Array<{ page_id: number; url: string; title: string }> = [];
		const pages = this.browser_context.pages();

		for (let page_id = 0; page_id < pages.length; page_id++) {
			const page = pages[page_id];

			// Skip chrome:// pages and new tab pages
			const isNewTab = page.url() === 'about:blank' || page.url().startsWith('chrome://newtab');
			if (isNewTab || page.url().startsWith('chrome://')) {
				if (isNewTab) {
					tabs_info.push({
						page_id,
						url: page.url(),
						title: 'ignore this tab and do not use it',
					});
				} else {
					tabs_info.push({
						page_id,
						url: page.url(),
						title: page.url(),
					});
				}
				continue;
			}

			// Normal pages - try to get title with timeout
			try {
				const titlePromise = page.title();
				const timeoutPromise = new Promise<string>((_, reject) => {
					setTimeout(() => reject(new Error('timeout')), 2000);
				});

				const title = await Promise.race([titlePromise, timeoutPromise]);
				tabs_info.push({ page_id, url: page.url(), title });
			} catch (error) {
				this.logger.debug(`⚠️ Failed to get tab info for tab #${page_id}: ${page.url()} (using fallback title)`);

				if (isNewTab) {
					tabs_info.push({
						page_id,
						url: page.url(),
						title: 'ignore this tab and do not use it',
					});
				} else {
					tabs_info.push({
						page_id,
						url: page.url(),
						title: page.url(), // Use URL as fallback title
					});
				}
			}
		}

		return tabs_info;
	}

	/**
	 * Check if a page is responsive by trying to evaluate simple JavaScript
	 * @param page - The page to check
	 * @param timeout - Timeout in seconds (default: 5)
	 * @returns True if page is responsive, false otherwise
	 */
	async _is_page_responsive(page: any, timeout: number = 5.0): Promise<boolean> {
		try {
			const evalPromise = page.evaluate('1');
			const timeoutPromise = new Promise<never>((_, reject) => {
				setTimeout(() => reject(new Error('timeout')), timeout * 1000);
			});

			await Promise.race([evalPromise, timeoutPromise]);
			return true;
		} catch (error) {
			return false;
		}
	}

	/**
	 * Get scroll information for the current page
	 * @returns Object with scroll position and page dimensions
	 */
	async get_scroll_info(): Promise<{
		scroll_x: number;
		scroll_y: number;
		page_width: number;
		page_height: number;
		viewport_width: number;
		viewport_height: number;
	}> {
		const page = await this.get_current_page();
		if (!page) {
			return {
				scroll_x: 0,
				scroll_y: 0,
				page_width: 0,
				page_height: 0,
				viewport_width: 0,
				viewport_height: 0,
			};
		}

		return await page.evaluate(() => {
			return {
				scroll_x: window.scrollX || window.pageXOffset || document.documentElement.scrollLeft || 0,
				scroll_y: window.scrollY || window.pageYOffset || document.documentElement.scrollTop || 0,
				page_width: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth || 0),
				page_height: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight || 0),
				viewport_width: window.innerWidth,
				viewport_height: window.innerHeight,
			};
		});
	}

	/**
	 * Remove all highlights from the current page
	 */
	async remove_highlights(): Promise<void> {
		const page = await this.get_current_page();
		if (!page) {
			return;
		}

		try {
			await page.evaluate(() => {
				// Remove all elements with browser-use highlight class
				const highlights = document.querySelectorAll('.browser-use-highlight');
				highlights.forEach((el) => el.remove());

				// Remove inline highlight styles
				const styled = document.querySelectorAll('[style*="browser-use"]');
				styled.forEach((el: any) => {
					if (el.style) {
						el.style.outline = '';
						el.style.border = '';
					}
				});
			});
		} catch (error) {
			this.logger.debug(`Failed to remove highlights: ${(error as Error).message}`);
		}
	}

}

export { DEFAULT_BROWSER_PROFILE };
