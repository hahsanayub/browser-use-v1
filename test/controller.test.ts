/**
 * Comprehensive tests for the Controller and Registry system.
 *
 * Tests cover:
 * 1. Action registration and execution
 * 2. Parameter patterns (individual params, Zod models)
 * 3. Action validation and error handling
 * 4. Built-in actions patterns (click, input, scroll, navigate, etc.)
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { z } from 'zod';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Mock utils to avoid decorator issues
vi.mock('../src/utils.js', () => {
  let counter = 0;
  const decorator =
    <T extends (...args: any[]) => any>(_label?: string) =>
    (fn: T) =>
      fn;

  return {
    uuid7str: () => `uuid-${++counter}`,
    time_execution_sync: decorator,
    time_execution_async: decorator,
    SignalHandler: class {
      register() {}
      reset() {}
      unregister() {}
    },
    get_browser_use_version: () => 'test-version',
    is_new_tab_page: (url: string) =>
      url === 'about:blank' || url.startsWith('chrome://'),
    match_url_with_domain_pattern: (url: string, pattern: string) => {
      if (!pattern) return false;
      const normalized = pattern.replace(/\*/g, '');
      return url.includes(normalized);
    },
    log_pretty_path: (p: string) => p,
  };
});

let mockedPdfPages: string[] = [];
vi.mock('pdf-parse', () => {
  class PDFParse {
    constructor(_options: { data: Buffer }) {}

    async getInfo() {
      return { total: Math.max(1, mockedPdfPages.length) };
    }

    async getText(options?: { partial?: number[] }) {
      const partial = options?.partial;
      if (Array.isArray(partial) && partial.length > 0) {
        const pageNumber = partial[0] ?? 1;
        return { text: mockedPdfPages[pageNumber - 1] ?? '' };
      }
      return { text: mockedPdfPages.join('\n\n') };
    }

    async destroy() {}
  }

  return { PDFParse };
});

// Import after mocks
import { Registry } from '../src/controller/registry/service.js';
import { Controller } from '../src/controller/service.js';
import {
  ExtractStructuredDataActionSchema,
  StructuredOutputActionSchema,
} from '../src/controller/views.js';
import { SchemaOptimizer } from '../src/llm/schema.js';
import { ActionResult } from '../src/agent/views.js';
import { BrowserError } from '../src/browser/views.js';
import { FileSystem } from '../src/filesystem/file-system.js';

