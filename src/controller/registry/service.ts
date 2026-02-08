import { z, type ZodTypeAny } from 'zod';
import { createLogger } from '../../logging-config.js';
import { observe_debug } from '../../observability.js';
import { time_execution_async } from '../../utils.js';
import { is_new_tab_page, match_url_with_domain_pattern } from '../../utils.js';
import type { Page } from '../../browser/types.js';
import { BrowserError } from '../../browser/views.js';
import { FileSystem } from '../../filesystem/file-system.js';
import { ActionModel, ActionRegistry, RegisteredAction } from './views.js';

const logger = createLogger('browser_use.controller.registry');

import type { BrowserSession } from '../../browser/session.js';

type BaseChatModel = unknown;

export interface SensitiveDataMap {
  [key: string]: string | Record<string, string>;
}

export interface ExecuteActionContext<Context> {
  context?: Context;
  browser_session?: BrowserSession | null;
  page_extraction_llm?: BaseChatModel | null;
  file_system?: FileSystem | null;
  available_file_paths?: string[] | null;
  sensitive_data?: SensitiveDataMap | null;
  signal?: AbortSignal | null;
}

export type RegistryActionHandler<Params = any, Context = unknown> = (
  params: Params,
  ctx: ExecuteActionContext<Context> & {
    page?: Page | null;
    has_sensitive_data?: boolean;
  }
) => Promise<unknown> | unknown;

export interface ActionOptions {
  param_model?: ZodTypeAny;
  domains?: string[] | null;
  allowed_domains?: string[] | null;
  page_filter?: ((page: Page) => boolean) | null;
}

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AbortError';

const createAbortError = (reason?: unknown): Error => {
  if (isAbortError(reason)) {
    return reason as Error;
  }

  const message =
    reason instanceof Error ? reason.message : 'Operation aborted';
  const error = new Error(message);
  error.name = 'AbortError';
  if (reason !== undefined) {
    (error as Error & { cause?: unknown }).cause = reason;
  }
  return error;
};

