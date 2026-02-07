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

// Import after mocks
import { Registry } from '../src/controller/registry/service.js';
import { Controller } from '../src/controller/service.js';
import { ActionResult } from '../src/agent/views.js';

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
      })(async function default_params_action(params: { required: string; optional: string }) {
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
      })(async function validated_action(params: { email: string; age: number }) {
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
      })(async function array_params_action(params: { items: string[]; counts: number[] }) {
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
      })(async function optional_params_action(params: { required: string; optional?: string }) {
        return new ActionResult({
          extracted_content: `Required: ${params.required}, Optional: ${params.optional ?? 'not provided'}`,
        });
      });

      // Without optional
      const result1 = await registry.execute_action('optional_params_action', {
        required: 'test',
      });
      expect(result1.extracted_content).toBe('Required: test, Optional: not provided');

      // With optional
      const result2 = await registry.execute_action('optional_params_action', {
        required: 'test',
        optional: 'provided',
      });
      expect(result2.extracted_content).toBe('Required: test, Optional: provided');
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
      })(async function scroll(params: { direction: 'up' | 'down'; amount: number }) {
        const delta = params.direction === 'down' ? params.amount : -params.amount;
        await page.evaluate((d) => window.scrollBy(0, d), delta);
        return new ActionResult({
          extracted_content: `Scrolled ${params.direction} by ${params.amount}px`,
        });
      });

      const initialScroll = await page.evaluate(() => window.scrollY);
      await registry.execute_action('scroll', { direction: 'down', amount: 500 });
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
    expect(result.extracted_content).toContain('Waiting for 3 seconds');
    expect(result.extracted_content).not.toContain('NaN');
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
});
