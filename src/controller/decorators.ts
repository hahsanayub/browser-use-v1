import { z } from 'zod';
import type { Page } from 'playwright';
import { registry } from './singleton.js';
import type { ActionResult } from '../types/agent';

export type ActionHandler = (args: {
  params: Record<string, unknown>;
  page: Page;
  context: Record<string, unknown>;
}) => Promise<ActionResult>;

export function action(
  name: string,
  description: string,
  paramSchema: z.ZodTypeAny = z.object({})
): MethodDecorator {
  return function (
    _target: any,
    _propertyKey: string | symbol,
    descriptor: PropertyDescriptor
  ) {
    const execute = descriptor.value as ActionHandler;
    registry.register({ name, description, paramSchema, execute });
  };
}


