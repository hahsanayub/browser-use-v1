import type { Page } from 'playwright';
import { getLogger } from './logging';

/**
 * Ensure the given page is responsive. If not, attempt recovery by closing and reopening.
 * Returns a healthy page to continue with (may be a new instance).
 */
export async function ensureHealthyPage(page: Page): Promise<Page> {
  const logger = getLogger();

  // Quick ping with short timeout
  const isHealthy = await pingPage(page, 1000);
  if (isHealthy) return page;

  logger.warn('Page is unresponsive, attempting recovery');

  const ctx = page.context();
  const url = safeGetUrl(page);

  try {
    // Try CDP close if available (Chromium)
    // Ignore errors and fall back to standard close
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - CDP only available for Chromium
    const session = await ctx.newCDPSession(page).catch(() => null);
    if (session) {
      try {
        await session.send('Page.close');
      } catch {}
    }
  } catch {}

  try {
    if (!page.isClosed()) {
      await page.close({ runBeforeUnload: false });
    }
  } catch {}

  // Create a new page and try to reload previous URL
  let newPage: Page;
  try {
    newPage = await ctx.newPage();
  } catch (e) {
    logger.error('Failed to create new page during recovery', e as Error);
    throw e;
  }

  if (url) {
    try {
      await newPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 5000 });
      logger.info('Recovered page and navigated back to previous URL', { url });
      return newPage;
    } catch (e) {
      logger.warn('Failed to navigate to previous URL during recovery', {
        url,
        error: (e as Error).message,
      });
    }
  }

  // Fallback to about:blank
  try {
    await newPage.goto('about:blank');
  } catch {}
  return newPage;
}

export async function withHealthCheck<T>(page: Page, fn: (healthyPage: Page) => Promise<T>): Promise<T> {
  const healthy = await ensureHealthyPage(page);
  return await fn(healthy);
}

async function pingPage(page: Page, timeoutMs: number): Promise<boolean> {
  try {
    await page.evaluate(() => true, { timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

function safeGetUrl(page: Page): string | null {
  try {
    const u = page.url();
    if (!u || u === 'about:blank') return null;
    return u;
  } catch {
    return null;
  }
}


