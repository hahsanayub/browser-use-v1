import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../logging-config.js';
import { observe_debug } from '../observability.js';
import { time_execution_async } from '../utils.js';
import { is_new_tab_page } from '../utils.js';
import type { Page } from '../browser/types.js';
import { DOMBaseNode, DOMElementNode, DOMState, DOMTextNode, type SelectorMap } from './views.js';

type SerializedDOMNode = {
	type: string;
	text?: string;
	isVisible?: boolean;
	tagName?: string;
	xpath?: string;
	attributes?: Record<string, string>;
	children?: Array<number | string>;
	isInteractive?: boolean;
	isTopElement?: boolean;
	isInViewport?: boolean;
	shadowRoot?: boolean;
	highlightIndex?: number | null;
	pageCoordinates?: unknown;
	viewportCoordinates?: unknown;
	viewportInfo?: unknown;
	isNew?: boolean | null;
};

type SerializedDOMTree = {
	map: Record<string, SerializedDOMNode>;
	rootId: string | number;
};

const DOM_TREE_SCRIPT = fs.readFileSync(fileURLToPath(new URL('./dom_tree/index.js', import.meta.url)), 'utf-8');

export class DomService {
	private readonly logger;
	private readonly jsCode: string;

	constructor(private readonly page: Page, logger = createLogger('browser_use.dom.service')) {
		this.logger = logger;
		this.jsCode = DOM_TREE_SCRIPT;
	}

	@observe_debug({ ignore_input: true, ignore_output: true, name: 'get_clickable_elements' })
	@time_execution_async('--get_clickable_elements')
	async get_clickable_elements(
		highlight_elements = true,
		focus_element = -1,
		viewport_expansion = 0,
	) {
		const [element_tree, selector_map] = await this._build_dom_tree(highlight_elements, focus_element, viewport_expansion);
		return new DOMState(element_tree, selector_map);
	}

	@time_execution_async('--get_cross_origin_iframes')
	async get_cross_origin_iframes() {
		const hiddenFrameUrls = await this.page
			.locator('iframe')
			.evaluateAll((elements) =>
				elements
					.filter((el) => {
						const element = el as HTMLElement;
						const style = window.getComputedStyle(element);
						const rect = element.getBoundingClientRect();
						return (
							style.visibility === 'hidden' ||
							style.display === 'none' ||
							rect.width === 0 ||
							rect.height === 0
						);
					})
					.map((el) => (el as HTMLIFrameElement).src),
			);

		const currentHost = this.safeHostname(this.getPageUrl());

		return this.getFrames()
			.map((frame) => this.getFrameUrl(frame))
			.filter((url: string | null) => {
				if (!url) return false;
				const host = this.safeHostname(url);
				if (!host) return false;
				if (host === currentHost) return false;
				if (hiddenFrameUrls.includes(url)) return false;
				return !this.isAdUrl(url);
			});
	}

	@time_execution_async('--build_dom_tree')
	private async _build_dom_tree(highlight_elements: boolean, focus_element: number, viewport_expansion: number) {
		const canEvaluate = await this.page.evaluate(() => 1 + 1);
		if (canEvaluate !== 2) {
			throw new Error('The page cannot evaluate JavaScript code properly');
		}

		const pageUrl = this.getPageUrl();
		if (is_new_tab_page(pageUrl) || pageUrl.startsWith('chrome://')) {
			return [
				new DOMElementNode(false, null, 'body', '', {}, []),
				{} as SelectorMap,
			] as const;
		}

		const args = {
			doHighlightElements: highlight_elements,
			focusHighlightIndex: focus_element,
			viewportExpansion: viewport_expansion,
			debugMode: this.isDebugEnabled(),
		};

		let eval_page: SerializedDOMTree;
		try {
			this.logger.debug(`🔧 Starting JavaScript DOM analysis for ${pageUrl.slice(0, 50)}...`);
			eval_page = await this.page.evaluate(
				(script, evaluateArgs) => {
					const fn = eval(script);
					return fn(evaluateArgs);
				},
				this.jsCode,
				args,
			);
			this.logger.debug('✅ JavaScript DOM analysis completed');
		} catch (error) {
			this.logger.error(`Error evaluating DOMTree: ${(error as Error).message}`);
			throw error;
		}

		if (args.debugMode && (eval_page as any).perfMetrics) {
			const perf = (eval_page as any).perfMetrics;
			const totalNodes = perf?.nodeMetrics?.totalNodes ?? 0;
			let interactiveCount = 0;
			if ((eval_page as any).map) {
				for (const node of Object.values((eval_page as any).map)) {
					if ((node as any)?.isInteractive) {
						interactiveCount += 1;
					}
				}
			}
			this.logger.debug(
				`🔎 Ran buildDOMTree.js interactive element detection on: ${pageUrl.slice(0, 50)} interactive=${interactiveCount}/${totalNodes}`,
			);
		}

		this.logger.debug('🔄 Starting DOM tree construction...');
		const result = await this._construct_dom_tree(eval_page);
		this.logger.debug('✅ DOM tree construction completed');
		return result;
	}

