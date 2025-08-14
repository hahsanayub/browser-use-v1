/* eslint-disable prettier/prettier */
import { z } from 'zod';
import type { Page } from 'playwright';
import { action } from './decorators';
import type { ActionResult } from '../types/agent';
import { withHealthCheck } from '../services/health-check';
import { promises as fs } from 'fs';
import path from 'path';
import type { BrowserContext as AgentBrowserContext } from '../browser/BrowserContext';
import type { BrowserSession } from '../browser/BrowserSession';

// Use BrowserSession's enhanced index-based interaction
async function executeWithBrowserSession<T>(
  context: { browserSession?: BrowserSession } | undefined,
  fn: (session: BrowserSession) => Promise<T>
): Promise<T> {
  const session = context?.browserSession;
  if (!session) {
    throw new Error('BrowserSession not available');
  }
  return await fn(session);
}

// Helper function to resolve index to DOM target
async function resolveIndexToDomTarget(
  index: number,
  page: Page,
  context?: { browserSession?: BrowserSession }
): Promise<{ xpath: string; selector: string }> {
  const session = context?.browserSession;
  if (session) {
    const summary = await session.getStateSummary(false);
    const node = summary.selectorMap.get(index);
    if (node) {
      return {
        xpath: node.xpath ? `/${node.xpath}` : '',
        selector: node.xpath
          ? `xpath=/${node.xpath}`
          : node.selector || node.tagName || '',
      };
    }
  }
  // Fallback: try to find element by data-index attribute
  const selector = `[data-index="${index}"]`;
  const xpath = `//*[@data-index="${index}"]`;
  return { xpath, selector };
}

// click
class ClickActions {
  @action(
    'click',
    'Click an element by CSS selector',
    z.object({ selector: z.string().min(1) }),
    {
      isAvailableForPage: (page) => page && !page.isClosed(),
    }
  )
  static async click({
    params,
    page,
  }: {
    params: { selector: string };
    page: Page;
  }): Promise<ActionResult> {
    const { selector } = params;
    return withHealthCheck(page, async (p) => {
      await p.click(selector);
      await p.waitForTimeout(300);
      return { success: true, message: `Clicked ${selector}` };
    });
  }
}

// type
class TypeActions {
  @action(
    'type',
    'Type text into an input by selector',
    z.object({ selector: z.string().min(1), text: z.string() }),
    {
      isAvailableForPage: (page) => page && !page.isClosed(),
    }
  )
  static async type({
    params,
    page,
  }: {
    params: { selector: string; text: string };
    page: Page;
  }): Promise<ActionResult> {
    const { selector, text } = params;
    return withHealthCheck(page, async (p) => {
      await p.fill(selector, '');
      await p.type(selector, text, { delay: 30 });
      return { success: true, message: `Typed into ${selector}` };
    });
  }
}

// goto
class GotoActions {
  @action('goto', 'Navigate to a URL', z.object({ url: z.string().url() }), {
    isAvailableForPage: (page) => {
      if (!page || page.isClosed()) return false;
      try {
        const url = page.url();
        // 示例：禁止在 example.org 域名上执行 goto（可按需调整）
        if (url.includes('example.org')) return false;
      } catch {
        // ignore
      }
      return true;
    },
  })
  static async goto({
    params,
    page,
  }: {
    params: { url: string };
    page: Page;
  }): Promise<ActionResult> {
    const { url } = params;
    return withHealthCheck(page, async (p) => {
      await p.goto(url, { waitUntil: 'domcontentloaded' });
      return { success: true, message: `Navigated to ${url}` };
    });
  }
}