describe('Controller Registry Tests', () => {
  describe('Action Registration', () => {
    it('registers action with decorator pattern', async () => {
      const registry = new Registry();

      // The decorator uses handler.name as action name
      registry.action('Simple action', {
        param_model: z.object({
          text: z.string(),
        }),
      })(async function simple_action(params: { text: string }) {
        return new ActionResult({
          extracted_content: `Text: ${params.text}`,
        });
      });

      const action = registry.get_action('simple_action');
      expect(action).toBeDefined();
      expect(action!.description).toBe('Simple action');
    });

    it('registers action without parameters', async () => {
      const registry = new Registry();

      registry.action('No params action')(async function no_params() {
        return new ActionResult({ extracted_content: 'Done' });
      });

      const action = registry.get_action('no_params');
      expect(action).toBeDefined();
    });

    it('excludes actions from exclude list', async () => {
      const registry = new Registry(['excluded_action']);

      registry.action('Should be excluded')(async function excluded_action() {
        return new ActionResult({});
      });

      const action = registry.get_action('excluded_action');
      // Excluded actions are not registered, so get_action returns null
      expect(action).toBeNull();
    });

    it('registers actions with action_name override', async () => {
      const registry = new Registry();

      registry
        .action('Alias action', {
          action_name: 'navigate',
        })
        (async function go_to_url_alias() {
          return new ActionResult({ extracted_content: 'ok' });
        });

      expect(registry.get_action('navigate')).toBeDefined();
      expect(registry.get_action('go_to_url_alias')).toBeNull();
    });

    it('applies exclude_actions against action_name override', async () => {
      const registry = new Registry(['switch']);

      registry
        .action('Excluded alias action', {
          action_name: 'switch',
        })
        (async function switch_tab_alias() {
          return new ActionResult({ extracted_content: 'ok' });
        });

      expect(registry.get_action('switch')).toBeNull();
    });
  });

  describe('Action Execution', () => {
    it('executes action with correct parameters', async () => {
      const registry = new Registry();

      registry.action('Test action', {
        param_model: z.object({
          text: z.string(),
          count: z.number(),
        }),
      })(async function test_action(params: { text: string; count: number }) {
        return new ActionResult({
          extracted_content: `Received: ${params.text} x ${params.count}`,
        });
      });

      const result = await registry.execute_action('test_action', {
        text: 'hello',
        count: 5,
      });

      expect(result).toBeInstanceOf(ActionResult);
      expect(result.extracted_content).toBe('Received: hello x 5');
    });

    it('uses default values when parameters omitted', async () => {
      const registry = new Registry();

      registry.action('Default params action', {
        param_model: z.object({
          required: z.string(),
          optional: z.string().default('default_value'),
        }),
      })(async function default_params_action(params: {
        required: string;
        optional: string;
      }) {
        return new ActionResult({
          extracted_content: `${params.required}|${params.optional}`,
        });
      });

      const result = await registry.execute_action('default_params_action', {
        required: 'test',
      });

      expect(result.extracted_content).toBe('test|default_value');
    });

    it('throws error for unknown action', async () => {
      const registry = new Registry();

      await expect(
        registry.execute_action('nonexistent_action', {})
      ).rejects.toThrow('Action nonexistent_action not found');
    });

    it('validates parameters against schema', async () => {
      const registry = new Registry();

      registry.action('Validated action', {
        param_model: z.object({
          email: z.string().email(),
          age: z.number().min(0).max(150),
        }),
      })(async function validated_action(params: {
        email: string;
        age: number;
      }) {
        return new ActionResult({ extracted_content: 'Valid' });
      });

      // Valid parameters
      const validResult = await registry.execute_action('validated_action', {
        email: 'test@example.com',
        age: 25,
      });
      expect(validResult.extracted_content).toBe('Valid');

      // Invalid email
      await expect(
        registry.execute_action('validated_action', {
          email: 'invalid-email',
          age: 25,
        })
      ).rejects.toThrow();

      // Invalid age
      await expect(
        registry.execute_action('validated_action', {
          email: 'test@example.com',
          age: -5,
        })
      ).rejects.toThrow();
    });

    it('preserves AbortError when signal is already aborted', async () => {
      const registry = new Registry();

      registry.action('Noop action')(async function noop_action() {
        return new ActionResult({ extracted_content: 'noop' });
      });

      const controller = new AbortController();
      controller.abort();

      await expect(
        registry.execute_action(
          'noop_action',
          {},
          { signal: controller.signal }
        )
      ).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('preserves AbortError thrown by action handlers', async () => {
      const registry = new Registry();

      registry.action('Abort from action')(async function aborting_action() {
        const abortError = new Error('aborted by test');
        abortError.name = 'AbortError';
        throw abortError;
      });

      await expect(
        registry.execute_action('aborting_action', {})
      ).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('treats input alias as sensitive action when sensitive data exists', async () => {
      const registry = new Registry();

      registry.action('Input alias', {
        param_model: z.object({ text: z.string() }),
      })(async function input(_params: { text: string }, ctx) {
        return new ActionResult({
          extracted_content: String(Boolean(ctx.has_sensitive_data)),
        });
      });

      const result = await registry.execute_action(
        'input',
        { text: 'demo' },
        {
          sensitive_data: {
            secret: 'demo',
          },
        }
      );

      expect(result.extracted_content).toBe('true');
    });
  });

  describe('Action Result Handling', () => {
    it('handles action returning extracted content', async () => {
      const registry = new Registry();

      registry.action('Content action')(async function content_action() {
        return new ActionResult({
          extracted_content: 'Extracted data here',
          include_in_memory: true,
        });
      });

      const result = await registry.execute_action('content_action', {});
      expect(result.extracted_content).toBe('Extracted data here');
      expect(result.include_in_memory).toBe(true);
    });

    it('handles action returning error', async () => {
      const registry = new Registry();

      registry.action('Error action')(async function error_action() {
        return new ActionResult({
          error: 'Something went wrong',
          include_in_memory: false,
        });
      });

      const result = await registry.execute_action('error_action', {});
      expect(result.error).toBe('Something went wrong');
      expect(result.include_in_memory).toBe(false);
    });

    it('handles action throwing exception', async () => {
      const registry = new Registry();

      registry.action('Throwing action')(async function throwing_action() {
        throw new Error('Unexpected error');
      });

      await expect(
        registry.execute_action('throwing_action', {})
      ).rejects.toThrow('Unexpected error');
    });

    it('preserves BrowserError metadata when action throws BrowserError', async () => {
      const registry = new Registry();

      registry.action('Browser error action')(async function browser_error() {
        throw new BrowserError({
          message: 'Element interaction failed',
          short_term_memory: 'Try refreshing the page and retry.',
          long_term_memory: 'Element became stale after navigation.',
          details: { action: 'click', index: 7 },
        });
      });

      await expect(registry.execute_action('browser_error', {})).rejects.toBeInstanceOf(
        BrowserError
      );
      try {
        await registry.execute_action('browser_error', {});
      } catch (error) {
        const browserError = error as BrowserError;
        expect(browserError.short_term_memory).toBe(
          'Try refreshing the page and retry.'
        );
        expect(browserError.long_term_memory).toBe(
          'Element became stale after navigation.'
        );
      }
    });
  });

  describe('Complex Parameter Types', () => {
    it('handles nested object parameters', async () => {
      const registry = new Registry();

      registry.action('Nested params action', {
        param_model: z.object({
          user: z.object({
            name: z.string(),
            email: z.string(),
          }),
          settings: z.object({
            notifications: z.boolean(),
          }),
        }),
      })(async function nested_params_action(params: {
        user: { name: string; email: string };
        settings: { notifications: boolean };
      }) {
        return new ActionResult({
          extracted_content: `User: ${params.user.name}, Notify: ${params.settings.notifications}`,
        });
      });

      const result = await registry.execute_action('nested_params_action', {
        user: { name: 'John', email: 'john@example.com' },
        settings: { notifications: true },
      });

      expect(result.extracted_content).toBe('User: John, Notify: true');
    });

    it('handles array parameters', async () => {
      const registry = new Registry();

      registry.action('Array params action', {
        param_model: z.object({
          items: z.array(z.string()),
          counts: z.array(z.number()),
        }),
      })(async function array_params_action(params: {
        items: string[];
        counts: number[];
      }) {
        return new ActionResult({
          extracted_content: `Items: ${params.items.join(',')}, Sum: ${params.counts.reduce((a, b) => a + b, 0)}`,
        });
      });

      const result = await registry.execute_action('array_params_action', {
        items: ['a', 'b', 'c'],
        counts: [1, 2, 3],
      });

      expect(result.extracted_content).toBe('Items: a,b,c, Sum: 6');
    });

    it('handles optional parameters', async () => {
      const registry = new Registry();

      registry.action('Optional params action', {
        param_model: z.object({
          required: z.string(),
          optional: z.string().optional(),
        }),
      })(async function optional_params_action(params: {
        required: string;
        optional?: string;
      }) {
        return new ActionResult({
          extracted_content: `Required: ${params.required}, Optional: ${params.optional ?? 'not provided'}`,
        });
      });

      // Without optional
      const result1 = await registry.execute_action('optional_params_action', {
        required: 'test',
      });
      expect(result1.extracted_content).toBe(
        'Required: test, Optional: not provided'
      );

      // With optional
      const result2 = await registry.execute_action('optional_params_action', {
        required: 'test',
        optional: 'provided',
      });
      expect(result2.extracted_content).toBe(
        'Required: test, Optional: provided'
      );
    });
  });

  describe('Registry Metadata', () => {
    it('returns all registered actions', async () => {
      const registry = new Registry();

      registry.action('Action one')(async function action_one() {
        return new ActionResult({});
      });
      registry.action('Action two')(async function action_two() {
        return new ActionResult({});
      });
      registry.action('Action three')(async function action_three() {
        return new ActionResult({});
      });

      // get_all_actions() returns the internal Map, so check size
      const actions = registry.get_all_actions();
      expect(actions.size).toBe(3);
      expect(actions.has('action_one')).toBe(true);
      expect(actions.has('action_two')).toBe(true);
      expect(actions.has('action_three')).toBe(true);
    });

    it('creates prompt description for actions', async () => {
      const registry = new Registry();

      registry.action('Described action', {
        param_model: z.object({
          url: z.string().describe('The URL to navigate to'),
        }),
      })(async function described_action() {
        return new ActionResult({});
      });

      const prompt = registry.get_prompt_description();
      expect(prompt).toContain('described_action');
    });

    it('hides top-level success in structured done prompt schema', async () => {
      const registry = new Registry();
      const structuredDoneSchema = StructuredOutputActionSchema(
        z.object({
          value: z.string(),
        })
      );

      registry.action('Structured done action', {
        param_model: structuredDoneSchema,
      })(async function done() {
        return new ActionResult({ is_done: true, success: true });
      });

      const prompt = registry.get_prompt_description();
      expect(prompt).toContain('done');
      expect(prompt).toContain('data');
      expect(prompt).not.toContain('"success"');
    });

    it('hides top-level success in structured done JSON schema but keeps nested data.success', async () => {
      const optimizedSchema = SchemaOptimizer.createOptimizedJsonSchema(
        {
          type: 'object',
          properties: {
            success: {
              type: 'boolean',
              default: true,
              description: 'True if user_request completed successfully',
            },
            data: {
              type: 'object',
              properties: {
                success: { type: 'string' },
                value: { type: 'string' },
              },
              required: ['success', 'value'],
            },
          },
          required: ['success', 'data'],
        } as Record<string, unknown>
      ) as any;

      expect(optimizedSchema.properties?.success).toBeUndefined();
      expect(optimizedSchema.properties?.data).toBeDefined();
      expect(
        optimizedSchema.properties?.data?.properties?.success
      ).toBeDefined();
    });

    it('hides output_schema from extract_structured_data prompt schema', async () => {
      const registry = new Registry();

      registry.action('Extract structured data', {
        param_model: ExtractStructuredDataActionSchema,
      })(async function extract_structured_data() {
        return new ActionResult({ extracted_content: '{}' });
      });

      const prompt = registry.get_prompt_description();
      expect(prompt).toContain('extract_structured_data');
      expect(prompt).toContain('extract_links');
      expect(prompt).not.toContain('output_schema');
    });

    it('stores terminates_sequence metadata on registered actions', async () => {
      const registry = new Registry();
      registry.action('Terminating action', {
        terminates_sequence: true,
      })(async function terminating_action() {
        return new ActionResult({});
      });
      registry.action('Non-terminating action')(async function plain_action() {
        return new ActionResult({});
      });

      expect(registry.get_action('terminating_action')?.terminates_sequence).toBe(
        true
      );
      expect(registry.get_action('plain_action')?.terminates_sequence).toBe(
        false
      );
    });
  });
});

describe('Controller Integration Tests', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    page = await context.newPage();
  });

  afterAll(async () => {
    await browser.close();
  });

  describe('Built-in Actions Patterns', () => {
    it('go_to_url pattern navigates to URL', async () => {
      const registry = new Registry();

      registry.action('Navigate to URL', {
        param_model: z.object({
          url: z.string(),
        }),
      })(async function go_to_url(params: { url: string }) {
        await page.goto(params.url);
        return new ActionResult({
          extracted_content: `Navigated to ${params.url}`,
        });
      });

      const result = await registry.execute_action('go_to_url', {
        url: 'about:blank',
      });

      expect(result.extracted_content).toContain('Navigated to');
    });

    it('click pattern interacts with elements', async () => {
      await page.setContent(`
        <html>
          <body>
            <button id="test-btn" onclick="this.textContent='Clicked!'">Click me</button>
          </body>
        </html>
      `);

      const registry = new Registry();

      registry.action('Click element', {
        param_model: z.object({
          selector: z.string(),
        }),
      })(async function click(params: { selector: string }) {
        await page.click(params.selector);
        return new ActionResult({
          extracted_content: `Clicked ${params.selector}`,
        });
      });

      await registry.execute_action('click', { selector: '#test-btn' });

      const buttonText = await page.textContent('#test-btn');
      expect(buttonText).toBe('Clicked!');
    });

    it('input_text pattern types into fields', async () => {
      await page.setContent(`
        <html>
          <body>
            <input id="test-input" type="text" />
          </body>
        </html>
      `);

      const registry = new Registry();

      registry.action('Input text', {
        param_model: z.object({
          selector: z.string(),
          text: z.string(),
        }),
      })(async function input_text(params: { selector: string; text: string }) {
        await page.fill(params.selector, params.text);
        return new ActionResult({
          extracted_content: `Typed "${params.text}"`,
        });
      });

      await registry.execute_action('input_text', {
        selector: '#test-input',
        text: 'Hello World',
      });

      const inputValue = await page.inputValue('#test-input');
      expect(inputValue).toBe('Hello World');
    });

    it('scroll pattern scrolls the page', async () => {
      await page.setContent(`
        <html>
          <body style="height: 5000px;">
            <div id="top">Top</div>
            <div id="bottom" style="position: absolute; bottom: 0;">Bottom</div>
          </body>
        </html>
      `);

      const registry = new Registry();

      registry.action('Scroll page', {
        param_model: z.object({
          direction: z.enum(['up', 'down']),
          amount: z.number().default(500),
        }),
      })(async function scroll(params: {
        direction: 'up' | 'down';
        amount: number;
      }) {
        const delta =
          params.direction === 'down' ? params.amount : -params.amount;
        await page.evaluate((d) => window.scrollBy(0, d), delta);
        return new ActionResult({
          extracted_content: `Scrolled ${params.direction} by ${params.amount}px`,
        });
      });

      const initialScroll = await page.evaluate(() => window.scrollY);
      await registry.execute_action('scroll', {
        direction: 'down',
        amount: 500,
      });
      const afterScroll = await page.evaluate(() => window.scrollY);

      expect(afterScroll).toBeGreaterThan(initialScroll);
    });
  });

  describe('Done Action Pattern', () => {
    it('done action marks task as complete', async () => {
      const registry = new Registry();

      registry.action('Mark task done', {
        param_model: z.object({
          text: z.string(),
          success: z.boolean().default(true),
        }),
      })(async function done(params: { text: string; success: boolean }) {
        return new ActionResult({
          extracted_content: params.text,
          is_done: true,
          success: params.success,
          include_in_memory: true,
        });
      });

      const result = await registry.execute_action('done', {
        text: 'Task completed successfully',
        success: true,
      });

      expect(result.is_done).toBe(true);
      expect(result.extracted_content).toBe('Task completed successfully');
    });
  });
});

describe('Sensitive Data Handling', () => {
  it('replaces secret placeholders in parameters', async () => {
    const registry = new Registry();
    let capturedParams: any = null;

    registry.action('Input with secrets', {
      param_model: z.object({
        text: z.string(),
      }),
    })(async function input_text(params: { text: string }) {
      capturedParams = params;
      return new ActionResult({ extracted_content: 'Done' });
    });

    // Execute with sensitive_data
    await registry.execute_action(
      'input_text',
      { text: '<secret>password</secret>' },
      {
        sensitive_data: {
          password: 'actual_secret_value',
        },
      }
    );

    expect(capturedParams.text).toBe('actual_secret_value');
  });

  it('handles domain-scoped sensitive data', async () => {
    const registry = new Registry();
    let capturedParams: any = null;

    registry.action('Login action', {
      param_model: z.object({
        username: z.string(),
        password: z.string(),
      }),
    })(async function login(params: { username: string; password: string }) {
      capturedParams = params;
      return new ActionResult({ extracted_content: 'Logged in' });
    });

    // Domain-scoped sensitive data won't match without browser_session URL
    await registry.execute_action(
      'login',
      {
        username: '<secret>user</secret>',
        password: '<secret>pass</secret>',
      },
      {
        sensitive_data: {
          '*.example.com': {
            user: 'john_doe',
            pass: 'secret123',
          },
        },
      }
    );

    // Without URL match, placeholders remain unchanged
    expect(capturedParams.username).toBe('<secret>user</secret>');
    expect(capturedParams.password).toBe('<secret>pass</secret>');
  });
});

describe('Regression Coverage', () => {
  it('wait action uses object params and does not produce NaN', async () => {
    const controller = new Controller();
    const result = await controller.registry.execute_action('wait', {});
    expect(result.extracted_content).toContain('Waited for 3 seconds');
    expect(result.extracted_content).not.toContain('NaN');
  });

  it('registers python-compatible default action aliases', async () => {
    const controller = new Controller();
    const actions = controller.registry.get_all_actions();

    expect(actions.has('navigate')).toBe(true);
    expect(actions.has('input')).toBe(true);
    expect(actions.has('switch')).toBe(true);
    expect(actions.has('close')).toBe(true);
    expect(actions.has('extract')).toBe(true);
    expect(actions.has('find_text')).toBe(true);
    expect(actions.has('dropdown_options')).toBe(true);
    expect(actions.has('select_dropdown')).toBe(true);
    expect(actions.has('replace_file')).toBe(true);
  });

  it('replace_file alias delegates to replace_file_str handler', async () => {
    const controller = new Controller();
    const fileSystem = {
      replace_file_str: vi.fn(async () => 'Replaced 1 occurrence in notes.md'),
    };

    const result = await controller.registry.execute_action(
      'replace_file',
      {
        file_name: 'notes.md',
        old_str: 'todo',
        new_str: 'done',
      },
      { file_system: fileSystem as any }
    );

    expect(fileSystem.replace_file_str).toHaveBeenCalledWith(
      'notes.md',
      'todo',
      'done'
    );
    expect(result.extracted_content).toContain('Replaced 1 occurrence');
  });

  it('find_text alias delegates to scroll_to_text behavior', async () => {
    const controller = new Controller();
    const page = {
      evaluate: vi.fn(async () => true),
      url: vi.fn(() => 'https://example.com'),
    };
    const browserSession = {
      get_current_page: vi.fn(async () => page),
    };

    const result = await controller.registry.execute_action(
      'find_text',
      { text: 'checkout' },
      { browser_session: browserSession as any }
    );

    expect(page.evaluate).toHaveBeenCalled();
    expect(result.extracted_content).toContain('Scrolled to text: checkout');
  });

  it('find_text returns informative result when text is not found', async () => {
    const controller = new Controller();
    const page = {
      evaluate: vi.fn(async () => false),
      url: vi.fn(() => 'https://example.com'),
    };
    const browserSession = {
      get_current_page: vi.fn(async () => page),
    };

    const result = await controller.registry.execute_action(
      'find_text',
      { text: 'missing phrase' },
      { browser_session: browserSession as any }
    );

    expect(result.error).toBeNull();
    expect(result.extracted_content).toContain(
      "Text 'missing phrase' not found or not visible on page"
    );
    expect(result.long_term_memory).toContain(
      "Tried scrolling to text 'missing phrase' but it was not found"
    );
  });

  it('page prompt description includes unfiltered and page-filtered actions', async () => {
    const registry = new Registry();

    registry.action('Always available action', {
      param_model: z.object({}),
    })(async function base_action() {
      return new ActionResult({});
    });

    registry.action('Only example.com action', {
      param_model: z.object({}),
      domains: ['https://example.com'],
    })(async function domain_action() {
      return new ActionResult({});
    });

    const prompt = registry.get_prompt_description({
      url: () => 'https://example.com',
    } as any);

    expect(prompt).toContain('base_action');
    expect(prompt).toContain('domain_action');
  });

  it('create_action_model filters by include_actions and page context', async () => {
    const registry = new Registry();

    registry.action('Always available action', {
      param_model: z.object({}),
    })(async function base_action() {
      return new ActionResult({});
    });

    registry.action('Only example.com action', {
      param_model: z.object({}),
      domains: ['https://example.com'],
    })(async function domain_action() {
      return new ActionResult({});
    });

    const baseModel = registry.create_action_model();
    const pageModel = registry.create_action_model({
      page: { url: () => 'https://example.com' } as any,
    });
    const includedModel = registry.create_action_model({
      include_actions: ['domain_action'],
      page: { url: () => 'https://example.com' } as any,
    });

    expect((baseModel as any).available_actions).toContain('base_action');
    expect((baseModel as any).available_actions).not.toContain('domain_action');
    expect((pageModel as any).available_actions).toContain('domain_action');
    expect((includedModel as any).available_actions).toEqual(['domain_action']);
  });

  it('search action defaults to duckduckgo and navigates current tab', async () => {
    const controller = new Controller();
    const browserSession = {
      navigate_to: vi.fn(async () => {}),
      create_new_tab: vi.fn(async () => {}),
    };

    const result = await controller.registry.execute_action(
      'search',
      { query: 'browser use' },
      { browser_session: browserSession as any }
    );

    expect(browserSession.navigate_to).toHaveBeenCalledTimes(1);
    expect(browserSession.navigate_to.mock.calls[0][0]).toContain(
      'duckduckgo.com/?q=browser%20use'
    );
    expect(browserSession.create_new_tab).not.toHaveBeenCalled();
    expect(result.long_term_memory).toContain("Searched duckduckgo for 'browser use'");
  });

  it('click action supports coordinate clicks without index', async () => {
    const controller = new Controller();
    const page = {
      mouse: {
        click: vi.fn(async () => {}),
      },
      url: vi.fn(() => 'https://example.com'),
    };
    const browserSession = {
      get_current_page: vi.fn(async () => page),
    };

    const result = await controller.registry.execute_action(
      'click',
      { coordinate_x: 42, coordinate_y: 84 },
      { browser_session: browserSession as any }
    );

    expect(page.mouse.click).toHaveBeenCalledWith(42, 84);
    expect(result.extracted_content).toContain('Clicked at coordinates (42, 84)');
  });

  it('click action rescales coordinates when llm_screenshot_size is configured', async () => {
    const controller = new Controller();
    const page = {
      mouse: {
        click: vi.fn(async () => {}),
      },
      url: vi.fn(() => 'https://example.com'),
    };
    const browserSession = {
      get_current_page: vi.fn(async () => page),
      llm_screenshot_size: [1400, 850],
      _original_viewport_size: [700, 425],
    };

    const result = await controller.registry.execute_action(
      'click',
      { coordinate_x: 280, coordinate_y: 170 },
      { browser_session: browserSession as any }
    );

    expect(page.mouse.click).toHaveBeenCalledWith(140, 85);
    expect(result.extracted_content).toContain(
      'Clicked at coordinates (280, 170)'
    );
    expect(result.metadata).toEqual({
      click_x: 140,
      click_y: 85,
    });
  });

  it('click action by coordinate reports newly opened tab for follow-up switch', async () => {
    const controller = new Controller();
    const tabs = [{ page_id: 1, url: 'https://example.com', title: 'Example' }];
    const page = {
      mouse: {
        click: vi.fn(async () => {
          tabs.push({ page_id: 7, url: 'https://newtab.test', title: 'New Tab' });
        }),
      },
      url: vi.fn(() => 'https://example.com'),
    };
    const browserSession = {
      tabs,
      get_current_page: vi.fn(async () => page),
    };

    const result = await controller.registry.execute_action(
      'click',
      { coordinate_x: 12, coordinate_y: 34 },
      { browser_session: browserSession as any }
    );

    expect(result.extracted_content).toContain('Clicked at coordinates (12, 34)');
    expect(result.extracted_content).toContain('opened a new tab');
    expect(result.extracted_content).toContain('tab_id: 0007');
  });

  it('click action by index reports newly opened tab without auto-switching', async () => {
    const controller = new Controller();
    const tabs = [{ page_id: 1, url: 'https://example.com', title: 'Example' }];
    const element = {
      get_all_text_till_next_clickable_element: vi.fn(() => 'Open details'),
    };
    const browserSession = {
      tabs,
      get_dom_element_by_index: vi.fn(async () => element),
      is_file_input: vi.fn(() => false),
      _click_element_node: vi.fn(async () => {
        tabs.push({ page_id: 8, url: 'https://details.test', title: 'Details' });
        return null;
      }),
      switch_to_tab: vi.fn(async () => {}),
    };

    const result = await controller.registry.execute_action(
      'click',
      { index: 3 },
      { browser_session: browserSession as any }
    );

    expect(result.extracted_content).toContain('Clicked button with index 3');
    expect(result.extracted_content).toContain('opened a new tab');
    expect(result.extracted_content).toContain('tab_id: 0008');
    expect(browserSession.switch_to_tab).not.toHaveBeenCalled();
  });

  it('switch action accepts tab_id identifiers', async () => {
    const controller = new Controller();
    const page = {
      url: vi.fn(() => 'https://switched.test'),
      wait_for_load_state: vi.fn(async () => {}),
    };
    const browserSession = {
      switch_to_tab: vi.fn(async () => {}),
      get_current_page: vi.fn(async () => page),
      tabs: [{ page_id: 7, tab_id: '0007', url: 'https://switched.test', title: 'Switched' }],
    };

    const result = await controller.registry.execute_action(
      'switch',
      { tab_id: '0007' },
      { browser_session: browserSession as any }
    );

    expect(browserSession.switch_to_tab).toHaveBeenCalledWith('0007', {
      signal: null,
    });
    expect(result.extracted_content).toContain('Switched to tab #0007');
  });

  it('close action accepts tab_id identifiers', async () => {
    const controller = new Controller();
    const closingPage = {
      url: vi.fn(() => 'https://closing.test'),
      close: vi.fn(async () => {}),
    };
    const focusedPage = {
      url: vi.fn(() => 'https://focused.test'),
    };
    const browserSession = {
      switch_to_tab: vi.fn(async () => {}),
      get_current_page: vi
        .fn()
        .mockResolvedValueOnce(closingPage)
        .mockResolvedValueOnce(closingPage)
        .mockResolvedValueOnce(closingPage)
        .mockResolvedValueOnce(focusedPage),
      active_tab: { page_id: 1, tab_id: '0001', url: 'https://focused.test', title: 'Focused' },
      active_tab_index: 0,
      tabs: [{ page_id: 7, tab_id: '0007', url: 'https://closing.test', title: 'Closing' }],
    };

    const result = await controller.registry.execute_action(
      'close',
      { tab_id: '0007' },
      { browser_session: browserSession as any }
    );

    expect(browserSession.switch_to_tab).toHaveBeenCalledWith('0007', {
      signal: null,
    });
    expect(closingPage.close).toHaveBeenCalled();
    expect(result.extracted_content).toContain('Closed tab #0007');
    expect(result.extracted_content).toContain('focused on tab #0001');
  });

  it('click action validation requires index or coordinates', async () => {
    const controller = new Controller();
    const browserSession = {
      get_current_page: vi.fn(async () => ({
        url: vi.fn(() => 'https://example.com'),
      })),
    };

    await expect(
      controller.registry.execute_action('click', {}, { browser_session: browserSession as any })
    ).rejects.toThrow('Provide index or both coordinate_x and coordinate_y');
  });

  it('click action rejects index 0', async () => {
    const controller = new Controller();
    await expect(
      controller.registry.execute_action('click', { index: 0 })
    ).rejects.toThrow('Too small: expected number to be >=1');
  });

  it('input_text forwards clear=false to browser session', async () => {
    const controller = new Controller();
    const element = { xpath: '/html/body/input' };
    const browserSession = {
      get_dom_element_by_index: vi.fn(async () => element),
      _input_text_element_node: vi.fn(async () => {}),
    };

    await controller.registry.execute_action(
      'input_text',
      { index: 2, text: 'append text', clear: false },
      { browser_session: browserSession as any }
    );

    expect(browserSession._input_text_element_node).toHaveBeenCalledWith(
      element,
      'append text',
      expect.objectContaining({ clear: false })
    );
  });

  it('scroll action accepts pages alias for num_pages', async () => {
    const controller = new Controller();
    const page = {
      evaluate: vi.fn(async () => 1000),
      url: vi.fn(() => 'https://example.com'),
    };
    const browserSession = {
      get_current_page: vi.fn(async () => page),
      _scrollContainer: vi.fn(async () => {}),
    };

    const result = await controller.registry.execute_action(
      'scroll',
      { down: true, pages: 0.5 },
      { browser_session: browserSession as any }
    );

    expect(browserSession._scrollContainer).toHaveBeenCalledWith(500);
    expect(result.long_term_memory).toContain('by 0.5 pages');
  });

  it('select_dropdown_option matches options case-insensitively by text/value', async () => {
    const controller = new Controller();
    const frame = {
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({ found: true, type: 'select' })
        .mockResolvedValueOnce({
          found: true,
          success: true,
          matched: { index: 2, text: 'United Kingdom', value: 'uk' },
          options: [],
        }),
    };
    const page = {
      frames: [frame],
      url: vi.fn(() => 'https://example.com'),
    };
    const browserSession = {
      get_current_page: vi.fn(async () => page),
      get_dom_element_by_index: vi.fn(async () => ({ xpath: '/html/body/select' })),
    };

    const result = await controller.registry.execute_action(
      'select_dropdown_option',
      { index: 1, text: 'united kingdom' },
      { browser_session: browserSession as any }
    );

    expect(result.extracted_content).toContain('United Kingdom');
    expect(result.extracted_content).toContain('(uk)');
  });

  it('select_dropdown_option returns available options in error details', async () => {
    const controller = new Controller();
    const frame = {
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({ found: true, type: 'select' })
        .mockResolvedValueOnce({
          found: true,
          success: false,
          options: [
            { index: 0, text: 'United States', value: 'us' },
            { index: 1, text: 'Canada', value: 'ca' },
          ],
        }),
    };
    const page = {
      frames: [frame],
      url: vi.fn(() => 'https://example.com'),
    };
    const browserSession = {
      get_current_page: vi.fn(async () => page),
      get_dom_element_by_index: vi.fn(async () => ({ xpath: '/html/body/select' })),
    };

    await expect(
      controller.registry.execute_action(
        'select_dropdown_option',
        { index: 1, text: 'united kingdom' },
        { browser_session: browserSession as any }
      )
    ).rejects.toThrow('Available options');
  });

  it('search_page returns formatted matches with memory summary', async () => {
    const controller = new Controller();
    const page = {
      evaluate: vi.fn(async () => ({
        total: 2,
        matches: [
          { position: 12, match: 'price', snippet: 'The current price is $19' },
          { position: 87, match: 'price', snippet: 'Lowest price this month' },
        ],
        truncated: false,
      })),
      url: vi.fn(() => 'https://example.com'),
    };
    const browserSession = {
      get_current_page: vi.fn(async () => page),
    };

    const result = await controller.registry.execute_action(
      'search_page',
      { pattern: 'price' },
      { browser_session: browserSession as any }
    );

    expect(page.evaluate).toHaveBeenCalled();
    expect(result.extracted_content).toContain(
      'Found 2 matches for "price" in page text'
    );
    expect(result.extracted_content).toContain('[pos 12]');
    expect(result.long_term_memory).toBe(
      'Searched page for "price": 2 matches found.'
    );
  });

  it('find_elements returns formatted selector results', async () => {
    const controller = new Controller();
    const page = {
      evaluate: vi.fn(async () => ({
        total: 3,
        elements: [
          {
            index: 1,
            tag: 'a',
            text: 'Documentation',
            attributes: { href: 'https://example.com/docs' },
          },
        ],
        truncated: true,
      })),
      url: vi.fn(() => 'https://example.com'),
    };
    const browserSession = {
      get_current_page: vi.fn(async () => page),
    };

    const result = await controller.registry.execute_action(
      'find_elements',
      { selector: 'a', attributes: ['href'], max_results: 1 },
      { browser_session: browserSession as any }
    );

    expect(page.evaluate).toHaveBeenCalled();
    expect(result.extracted_content).toContain(
      'Found 3 elements for selector "a"'
    );
    expect(result.extracted_content).toContain('<a>');
    expect(result.extracted_content).toContain('href="https://example.com/docs"');
    expect(result.extracted_content).toContain('showing first 1 elements');
    expect(result.long_term_memory).toBe(
      'Queried selector "a" and found 3 elements.'
    );
  });

  it('evaluate executes JavaScript and returns serialized output', async () => {
    const controller = new Controller();
    const page = {
      evaluate: vi.fn(async () => ({
        ok: true,
        result: { status: 'ok', count: 2 },
      })),
      url: vi.fn(() => 'https://example.com'),
    };
    const browserSession = {
      get_current_page: vi.fn(async () => page),
    };

    const result = await controller.registry.execute_action(
      'evaluate',
      { code: '(() => ({ status: "ok", count: 2 }))()' },
      { browser_session: browserSession as any }
    );

    expect(page.evaluate).toHaveBeenCalled();
    expect(result.error).toBeNull();
    expect(result.extracted_content).toContain('"status":"ok"');
    expect(result.include_extracted_content_only_once).toBe(false);
  });

  it('evaluate normalizes over-escaped JavaScript before execution', async () => {
    const controller = new Controller();
    const rawCode =
      '(() => { const el = document.querySelector(\\\\\"#value\\\\\"); return el ? el.textContent : "missing"; })()';
    const page = {
      evaluate: vi.fn(async (_handler: unknown, args: { code: string }) => ({
        ok: true,
        result: args.code,
      })),
      url: vi.fn(() => 'https://example.com'),
    };
    const browserSession = {
      get_current_page: vi.fn(async () => page),
    };

    const result = await controller.registry.execute_action(
      'evaluate',
      {
        code: rawCode,
      },
      { browser_session: browserSession as any }
    );

    expect(page.evaluate).toHaveBeenCalled();
    const evaluatedCode = (page.evaluate.mock.calls[0]?.[1] as { code: string })
      ?.code;
    expect(evaluatedCode).toContain('document.querySelector(\\"#value\\")');
    expect(evaluatedCode).not.toContain('\\\\\\"#value\\\\\\"');
    expect((evaluatedCode ?? '').length).toBeLessThan(rawCode.length);
    expect(result.error).toBeNull();
  });

  it('evaluate returns action error on JavaScript failure', async () => {
    const controller = new Controller();
    const page = {
      evaluate: vi.fn(async () => ({
        ok: false,
        error: 'boom',
      })),
      url: vi.fn(() => 'https://example.com'),
    };
    const browserSession = {
      get_current_page: vi.fn(async () => page),
    };

    const result = await controller.registry.execute_action(
      'evaluate',
      { code: 'throw new Error("boom")' },
      { browser_session: browserSession as any }
    );

    expect(result.error).toContain('JavaScript execution error: boom');
  });

  it('evaluate extracts inline base64 images into metadata', async () => {
    const controller = new Controller();
    const imageData = 'data:image/png;base64,QUJDRA==';
    const page = {
      evaluate: vi.fn(async () => ({
        ok: true,
        result: `Result includes ${imageData} for preview`,
      })),
      url: vi.fn(() => 'https://example.com'),
    };
    const browserSession = {
      get_current_page: vi.fn(async () => page),
    };

    const result = await controller.registry.execute_action(
      'evaluate',
      { code: 'return image' },
      { browser_session: browserSession as any }
    );

    expect(result.metadata).toEqual({ images: [imageData] });
    expect(result.extracted_content).toContain('[Image]');
    expect(result.extracted_content).not.toContain(imageData);
  });

  it('screenshot saves base64 image to requested file path', async () => {
    const controller = new Controller();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-use-ss-'));
    const browserSession = {
      take_screenshot: vi.fn(async () =>
        Buffer.from('fake_png_data').toString('base64')
      ),
    };
    const fileSystem = {
      get_dir: vi.fn(() => tempDir),
    };

    try {
      const result = await controller.registry.execute_action(
        'screenshot',
        { file_name: 'capture.png' },
        {
          browser_session: browserSession as any,
          file_system: fileSystem as any,
        }
      );

      expect(browserSession.take_screenshot).toHaveBeenCalledWith(false);
      expect(result.error).toBeNull();
      expect(result.attachments).toHaveLength(1);
      expect(result.attachments?.[0]).toContain('capture.png');
      expect(fs.existsSync(result.attachments?.[0] as string)).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('screenshot without file_name requests inclusion in next observation', async () => {
    const controller = new Controller();
    const browserSession = {
      take_screenshot: vi.fn(async () =>
        Buffer.from('fake_png_data').toString('base64')
      ),
    };

    const result = await controller.registry.execute_action(
      'screenshot',
      {},
      {
        browser_session: browserSession as any,
      }
    );

    expect(browserSession.take_screenshot).not.toHaveBeenCalled();
    expect(result.extracted_content).toBe('Requested screenshot for next observation');
    expect(result.metadata).toEqual({ include_screenshot: true });
  });

  it('screenshot sanitizes filename and appends .png when extension is missing', async () => {
    const controller = new Controller();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-use-ss-'));
    const browserSession = {
      take_screenshot: vi.fn(async () =>
        Buffer.from('fake_png_data').toString('base64')
      ),
    };
    const fileSystem = {
      get_dir: vi.fn(() => tempDir),
    };

    try {
      const result = await controller.registry.execute_action(
        'screenshot',
        { file_name: 'My Screenshot !!' },
        {
          browser_session: browserSession as any,
          file_system: fileSystem as any,
        }
      );

      expect(result.error).toBeNull();
      expect(result.attachments).toHaveLength(1);
      expect(result.attachments?.[0]).toMatch(/My-Screenshot\.png$/);
      expect(fs.existsSync(result.attachments?.[0] as string)).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('extract_structured_data propagates abort during iframe extraction', async () => {
    const controller = new Controller();
    const abortController = new AbortController();
    const pageExtractionLlm = {
      ainvoke: vi.fn(async () => ({ completion: 'ok' })),
    };
    const iframe = {
      waitForLoadState: vi.fn(async () => {}),
      url: vi.fn(() => 'https://iframe.example.com'),
      content: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            setTimeout(() => resolve('<html><body>Iframe</body></html>'), 50);
          })
      ),
    };
    const page = {
      content: vi.fn(async () => '<html><body>Main</body></html>'),
      frames: vi.fn(() => [iframe]),
      url: vi.fn(() => 'https://example.com'),
    };
    const browserSession = {
      get_current_page: vi.fn(async () => page),
      agent_current_page: {
        url: vi.fn(() => 'https://example.com'),
      },
    };

    const execution = controller.registry.execute_action(
      'extract_structured_data',
      { query: 'Extract data', extract_links: true },
      {
        browser_session: browserSession as any,
        page_extraction_llm: pageExtractionLlm as any,
        file_system: {
          save_extracted_content: vi.fn(async () => ''),
        } as any,
        signal: abortController.signal,
      }
    );
    setTimeout(() => abortController.abort(), 10);

    await expect(execution).rejects.toThrow(/aborted/i);
    expect(pageExtractionLlm.ainvoke).not.toHaveBeenCalled();
  });

  it('read_file truncates long-term memory above 1k chars', async () => {
    const controller = new Controller();
    const content = Array.from({ length: 250 }, (_, idx) => `line-${idx}`).join(
      '\n'
    );
    const fileSystem = {
      read_file: vi.fn(async () => content),
    };

    const result = await controller.registry.execute_action(
      'read_file',
      { file_name: 'sample.txt' },
      {
        file_system: fileSystem as any,
        available_file_paths: ['sample.txt'],
      }
    );

    expect(fileSystem.read_file).toHaveBeenCalledWith('sample.txt', true);
    expect(result.extracted_content).toBe(content);
    expect(result.long_term_memory).not.toBe(content);
    expect(result.long_term_memory).toContain('more lines...');
    expect(result.include_extracted_content_only_once).toBe(true);
  });

  it('read_file returns image payload for external image files', async () => {
    const controller = new Controller();
    const imageData = Buffer.from('fake-image-bytes').toString('base64');
    const fileSystem = {
      read_file_structured: vi.fn(async () => ({
        message: 'Read image file /tmp/chart.png.',
        images: [{ name: 'chart.png', data: imageData }],
      })),
    };

    const result = await controller.registry.execute_action(
      'read_file',
      { file_name: '/tmp/chart.png' },
      {
        file_system: fileSystem as any,
        available_file_paths: ['/tmp/chart.png'],
      }
    );

    expect(fileSystem.read_file_structured).toHaveBeenCalledWith(
      '/tmp/chart.png',
      true
    );
    expect(result.extracted_content).toBe('Read image file /tmp/chart.png.');
    expect(result.long_term_memory).toBe('Read image file /tmp/chart.png');
    expect(result.images).toEqual([{ name: 'chart.png', data: imageData }]);
  });

  it('write_file rejects binary/image extensions with actionable error', async () => {
    const controller = new Controller();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-use-fs-'));
    const fileSystem = new FileSystem(tempDir, false);
    try {
      const result = await controller.registry.execute_action(
        'write_file',
        { file_name: 'capture.png', content: 'hello' },
        {
          file_system: fileSystem as any,
        }
      );

      expect(result.extracted_content).toContain(
        "Error: Cannot write binary/image file 'capture.png'."
      );
      expect(result.extracted_content).toContain(
        'For screenshots, the browser automatically captures them'
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('upload_file resolves FileSystem-managed files outside available_file_paths', async () => {
    const controller = new Controller();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-use-upload-'));
    const fileSystem = new FileSystem(tempDir, false);
    const locator = {
      setInputFiles: vi.fn(async () => {}),
    };
    const browserSession = {
      downloaded_files: [],
      find_file_upload_element_by_index: vi.fn(async () => ({ xpath: '/html/body/input' })),
      get_locate_element: vi.fn(async () => locator),
    };

    try {
      await fileSystem.write_file('resume.txt', 'hello');

      const result = await controller.registry.execute_action(
        'upload_file',
        { index: 1, path: 'resume.txt' },
        {
          browser_session: browserSession as any,
          available_file_paths: [],
          file_system: fileSystem as any,
        }
      );

      const expectedPath = path.join(fileSystem.get_dir(), 'resume.txt');
      expect(locator.setInputFiles).toHaveBeenCalledWith(expectedPath);
      expect(result.long_term_memory).toContain(expectedPath);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('upload_file rejects zero-byte files', async () => {
    const controller = new Controller();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-use-upload-'));
    const emptyPath = path.join(tempDir, 'empty.txt');
    fs.writeFileSync(emptyPath, '');

    try {
      await expect(
        controller.registry.execute_action(
          'upload_file',
          { index: 1, path: emptyPath },
          {
            browser_session: {
              downloaded_files: [],
            } as any,
            available_file_paths: [emptyPath],
          }
        )
      ).rejects.toThrow('is empty (0 bytes)');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('read_long_content blocks files outside available_file_paths', async () => {
    const controller = new Controller();

    const result = await controller.registry.execute_action(
      'read_long_content',
      {
        goal: 'find totals',
        source: '/tmp/not-allowed.txt',
      },
      {
        browser_session: {
          downloaded_files: [],
        } as any,
        available_file_paths: ['/tmp/allowed.txt'],
      }
    );

    expect(result.extracted_content).toContain(
      'Error: File path not in available_file_paths: /tmp/not-allowed.txt'
    );
    expect(result.long_term_memory).toContain('file path not allowed');
  });

  it('read_long_content returns relevant sections for long page content', async () => {
    const controller = new Controller();
    const noisePrefix = 'lorem ipsum dolor sit amet '.repeat(2200);
    const noiseSuffix = 'consectetur adipiscing elit '.repeat(2200);
    const html = `<html><body>${noisePrefix}TARGET_KEYWORD revenue growth${noiseSuffix}</body></html>`;
    const page = {
      content: vi.fn(async () => html),
      url: vi.fn(() => 'https://example.com/report'),
    };
    const browserSession = {
      get_current_page: vi.fn(async () => page),
      downloaded_files: [],
    };
    const pageExtractionLlm = {
      ainvoke: vi.fn(async () => ({
        completion: 'TARGET_KEYWORD\nrevenue growth',
      })),
    };

    const result = await controller.registry.execute_action(
      'read_long_content',
      {
        goal: 'Find revenue growth details',
        source: 'page',
      },
      {
        browser_session: browserSession as any,
        page_extraction_llm: pageExtractionLlm as any,
      }
    );

    expect(pageExtractionLlm.ainvoke).toHaveBeenCalled();
    expect(result.extracted_content).toContain('relevant sections');
    expect(result.extracted_content).toContain('revenue growth');
    expect(result.include_extracted_content_only_once).toBe(true);
    expect(result.long_term_memory).toContain('relevant sections');
  });

  it('read_long_content returns full content for small pdf files', async () => {
    const controller = new Controller();
    mockedPdfPages = ['Executive summary', 'Revenue increased by 12%'];
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-use-pdf-'));
    const pdfPath = path.join(tempDir, 'report.pdf');
    fs.writeFileSync(pdfPath, 'fake-pdf-bytes');

    try {
      const result = await controller.registry.execute_action(
        'read_long_content',
        {
          goal: 'Summarize report',
          source: pdfPath,
        },
        {
          browser_session: {
            downloaded_files: [],
          } as any,
          page_extraction_llm: {
            ainvoke: vi.fn(async () => ({ completion: 'summary' })),
          } as any,
          available_file_paths: [pdfPath],
        }
      );

      expect(result.extracted_content).toContain('PDF: report.pdf (2 pages)');
      expect(result.extracted_content).toContain('--- Page 1 ---');
      expect(result.extracted_content).toContain('--- Page 2 ---');
      expect(result.long_term_memory).toContain('(2 pages,');
      expect(result.include_extracted_content_only_once).toBe(true);
    } finally {
      mockedPdfPages = [];
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('read_long_content prioritizes relevant pages for large pdf files', async () => {
    const controller = new Controller();
    mockedPdfPages = [
      'Introduction '.repeat(2000),
      'Revenue growth forecast '.repeat(2200),
      'Appendix '.repeat(2200),
    ];
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-use-pdf-'));
    const pdfPath = path.join(tempDir, 'annual-report.pdf');
    fs.writeFileSync(pdfPath, 'fake-pdf-bytes');

    try {
      const pageExtractionLlm = {
        ainvoke: vi.fn(async () => ({
          completion: 'revenue\ngrowth',
        })),
      };

      const result = await controller.registry.execute_action(
        'read_long_content',
        {
          goal: 'Find revenue growth details',
          source: pdfPath,
        },
        {
          browser_session: {
            downloaded_files: [],
          } as any,
          page_extraction_llm: pageExtractionLlm as any,
          available_file_paths: [pdfPath],
        }
      );

      expect(pageExtractionLlm.ainvoke).toHaveBeenCalled();
      expect(result.extracted_content).toContain(
        'PDF: annual-report.pdf (3 pages, showing'
      );
      expect(result.extracted_content).toContain('--- Page 1 ---');
      expect(result.extracted_content).toContain('Revenue growth forecast');
      expect(result.long_term_memory).toContain('relevant pages of 3');
      expect(result.include_extracted_content_only_once).toBe(true);
    } finally {
      mockedPdfPages = [];
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('extract_structured_data keeps long-term memory up to 10k chars', async () => {
    const controller = new Controller();
    const completion = 'result '.repeat(300);
    const pageExtractionLlm = {
      ainvoke: vi.fn(async () => ({ completion })),
    };
    const page = {
      content: vi.fn(async () => '<html><body>Main Content</body></html>'),
      frames: vi.fn(() => []),
      url: vi.fn(() => 'https://example.com'),
    };
    const browserSession = {
      get_current_page: vi.fn(async () => page),
      agent_current_page: {
        url: vi.fn(() => 'https://example.com'),
      },
    };
    const fileSystem = {
      save_extracted_content: vi.fn(async () => '/tmp/saved.txt'),
    };

    const result = await controller.registry.execute_action(
      'extract_structured_data',
      { query: 'Extract data', extract_links: true },
      {
        browser_session: browserSession as any,
        page_extraction_llm: pageExtractionLlm as any,
        file_system: fileSystem as any,
      }
    );

    expect(result.include_extracted_content_only_once).toBe(false);
    expect(result.long_term_memory).toContain(completion.trim());
    expect(fileSystem.save_extracted_content).not.toHaveBeenCalled();
  });

  it('extract_structured_data validates start_from_char against content length', async () => {
    const controller = new Controller();
    const pageExtractionLlm = {
      ainvoke: vi.fn(async () => ({ completion: '{}' })),
    };
    const page = {
      content: vi.fn(async () => '<html><body>Short content</body></html>'),
      frames: vi.fn(() => []),
      url: vi.fn(() => 'https://example.com'),
    };
    const browserSession = {
      get_current_page: vi.fn(async () => page),
      agent_current_page: {
        url: vi.fn(() => 'https://example.com'),
      },
    };

    const result = await controller.registry.execute_action(
      'extract_structured_data',
      {
        query: 'Extract data',
        extract_links: false,
        start_from_char: 9999,
      },
      {
        browser_session: browserSession as any,
        page_extraction_llm: pageExtractionLlm as any,
        file_system: {
          save_extracted_content: vi.fn(async () => ''),
        } as any,
      }
    );

    expect(result.error).toContain('start_from_char (9999) exceeds content length');
    expect(pageExtractionLlm.ainvoke).not.toHaveBeenCalled();
  });

  it('extract_structured_data enforces output_schema JSON response parsing', async () => {
    const controller = new Controller();
    const pageExtractionLlm = {
      ainvoke: vi.fn(async () => ({
        completion: '```json\n{"name":"Alice","age":30}\n```',
      })),
    };
    const page = {
      content: vi.fn(async () => '<html><body>Alice is 30 years old.</body></html>'),
      frames: vi.fn(() => []),
      url: vi.fn(() => 'https://example.com/profile'),
    };
    const browserSession = {
      get_current_page: vi.fn(async () => page),
      agent_current_page: {
        url: vi.fn(() => 'https://example.com/profile'),
      },
    };
    const fileSystem = {
      save_extracted_content: vi.fn(async () => '/tmp/saved.txt'),
    };

    const result = await controller.registry.execute_action(
      'extract_structured_data',
      {
        query: 'Extract person profile',
        extract_links: false,
        output_schema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            age: { type: 'number' },
          },
          required: ['name', 'age'],
        },
      },
      {
        browser_session: browserSession as any,
        page_extraction_llm: pageExtractionLlm as any,
        file_system: fileSystem as any,
      }
    );

    expect(pageExtractionLlm.ainvoke).toHaveBeenCalled();
    expect(result.error).toBeNull();
    expect(result.extracted_content).toContain('{"name":"Alice","age":30}');
    expect(fileSystem.save_extracted_content).not.toHaveBeenCalled();
  });

  it('extract_structured_data rejects responses that violate output_schema', async () => {
    const controller = new Controller();
    const pageExtractionLlm = {
      ainvoke: vi.fn(async () => ({
        completion: '{"name":"Alice","age":"30"}',
      })),
    };
    const page = {
      content: vi.fn(async () => '<html><body>Alice is 30 years old.</body></html>'),
      frames: vi.fn(() => []),
      url: vi.fn(() => 'https://example.com/profile'),
    };
    const browserSession = {
      get_current_page: vi.fn(async () => page),
      agent_current_page: {
        url: vi.fn(() => 'https://example.com/profile'),
      },
    };

    await expect(
      controller.registry.execute_action(
        'extract_structured_data',
        {
          query: 'Extract person profile',
          extract_links: false,
          output_schema: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              age: { type: 'number' },
            },
            required: ['name', 'age'],
          },
        },
        {
          browser_session: browserSession as any,
          page_extraction_llm: pageExtractionLlm as any,
          file_system: {
            save_extracted_content: vi.fn(async () => '/tmp/saved.txt'),
          } as any,
        }
      )
    ).rejects.toThrow(
      /Structured extraction result does not match output_schema/
    );
  });

  it('extract_structured_data uses context extraction_schema when params.output_schema is omitted', async () => {
    const controller = new Controller();
    const pageExtractionLlm = {
      ainvoke: vi.fn(async () => ({
        completion: '{"name":"Alice","age":30}',
      })),
    };
    const page = {
      content: vi.fn(async () => '<html><body>Alice is 30 years old.</body></html>'),
      frames: vi.fn(() => []),
      url: vi.fn(() => 'https://example.com/profile'),
    };
    const browserSession = {
      get_current_page: vi.fn(async () => page),
      agent_current_page: {
        url: vi.fn(() => 'https://example.com/profile'),
      },
    };
    const extractionSchema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'number' },
      },
      required: ['name', 'age'],
    };

    const result = await controller.registry.execute_action(
      'extract_structured_data',
      {
        query: 'Extract person profile',
        extract_links: false,
      },
      {
        browser_session: browserSession as any,
        page_extraction_llm: pageExtractionLlm as any,
        extraction_schema: extractionSchema,
        file_system: {
          save_extracted_content: vi.fn(async () => '/tmp/saved.txt'),
        } as any,
      }
    );

    expect(pageExtractionLlm.ainvoke).toHaveBeenCalled();
    const messages = pageExtractionLlm.ainvoke.mock.calls[0]?.[0] ?? [];
    const systemPrompt = messages[0]?.text ?? '';
    const userPrompt = messages[1]?.text ?? '';
    expect(systemPrompt).toContain('JSON Schema');
    expect(userPrompt).toContain('<output_schema>');
    expect(userPrompt).toContain('"name"');
    expect(result.error).toBeNull();
    expect(result.extracted_content).toContain('{"name":"Alice","age":30}');
  });

  it('controller.act maps BrowserError to ActionResult memory fields', async () => {
    const controller = new Controller();

    controller.registry.action('Custom browser error action')(
      async function custom_browser_error_action() {
        throw new BrowserError({
          message: 'Navigation blocked by policy',
          short_term_memory: 'Open an allowed URL instead.',
          long_term_memory: 'Attempted blocked navigation to disallowed host.',
        });
      }
    );

    const result = await controller.act(
      { custom_browser_error_action: {} },
      { browser_session: {} as any }
    );

    expect(result.error).toBe('Open an allowed URL instead.');
    expect(result.long_term_memory).toBe(
      'Attempted blocked navigation to disallowed host.'
    );
    expect(result.include_in_memory).toBe(true);
  });
});
