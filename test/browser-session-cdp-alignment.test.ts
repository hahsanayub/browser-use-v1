import { describe, expect, it, vi } from 'vitest';
import { BrowserSession } from '../src/browser/session.js';

describe('browser session cdp alignment', () => {
  it('creates CDP session for the provided page', async () => {
    const session = new BrowserSession();
    const page = { id: 'page-explicit' } as any;
    const cdpSession = { send: vi.fn() };
    const newCDPSession = vi.fn(async (targetPage: unknown) => {
      expect(targetPage).toBe(page);
      return cdpSession;
    });
    session.browser_context = {
      newCDPSession,
    } as any;

    const result = await session.get_or_create_cdp_session(page);

    expect(result).toBe(cdpSession);
    expect(newCDPSession).toHaveBeenCalledTimes(1);
  });

  it('uses current page when explicit page is omitted', async () => {
    const session = new BrowserSession();
    const page = { id: 'page-current' } as any;
    const cdpSession = { send: vi.fn() };
    const newCDPSession = vi.fn(async () => cdpSession);
    session.browser_context = {
      newCDPSession,
    } as any;
    vi.spyOn(session, 'get_current_page').mockResolvedValue(page);

    const result = await session.get_or_create_cdp_session();

    expect(result).toBe(cdpSession);
    expect(newCDPSession).toHaveBeenCalledWith(page);
  });

  it('throws when CDP session cannot be created', async () => {
    const session = new BrowserSession();

    await expect(session.get_or_create_cdp_session()).rejects.toThrow(
      'CDP sessions are not available'
    );

    session.browser_context = {
      newCDPSession: vi.fn(async () => ({})),
    } as any;
    vi.spyOn(session, 'get_current_page').mockResolvedValue(null);

    await expect(session.get_or_create_cdp_session()).rejects.toThrow(
      'No active page available'
    );
  });
});