// scroll
class ScrollActions {
  @action(
    'scroll',
    'Scroll the page',
    z.object({
      direction: z.enum(['up', 'down', 'left', 'right']).default('down'),
      amount: z.number().min(1).max(10).default(3),
    }),
    {
      isAvailableForPage: (page) => page && !page.isClosed(),
    }
  )
  static async scroll({
    params,
    page,
  }: {
    params: { direction: 'up' | 'down' | 'left' | 'right'; amount?: number };
    page: Page;
  }): Promise<ActionResult> {
    const pixels = (params.amount ?? 3) * 300;
    const dx =
      params.direction === 'left'
        ? -pixels
        : params.direction === 'right'
          ? pixels
          : 0;
    const dy =
      params.direction === 'up'
        ? -pixels
        : params.direction === 'down'
          ? pixels
          : 0;
    return withHealthCheck(page, async (p) => {
      await p.mouse.wheel(dx, dy);
      await p.waitForTimeout(200);
      return {
        success: true,
        message: `Scrolled ${params.direction} ${params.amount ?? 3}`,
      };
    });
  }

  @action(
    'scroll_pages',
    'Scroll page by number of pages (down=true for down; supports half pages like 0.5)',
    z.object({
      down: z.boolean().default(true),
      num_pages: z.number().positive().default(1),
      index: z.number().int().min(0).optional(),
    }),
    { isAvailableForPage: (page) => page && !page.isClosed() }
  )
  static async scrollPages({
    params,
    page,
    context,
  }: {
    params: { down: boolean; num_pages: number; index?: number };
    page: Page;
    context?: { browserSession?: BrowserSession };
  }): Promise<ActionResult> {
    return withHealthCheck(page, async (p) => {
      const windowHeight = await p.evaluate(() => window.innerHeight);
      const dy = Math.round(
        (params.down ? 1 : -1) * windowHeight * params.num_pages
      );
      if (typeof params.index === 'number') {
        try {
          // Use BrowserSession for more robust element handling
          const session = context?.browserSession;
          if (session) {
            const summary = await session.getStateSummary(false);
            const node = summary.selectorMap.get(params.index);
            if (node) {
              const target = {
                selector: node.xpath
                  ? `xpath=/${node.xpath}`
                  : node.selector || node.tagName,
                xpath: node.xpath ? `/${node.xpath}` : undefined,
              };
              const result = await p.evaluate(
                (payload) => {
                  const { dy, xpath, selector } = payload as {
                    dy: number;
                    xpath?: string;
                    selector?: string;
                  };
                  let node: HTMLElement | null = null;
                  if (xpath) {
                    node = document.evaluate(
                      xpath,
                      document,
                      null,
                      XPathResult.FIRST_ORDERED_NODE_TYPE,
                      null
                    ).singleNodeValue as HTMLElement | null;
                  }
                  if (!node && selector) {
                    node = document.querySelector(
                      selector
                    ) as HTMLElement | null;
                  }
                  if (!node) return false;
                  const before = node.scrollTop;
                  node.scrollTop = before + dy / 3;
                  return Math.abs(node.scrollTop - before) > 0.5;
                },
                {
                  dy,
                  xpath: target.xpath,
                  selector: target.selector.startsWith('xpath=')
                    ? undefined
                    : target.selector,
                }
              );
              if (!result) {
                await p.evaluate((y) => window.scrollBy(0, y as number), dy);
              }
            } else {
              await p.evaluate((y) => window.scrollBy(0, y as number), dy);
            }
          } else {
            await p.evaluate((y) => window.scrollBy(0, y as number), dy);
          }
        } catch {
          await p.evaluate((y) => window.scrollBy(0, y as number), dy);
        }
      } else {
        await p.evaluate((y) => window.scrollBy(0, y as number), dy);
      }
      return {
        success: true,
        message: `Scrolled ${params.down ? 'down' : 'up'} by ${params.num_pages} pages`,
      };
    });
  }
}

