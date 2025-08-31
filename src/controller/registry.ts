import { z } from 'zod';
import type { Page } from 'playwright';
import type { ActionResult } from '../types/agent';
import { matchUrlWithDomainPattern, isNewTabPage, validateDomainPatterns } from '../utils/domain-matcher';
import { getLogger } from '../services/logging';

export interface RegisteredAction {
  name: string;
  description: string;
  /** Schema for the params object that action expects */
  paramSchema: z.ZodTypeAny;
  /** Execute handler. Context is injected automatically. */
  execute: (args: {
    params: Record<string, unknown>;
    page: Page;
    context: Record<string, unknown>;
  }) => Promise<ActionResult>;
  /** Optional predicate to determine if action is available for current page */
  isAvailableForPage?: (page: Page) => Promise<boolean> | boolean;
  /** Domain patterns for filtering actions by URL (e.g., ['*.google.com', 'www.bing.com']) */
  domains?: string[];

  /**
   * Generate a structured description of this action for the prompt
   */
  promptDescription(): string;
}

/**
 * Enhanced in-memory registry for actions with domain security
 */
export class ActionRegistry {
  private actions: Map<string, RegisteredAction> = new Map();
  private logger = getLogger();

  register(action: RegisteredAction): void {
    // Validate domain patterns for security
    if (action.domains) {
      const validation = validateDomainPatterns(action.domains);
      if (!validation.isValid) {
        this.logger.error(`Invalid domain patterns for action ${action.name}:`, validation.errors);
        throw new Error(`Invalid domain patterns for action ${action.name}: ${validation.errors.join(', ')}`);
      }
      if (validation.warnings.length > 0) {
        this.logger.warn(`Domain pattern warnings for action ${action.name}:`, validation.warnings);
      }
    }

    // Log registration with domain info
    const domainInfo = action.domains ? `[${action.domains.join(', ')}]` : '[no domain restrictions]';
    this.logger.debug(`Registering action: ${action.name} ${domainInfo}`);
    
    this.actions.set(action.name, action);
  }

  get(name: string): RegisteredAction | undefined {
    return this.actions.get(name);
  }

  has(name: string): boolean {
    return this.actions.has(name);
  }

  unregister(name: string): boolean {
    return this.actions.delete(name);
  }

  list(): RegisteredAction[] {
    return Array.from(this.actions.values());
  }

  /** Get action names */
  names(): string[] {
    return Array.from(this.actions.keys());
  }

  /**
   * Match a list of domain patterns against a URL with enhanced security
   * Equivalent to Python's _match_domains with security improvements
   * @param domains Domain patterns that can include wildcards 
   * @param url The URL to match against
   * @returns True if the URL's domain matches any pattern, False otherwise
   */
  private static matchDomains(
    domains: string[] | undefined,
    url: string
  ): boolean {
    if (!domains || domains.length === 0) {
      return true; // No restrictions
    }
    
    if (!url || isNewTabPage(url)) {
      return true; // Allow new tab pages
    }

    // Use the secure domain matching function from utils
    return domains.some(pattern => 
      matchUrlWithDomainPattern(url, pattern, true) // Enable warnings for debugging
    );
  }

  /**
   * Get a description of all actions for the prompt
   * @param pageUrl If provided, filter actions by URL using domain filters
   * @returns A string description of available actions
   */
  getPromptDescription(pageUrl?: string): string {
    if (!pageUrl) {
      // For system prompt (no URL provided), include only actions with no domain filters
      return this.list()
        .filter((action) => !action.domains)
        .map((action) => action.promptDescription())
        .join('\n');
    }

    // Only include filtered actions for the current page URL
    const filteredActions = this.list().filter((action) => {
      if (!action.domains) {
        // Skip actions with no filters, they are already included in the system prompt
        return false;
      }
      // Check domain filter
      return ActionRegistry.matchDomains(action.domains, pageUrl);
    });

    return filteredActions
      .map((action) => action.promptDescription())
      .join('\n');
  }

  /**
   * Build a dynamic Zod union schema representing available actions for a page.
   * Each variant is an object keyed by action name and mapping to its param schema.
   *
   * Example: z.union([ z.object({ scroll: z.object({down:z.boolean(), num_pages:z.number()}) }), ... ])
   */
  buildDynamicActionSchemaForPage(page?: Page): z.ZodUnion<any> {
    const variants: z.ZodTypeAny[] = [];
    for (const a of this.actions.values()) {
      // Check both domain filtering and isAvailableForPage
      if (page) {
        const pageUrl = page.url();

        // Check domain filtering
        if (a.domains && !ActionRegistry.matchDomains(a.domains, pageUrl)) {
          continue;
        }

        // Check isAvailableForPage predicate
        if (a.isAvailableForPage) {
          const available = a.isAvailableForPage(page);
          if (typeof available === 'boolean' && !available) continue;
        }
      }

      const variant = z.object({
        [a.name]: a.paramSchema,
      }) as z.ZodTypeAny;
      variants.push(variant);
    }
    if (variants.length === 0) {
      const fallback = z.object({ _placeholder: z.string() });
      return z.union([fallback, fallback]) as unknown as z.ZodUnion<any>;
    }
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - Variadic union typing
    return z.union(variants);
  }
}
