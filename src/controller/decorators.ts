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
  paramSchema: z.ZodTypeAny = z.object({}),
  options?: {
    isAvailableForPage?: (page: Page) => Promise<boolean> | boolean;
    domains?: string[];
  }
): MethodDecorator {
  return function (
    _target: any,
    _propertyKey: string | symbol,
    descriptor: PropertyDescriptor
  ) {
    const execute = descriptor.value as ActionHandler;

    // Generate prompt description from schema
    const promptDescription = (): string => {
      const skipKeys = ['title'];
      let s = `${description}: \n`;
      s += `{${name}: `;

      try {
        const schemaData = paramSchema._def;
        if (schemaData && schemaData.shape) {
          // Handle z.object() schemas
          const properties: Record<string, any> = {};
          for (const [key, value] of Object.entries(schemaData.shape())) {
            if (!skipKeys.includes(key)) {
              properties[key] = getZodSchemaDescription(value as z.ZodTypeAny);
            }
          }
          s += JSON.stringify(properties);
        } else {
          // Fallback for other schema types
          s += JSON.stringify({});
        }
      } catch {
        // If schema parsing fails, provide empty object
        s += JSON.stringify({});
      }

      s += '}';
      return s;
    };

    registry.register({
      name,
      description,
      paramSchema,
      execute,
      promptDescription,
      ...(options ?? {}),
    });
  };
}

/**
 * Extract description from Zod schema for prompt generation
 */
function getZodSchemaDescription(schema: z.ZodTypeAny): any {
  const def = schema._def;

  if (def.typeName === 'ZodString') {
    return { type: 'string', description: def.description || 'string value' };
  } else if (def.typeName === 'ZodNumber') {
    return { type: 'number', description: def.description || 'numeric value' };
  } else if (def.typeName === 'ZodBoolean') {
    return { type: 'boolean', description: def.description || 'true or false' };
  } else if (def.typeName === 'ZodEnum') {
    return { type: 'enum', options: def.values, description: def.description || 'one of the allowed values' };
  } else if (def.typeName === 'ZodArray') {
    return { type: 'array', description: def.description || 'array of values' };
  } else if (def.typeName === 'ZodObject') {
    const properties: Record<string, any> = {};
    if (def.shape) {
      for (const [key, value] of Object.entries(def.shape())) {
        properties[key] = getZodSchemaDescription(value as z.ZodTypeAny);
      }
    }
    return { type: 'object', properties, description: def.description || 'object' };
  } else if (def.typeName === 'ZodOptional') {
    return { ...getZodSchemaDescription(def.innerType), optional: true };
  } else if (def.typeName === 'ZodDefault') {
    // Handle default values like z.string().default('hello')
    return { ...getZodSchemaDescription(def.innerType), default: def.defaultValue() };
  } else if (def.typeName === 'ZodUnion') {
    // Handle union types like z.union([z.string(), z.number()])
    const options = def.options.map((option: z.ZodTypeAny) => {
      const optionDesc = getZodSchemaDescription(option);
      return optionDesc.type;
    });
    return {
      type: 'union',
      options: options,
      description: def.description || `one of: ${options.join(' | ')}`
    };
  } else {
    return { type: 'unknown', description: def.description || 'value' };
  }
}
