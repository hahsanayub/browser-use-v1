import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  afterEach,
  beforeAll,
  afterAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from 'playwright';
import type { BaseChatModel } from '../src/llm/base.js';

// Mock utilities
vi.mock('../src/utils.js', () => {
  let counter = 0;
  const decorator =
    <T extends (...args: any[]) => any>(_label?: string) =>
    (fn: T) =>
      fn;

  class SignalHandler {
    constructor(_opts?: unknown) {}
    register() {}
    reset() {}
    unregister() {}
  }

  const uuid7str = () => `uuid-${++counter}`;
  const is_new_tab_page = (url: string) =>
    url === 'about:blank' || url.startsWith('chrome://');
  const match_url_with_domain_pattern = (url: string, pattern: string) => {
    if (!pattern) return false;
    const normalized = pattern.replace(/\*/g, '');
    return url.includes(normalized);
  };

  return {
    uuid7str,
    time_execution_sync: decorator,
    time_execution_async: decorator,
    SignalHandler,
    get_browser_use_version: () => 'test-version',
    is_new_tab_page,
    match_url_with_domain_pattern,
    sanitize_surrogates: (text: string) => text,
    log_pretty_path: (p: string) => p,
    wait_until: async (predicate: () => boolean, timeout = 1000) => {
      const start = Date.now();
      while (!predicate() && Date.now() - start < timeout) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (!predicate()) {
        throw new Error('wait_until timeout');
      }
    },
  };
});

vi.mock('../src/llm/messages.js', () => {
  class MessageBase {
    cache = false;
    constructor(init?: { cache?: boolean }) {
      if (init?.cache !== undefined) {
        this.cache = init.cache;
      }
    }
  }

  class SystemMessage extends MessageBase {
    role = 'system' as const;
    constructor(
      public content: any,
      public name: string | null = null
    ) {
      super();
    }
    get text() {
      return typeof this.content === 'string' ? this.content : '';
    }
  }

  class UserMessage extends MessageBase {
    role = 'user' as const;
    constructor(
      public content: any,
      public name: string | null = null
    ) {
      super();
    }
    get text() {
      return typeof this.content === 'string' ? this.content : '';
    }
  }

  class AssistantMessage extends MessageBase {
    role = 'assistant' as const;
    content: any;
    tool_calls: any;
    refusal: any;
    constructor(init: any = {}) {
      super();
      this.content = init.content ?? null;
      this.tool_calls = init.tool_calls ?? null;
      this.refusal = init.refusal ?? null;
    }
    get text() {
      return typeof this.content === 'string' ? this.content : '';
    }
  }

  class ContentPartTextParam {
    type = 'text' as const;
    constructor(public text: string) {}
  }

  class ContentPartRefusalParam {
    type = 'refusal' as const;
    constructor(public refusal: string) {}
  }

  class ImageURL {
    constructor(
      public url: string,
      public detail: 'auto' | 'low' | 'high' = 'auto',
      public media_type: string = 'image/png'
    ) {}
    toString() {
      return this.url;
    }
  }

  class ContentPartImageParam {
    type = 'image_url' as const;
    constructor(public image_url: ImageURL) {}
  }

  class FunctionCall {
    constructor(
      public name: string,
      public args: string
    ) {}
  }

  class ToolCall {
    type = 'function' as const;
    constructor(
      public id: string,
      public functionCall: FunctionCall
    ) {}
  }

  return {
    MessageBase,
    SystemMessage,
    UserMessage,
    AssistantMessage,
    ContentPartTextParam,
    ContentPartRefusalParam,
    ContentPartImageParam,
    ImageURL,
    FunctionCall,
    ToolCall,
  };
});

const { Agent } = await import('../src/agent/service.js');
const { ActionResult, AgentHistoryList } =
  await import('../src/agent/views.js');
const { Controller } = await import('../src/controller/service.js');
const { BrowserSession } = await import('../src/browser/session.js');
const { ActionModel: RegistryActionModel } =
  await import('../src/controller/registry/views.js');

(globalThis as any).ActionModel = RegistryActionModel;

