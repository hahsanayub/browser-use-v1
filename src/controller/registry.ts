import { z } from 'zod';
import type { Page } from 'playwright';
import type { ActionResult } from '../types/agent';

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
}

/**
 * Simple in-memory registry for actions
 */
export class ActionRegistry {
  private actions: Map<string, RegisteredAction> = new Map();

  register(action: RegisteredAction): void {
    if (this.actions.has(action.name)) {
      throw new Error(`Action already registered: ${action.name}`);
    }
    this.actions.set(action.name, action);
  }

  get(name: string): RegisteredAction | undefined {
    return this.actions.get(name);
  }

  list(): RegisteredAction[] {
    return Array.from(this.actions.values());
  }

  /** Get action names */
  names(): string[] {
    return Array.from(this.actions.keys());
  }

  /**
   * Build a dynamic Zod union schema representing available actions for a page.
   * Each variant is an object keyed by action name and mapping to its param schema.
   * Example: z.union([ z.object({ click: z.object({selector:z.string()}) }), ... ])
   */
  buildDynamicActionSchemaForPage(page?: Page): z.ZodUnion<any> {
    const variants: z.ZodTypeAny[] = [];
    for (const a of this.actions.values()) {
      if (page && a.isAvailableForPage) {
        const available = a.isAvailableForPage(page);
        if (typeof available === 'boolean' && !available) continue;
      }
      // Expect normalized shape: { action: '<name>', ...params }
      const variant = (z.object({ action: z.literal(a.name) }).and(a.paramSchema)) as z.ZodTypeAny;
      variants.push(variant);
    }
    if (variants.length === 0) {
      const fallback = z.object({ action: z.string() });
      return z.union([fallback, fallback]) as unknown as z.ZodUnion<any>;
    }
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - Variadic union typing
    return z.union(variants);
  }
}
