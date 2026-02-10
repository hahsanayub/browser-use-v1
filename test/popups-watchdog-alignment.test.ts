import { describe, expect, it, vi } from 'vitest';
import { BrowserSession } from '../src/browser/session.js';
import { TabCreatedEvent } from '../src/browser/events.js';
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
});
