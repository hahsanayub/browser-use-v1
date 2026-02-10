import { describe, expect, it, vi } from 'vitest';
import { BrowserSession } from '../src/browser/session.js';
import {
  BrowserStateRequestEvent,
  TabCreatedEvent,
} from '../src/browser/events.js';
import { DOMWatchdog } from '../src/browser/watchdogs/dom-watchdog.js';

describe('dom watchdog alignment', () => {
  it('routes BrowserStateRequestEvent to BrowserSession state builder', async () => {
    const session = new BrowserSession();
    const watchdog = new DOMWatchdog({ browser_session: session });
    session.attach_watchdog(watchdog);

    const mockedState = { url: 'https://dom-watchdog.test' } as any;
    const stateSpy = vi
      .spyOn(session, 'get_browser_state_with_recovery')
      .mockResolvedValue(mockedState);

    const result = await session.event_bus.dispatch_or_throw(
      new BrowserStateRequestEvent({
        include_screenshot: false,
        include_recent_events: true,
      })
    );

    expect(stateSpy).toHaveBeenCalledWith({
      cache_clickable_elements_hashes: true,
      include_screenshot: false,
      include_recent_events: true,
    });
    expect(result.event.event_result).toBe(mockedState);
  });

  it('accepts TabCreatedEvent lifecycle hook without side effects', async () => {
    const session = new BrowserSession();
    const watchdog = new DOMWatchdog({ browser_session: session });
    session.attach_watchdog(watchdog);

    const result = await session.event_bus.dispatch_or_throw(
      new TabCreatedEvent({
        target_id: 'target-dom-watchdog',
        url: 'https://example.com/new-tab',
      })
    );

    expect(result.errors).toHaveLength(0);
  });
});
