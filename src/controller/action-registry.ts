/**
 * Action Registry - Node.js Implementation  
 * Port of Python version's domain-restricted action system
 *
 * This module provides secure action registration and execution
 * with domain restrictions and page filtering capabilities.
 */

import type { Page, BrowserContext } from 'playwright';
import { matchUrlWithDomainPattern, isNewTabPage } from '../utils/domain-matcher';
import { getLogger } from '../services/logging';

let logger: ReturnType<typeof getLogger>;

/**
 * Initialize logger if not already done
 */
function initLogger() {
  if (!logger) {
    logger = getLogger();
  }
}

/**
 * Options for action registration
 */
export interface ActionOptions {
  /** List of domain patterns that this action is restricted to */
  domains?: string[];
  /** Alias for domains (for backward compatibility) */
  allowedDomains?: string[];
  /** Custom function to determine if action is available for a page */
  pageFilter?: (page: Page) => boolean | Promise<boolean>;
  /** Whether this action requires a browser session */
  requiresBrowser?: boolean;
  /** Whether this action requires a specific page context */
  requiresPage?: boolean;
}

/**
 * Registered action information
 */
export interface RegisteredAction {
  name: string;
  description: string;
  handler: Function;
  options: ActionOptions;
  parameterSchema?: any; // JSON schema for parameters
}

/**
 * Result of action availability check
 */
export interface ActionAvailabilityResult {
  available: boolean;
  reason?: string;
  domainMatch?: boolean;
  pageFilterMatch?: boolean;
}

/**
 * Action Registry for managing domain-restricted actions
 */
export class ActionRegistry {
  private actions = new Map<string, RegisteredAction>();
  private excludeActions: Set<string>;

  constructor(excludeActions?: string[]) {
    this.excludeActions = new Set(excludeActions || []);
    initLogger();
  }

  /**
   * Register an action with domain restrictions and page filtering
   * Equivalent to Python's @registry.action decorator
   * 
   * @param name - Action name
   * @param description - Action description
   * @param handler - Action handler function
   * @param options - Action options including domain restrictions
   */
  registerAction(
    name: string, 
    description: string, 
    handler: Function, 
    options: ActionOptions = {}
  ): void {
    // Skip registration if action is in exclude list
    if (this.excludeActions.has(name)) {
      logger.debug(`Skipping registration of excluded action: ${name}`);
      return;
    }

    // Handle aliases: domains and allowedDomains are the same parameter
    if (options.allowedDomains && options.domains) {
      throw new Error("Cannot specify both 'domains' and 'allowedDomains' - they are aliases for the same parameter");
    }

    const finalDomains = options.allowedDomains || options.domains;
    const normalizedOptions: ActionOptions = {
      ...options,
      domains: finalDomains,
      allowedDomains: undefined, // Remove alias
    };

    const action: RegisteredAction = {
      name,
      description,
      handler,
      options: normalizedOptions,
    };

    this.actions.set(name, action);
    
    const domainInfo = finalDomains ? `[${finalDomains.join(', ')}]` : '[no domain restrictions]';
    logger.debug(`Registered action: ${name} ${domainInfo}`);
  }

  /**
   * Action decorator that mimics Python's @registry.action decorator
   * 
   * Usage:
   * @actionRegistry.action('Action description', { domains: ['https://example.com'] })
   * async function myAction(params: MyParams) { ... }
   */
  action(description: string, options: ActionOptions = {}) {
    return (target: any, propertyKey: string, descriptor: PropertyDescriptor) => {
      const originalMethod = descriptor.value;
      
      // Register the action
      this.registerAction(propertyKey, description, originalMethod, options);
      
      return descriptor;
    };
  }

  /**
   * Check if an action is available for a specific page
   * Equivalent to Python's domain and page filter checking
   * 
   * @param actionName - Name of the action
   * @param page - Page to check against (optional)
   * @returns ActionAvailabilityResult - Availability info
   */
  async isActionAvailable(actionName: string, page?: Page): Promise<ActionAvailabilityResult> {
    const action = this.actions.get(actionName);
    if (!action) {
      return { available: false, reason: 'Action not found' };
    }

    // If no page provided, only allow actions with no restrictions
    if (!page) {
      const hasRestrictions = action.options.domains || action.options.pageFilter;
      return {
        available: !hasRestrictions,
        reason: hasRestrictions ? 'Action has restrictions but no page provided' : undefined,
      };
    }

    // Check domain restrictions
    const domainMatch = this.matchDomains(action.options.domains, page.url());
    if (!domainMatch) {
      return {
        available: false,
        reason: 'Page domain not allowed for this action',
        domainMatch: false,
      };
    }

    // Check page filter
    let pageFilterMatch = true;
    if (action.options.pageFilter) {
      try {
        pageFilterMatch = await action.options.pageFilter(page);
      } catch (error) {
        logger.error(`Error in page filter for action ${actionName}:`, error as Error);
        pageFilterMatch = false;
      }
    }

    if (!pageFilterMatch) {
      return {
        available: false,
        reason: 'Page filter check failed',
        domainMatch: true,
        pageFilterMatch: false,
      };
    }

    return {
      available: true,
      domainMatch: true,
      pageFilterMatch: true,
    };
  }