// wait
class WaitActions {
  @action(
    'wait',
    'Wait for time/selector/navigation',
    z.object({
      type: z.enum(['time', 'element', 'navigation']).default('time'),
      value: z.union([z.number(), z.string()]),
      timeout: z.number().min(100).max(60000).default(5000),
    }),
    {
      isAvailableForPage: (page) => page && !page.isClosed(),
    }
  )
  static async wait({
    params,
    page,
  }: {
    params: {
      type: 'time' | 'element' | 'navigation';
      value: number | string;
      timeout?: number;
    };
    page: Page;
  }): Promise<ActionResult> {
    return withHealthCheck(page, async (p) => {
      if (params.type === 'time') {
        await p.waitForTimeout(params.value as number);
      } else if (params.type === 'element') {
        await p.waitForSelector(params.value as string, {
          timeout: params.timeout,
        });
      } else {
        await p.waitForURL(params.value as string, { timeout: params.timeout });
      }
      return { success: true, message: `Waited for ${params.type}` };
    });
  }
}

// key
class KeyActions {
  @action('key', 'Press a keyboard key', z.object({ key: z.string().min(1) }), {
    isAvailableForPage: (page) => page && !page.isClosed(),
  })
  static async key({
    params,
    page,
  }: {
    params: { key: string };
    page: Page;
  }): Promise<ActionResult> {
    return withHealthCheck(page, async (p) => {
      await p.keyboard.press(params.key);
      await p.waitForTimeout(100);
      return { success: true, message: `Pressed ${params.key}` };
    });
  }
}

// hover
class HoverActions {
  @action(
    'hover',
    'Hover over an element',
    z.object({ selector: z.string().min(1) }),
    {
      isAvailableForPage: (page) => page && !page.isClosed(),
    }
  )
  static async hover({
    params,
    page,
  }: {
    params: { selector: string };
    page: Page;
  }): Promise<ActionResult> {
    return withHealthCheck(page, async (p) => {
      await p.hover(params.selector);
      await p.waitForTimeout(100);
      return { success: true, message: `Hovered ${params.selector}` };
    });
  }
}

// screenshot
class ScreenshotActions {
  @action(
    'screenshot',
    'Take a full-page screenshot',
    z.object({}).optional(),
    {
      isAvailableForPage: (page) => page && !page.isClosed(),
    }
  )
  static async screenshot({
    page,
  }: {
    params: Record<string, unknown>;
    page: Page;
  }): Promise<ActionResult> {
    return withHealthCheck(page, async (p) => {
      const image = await p.screenshot({ fullPage: true, type: 'png' });
      return {
        success: true,
        message: 'Screenshot taken',
        metadata: { size: image.length, timestamp: Date.now() },
      };
    });
  }
}

// done
class DoneActions {
  @action(
    'done',
    'Mark the task as completed - provide a summary of results for the user. Set success=true if task completed successfully, false otherwise. Text should be your response to the user summarizing results. Include files you would like to display to the user in files_to_display.',
    z.object({
      success: z.boolean().describe('Whether the task was completed successfully'),
      text: z.string().describe('Summary of results for the user'),
      files_to_display: z.array(z.string()).optional().default([]).describe('Files to display to the user')
    })
  )
  static async done({ params }: { params: { success: boolean; text: string; files_to_display?: string[] } }): Promise<ActionResult> {
    return {
      success: params.success,
      message: params.text,
      attachments: params.files_to_display
    };
  }
}

class IndexActions {
  @action(
    'click_element_by_index',
    'Click an interactive element by index shown on the page overlay',
    z.object({ index: z.number().int().min(0) }),
    { isAvailableForPage: (page) => page && !page.isClosed() }
  )
  static async clickByIndex({
    params,
    page: _page, // eslint-disable-line @typescript-eslint/no-unused-vars
    context,
  }: {
    params: { index: number };
    page: Page;
    context?: { browserSession?: BrowserSession };
  }): Promise<ActionResult> {
    return executeWithBrowserSession(context, async (session) => {
      await session.clickByIndex(params.index);
      return { success: true, message: `Clicked element #${params.index}` };
    });
  }

