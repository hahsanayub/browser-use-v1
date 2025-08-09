import { z } from 'zod';
import type { Page } from 'playwright';
import { action } from './decorators';
import type { ActionResult } from '../types/agent';
import { withHealthCheck } from '../services/health-check';

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
  static async click({ params, page }: { params: { selector: string }; page: Page }): Promise<ActionResult> {
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
  static async type({ params, page }: { params: { selector: string; text: string }; page: Page }): Promise<ActionResult> {
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
    isAvailableForPage: (page) => page && !page.isClosed(),
  })
  static async goto({ params, page }: { params: { url: string }; page: Page }): Promise<ActionResult> {
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
  static async scroll({ params, page }: { params: { direction: 'up'|'down'|'left'|'right'; amount?: number }; page: Page }): Promise<ActionResult> {
    const pixels = (params.amount ?? 3) * 300;
    const dx = params.direction === 'left' ? -pixels : params.direction === 'right' ? pixels : 0;
    const dy = params.direction === 'up' ? -pixels : params.direction === 'down' ? pixels : 0;
    return withHealthCheck(page, async (p) => {
      await p.mouse.wheel(dx, dy);
      await p.waitForTimeout(200);
      return { success: true, message: `Scrolled ${params.direction} ${params.amount ?? 3}` };
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
  static async wait({ params, page }: { params: { type: 'time'|'element'|'navigation'; value: number|string; timeout?: number }; page: Page }): Promise<ActionResult> {
    return withHealthCheck(page, async (p) => {
      if (params.type === 'time') {
        await p.waitForTimeout(params.value as number);
      } else if (params.type === 'element') {
        await p.waitForSelector(params.value as string, { timeout: params.timeout });
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
  static async key({ params, page }: { params: { key: string }; page: Page }): Promise<ActionResult> {
    return withHealthCheck(page, async (p) => {
      await p.keyboard.press(params.key);
      await p.waitForTimeout(100);
      return { success: true, message: `Pressed ${params.key}` };
    });
  }
}

// hover
class HoverActions {
  @action('hover', 'Hover over an element', z.object({ selector: z.string().min(1) }), {
    isAvailableForPage: (page) => page && !page.isClosed(),
  })
  static async hover({ params, page }: { params: { selector: string }; page: Page }): Promise<ActionResult> {
    return withHealthCheck(page, async (p) => {
      await p.hover(params.selector);
      await p.waitForTimeout(100);
      return { success: true, message: `Hovered ${params.selector}` };
    });
  }
}

// screenshot
class ScreenshotActions {
  @action('screenshot', 'Take a full-page screenshot', z.object({}).optional(), {
    isAvailableForPage: (page) => page && !page.isClosed(),
  })
  static async screenshot({ page }: { params: Record<string, unknown>; page: Page }): Promise<ActionResult> {
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

// finish
class FinishActions {
  @action('finish', 'Mark the task as completed')
  static async finish(): Promise<ActionResult> {
    return { success: true, message: 'Task marked as complete' };
  }
}


