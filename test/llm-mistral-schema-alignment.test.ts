import { describe, expect, it } from 'vitest';
import { MistralSchemaOptimizer } from '../src/llm/mistral/schema.js';

describe('Mistral schema alignment', () => {
  it('strips mistral-unsupported schema keywords recursively', () => {
    const schema = {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          minLength: 5,
          maxLength: 120,
          format: 'email',
          pattern: '^.+@.+$',
        },
        profile: {
          type: 'object',
          properties: {
            code: {
              type: 'string',
              minLength: 2,
            },
          },
        },
      },
      required: ['email'],
    };

    const compatible = MistralSchemaOptimizer.stripUnsupportedKeywords(schema);
    const serialized = JSON.stringify(compatible);

    expect(serialized).not.toContain('minLength');
    expect(serialized).not.toContain('maxLength');
    expect(serialized).not.toContain('pattern');
    expect(serialized).not.toContain('format');
    expect((compatible as any).properties.email.type).toBe('string');
    expect((compatible as any).properties.profile.type).toBe('object');
  });

  it('applies base schema optimization before mistral keyword stripping', () => {
    const schema = {
      type: 'object',
      properties: {
        tags: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
        },
        title: {
          type: 'string',
          default: 'preset',
          minLength: 1,
        },
      },
      required: ['tags'],
    };

    const compatible = MistralSchemaOptimizer.createMistralCompatibleSchema(
      schema as Record<string, unknown>,
      { removeMinItems: true, removeDefaults: true }
    );
    const serialized = JSON.stringify(compatible);

    expect(serialized).not.toContain('minItems');
    expect(serialized).not.toContain('"default"');
    expect(serialized).not.toContain('minLength');
  });
});