const wrapActionExecutionError = (
  actionName: string,
  error: unknown
): Error => {
  if (error instanceof BrowserError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  const wrapped = new Error(`Error executing action ${actionName}: ${message}`);
  if (error !== undefined) {
    (wrapped as Error & { cause?: unknown }).cause = error;
  }
  return wrapped;
};

export class Registry<Context = unknown> {
  private registry = new ActionRegistry();
  private excludeActions: Set<string>;

  constructor(exclude_actions: string[] | null = null) {
    this.excludeActions = new Set(exclude_actions ?? []);
  }

  action(description: string, options: ActionOptions = {}) {
    const schema = options.param_model ?? z.object({}).strict();
    const domains = options.allowed_domains ?? options.domains ?? null;
    const pageFilter = options.page_filter ?? null;

    return <Params = any>(handler: RegistryActionHandler<Params, Context>) => {
      if (this.excludeActions.has(handler.name)) {
        return handler;
      }

      const action = new RegisteredAction(
        handler.name,
        description,
        handler,
        schema,
        domains,
        pageFilter
      );
      this.registry.register(action);
      return handler;
    };
  }

  public get_action(action_name: string) {
    return this.registry.get(action_name);
  }

  public get_all_actions() {
    return this.registry.actionsMap;
  }

  public execute_action = observe_debug({
    name: 'execute_action',
    ignore_input: true,
    ignore_output: true,
  })(
    time_execution_async('--execute_action')(
      async (
        action_name: string,
        params: Record<string, unknown>,
        {
          browser_session = null,
          page_extraction_llm = null,
          file_system = null,
          sensitive_data = null,
          available_file_paths = null,
          signal = null,
          context = null as unknown as Context,
        }: ExecuteActionContext<Context> = {}
      ) => {
        const action = this.registry.get(action_name);
        if (!action) {
          throw new Error(`Action ${action_name} not found`);
        }

        const parsed = action.paramSchema.safeParse(params);
        if (!parsed.success) {
          throw new Error(
            `Invalid parameters for action ${action_name}: ${parsed.error.message}`
          );
        }

        let validatedParams: any = parsed.data;

        let currentUrl: string | null = null;
        if (browser_session?.agent_current_page?.url) {
          currentUrl = browser_session.agent_current_page.url();
        } else if (browser_session?.get_current_page) {
          const currentPage = await browser_session.get_current_page();
          currentUrl = currentPage?.url() ?? null;
        }

        if (sensitive_data) {
          validatedParams = this.replace_sensitive_data(
            validatedParams,
            sensitive_data,
            currentUrl
          );
        }

        let page: Page | null = null;
        if (browser_session?.get_current_page) {
          page = await browser_session.get_current_page();
        }

        const ctx = {
          context,
          browser_session,
          browser: browser_session,
          browser_context: browser_session,
          page,
          page_extraction_llm,
          file_system,
          available_file_paths,
          signal,
          has_sensitive_data:
            action_name === 'input_text' && Boolean(sensitive_data),
        };

        if (signal?.aborted) {
          throw createAbortError(signal.reason);
        }

        try {
          return await action.handler(validatedParams, ctx);
        } catch (error) {
          if (signal?.aborted || isAbortError(error)) {
            throw createAbortError(signal?.reason ?? error);
          }
          throw wrapActionExecutionError(action_name, error);
        }
      }
    )
  );

  private replace_sensitive_data(
    params: any,
    sensitiveData: SensitiveDataMap,
    currentUrl: string | null
  ) {
    const secretPattern = /<secret>(.*?)<\/secret>/g;
    const applicableSecrets: Record<string, string> = {};

    for (const [domainOrKey, content] of Object.entries(sensitiveData)) {
      if (content && typeof content === 'object' && !Array.isArray(content)) {
        if (
          currentUrl &&
          !is_new_tab_page(currentUrl) &&
          match_url_with_domain_pattern(currentUrl, domainOrKey)
        ) {
          Object.assign(applicableSecrets, content);
        }
      } else if (typeof content === 'string') {
        applicableSecrets[domainOrKey] = content;
      }
    }

    const cloneValue = (value: any): any => {
      if (Array.isArray(value)) {
        return value.map((item) => cloneValue(item));
      }
      if (value && typeof value === 'object') {
        return Object.fromEntries(
          Object.entries(value).map(([k, v]) => [k, cloneValue(v)])
        );
      }
      return value;
    };

    const processed = cloneValue(params);
    const replaced = new Set<string>();
    const missing = new Set<string>();

    const traverse = (value: any): any => {
      if (typeof value === 'string') {
        return value.replace(secretPattern, (_, placeholder) => {
          if (placeholder in applicableSecrets) {
            replaced.add(placeholder);
            return applicableSecrets[placeholder];
          }
          missing.add(placeholder);
          return `<secret>${placeholder}</secret>`;
        });
      }
      if (Array.isArray(value)) {
        return value.map(traverse);
      }
      if (value && typeof value === 'object') {
        for (const [key, val] of Object.entries(value)) {
          value[key] = traverse(val);
        }
      }
      return value;
    };

    traverse(processed);
    this.log_sensitive_data_usage(replaced, currentUrl);
    if (missing.size > 0) {
      logger.warning(
        `Missing or empty keys in sensitive_data dictionary: ${Array.from(missing).join(', ')}`
      );
    }

    return processed;
  }

  private log_sensitive_data_usage(
    placeholders: Set<string>,
    currentUrl: string | null
  ) {
    if (!placeholders.size) {
      return;
    }
    const urlInfo =
      currentUrl && !is_new_tab_page(currentUrl) ? ` on ${currentUrl}` : '';
    logger.info(
      `🔒 Using sensitive data placeholders: ${Array.from(placeholders).join(', ')}${urlInfo}`
    );
  }

  create_action_model(
    options: {
      include_actions?: string[] | null;
      page?: Page | null;
    } = {}
  ) {
    const { include_actions = null, page = null } = options;
    const availableActions = this.registry.getAvailableActions(
      page,
      include_actions
    );

    class DynamicActionModel extends ActionModel {
      static available_actions = availableActions.map((action) => action.name);
    }

    Object.defineProperty(DynamicActionModel, 'name', {
      value: 'ActionModel',
    });

    return DynamicActionModel as typeof ActionModel;
  }

  get_prompt_description(page?: Page | null) {
    return this.registry.get_prompt_description(page ?? undefined);
  }
}
