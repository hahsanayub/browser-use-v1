/**
 * Tests for BrowserSession functionality.
 *
 * Tests cover:
 * 1. Session lifecycle (start, stop)
 * 2. Basic browser operations
 * 3. Configuration options
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Mock utils
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

// Mock telemetry
vi.mock('../src/telemetry/service.js', () => ({
  productTelemetry: {
    capture: vi.fn(),
    flush: vi.fn(),
  },
}));

// Import after mocks
import { BrowserSession } from '../src/browser/session.js';
import { BrowserProfile } from '../src/browser/profile.js';

describe('BrowserSession Basic Operations', () => {
  it('creates browser session with profile', () => {
    const profile = new BrowserProfile({
      headless: true,
    });

    const session = new BrowserSession({
      browser_profile: profile,
    });

    expect(session).toBeDefined();
  });

  it('clones provided browser_profile to avoid shared mutable state', () => {
    const profile = new BrowserProfile({
      keep_alive: null,
      allowed_domains: ['example.com'],
    });

    const session = new BrowserSession({
      browser_profile: profile,
    });

    expect(session.browser_profile).not.toBe(profile);
    profile.keep_alive = true;
    expect(session.browser_profile.keep_alive).toBeNull();
  });

  it('supports python compatibility aliases for ownership and model_copy', () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({}),
      browser: {} as any,
    });

    expect(session._owns_browser_resources).toBe(false);

    const copied = session.model_copy();
    expect(copied).toBeInstanceOf(BrowserSession);
    expect(copied).not.toBe(session);
  });

  it('enforces single-agent attachment claims', () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    });

    expect(session.claim_agent('agent-a')).toBe(true);
    expect(session.claim_agent('agent-a')).toBe(true);
    expect(session.claim_agent('agent-b')).toBe(false);
    expect(session.get_attached_agent_id()).toBe('agent-a');

    expect(session.release_agent('agent-b')).toBe(false);
    expect(session.get_attached_agent_id()).toBe('agent-a');

    expect(session.release_agent('agent-a')).toBe(true);
    expect(session.get_attached_agent_id()).toBeNull();
  });

  it('supports shared attachment mode for controlled parallel agents', () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    });

    expect(session.claim_agent('agent-a', 'shared')).toBe(true);
    expect(session.claim_agent('agent-b', 'shared')).toBe(true);
    expect(session.get_attached_agent_ids().sort()).toEqual([
      'agent-a',
      'agent-b',
    ]);
    expect(session.claim_agent('agent-c')).toBe(false);

    expect(session.release_agent('agent-a')).toBe(true);
    expect(session.get_attached_agent_ids()).toEqual(['agent-b']);
    expect(session.release_agent('agent-b')).toBe(true);
    expect(session.get_attached_agent_ids()).toEqual([]);
  });

  it('deduplicates concurrent stop calls', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    });
    await session.start();

    const shutdownSpy = vi
      .spyOn(session as any, '_shutdown_browser_session')
      .mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        (session as any).initialized = false;
      });

    await Promise.all([session.stop(), session.stop(), session.stop()]);
    expect(shutdownSpy).toHaveBeenCalledTimes(1);
  });

  it('starts and stops browser session', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        headless: true,
      }),
    });

    await session.start();
    expect(session.browser).toBeTruthy();
    expect(session.browser_context).toBeTruthy();
    expect(await session.get_current_page()).toBeTruthy();

    await session.stop();
    expect(session.browser).toBeNull();
    expect(session.browser_context).toBeNull();
  });
});

describe('BrowserProfile Configuration', () => {
  it('creates profile with default headless (null by default)', () => {
    const profile = new BrowserProfile({});
    // headless defaults to null (auto-detect) in BrowserProfile
    expect(profile.config.headless).toBeNull();
  });

  it('creates profile with custom viewport', () => {
    const profile = new BrowserProfile({
      viewport: { width: 1920, height: 1080 },
    });

    expect(profile.viewport?.width).toBe(1920);
    expect(profile.viewport?.height).toBe(1080);
  });

  it('creates profile with user agent', () => {
    const customUA = 'Custom User Agent';
    const profile = new BrowserProfile({
      user_agent: customUA,
    });

    // Access via config since user_agent is not a public getter
    expect(profile.config.user_agent).toBe(customUA);
  });

  it('creates profile with headless mode', () => {
    const profile = new BrowserProfile({
      headless: true,
    });

    expect(profile.config.headless).toBe(true);
  });
});

describe('BrowserSession PDF Auto Download', () => {
  it('auto-downloads detected PDFs and tracks the file', async () => {
    const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-pdf-'));
    try {
      const session = new BrowserSession({
        browser_profile: new BrowserProfile({
          downloads_path: downloadsDir,
        }),
      });

      const fakePage = {
        url: () => 'https://example.com/report.pdf',
        evaluate: vi.fn(async () => ({
          data: [37, 80, 68, 70], // %PDF
          fromCache: true,
          responseSize: 4,
        })),
      } as any;

      const downloadedPath = await (session as any)._auto_download_pdf_if_needed(
        fakePage
      );

      expect(downloadedPath).toBeTruthy();
      expect(fs.existsSync(downloadedPath!)).toBe(true);
      expect(session.get_downloaded_files()).toContain(downloadedPath);
    } finally {
      fs.rmSync(downloadsDir, { recursive: true, force: true });
    }
  });

  it('skips re-downloading the same PDF filename', async () => {
    const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-pdf-'));
    try {
      const session = new BrowserSession({
        browser_profile: new BrowserProfile({
          downloads_path: downloadsDir,
        }),
      });

      const evaluate = vi.fn(async () => ({
        data: [37, 80, 68, 70],
        fromCache: false,
        responseSize: 4,
      }));
      const fakePage = {
        url: () => 'https://example.com/duplicate.pdf?token=abc',
        evaluate,
      } as any;

      const firstPath = await (session as any)._auto_download_pdf_if_needed(
        fakePage
      );
      const secondPath = await (session as any)._auto_download_pdf_if_needed(
        fakePage
      );

      expect(firstPath).toBeTruthy();
      expect(secondPath).toBeNull();
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(session.get_downloaded_files()).toHaveLength(1);
    } finally {
      fs.rmSync(downloadsDir, { recursive: true, force: true });
    }
  });
});

describe('Direct Playwright Operations', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    page = await context.newPage();
  });

  afterAll(async () => {
    await browser.close();
  });

  it('navigates to URL', async () => {
    await page.goto('about:blank');
    expect(page.url()).toBe('about:blank');
  });

  it('gets page content', async () => {
    await page.setContent('<html><body><h1>Test</h1></body></html>');
    const content = await page.content();
    expect(content).toContain('Test');
  });

  it('handles page interactions', async () => {
    await page.setContent(`
      <html>
        <body>
          <button id="btn" onclick="this.textContent='Clicked'">Click me</button>
        </body>
      </html>
    `);

    await page.click('#btn');
    const text = await page.textContent('#btn');
    expect(text).toBe('Clicked');
  });

  it('handles form inputs', async () => {
    await page.setContent(`
      <html>
        <body>
          <input id="input" type="text" />
        </body>
      </html>
    `);

    await page.fill('#input', 'Hello World');
    const value = await page.inputValue('#input');
    expect(value).toBe('Hello World');
  });

  it('handles multiple tabs', async () => {
    const page2 = await context.newPage();
    await page2.goto('about:blank');

    const pages = context.pages();
    expect(pages.length).toBeGreaterThanOrEqual(2);

    await page2.close();
  });

  it('captures screenshots', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'screenshot-test-'));
    const screenshotPath = path.join(tempDir, 'test.png');

    await page.setContent('<html><body style="background:blue;"></body></html>');
    await page.screenshot({ path: screenshotPath });

    expect(fs.existsSync(screenshotPath)).toBe(true);

    // Cleanup
    fs.rmSync(tempDir, { recursive: true });
  });

  it('evaluates JavaScript', async () => {
    const result = await page.evaluate(() => 1 + 1);
    expect(result).toBe(2);
  });

  it('gets scroll position', async () => {
    await page.setContent(`
      <html>
        <body style="height: 5000px;">
          <div>Tall content</div>
        </body>
      </html>
    `);

    const scrollInfo = await page.evaluate(() => ({
      scrollTop: window.scrollY,
      scrollHeight: document.body.scrollHeight,
      clientHeight: window.innerHeight,
    }));

    expect(scrollInfo.scrollTop).toBe(0);
    expect(scrollInfo.scrollHeight).toBeGreaterThan(0);
  });

  it('handles navigation history', async () => {
    await page.setContent('<html><body>Page 1</body></html>');

    // Page should be functional
    const content = await page.content();
    expect(content).toContain('Page 1');
  });
});

describe('Storage State', () => {
  it('saves and loads storage state', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-test-'));
    const statePath = path.join(tempDir, 'state.json');

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();

    // Add a cookie
    await context.addCookies([
      {
        name: 'test_cookie',
        value: 'test_value',
        domain: 'localhost',
        path: '/',
      },
    ]);

    // Save state
    await context.storageState({ path: statePath });

    expect(fs.existsSync(statePath)).toBe(true);

    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    expect(state).toHaveProperty('cookies');

    await browser.close();

    // Cleanup
    fs.rmSync(tempDir, { recursive: true });
  });
});

describe('DOM Extraction Patterns', () => {
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

  it('extracts interactive elements', async () => {
    await page.setContent(`
      <html>
        <body>
          <button id="btn1">Button 1</button>
          <a href="#" id="link1">Link 1</a>
          <input type="text" id="input1" />
          <select id="select1">
            <option>Option 1</option>
          </select>
        </body>
      </html>
    `);

    const interactiveElements = await page.evaluate(() => {
      const selectors = ['button', 'a', 'input', 'select', 'textarea'];
      const elements: string[] = [];
      for (const selector of selectors) {
        document.querySelectorAll(selector).forEach((el) => {
          elements.push(el.tagName.toLowerCase());
        });
      }
      return elements;
    });

    expect(interactiveElements).toContain('button');
    expect(interactiveElements).toContain('a');
    expect(interactiveElements).toContain('input');
    expect(interactiveElements).toContain('select');
  });

  it('handles complex nested structures', async () => {
    await page.setContent(`
      <html>
        <body>
          <nav>
            <ul>
              <li><a href="#1">Item 1</a></li>
              <li><a href="#2">Item 2</a></li>
            </ul>
          </nav>
          <main>
            <form>
              <input type="text" name="name" />
              <button type="submit">Submit</button>
            </form>
          </main>
        </body>
      </html>
    `);

    const structure = await page.evaluate(() => {
      return {
        hasNav: !!document.querySelector('nav'),
        hasMain: !!document.querySelector('main'),
        hasForm: !!document.querySelector('form'),
        linkCount: document.querySelectorAll('a').length,
        inputCount: document.querySelectorAll('input').length,
      };
    });

    expect(structure.hasNav).toBe(true);
    expect(structure.hasMain).toBe(true);
    expect(structure.hasForm).toBe(true);
    expect(structure.linkCount).toBe(2);
    expect(structure.inputCount).toBe(1);
  });
});

describe('Error Handling', () => {
  it('handles navigation timeout gracefully', async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await page.goto('http://localhost:99999', { timeout: 1000 });
    } catch (error) {
      expect(error).toBeDefined();
    }

    await browser.close();
  });

  it('handles missing elements', async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.setContent('<html><body></body></html>');

    const element = await page.$('#nonexistent');
    expect(element).toBeNull();

    await browser.close();
  });
});
