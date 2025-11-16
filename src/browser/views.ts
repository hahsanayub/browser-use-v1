import fs from 'node:fs';
import path from 'node:path';
import { DOMState } from '../dom/views.js';
import type { DOMHistoryElement } from '../dom/history-tree-processor/view.js';

export const PLACEHOLDER_4PX_SCREENSHOT =
	'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAFElEQVR4nGP8//8/AwwwMSAB3BwAlm4DBfIlvvkAAAAASUVORK5CYII=';

export interface TabInfo {
	page_id: number;
	url: string;
	title: string;
	parent_page_id?: number | null;
}

export interface PageInfo {
	viewport_width: number;
	viewport_height: number;
	page_width: number;
	page_height: number;
	scroll_x: number;
	scroll_y: number;
	pixels_above: number;
	pixels_below: number;
	pixels_left: number;
	pixels_right: number;
}

interface BrowserStateSummaryInit {
	url: string;
	title: string;
	tabs: TabInfo[];
	screenshot?: string | null;
	page_info?: PageInfo | null;
	pixels_above?: number;
	pixels_below?: number;
	browser_errors?: string[];
	is_pdf_viewer?: boolean;
	loading_status?: string | null;
}

export class BrowserStateSummary extends DOMState {
	url: string;
	title: string;
	tabs: TabInfo[];
	screenshot: string | null;
	page_info: PageInfo | null;
	pixels_above: number;
	pixels_below: number;
	browser_errors: string[];
	is_pdf_viewer: boolean;
	loading_status: string | null;

	constructor(dom_state: DOMState, init: BrowserStateSummaryInit) {
		super(dom_state.element_tree, dom_state.selector_map);
		this.url = init.url;
		this.title = init.title;
		this.tabs = init.tabs;
		this.screenshot = init.screenshot ?? null;
		this.page_info = init.page_info ?? null;
		this.pixels_above = init.pixels_above ?? 0;
		this.pixels_below = init.pixels_below ?? 0;
		this.browser_errors = init.browser_errors ?? [];
		this.is_pdf_viewer = init.is_pdf_viewer ?? false;
		this.loading_status = init.loading_status ?? null;
	}
}

export class BrowserStateHistory {
	constructor(
		public url: string,
		public title: string,
		public tabs: TabInfo[],
		public interacted_element: Array<DOMHistoryElement | null>,
		public screenshot_path: string | null = null,
	) {}

	get_screenshot() {
		if (!this.screenshot_path) {
			return null;
		}

		const resolved = path.resolve(this.screenshot_path);
		if (!fs.existsSync(resolved)) {
			return null;
		}

		try {
			const data = fs.readFileSync(resolved);
			return data.toString('base64');
		} catch {
			return null;
		}
	}

	to_dict() {
		return {
			tabs: this.tabs,
			screenshot_path: this.screenshot_path,
			interacted_element: this.interacted_element.map((element) => element?.to_dict?.() ?? null),
			url: this.url,
			title: this.title,
		};
	}
}

export class BrowserError extends Error {}

export class URLNotAllowedError extends BrowserError {}
