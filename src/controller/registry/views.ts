import { z, type ZodTypeAny } from 'zod';
import type { Page } from '../../browser/types.js';
import { match_url_with_domain_pattern } from '../../utils.js';

const getPageUrl = (page: Page | null | undefined) => {
  if (!page) {
    return '';
  }
  const candidate = (page as any).url;
  if (typeof candidate === 'function') {
    try {
      return candidate.call(page);
    } catch {
      return '';
    }
  }
  return candidate ?? '';
};

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
    public readonly terminates_sequence = false
  ) {}

  promptDescription() {
    const skipKeys = new Set(['title']);
    let description = `${this.description}: \n`;
    description += `{${this.name}: `;

    const schemaShape =
      (this.paramSchema instanceof z.ZodObject && this.paramSchema.shape) ||
      ('shape' in this.paramSchema ? (this.paramSchema as any).shape : null);

    const hideStructuredDoneSuccess = Boolean(
      this.name === 'done' &&
        schemaShape &&
        typeof schemaShape === 'object' &&
        Object.prototype.hasOwnProperty.call(schemaShape, 'data') &&
        Object.prototype.hasOwnProperty.call(schemaShape, 'success')
    );
    if (hideStructuredDoneSuccess) {
      skipKeys.add('success');
    }

    if (schemaShape) {
      const props = Object.fromEntries(
        Object.entries(schemaShape)
          .filter(([key]) => !skipKeys.has(key))
          .map(([key, value]) => {
            const entries = value instanceof z.ZodType ? value._def : value;
            const cleanEntries = Object.fromEntries(
              Object.entries(entries as Record<string, unknown>).filter(
                ([propKey]) => !skipKeys.has(propKey)
              )
            );
            return [key, cleanEntries];
          })
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

  model_dump(options?: { exclude_none?: boolean }) {
    const clone = JSON.parse(JSON.stringify(this.data));
    if (options?.exclude_none) {
      for (const [key, value] of Object.entries(clone)) {
        if (value === null || value === undefined) {
          delete clone[key];
        }
      }
    }
    return clone;
  }

  model_dump_json(options?: { exclude_none?: boolean }) {
    return JSON.stringify(this.model_dump(options));
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

  remove(name: string) {
    this.actions.delete(name);
  }

  get(name: string) {
    return this.actions.get(name) ?? null;
  }

  getAll() {
    return Array.from(this.actions.values());
  }

  get actionsMap() {
    return new Map(this.actions);
  }

  get actionEntries() {
    return Array.from(this.actions.values());
  }

  private _matchDomains(domains: string[] | null, pageUrl: string) {
    if (!domains || domains.length === 0) {
      return true;
    }
    if (!pageUrl) {
      return false;
    }
    return domains.some((pattern) => {
      try {
        return match_url_with_domain_pattern(pageUrl, pattern);
      } catch {
        return false;
      }
    });
  }

  private _matchPageFilter(
    pageFilter: ((page: Page) => boolean) | null,
    page: Page
  ) {
    if (!pageFilter) {
      return true;
    }
    try {
      return pageFilter(page);
    } catch {
      return false;
    }
  }

  getAvailableActions(page?: Page | null, includeActions?: string[] | null) {
    const include = includeActions ? new Set(includeActions) : null;

    return this.actionEntries.filter((action) => {
      if (include && !include.has(action.name)) {
        return false;
      }

      if (!page) {
        return !action.pageFilter && !action.domains;
      }

      const pageUrl = getPageUrl(page);
      const domainAllowed = this._matchDomains(action.domains, pageUrl);
      const pageAllowed = this._matchPageFilter(action.pageFilter, page);
      return domainAllowed && pageAllowed;
    });
  }

  get_prompt_description(page?: Page | null) {
    return this.getAvailableActions(page)
      .map((action) => action.promptDescription())
      .join('\n');
  }
}

export class SpecialActionParameters {
  context: any | null = null;
  browser_session: BrowserSession | null = null;
  browser: BrowserSession | null = null;
  browser_context: BrowserSession | null = null;
  page: Page | null = null;
  page_extraction_llm: BaseChatModel | null = null;
  extraction_schema: Record<string, unknown> | null = null;
  file_system: FileSystem | null = null;
  available_file_paths: string[] | null = null;
  signal: AbortSignal | null = null;
  has_sensitive_data = false;

  static get_browser_requiring_params(): Set<string> {
    return new Set(['browser_session', 'browser', 'browser_context', 'page']);
  }
}