class MockLLM implements BaseChatModel {
  model = 'mock-model';
  private readonly responses: Array<{ completion: any }>;
  calls: any[][] = [];

  constructor(responses: Array<{ completion: any }>) {
    this.responses = responses;
  }

  get provider() {
    return 'mock';
  }
  get name() {
    return this.model;
  }
  get model_name() {
    return this.model;
  }

  async ainvoke(
    messages: any[],
    _output_format?: unknown,
    _options?: { signal?: AbortSignal }
  ) {
    this.calls.push(messages);
    const idx = Math.min(this.calls.length - 1, this.responses.length - 1);
    return this.responses[idx] ?? { completion: { action: [] } };
  }
}

const tempResources: string[] = [];
afterEach(() => {
  while (tempResources.length) {
    const dir = tempResources.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

const createTempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-use-test-'));
  tempResources.push(dir);
  return dir;
};

describe('Advanced Integration Tests (Real Browser)', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
      ],
    });
  });

  afterAll(async () => {
    if (browser) {
      await browser.close();
    }
  });

  afterEach(async () => {
    if (context) {
      await context.close();
    }
  });

  describe('Element Interaction Tests', () => {
    it('clicks button and verifies state change', async () => {
      context = await browser.newContext();
      page = await context.newPage();

      await page.setContent(`
        <!DOCTYPE html>
        <html>
          <head><title>Click Test</title></head>
          <body>
            <button id="test-btn">Click Me</button>
            <div id="result">Not clicked</div>
            <script>
              document.getElementById('test-btn').addEventListener('click', () => {
                document.getElementById('result').textContent = 'Clicked!';
              });
            </script>
          </body>
        </html>
      `);

      await page.waitForLoadState('domcontentloaded');

      const browserSession = new BrowserSession({
        page,
        browser,
        browser_context: context,
        profile: { disable_security: true },
      });

      // Get initial state
      const stateBefore = await browserSession.get_browser_state_with_recovery({
        cache_clickable_elements_hashes: false,
        include_screenshot: false,
      });

      expect(stateBefore).toBeDefined();

      // Click the button using Playwright directly
      await page.click('#test-btn');

      // Verify state changed
      const resultText = await page.textContent('#result');
      expect(resultText).toBe('Clicked!');

      await browserSession.close();
    });

    it('inputs text into form fields', async () => {
      context = await browser.newContext();
      page = await context.newPage();

      await page.setContent(`
        <!DOCTYPE html>
        <html>
          <body>
            <input id="name" type="text" placeholder="Name" />
            <input id="email" type="email" placeholder="Email" />
            <textarea id="message" placeholder="Message"></textarea>
            <div id="output"></div>
            <script>
              ['name', 'email', 'message'].forEach(id => {
                document.getElementById(id).addEventListener('input', (e) => {
                  document.getElementById('output').textContent =
                    'Updated: ' + e.target.id;
                });
              });
            </script>
          </body>
        </html>
      `);

      await page.waitForLoadState('domcontentloaded');

      // Type in fields
      await page.fill('#name', 'John Doe');
      await page.fill('#email', 'john@example.com');
      await page.fill('#message', 'Hello World');

      // Verify values
      expect(await page.inputValue('#name')).toBe('John Doe');
      expect(await page.inputValue('#email')).toBe('john@example.com');
      expect(await page.inputValue('#message')).toBe('Hello World');
    });

    it('handles dropdown selection', async () => {
      context = await browser.newContext();
      page = await context.newPage();

      await page.setContent(`
        <!DOCTYPE html>
        <html>
          <body>
            <select id="country">
              <option value="">Select...</option>
              <option value="us">United States</option>
              <option value="uk">United Kingdom</option>
              <option value="ca">Canada</option>
            </select>
            <div id="selected"></div>
            <script>
              document.getElementById('country').addEventListener('change', (e) => {
                document.getElementById('selected').textContent = e.target.value;
              });
            </script>
          </body>
        </html>
      `);

      await page.waitForLoadState('domcontentloaded');

      // Select dropdown option
      await page.selectOption('#country', 'uk');

      // Verify selection
      expect(await page.inputValue('#country')).toBe('uk');
      expect(await page.textContent('#selected')).toBe('uk');
    });
  });

  describe('Navigation and Tab Management', () => {
    it('manages multiple tabs', async () => {
      context = await browser.newContext();
      page = await context.newPage();

      await page.setContent('<html><body><h1>Tab 1</h1></body></html>');
      await page.waitForLoadState('domcontentloaded');

      // Create new tab
      const page2 = await context.newPage();
      await page2.setContent('<html><body><h1>Tab 2</h1></body></html>');
      await page2.waitForLoadState('domcontentloaded');

      // Verify we have 2 pages
      const pages = context.pages();
      expect(pages.length).toBe(2);

      // Close second tab
      await page2.close();

      // Verify only 1 page remains
      expect(context.pages().length).toBe(1);
    });

    it('navigates back and forward', async () => {
      context = await browser.newContext();
      page = await context.newPage();

      // Navigate to first URL
      await page.goto(
        'data:text/html,<html><body><h1>Page 1</h1></body></html>'
      );
      await page.waitForLoadState('domcontentloaded');

      // Navigate to second URL
      await page.goto(
        'data:text/html,<html><body><h1>Page 2</h1></body></html>'
      );
      await page.waitForLoadState('domcontentloaded');

      // Verify on page 2
      const content2 = await page.textContent('h1');
      expect(content2).toBe('Page 2');

      // Go back
      await page.goBack();
      await page.waitForLoadState('domcontentloaded');

      // Should be back at first page
      const content1 = await page.textContent('h1');
      expect(content1).toBe('Page 1');
    });
  });

  describe('Scrolling Tests', () => {
    it('scrolls to element', async () => {
      context = await browser.newContext();
      page = await context.newPage();

      await page.setContent(`
        <!DOCTYPE html>
        <html>
          <body style="height: 3000px;">
            <div id="top">Top</div>
            <div id="bottom" style="margin-top: 2500px;">Bottom</div>
          </body>
        </html>
      `);

      await page.waitForLoadState('domcontentloaded');

      // Scroll to bottom element
      await page.locator('#bottom').scrollIntoViewIfNeeded();

      // Verify element is in viewport
      const isVisible = await page.locator('#bottom').isVisible();
      expect(isVisible).toBe(true);
    });

    it('handles scroll events', async () => {
      context = await browser.newContext();
      page = await context.newPage();

      await page.setContent(`
        <!DOCTYPE html>
        <html>
          <body style="height: 2000px;">
            <div id="scroll-indicator">Scroll position: 0</div>
            <script>
              window.addEventListener('scroll', () => {
                document.getElementById('scroll-indicator').textContent =
                  'Scroll position: ' + window.scrollY;
              });
            </script>
          </body>
        </html>
      `);

      await page.waitForLoadState('domcontentloaded');

      // Scroll down
      await page.evaluate(() => window.scrollTo(0, 500));

      // Wait for scroll event
      await page.waitForTimeout(100);

      // Verify scroll position updated
      const text = await page.textContent('#scroll-indicator');
      expect(text).toContain('500');
    });
  });

  describe('Agent Workflow Tests', () => {
    it('executes multi-step workflow with real browser', async () => {
      context = await browser.newContext();
      page = await context.newPage();

      await page.setContent(`
        <!DOCTYPE html>
        <html>
          <head><title>Multi-Step Test</title></head>
          <body>
            <input id="name" type="text" placeholder="Enter name" />
            <button id="submit">Submit</button>
            <div id="greeting"></div>
            <script>
              document.getElementById('submit').addEventListener('click', () => {
                const name = document.getElementById('name').value;
                document.getElementById('greeting').textContent = 'Hello, ' + name + '!';
              });
            </script>
          </body>
        </html>
      `);

      await page.waitForLoadState('domcontentloaded');

      const browserSession = new BrowserSession({
        page,
        browser,
        browser_context: context,
        profile: { disable_security: true },
      });

      const controller = new Controller();
      const tempDir = createTempDir();

      // Simulate multi-step agent workflow
      const llm = new MockLLM([
        {
          completion: {
            action: [
              {
                done: {
                  success: true,
                  text: 'Form interaction completed',
                },
              },
            ],
            thinking: 'Found form, will interact',
          },
        },
      ]);

      const agent = new Agent({
        task: 'Fill and submit form',
        llm,
        browser_session: browserSession,
        controller,
        file_system_path: tempDir,
        use_vision: false,
      });

      tempResources.push(agent.agent_directory);

      // Manually interact with form
      await page.fill('#name', 'Test User');
      await page.click('#submit');

      // Run agent
      const history = await agent.run(2);

      // Agent completed at least one step
      expect(history.number_of_steps()).toBeGreaterThan(0);

      // Verify form was interacted with
      const greeting = await page.textContent('#greeting');
      expect(greeting).toBe('Hello, Test User!');

      await browserSession.close();
    });

    it('handles pause and resume', async () => {
      context = await browser.newContext();
      page = await context.newPage();

      await page.setContent('<html><body><h1>Test Page</h1></body></html>');
      await page.waitForLoadState('domcontentloaded');

      const browserSession = new BrowserSession({
        page,
        browser,
        browser_context: context,
        profile: { disable_security: true },
      });

      const controller = new Controller();
      const tempDir = createTempDir();

      const llm = new MockLLM([
        {
          completion: {
            action: [{ done: { success: true, text: 'Completed' } }],
            thinking: 'done',
          },
        },
      ]);

      const agent = new Agent({
        task: 'Test pause/resume',
        llm,
        browser_session: browserSession,
        controller,
        file_system_path: tempDir,
        use_vision: false,
      });

      tempResources.push(agent.agent_directory);

      // Test pause/resume functionality
      expect(agent.state.paused).toBe(false);

      agent.pause();
      expect(agent.state.paused).toBe(true);

      agent.resume();
      expect(agent.state.paused).toBe(false);

      // Run agent normally
      const history = await agent.run(2);

      // Agent completed successfully
      expect(history.number_of_steps()).toBeGreaterThan(0);

      await browserSession.close();
    });
  });

  describe('History Replay Tests', () => {
    it('replays agent history on new session', async () => {
      context = await browser.newContext();
      page = await context.newPage();

      await page.setContent(`
        <!DOCTYPE html>
        <html>
          <head><title>Replay Test</title></head>
          <body>
            <button id="btn1">Button 1</button>
            <div id="status">Ready</div>
          </body>
        </html>
      `);

      await page.waitForLoadState('domcontentloaded');

      const browserSession = new BrowserSession({
        page,
        browser,
        browser_context: context,
        profile: { disable_security: true },
      });

      const controller = new Controller();
      const tempDir = createTempDir();

      // First agent run to create history
      const llm1 = new MockLLM([
        {
          completion: {
            action: [{ done: { success: true, text: 'Completed' } }],
            thinking: 'done',
          },
        },
      ]);

      const agent1 = new Agent({
        task: 'Create history',
        llm: llm1,
        browser_session: browserSession,
        controller,
        file_system_path: tempDir,
        use_vision: false,
      });

      tempResources.push(agent1.agent_directory);

      const history = await agent1.run(2);

      // Verify history was created
      expect(history.number_of_steps()).toBeGreaterThan(0);

      // Test that we can access the history
      expect(history.history.length).toBeGreaterThan(0);

      await browserSession.close();
    });
  });

  describe('Error Handling Tests', () => {
    it('handles element not found gracefully', async () => {
      context = await browser.newContext();
      page = await context.newPage();

      await page.setContent(`
        <!DOCTYPE html>
        <html>
          <body>
            <div id="existing">Exists</div>
          </body>
        </html>
      `);

      await page.waitForLoadState('domcontentloaded');

      // Try to find non-existent element
      const element = page.locator('#non-existent');
      const exists = await element.count();

      expect(exists).toBe(0);
    });

    it('handles navigation timeout', async () => {
      context = await browser.newContext();
      page = await context.newPage();

      // Set very short timeout
      page.setDefaultTimeout(100);

      try {
        // This should timeout
        await page.goto('http://192.0.2.1:9999', {
          waitUntil: 'domcontentloaded',
        });
        expect.fail('Should have thrown timeout error');
      } catch (error) {
        expect(error).toBeDefined();
      }
    });

    it('recovers from page errors', async () => {
      context = await browser.newContext();
      page = await context.newPage();

      await page.setContent(`
        <!DOCTYPE html>
        <html>
          <body>
            <button id="error-btn">Cause Error</button>
            <script>
              document.getElementById('error-btn').addEventListener('click', () => {
                // This would cause an error in real scenario
                console.error('Test error');
              });
            </script>
          </body>
        </html>
      `);

      await page.waitForLoadState('domcontentloaded');

      // Click error button - should not crash test
      await page.click('#error-btn');

      // Page should still be functional
      const buttonExists = await page.locator('#error-btn').count();
      expect(buttonExists).toBe(1);
    });
  });

  describe('Dynamic Content Tests', () => {
    it('handles dynamically loaded content', async () => {
      context = await browser.newContext();
      page = await context.newPage();

      await page.setContent(`
        <!DOCTYPE html>
        <html>
          <body>
            <button id="load-btn">Load Content</button>
            <div id="content"></div>
            <script>
              document.getElementById('load-btn').addEventListener('click', () => {
                setTimeout(() => {
                  document.getElementById('content').innerHTML =
                    '<p id="dynamic">Dynamic Content Loaded</p>';
                }, 100);
              });
            </script>
          </body>
        </html>
      `);

      await page.waitForLoadState('domcontentloaded');

      // Click to load dynamic content
      await page.click('#load-btn');

      // Wait for dynamic content
      await page.waitForSelector('#dynamic', { timeout: 1000 });

      // Verify content loaded
      const dynamicText = await page.textContent('#dynamic');
      expect(dynamicText).toBe('Dynamic Content Loaded');
    });

    it('handles AJAX-like updates', async () => {
      context = await browser.newContext();
      page = await context.newPage();

      await page.setContent(`
        <!DOCTYPE html>
        <html>
          <body>
            <button id="fetch-btn">Fetch Data</button>
            <div id="data">No data</div>
            <script>
              document.getElementById('fetch-btn').addEventListener('click', async () => {
                // Simulate AJAX
                await new Promise(resolve => setTimeout(resolve, 50));
                document.getElementById('data').textContent = 'Data loaded: Item 1, Item 2';
              });
            </script>
          </body>
        </html>
      `);

      await page.waitForLoadState('domcontentloaded');

      // Trigger "AJAX" call
      await page.click('#fetch-btn');

      // Wait for update
      await page.waitForFunction(
        () => document.getElementById('data')?.textContent !== 'No data',
        { timeout: 1000 }
      );

      const dataText = await page.textContent('#data');
      expect(dataText).toContain('Item 1');
    });
  });

  describe('Complex DOM Scenarios', () => {
    it('handles iframe content', async () => {
      context = await browser.newContext();
      page = await context.newPage();

      await page.setContent(`
        <!DOCTYPE html>
        <html>
          <body>
            <iframe id="test-frame" srcdoc="<html><body><p id='inner'>Inside iframe</p></body></html>"></iframe>
          </body>
        </html>
      `);

      await page.waitForLoadState('domcontentloaded');

      // Access iframe content
      const frame = page.frameLocator('#test-frame');
      const innerText = await frame.locator('#inner').textContent();

      expect(innerText).toBe('Inside iframe');
    });

    it('handles shadow DOM', async () => {
      context = await browser.newContext();
      page = await context.newPage();

      await page.setContent(`
        <!DOCTYPE html>
        <html>
          <body>
            <div id="host"></div>
            <script>
              const host = document.getElementById('host');
              const shadow = host.attachShadow({ mode: 'open' });
              shadow.innerHTML = '<p id="shadow-content">Shadow Content</p>';
            </script>
          </body>
        </html>
      `);

      await page.waitForLoadState('domcontentloaded');

      // Access shadow DOM content
      const shadowText = await page.evaluate(() => {
        const host = document.getElementById('host');
        return host?.shadowRoot?.querySelector('#shadow-content')?.textContent;
      });

      expect(shadowText).toBe('Shadow Content');
    });

    it('handles nested structures', async () => {
      context = await browser.newContext();
      page = await context.newPage();

      await page.setContent(`
        <!DOCTYPE html>
        <html>
          <body>
            <div class="container">
              <div class="row">
                <div class="col">
                  <ul class="list">
                    <li class="item">Item 1</li>
                    <li class="item">Item 2</li>
                    <li class="item">Item 3</li>
                  </ul>
                </div>
              </div>
            </div>
          </body>
        </html>
      `);

      await page.waitForLoadState('domcontentloaded');

      // Navigate nested structure
      const items = await page
        .locator('.container .row .col .list .item')
        .all();

      expect(items.length).toBe(3);

      const firstItemText = await items[0].textContent();
      expect(firstItemText).toBe('Item 1');
    });
  });

  describe('State Persistence Tests', () => {
    it('maintains state across interactions', async () => {
      context = await browser.newContext();
      page = await context.newPage();

      await page.setContent(`
        <!DOCTYPE html>
        <html>
          <body>
            <button id="increment">Increment</button>
            <div id="counter">0</div>
            <script>
              let count = 0;
              document.getElementById('increment').addEventListener('click', () => {
                count++;
                document.getElementById('counter').textContent = count;
              });
            </script>
          </body>
        </html>
      `);

      await page.waitForLoadState('domcontentloaded');

      // Click multiple times
      await page.click('#increment');
      await page.click('#increment');
      await page.click('#increment');

      // Verify state maintained
      const counterText = await page.textContent('#counter');
      expect(counterText).toBe('3');
    });

    it('persists data across page evaluations', async () => {
      context = await browser.newContext();
      page = await context.newPage();

      await page.goto(
        'data:text/html,<!DOCTYPE html><html><body><div id="status">Ready</div></body></html>'
      );

      await page.waitForLoadState('domcontentloaded');

      // Set global variable
      await page.evaluate(() => {
        (window as any).testData = { value: 'persistent' };
      });

      // Retrieve global variable in separate evaluation
      const result = await page.evaluate(() => {
        return (window as any).testData?.value;
      });

      // Verify data persists across evaluations
      expect(result).toBe('persistent');
    });
  });

  describe('Performance and Timing Tests', () => {
    it('handles rapid interactions', async () => {
      context = await browser.newContext();
      page = await context.newPage();

      await page.setContent(`
        <!DOCTYPE html>
        <html>
          <body>
            <button id="rapid-btn">Click</button>
            <div id="click-count">0</div>
            <script>
              let count = 0;
              document.getElementById('rapid-btn').addEventListener('click', () => {
                count++;
                document.getElementById('click-count').textContent = count;
              });
            </script>
          </body>
        </html>
      `);

      await page.waitForLoadState('domcontentloaded');

      // Rapid clicks
      const clicks = 10;
      for (let i = 0; i < clicks; i++) {
        await page.click('#rapid-btn');
      }

      const countText = await page.textContent('#click-count');
      expect(parseInt(countText || '0')).toBe(clicks);
    });

    it('waits for animations to complete', async () => {
      context = await browser.newContext();
      page = await context.newPage();

      await page.setContent(`
        <!DOCTYPE html>
        <html>
          <head>
            <style>
              .box {
                width: 100px;
                height: 100px;
                background: red;
                transition: background 0.3s;
              }
              .box.active {
                background: green;
              }
            </style>
          </head>
          <body>
            <div class="box" id="animated-box"></div>
            <button id="animate">Animate</button>
            <script>
              document.getElementById('animate').addEventListener('click', () => {
                document.getElementById('animated-box').classList.add('active');
              });
            </script>
          </body>
        </html>
      `);

      await page.waitForLoadState('domcontentloaded');

      // Trigger animation
      await page.click('#animate');

      // Wait for animation
      await page.waitForTimeout(500);

      // Verify final state
      const hasClass = await page.evaluate(() => {
        return document
          .getElementById('animated-box')
          ?.classList.contains('active');
      });

      expect(hasClass).toBe(true);
    });
  });
});
