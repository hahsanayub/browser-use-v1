import { describe, expect, it, vi } from 'vitest';
import { BrowserSession } from '../src/browser/session.js';
import { BrowserStoppedEvent, TabCreatedEvent } from '../src/browser/events.js';
import { PopupsWatchdog } from '../src/browser/watchdogs/popups-watchdog.js';

describe('popups watchdog alignment', () => {
  it('ensures dialog handler attachment when a new tab is created', async () => {
    const session = new BrowserSession();
    const page = {
      on: vi.fn(),
    } as any;
    vi.spyOn(session, 'get_current_page').mockResolvedValue(page);
    const attachSpy = vi.spyOn(session as any, '_attachDialogHandler');

    const watchdog = new PopupsWatchdog({ browser_session: session });
    session.attach_watchdog(watchdog);

    await session.event_bus.dispatch_or_throw(
      new TabCreatedEvent({
        target_id: 'target-new-tab',
        url: 'https://example.com/new',
      })
    );

    expect(attachSpy).toHaveBeenCalledWith(page);
  });

  it('registers and handles JavaScript dialogs via CDP', async () => {
    const session = new BrowserSession();
    const page = { on: vi.fn() } as any;
    vi.spyOn(session, 'get_current_page').mockResolvedValue(page);

    const cdpListeners = new Map<string, (payload: any) => void>();
    const cdpSend = vi.fn(async () => ({}));
    vi.spyOn(session, 'get_or_create_cdp_session').mockResolvedValue({
      send: cdpSend,
      on: (event: string, handler: (payload: any) => void) => {
        cdpListeners.set(event, handler);
      },
      off: vi.fn((event: string) => {
        cdpListeners.delete(event);
      }),
      detach: vi.fn(async () => {}),
    } as any);

    const captureSpy = vi.spyOn(session as any, '_captureClosedPopupMessage');
    const watchdog = new PopupsWatchdog({ browser_session: session });
    session.attach_watchdog(watchdog);

    await session.event_bus.dispatch_or_throw(
      new TabCreatedEvent({
        target_id: 'target-cdp-dialog',
        url: 'https://example.com/new',
      })
    );

    expect(cdpSend).toHaveBeenCalledWith('Page.enable');
    cdpListeners.get('Page.javascriptDialogOpening')?.({
      type: 'alert',
      message: 'hello',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(captureSpy).toHaveBeenCalledWith('alert', 'hello');
    expect(cdpSend).toHaveBeenCalledWith('Page.handleJavaScriptDialog', {
      accept: true,
    });

    await session.event_bus.dispatch_or_throw(new BrowserStoppedEvent());
  });
});
