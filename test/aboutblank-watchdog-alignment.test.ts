import { describe, expect, it, vi } from 'vitest';
import { BrowserSession } from '../src/browser/session.js';
import {
  AboutBlankDVDScreensaverShownEvent,
  BrowserStopEvent,
  NavigateToUrlEvent,
  TabClosedEvent,
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

  it('dispatches about:blank navigation when the last tab is closed', async () => {
    const session = new BrowserSession();
    const watchdog = new AboutBlankWatchdog({ browser_session: session });
    session.attach_watchdog(watchdog);

    (session as any)._tabs = [];
    const navigateEvents: NavigateToUrlEvent[] = [];
    session.event_bus.on(
      'NavigateToUrlEvent',
      (event) => {
        navigateEvents.push(event as NavigateToUrlEvent);
      },
      { handler_id: 'test.aboutblank.navigate-capture' }
    );

    await session.event_bus.dispatch_or_throw(
      new TabClosedEvent({
        target_id: 'target-aboutblank-closed',
      })
    );

    expect(navigateEvents).toHaveLength(1);
    expect(navigateEvents[0].url).toBe('about:blank');
    expect(navigateEvents[0].new_tab).toBe(true);
  });

  it('does not dispatch keepalive about:blank navigation after stop', async () => {
    const session = new BrowserSession();
    const watchdog = new AboutBlankWatchdog({ browser_session: session });
    session.attach_watchdog(watchdog);

    (session as any)._tabs = [];
    const handler = vi.fn();
    session.event_bus.on('NavigateToUrlEvent', handler, {
      handler_id: 'test.aboutblank.navigate-stopped',
    });

    await session.event_bus.dispatch_or_throw(new BrowserStopEvent());
    await session.event_bus.dispatch_or_throw(
      new TabClosedEvent({
        target_id: 'target-aboutblank-closed-stop',
      })
    );

    expect(handler).not.toHaveBeenCalled();
  });
});
