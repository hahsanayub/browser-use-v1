import { SchemaOptimizer } from '../schema.js';

export class MistralSchemaOptimizer {
  static readonly UNSUPPORTED_KEYWORDS = new Set([
    'minLength',
    'maxLength',
    'pattern',
    'format',
  ]);

  static createMistralCompatibleSchema(
    rawSchema: Record<string, unknown>,
    options: { removeMinItems?: boolean; removeDefaults?: boolean } = {}
  ): Record<string, unknown> {
    const baseSchema = SchemaOptimizer.createOptimizedJsonSchema(rawSchema, {
      removeMinItems: options.removeMinItems ?? false,
      removeDefaults: options.removeDefaults ?? false,
    });
    return this.stripUnsupportedKeywords(baseSchema as Record<string, unknown>);
  }

  static stripUnsupportedKeywords(value: unknown): any {
    if (Array.isArray(value)) {
      return value.map((item) => this.stripUnsupportedKeywords(item));
    }
    if (!value || typeof value !== 'object') {
      return value;
    }

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !this.UNSUPPORTED_KEYWORDS.has(key))
        .map(([key, item]) => [key, this.stripUnsupportedKeywords(item)])
    );
  }
}