  /**
   * Get all actions available for a specific page
   * @param page - Page to check against (optional)
   * @returns RegisteredAction[] - Available actions
   */
  async getAvailableActions(page?: Page): Promise<RegisteredAction[]> {
    const availableActions: RegisteredAction[] = [];

    for (const action of this.actions.values()) {
      const result = await this.isActionAvailable(action.name, page);
      if (result.available) {
        availableActions.push(action);
      }
    }

    return availableActions;
  }

  /**
   * Get action by name
   * @param name - Action name
   * @returns RegisteredAction | undefined
   */
  getAction(name: string): RegisteredAction | undefined {
    return this.actions.get(name);
  }

  /**
   * Get all registered actions
   * @returns RegisteredAction[]
   */
  getAllActions(): RegisteredAction[] {
    return Array.from(this.actions.values());
  }

  /**
   * Execute an action with security checks
   * @param actionName - Name of the action to execute
   * @param params - Action parameters
   * @param context - Execution context (page, browser session, etc.)
   * @returns Promise<any> - Action result
   */
  async executeAction(
    actionName: string, 
    params: any, 
    context: {
      page?: Page;
      browserContext?: BrowserContext;
      [key: string]: any;
    } = {}
  ): Promise<any> {
    const action = this.actions.get(actionName);
    if (!action) {
      throw new Error(`Action '${actionName}' not found`);
    }

    // Check if action is available for the current page
    if (context.page) {
      const availability = await this.isActionAvailable(actionName, context.page);
      if (!availability.available) {
        throw new Error(`Action '${actionName}' not available: ${availability.reason}`);
      }
    }

    // Execute the action
    try {
      logger.debug(`Executing action: ${actionName}`);
      const result = await action.handler(params, context);
      logger.debug(`Action executed successfully: ${actionName}`);
      return result;
    } catch (error) {
      logger.error(`Error executing action ${actionName}:`, error as Error);
      throw error;
    }
  }

  /**
   * Get prompt description for available actions
   * Similar to Python's get_prompt_description
   * 
   * @param page - Page to filter actions for
   * @returns string - Description of available actions
   */
  async getPromptDescription(page?: Page): Promise<string> {
    const availableActions = await this.getAvailableActions(page);
    
    if (availableActions.length === 0) {
      return 'No actions available for the current page.';
    }

    const descriptions = availableActions.map(action => {
      const domainInfo = action.options.domains 
        ? ` (domains: ${action.options.domains.join(', ')})` 
        : '';
      return `${action.name}: ${action.description}${domainInfo}`;
    });

    return descriptions.join('\n');
  }

  /**
   * Match domains against URL - equivalent to Python's _match_domains
   * @param domains - Domain patterns to match
   * @param url - URL to check
   * @returns boolean - True if URL matches any domain pattern
   */
  private matchDomains(domains: string[] | undefined, url: string): boolean {
    if (!domains || domains.length === 0) {
      return true; // No domain restrictions
    }

    if (!url || isNewTabPage(url)) {
      return true; // Allow new tab pages
    }

    return domains.some(pattern => 
      matchUrlWithDomainPattern(url, pattern, true)
    );
  }

  /**
   * Clear all registered actions
   */
  clear(): void {
    this.actions.clear();
    logger.debug('Action registry cleared');
  }

  /**
   * Get count of registered actions
   * @returns number - Count of registered actions
   */
  getActionCount(): number {
    return this.actions.size;
  }

  /**
   * Check if action exists
   * @param name - Action name
   * @returns boolean - True if action exists
   */
  hasAction(name: string): boolean {
    return this.actions.has(name);
  }

  /**
   * Remove action from registry
   * @param name - Action name
   * @returns boolean - True if action was removed
   */
  removeAction(name: string): boolean {
    const existed = this.actions.has(name);
    this.actions.delete(name);
    if (existed) {
      logger.debug(`Removed action: ${name}`);
    }
    return existed;
  }

  /**
   * Get actions filtered by domain
   * @param domainPattern - Domain pattern to filter by
   * @returns RegisteredAction[] - Actions restricted to the domain
   */
  getActionsByDomain(domainPattern: string): RegisteredAction[] {
    return Array.from(this.actions.values()).filter(action => 
      action.options.domains?.some(domain => 
        matchUrlWithDomainPattern('https://example.com', domain, false) === 
        matchUrlWithDomainPattern('https://example.com', domainPattern, false)
      )
    );
  }

  /**
   * Validate all registered actions for security issues
   * @returns ValidationIssue[] - Any security issues found
   */
  validateSecurity(): SecurityValidationIssue[] {
    const issues: SecurityValidationIssue[] = [];

    for (const action of this.actions.values()) {
      if (!action.options.domains || action.options.domains.length === 0) {
        issues.push({
          type: 'warning',
          actionName: action.name,
          message: 'Action has no domain restrictions and can be used on any page',
        });
      } else {
        // Check for overly broad patterns
        const broadPatterns = action.options.domains.filter(domain => 
          ['*', '*.*', '*.com', '*.org', '*.net'].includes(domain.toLowerCase())
        );
        
        if (broadPatterns.length > 0) {
          issues.push({
            type: 'warning',
            actionName: action.name,
            message: `Action has overly broad domain patterns: ${broadPatterns.join(', ')}`,
          });
        }
      }
    }

    return issues;
  }
}

/**
 * Security validation issue
 */
export interface SecurityValidationIssue {
  type: 'error' | 'warning';
  actionName: string;
  message: string;
}

/**
 * Default action registry instance
 */
export const actionRegistry = new ActionRegistry();