import { describe, expect, it, vi } from 'vitest';
import { BrowserSession } from '../src/browser/session.js';
import {
  AboutBlankDVDScreensaverShownEvent,
  BrowserStopEvent,
  TabCreatedEvent,
} from '../src/browser/events.js';
import { AboutBlankWatchdog } from '../src/browser/watchdogs/aboutblank-watchdog.js';

describe('aboutblank watchdog alignment', () => {
  it('emits screensaver shown event when about:blank tab is created', async () => {
    const session = new BrowserSession();
    const watchdog = new AboutBlankWatchdog({ browser_session: session });
    session.attach_watchdog(watchdog);

    const events: AboutBlankDVDScreensaverShownEvent[] = [];
    session.event_bus.on(
      'AboutBlankDVDScreensaverShownEvent',
      (event) => {
        events.push(event as AboutBlankDVDScreensaverShownEvent);
      },
      { handler_id: 'test.aboutblank.capture' }
    );

    await session.event_bus.dispatch_or_throw(
      new TabCreatedEvent({
        target_id: 'target-aboutblank-1',
        url: 'about:blank',
      })
    );

    expect(events).toHaveLength(1);
    expect(events[0].target_id).toBe('target-aboutblank-1');
    expect(events[0].error).toBeNull();
  });

  it('stops emitting screensaver events after browser stop request', async () => {
    const session = new BrowserSession();
    const watchdog = new AboutBlankWatchdog({ browser_session: session });
    session.attach_watchdog(watchdog);

    const handler = vi.fn();
    session.event_bus.on('AboutBlankDVDScreensaverShownEvent', handler, {
      handler_id: 'test.aboutblank.stop',
    });

    await session.event_bus.dispatch_or_throw(new BrowserStopEvent());
    await session.event_bus.dispatch_or_throw(
      new TabCreatedEvent({
        target_id: 'target-aboutblank-2',
        url: 'about:blank',
      })
    );

    expect(handler).not.toHaveBeenCalled();
  });
});