  @action(
    'input_text',
    'Focus an interactive element by index and type the provided text',
    z.object({ index: z.number().int().min(0), text: z.string() }),
    { isAvailableForPage: (page) => page && !page.isClosed() }
  )
  static async inputText({
    params,
    page: _page, // eslint-disable-line @typescript-eslint/no-unused-vars
    context,
  }: {
    params: { index: number; text: string };
    page: Page;
    context?: { browserSession?: BrowserSession };
  }): Promise<ActionResult> {
    return executeWithBrowserSession(context, async (session) => {
      await session.typeByIndex(params.index, params.text);
      return {
        success: true,
        message: `Input text into element #${params.index}`,
      };
    });
  }
}

class NavActions {
  @action(
    'go_to_url',
    'Navigate to URL (optionally in new tab with new_tab=true)',
    z.object({ url: z.string().url(), new_tab: z.boolean().optional() }),
    { isAvailableForPage: (page) => page && !page.isClosed() }
  )
  static async goToUrl({
    params,
    page: _page, // eslint-disable-line @typescript-eslint/no-unused-vars
    context,
  }: {
    params: { url: string; new_tab?: boolean };
    page: Page;
    context: {
      browserContext?: AgentBrowserContext;
      browserSession?: BrowserSession;
    };
  }): Promise<ActionResult> {
    return executeWithBrowserSession(context, async (session) => {
      await session.navigate(params.url, params.new_tab || false);
      const message = params.new_tab
        ? `Opened new tab with ${params.url}`
        : `Navigated to ${params.url}`;
      return { success: true, message };
    });
  }

  @action('go_back', 'Navigate back in history', z.object({}).optional(), {
    isAvailableForPage: (page) => page && !page.isClosed(),
  })
  static async goBack({
    page,
  }: {
    params: Record<string, unknown>;
    page: Page;
  }): Promise<ActionResult> {
    return withHealthCheck(page, async (p) => {
      await p.goBack();
      return { success: true, message: 'Navigated back' };
    });
  }
}

class KeysActions {
  @action(
    'send_keys',
    'Send special keys via page.keyboard.press (e.g., Enter, Escape, Control+V)',
    z.object({ keys: z.union([z.string(), z.array(z.string())]) }),
    { isAvailableForPage: (page) => page && !page.isClosed() }
  )
  static async sendKeys({
    params,
    page,
  }: {
    params: { keys: string | string[] };
    page: Page;
  }): Promise<ActionResult> {
    return withHealthCheck(page, async (p) => {
      const pressOne = async (key: string) => p.keyboard.press(key);
      if (Array.isArray(params.keys)) {
        for (const k of params.keys) await pressOne(k);
      } else {
        await pressOne(params.keys);
      }
      return {
        success: true,
        message: `Sent keys: ${JSON.stringify(params.keys)}`,
      };
    });
  }
}

class SearchActions {
  @action(
    'search_google',
    'Search a query in Google (opens results)',
    z.object({ query: z.string().min(1) }),
    { isAvailableForPage: (page) => page && !page.isClosed() }
  )
  static async searchGoogle({
    params,
    page,
  }: {
    params: { query: string };
    page: Page;
  }): Promise<ActionResult> {
    const url = `https://www.google.com/search?q=${encodeURIComponent(params.query)}&udm=14`;
    return withHealthCheck(page, async (p) => {
      await p.goto(url, { waitUntil: 'domcontentloaded' });
      return {
        success: true,
        message: `Searched Google for "${params.query}"`,
      };
    });
  }
}

