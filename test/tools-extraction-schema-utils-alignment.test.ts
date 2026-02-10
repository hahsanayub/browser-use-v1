import { describe, expect, it } from 'vitest';
import {
  findUnsupportedJsonSchemaKeyword,
  normalizeStructuredDataBySchema,
  resolveDefaultForSchema,
  schemaDictToZodSchema,
} from '../src/tools/extraction/schema-utils.js';

describe('tools extraction schema utils alignment', () => {
  it('finds unsupported schema keywords recursively', () => {
    const keyword = findUnsupportedJsonSchemaKeyword({
      type: 'object',
      properties: {
        profile: {
          type: 'object',
          allOf: [{ type: 'string' }],
        },
      },
    });

    expect(keyword).toBe('allOf');
  });

  it('enforces top-level object schema with properties', () => {
    expect(() => schemaDictToZodSchema({ type: 'string' })).toThrow(
      'Top-level schema must have type "object"'
    );
    expect(() => schemaDictToZodSchema({ type: 'object', properties: {} })).toThrow(
      'Top-level schema must have at least one property'
    );
  });

  it('builds zod schema with python-aligned defaults for optional fields', () => {
    const schema = schemaDictToZodSchema({
      type: 'object',
      properties: {
        required_name: { type: 'string' },
        optional_text: { type: 'string' },
        optional_int: { type: 'integer' },
        optional_bool: { type: 'boolean' },
        optional_array: { type: 'array', items: { type: 'string' } },
        optional_enum: { type: 'string', enum: ['a', 'b'] },
        optional_object: {
          type: 'object',
          properties: {
            city: { type: 'string' },
            country: { type: 'string', default: 'US' },
          },
          required: ['city'],
        },
        nullable_number: { type: 'number', nullable: true },
        explicit_default: { type: 'string', default: 'preset' },
      },
      required: ['required_name'],
    });

    const parsed = schema.parse({ required_name: 'Ada' }) as Record<
      string,
      unknown
    >;

    expect(parsed).toMatchObject({
      required_name: 'Ada',
      optional_text: '',
      optional_int: 0,
      optional_bool: false,
      optional_array: [],
      optional_enum: null,
      optional_object: null,
      nullable_number: null,
      explicit_default: 'preset',
    });
  });

  it('supports nested object defaults when nested value is present', () => {
    const schema = schemaDictToZodSchema({
      type: 'object',
      properties: {
        profile: {
          type: 'object',
          properties: {
            city: { type: 'string' },
            country: { type: 'string', default: 'US' },
          },
          required: ['city'],
        },
      },
    });

    const parsed = schema.parse({
      profile: { city: 'NYC' },
    }) as Record<string, any>;

    expect(parsed.profile).toEqual({
      city: 'NYC',
      country: 'US',
    });
  });

  it('normalizes extracted data with schema defaults while preserving unknown fields', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'integer' },
        tags: { type: 'array', items: { type: 'string' } },
        choice: { type: 'string', enum: ['a', 'b'] },
        meta: {
          type: 'object',
          properties: {
            note: { type: 'string' },
          },
        },
      },
      required: ['name'],
    };

    const normalized = normalizeStructuredDataBySchema(
      { name: 'Ada', meta: {}, extra_field: 42 },
      schema
    ) as Record<string, unknown>;

    expect(normalized).toMatchObject({
      name: 'Ada',
      age: 0,
      tags: [],
      choice: null,
      meta: { note: '' },
      extra_field: 42,
    });
  });

  it('resolveDefaultForSchema follows python-aligned fallback defaults', () => {
    expect(resolveDefaultForSchema({ type: 'string' })).toBe('');
    expect(resolveDefaultForSchema({ type: 'integer' })).toBe(0);
    expect(resolveDefaultForSchema({ type: 'boolean' })).toBe(false);
    expect(resolveDefaultForSchema({ type: 'array' })).toEqual([]);
    expect(resolveDefaultForSchema({ type: 'string', enum: ['x'] })).toBeNull();
    expect(resolveDefaultForSchema({ type: 'number', nullable: true })).toBeNull();
  });
});
