import { z, type ZodTypeAny } from 'zod';
import type { Page } from '../../browser/types.js';
import { match_url_with_domain_pattern } from '../../utils.js';

export type ActionHandler = (...args: any[]) => Promise<unknown> | unknown;

type BrowserSession = unknown;
type BaseChatModel = unknown;
type FileSystem = unknown;

export class RegisteredAction {
	constructor(
		public readonly name: string,
		public readonly description: string,
		public readonly handler: ActionHandler,
		public readonly paramSchema: ZodTypeAny,
		public readonly domains: string[] | null = null,
		public readonly pageFilter: ((page: Page) => boolean) | null = null,
	) {}

	promptDescription() {
		const skipKeys = new Set(['title']);
		let description = `${this.description}: \n`;
		description += `{${this.name}: `;

		const schemaShape =
			(this.paramSchema instanceof z.ZodObject && this.paramSchema.shape) ||
			('shape' in this.paramSchema ? (this.paramSchema as any).shape : null);

		if (schemaShape) {
			const props = Object.fromEntries(
				Object.entries(schemaShape).map(([key, value]) => {
					const entries = value instanceof z.ZodType ? value._def : value;
					const cleanEntries = Object.fromEntries(
						Object.entries(entries as Record<string, unknown>).filter(([propKey]) => !skipKeys.has(propKey)),
					);
					return [key, cleanEntries];
				}),
			);
			description += JSON.stringify(props);
		} else {
			description += '{}';
		}

		description += '}';
		return description;
	}
}

export class ActionModel {
	constructor(initialData: Record<string, any> = {}) {
		this.data = initialData;
	}

	private data: Record<string, any>;

	toJSON() {
		return this.data;
	}

	get_index(): number | null {
		for (const value of Object.values(this.data)) {
			if (value && typeof value === 'object' && 'index' in value) {
				return (value as { index: number }).index ?? null;
			}
		}
		return null;
	}

	set_index(index: number) {
		const [actionName] = Object.keys(this.data);
		if (!actionName) {
			return;
		}
		const params = this.data[actionName];
		if (params && typeof params === 'object' && 'index' in params) {
			(params as { index: number }).index = index;
		}
	}
}

export class ActionRegistry {
	private actions = new Map<string, RegisteredAction>();

	register(action: RegisteredAction) {
		this.actions.set(action.name, action);
	}

	get actionEntries() {
		return Array.from(this.actions.values());
	}

	get_prompt_description(page?: Page) {
		if (!page) {
			return this.actionEntries
				.filter((action) => !action.pageFilter && !action.domains)
				.map((action) => action.promptDescription())
				.join('\n');
		}

		const filtered = this.actionEntries.filter((action) => {
			if (!action.domains && !action.pageFilter) {
				return false;
			}

			const domainAllowed =
				!action.domains ||
				action.domains.some((pattern) => match_url_with_domain_pattern(page.url(), pattern));
			const pageAllowed = action.pageFilter ? action.pageFilter(page) : true;
			return domainAllowed && pageAllowed;
		});

		return filtered.map((action) => action.promptDescription()).join('\n');
	}
}

export class SpecialActionParameters {
	context: any | null = null;
	browser_session: BrowserSession | null = null;
	browser: BrowserSession | null = null;
	browser_context: BrowserSession | null = null;
	page: Page | null = null;
	page_extraction_llm: BaseChatModel | null = null;
	file_system: FileSystem | null = null;
	available_file_paths: string[] | null = null;
	has_sensitive_data = false;

	static get_browser_requiring_params(): Set<string> {
		return new Set(['browser_session', 'browser', 'browser_context', 'page']);
	}
}