class DropdownActions {
  @action(
    'get_dropdown_options',
    'Get options from a native dropdown or ARIA menu by element index',
    z.object({ index: z.number().int().min(0) }),
    { isAvailableForPage: (page) => page && !page.isClosed() }
  )
  static async getOptions({
    params,
    page,
    context,
  }: {
    params: { index: number };
    page: Page;
    context?: { browserSession?: BrowserSession };
  }): Promise<ActionResult> {
    return withHealthCheck(page, async (p) => {
      const target = await resolveIndexToDomTarget(params.index, p, context);
      const xpath = target.xpath;
      const info = await p.evaluate((xp) => {
        const el = document.evaluate(
          xp as string,
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null
        ).singleNodeValue as any;
        if (!el) return null;
        if (el.tagName?.toLowerCase() === 'select') {
          const options = Array.from(el.options).map((o: any, i: number) => ({
            index: i,
            text: o.text,
            value: o.value,
          }));
          return { type: 'select', options };
        }
        const role = el.getAttribute?.('role');
        if (role === 'menu' || role === 'listbox' || role === 'combobox') {
          const items = el.querySelectorAll(
            '[role="menuitem"], [role="option"]'
          );
          const options = Array.from(items).map((it: any, i: number) => ({
            index: i,
            text: (it.textContent || '').trim(),
            value: (it.textContent || '').trim(),
          }));
          return { type: 'aria', options };
        }
        return null;
      }, xpath);
      if (!info || !info.options || info.options.length === 0) {
        return { success: true, message: 'No dropdown options found' };
      }
      const list = info.options
        .map((o: any) => `${o.index}: text=${JSON.stringify(o.text)}`)
        .join('\n');
      return { success: true, message: list };
    });
  }

  @action(
    'select_dropdown_option',
    'Select option or ARIA menu item by exact text for element index',
    z.object({ index: z.number().int().min(0), text: z.string().min(1) }),
    { isAvailableForPage: (page) => page && !page.isClosed() }
  )
  static async selectOption({
    params,
    page,
    context,
  }: {
    params: { index: number; text: string };
    page: Page;
    context?: { browserSession?: BrowserSession };
  }): Promise<ActionResult> {
    return withHealthCheck(page, async (p) => {
      const target = await resolveIndexToDomTarget(params.index, p, context);
      const xpath = target.xpath;
      // Try native select first
      const isSelect = await p.evaluate((xp) => {
        const el = document.evaluate(
          xp as string,
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null
        ).singleNodeValue as any;
        return !!el && el.tagName?.toLowerCase() === 'select';
      }, xpath);
      if (isSelect) {
        const values = await p
          .locator(`xpath=${xpath}`)
          .nth(0)
          .selectOption({ label: params.text });
        return {
          success: true,
          message: `Selected option ${params.text} (${JSON.stringify(values)})`,
        };
      }
      // Try ARIA menu
      const ok = await p.evaluate(
        (payload) => {
          const { xpath, text } = payload as { xpath: string; text: string };
          const el = document.evaluate(
            xpath,
            document,
            null,
            XPathResult.FIRST_ORDERED_NODE_TYPE,
            null
          ).singleNodeValue as HTMLElement | null;
          if (!el) return false;
          const items = el.querySelectorAll(
            '[role="menuitem"], [role="option"]'
          );
          for (const item of Array.from(items)) {
            const t = (item.textContent || '').trim();
            if (t === text) {
              (item as HTMLElement).click();
              const evt = new MouseEvent('click', {
                bubbles: true,
                cancelable: true,
                view: window,
              });
              item.dispatchEvent(evt);
              return true;
            }
          }
          return false;
        },
        { xpath, text: params.text }
      );
      if (ok)
        return { success: true, message: `Selected menu item ${params.text}` };
      return {
        success: false,
        message: `Option '${params.text}' not found`,
        error: 'OPTION_NOT_FOUND',
      };
    });
  }
}

class SheetsActions {
  @action(
    'sheets_read_all',
    'Google Sheets: copy all visible sheet contents to memory',
    z.object({}).optional(),
    { isAvailableForPage: (page) => page && !page.isClosed() }
  )
  static async readAll({
    page,
  }: {
    params: Record<string, unknown>;
    page: Page;
  }): Promise<ActionResult> {
    return withHealthCheck(page, async (p) => {
      await p.keyboard.press('Enter');
      await p.keyboard.press('Escape');
      await p.keyboard.press('ControlOrMeta+A');
      await p.keyboard.press('ControlOrMeta+C');
      const text = await p.evaluate(() => navigator.clipboard.readText());
      return { success: true, message: text };
    });
  }