	@time_execution_async('--construct_dom_tree')
	private async _construct_dom_tree(eval_page: SerializedDOMTree) {
		const selector_map: SelectorMap = {};
		const node_map = new Map<string, DOMBaseNode>();
		const child_index = new Map<string, Array<number | string>>();

		for (const [id, node_data] of Object.entries(eval_page.map)) {
			const [node, children] = this._parse_node(node_data);
			if (!node) continue;
			node_map.set(id, node);
			child_index.set(id, children);

			if (node instanceof DOMElementNode && node.highlight_index !== null && node.highlight_index !== undefined) {
				selector_map[node.highlight_index] = node;
			}
		}

		for (const [id, childrenIds] of child_index.entries()) {
			const parentNode = node_map.get(id);
			if (!(parentNode instanceof DOMElementNode)) continue;
			for (const childId of childrenIds || []) {
				const key = String(childId);
				const childNode = node_map.get(key);
				if (!childNode) continue;
				childNode.parent = parentNode;
				parentNode.children.push(childNode);
			}
		}

		const rootNode = node_map.get(String(eval_page.rootId));
		if (!(rootNode instanceof DOMElementNode)) {
			throw new Error('Failed to construct DOM tree');
		}

		return [rootNode, selector_map] as const;
	}

	private _parse_node(node_data: SerializedDOMNode): [DOMBaseNode | null, Array<number | string>] {
		if (!node_data) {
			return [null, []];
		}

		if (node_data.type === 'TEXT_NODE') {
			const textNode = new DOMTextNode(node_data.isVisible ?? false, null, node_data.text ?? '');
			return [textNode, []];
		}

		const children = Array.isArray(node_data.children) ? node_data.children : [];
		const tag = node_data.tagName ?? 'div';
		const xpath = node_data.xpath ?? '';
		const attributes = node_data.attributes ?? {};
	const element = new DOMElementNode(node_data.isVisible ?? false, null, tag, xpath, attributes, []);

		element.is_interactive = Boolean(node_data.isInteractive);
		element.is_top_element = Boolean(node_data.isTopElement);
		element.is_in_viewport = Boolean(node_data.isInViewport);
		element.shadow_root = Boolean(node_data.shadowRoot);
		element.highlight_index =
			node_data.highlightIndex === undefined || node_data.highlightIndex === null
				? null
				: Number(node_data.highlightIndex);
		element.page_coordinates = (node_data.pageCoordinates as any) ?? null;
		element.viewport_coordinates = (node_data.viewportCoordinates as any) ?? null;
		element.viewport_info = (node_data.viewportInfo as any) ?? null;
		element.is_new = node_data.isNew ?? null;

		return [element, children];
	}

	private safeHostname(url: string | null) {
		if (!url) return '';
		try {
			return new URL(url).hostname;
		} catch {
			return '';
		}
	}

	private getFrames() {
		const frames = (this.page as any).frames;
		return typeof frames === 'function' ? frames.call(this.page) : frames ?? [];
	}

	private getFrameUrl(frame: any) {
		return typeof frame.url === 'function' ? frame.url() : frame.url ?? '';
	}

	private isAdUrl(url: string) {
		const host = this.safeHostname(url);
		return ['doubleclick.net', 'adroll.com', 'googletagmanager.com'].some((domain) => host.endsWith(domain));
	}

	private getPageUrl() {
		return typeof (this.page as any).url === 'function' ? (this.page as any).url() : (this.page as any).url ?? '';
	}

	private isDebugEnabled() {
		return (process.env.BROWSER_USE_LOGGING_LEVEL ?? '').toLowerCase() === 'debug';
	}
}
