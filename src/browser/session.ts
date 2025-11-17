import { createLogger } from '../logging-config.js';
import { uuid7str } from '../utils.js';
import type { Browser, BrowserContext, Page } from './types.js';
import { BrowserProfile, type BrowserProfileOptions, DEFAULT_BROWSER_PROFILE } from './profile.js';
import { BrowserStateSummary, type TabInfo } from './views.js';
import { DOMElementNode, DOMState, type SelectorMap } from '../dom/views.js';
import { normalize_url } from './utils.js';

export interface BrowserSessionInit {
	id?: string;
	browser_profile?: BrowserProfile;
	profile?: Partial<BrowserProfileOptions>;
	browser?: Browser | null;
	browser_context?: BrowserContext | null;
	page?: Page | null;
	title?: string | null;
	url?: string | null;
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
	private cachedBrowserState: BrowserStateSummary | null = null;
	private currentUrl: string;
	private currentTitle: string;
	private readonly logger = createLogger('browser_use.browser.session');
	private _tabCounter = 0;
	private _tabs: TabInfo[] = [];
	private currentTabIndex = 0;
	private historyStack: string[] = [];
	downloaded_files: string[] = [];

	constructor(init: BrowserSessionInit = {}) {
		this.browser_profile = init.browser_profile ?? new BrowserProfile(init.profile ?? {});
		this.id = init.id ?? uuid7str();
		this.browser = init.browser ?? null;
		this.browser_context = init.browser_context ?? null;
		this.agent_current_page = init.page ?? null;
		this.human_current_page = init.page ?? null;
		this.currentUrl = normalize_url(init.url ?? 'about:blank');
		this.currentTitle = init.title ?? '';
		this._tabs = [
			{
				page_id: this._tabCounter++,
				url: this.currentUrl,
				title: this.currentTitle || this.currentUrl,
				parent_page_id: null,
			},
		];
		this.historyStack.push(this.currentUrl);
	}

	get tabs() {
		return this._tabs.slice();
	}

	describe() {
		return `BrowserSession#${this.id.slice(-4)}`;
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
	}

	async get_browser_state_with_recovery(_options: BrowserStateOptions = {}) {
		if (!this.initialized) {
			await this.start();
		}
		const domState = createEmptyDomState();
		const summary = new BrowserStateSummary(domState, {
			url: this.currentUrl,
			title: this.currentTitle || this.currentUrl,
			tabs: this._buildTabs(),
			screenshot: null,
			page_info: null,
			pixels_above: 0,
			pixels_below: 0,
			browser_errors: [],
			is_pdf_viewer: false,
			loading_status: null,
		});
		this.cachedBrowserState = summary;
		return summary;
	}

	async get_current_page() {
		return this.agent_current_page;
	}

	update_current_page(page: Page | null, title?: string | null, url?: string | null) {
		this.agent_current_page = page;
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
		this.currentUrl = normalized;
		this.currentTitle = normalized;
		this.historyStack.push(normalized);
		if (this._tabs[this.currentTabIndex]) {
			this._tabs[this.currentTabIndex].url = normalized;
			this._tabs[this.currentTabIndex].title = normalized;
		}
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
		return this.agent_current_page;
	}

	async switch_to_tab(index: number) {
		const tab = this._tabs[index] ?? null;
		if (!tab) {
			throw new Error(`Tab index ${index} does not exist`);
		}
		this.currentTabIndex = index;
		this.currentUrl = tab.url;
		this.currentTitle = tab.title;
		return this.agent_current_page;
	}

	async close_tab(index: number) {
		if (index < 0 || index >= this._tabs.length) {
			throw new Error(`Tab index ${index} does not exist`);
		}
		this._tabs.splice(index, 1);
		if (this.currentTabIndex >= this._tabs.length) {
			this.currentTabIndex = Math.max(0, this._tabs.length - 1);
		}
		if (this._tabs.length) {
			const tab = this._tabs[this.currentTabIndex];
			this.currentUrl = tab.url;
			this.currentTitle = tab.title;
		} else {
			this.currentUrl = 'about:blank';
			this.currentTitle = 'about:blank';
		}
	}

	async go_back() {
		if (this.historyStack.length <= 1) {
			return;
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
		throw new Error('get_dom_element_by_index is not implemented yet.');
	}

	is_file_input(_element: unknown): boolean {
		return false;
	}

	async _click_element_node(_node: DOMElementNode) {
		throw new Error('_click_element_node is not implemented yet.');
	}
}

export { DEFAULT_BROWSER_PROFILE };