  @action(
    'sheets_read_range',
    'Google Sheets: read a cell or range like A1 or A1:B2',
    z.object({ range: z.string().min(1) }),
    { isAvailableForPage: (page) => page && !page.isClosed() }
  )
  static async readRange({
    params,
    page,
  }: {
    params: { range: string };
    page: Page;
  }): Promise<ActionResult> {
    return withHealthCheck(page, async (p) => {
      await p.keyboard.press('Enter');
      await p.keyboard.press('Escape');
      await p.keyboard.press('Home');
      await p.keyboard.press('ArrowUp');
      await p.keyboard.press('Control+G');
      await p.waitForTimeout(200);
      await p.keyboard.type(params.range);
      await p.waitForTimeout(200);
      await p.keyboard.press('Enter');
      await p.waitForTimeout(200);
      await p.keyboard.press('Escape');
      await p.keyboard.press('ControlOrMeta+C');
      const text = await p.evaluate(() => navigator.clipboard.readText());
      return { success: true, message: text };
    });
  }

  @action(
    'sheets_update_range',
    'Google Sheets: update cell/range contents by simulating paste of TSV',
    z.object({ range: z.string().min(1), tsv: z.string().min(1) }),
    { isAvailableForPage: (page) => page && !page.isClosed() }
  )
  static async updateRange({
    params,
    page,
  }: {
    params: { range: string; tsv: string };
    page: Page;
  }): Promise<ActionResult> {
    return withHealthCheck(page, async (p) => {
      await p.keyboard.press('Enter');
      await p.keyboard.press('Escape');
      await p.keyboard.press('Home');
      await p.keyboard.press('ArrowUp');
      await p.keyboard.press('Control+G');
      await p.waitForTimeout(200);
      await p.keyboard.type(params.range);
      await p.waitForTimeout(200);
      await p.keyboard.press('Enter');
      await p.waitForTimeout(200);
      await p.keyboard.press('Escape');
      await p.evaluate((tsv) => {
        const clipboardData = new DataTransfer();
        clipboardData.setData('text/plain', tsv as string);
        (document.activeElement as HTMLElement)?.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData } as any)
        );
      }, params.tsv);
      return { success: true, message: `Updated ${params.range}` };
    });
  }

  @action(
    'sheets_clear_range',
    'Google Sheets: clear the currently selected cells',
    z.object({ range: z.string().min(1) }),
    { isAvailableForPage: (page) => page && !page.isClosed() }
  )
  static async clearRange({
    params,
    page,
  }: {
    params: { range: string };
    page: Page;
  }): Promise<ActionResult> {
    return withHealthCheck(page, async (p) => {
      await p.keyboard.press('Enter');
      await p.keyboard.press('Escape');
      await p.keyboard.press('Home');
      await p.keyboard.press('ArrowUp');
      await p.keyboard.press('Control+G');
      await p.waitForTimeout(200);
      await p.keyboard.type(params.range);
      await p.waitForTimeout(200);
      await p.keyboard.press('Enter');
      await p.waitForTimeout(200);
      await p.keyboard.press('Escape');
      await p.keyboard.press('Backspace');
      return { success: true, message: `Cleared ${params.range}` };
    });
  }
}

