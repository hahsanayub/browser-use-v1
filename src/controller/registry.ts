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
}