class ScrollToTextAction {
  @action(
    'scroll_to_text',
    'Scroll to text on page if visible',
    z.object({ text: z.string().min(1) }),
    { isAvailableForPage: (page) => page && !page.isClosed() }
  )
  static async scrollToText({
    params,
    page,
  }: {
    params: { text: string };
    page: Page;
  }): Promise<ActionResult> {
    return withHealthCheck(page, async (p) => {
      const locators = [
        p.getByText(params.text, { exact: false }),
        p.locator(`text=${params.text}`),
        p.locator(`//*[contains(text(), '${params.text}')]`),
      ];
      for (const loc of locators) {
        try {
          if ((await loc.count()) === 0) continue;
          const el = loc.first();
          const visible = await el.isVisible().catch(() => false);
          const bbox = await el.boundingBox().catch(() => null);
          if (visible && bbox && bbox.width > 0 && bbox.height > 0) {
            await el.scrollIntoViewIfNeeded();
            await p.waitForTimeout(500);
            return {
              success: true,
              message: `Scrolled to text: ${params.text}`,
            };
          }
        } catch {
          // ignore
        }
      }
      return {
        success: true,
        message: `Text '${params.text}' not found or not visible`,
      };
    });
  }
}

class FileActions {
  @action(
    'write_file',
    'Write or append content to a file; extensions allowed: .md, .txt, .json, .csv, .pdf (PDF written as markdown)',
    z.object({
      file_name: z.string().min(1),
      content: z.string().default(''),
      append: z.boolean().default(false),
    })
  )
  static async writeFile({
    params,
  }: {
    params: { file_name: string; content: string; append: boolean };
  }): Promise<ActionResult> {
    const allowed = ['.md', '.txt', '.json', '.csv', '.pdf'];
    const ext = path.extname(params.file_name).toLowerCase();
    if (!allowed.includes(ext)) {
      return {
        success: false,
        message: `Extension ${ext} not allowed`,
        error: 'EXT_NOT_ALLOWED',
      };
    }
    const filePath = path.resolve(process.cwd(), params.file_name);
    try {
      if (params.append) {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.appendFile(filePath, params.content + '\n', 'utf-8');
      } else {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, params.content + '\n', 'utf-8');
      }
      return { success: true, message: `Saved ${filePath}` };
    } catch (e) {
      return {
        success: false,
        message: `Failed to write file: ${(e as Error).message}`,
        error: (e as Error).message,
      };
    }
  }

  @action(
    'replace_file_str',
    'Replace occurrences of old_str with new_str in a text file',
    z.object({
      file_name: z.string().min(1),
      old_str: z.string(),
      new_str: z.string(),
    })
  )
  static async replaceFileStr({
    params,
  }: {
    params: { file_name: string; old_str: string; new_str: string };
  }): Promise<ActionResult> {
    try {
      const filePath = path.resolve(process.cwd(), params.file_name);
      const content = await fs.readFile(filePath, 'utf-8');
      const replaced = content.split(params.old_str).join(params.new_str);
      await fs.writeFile(filePath, replaced, 'utf-8');
      return { success: true, message: `Replaced in ${filePath}` };
    } catch (e) {
      return {
        success: false,
        message: `Replace failed: ${(e as Error).message}`,
        error: (e as Error).message,
      };
    }
  }

  @action(
    'read_file',
    'Read a file from local filesystem',
    z.object({ file_name: z.string().min(1) })
  )
  static async readFile({
    params,
  }: {
    params: { file_name: string };
  }): Promise<ActionResult> {
    try {
      const filePath = path.resolve(process.cwd(), params.file_name);
      const content = await fs.readFile(filePath, 'utf-8');
      return { success: true, message: content };
    } catch (e) {
      return {
        success: false,
        message: `Read failed: ${(e as Error).message}`,
        error: (e as Error).message,
      };
    }
  }
}

// Ensure classes are referenced to avoid tree-shaking and "unused" warnings
export default [
  ClickActions,
  TypeActions,
  GotoActions,
  ScrollActions,
  WaitActions,
  KeyActions,
  HoverActions,
  ScreenshotActions,
  DoneActions,
  IndexActions,
  NavActions,
  KeysActions,
  SearchActions,
  DropdownActions,
  SheetsActions,
  ScrollToTextAction,
  FileActions,
];
