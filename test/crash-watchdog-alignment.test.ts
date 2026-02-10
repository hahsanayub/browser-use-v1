import { describe, expect, it, vi } from 'vitest';
import { BrowserSession } from '../src/browser/session.js';
import {
  BrowserConnectedEvent,
  BrowserErrorEvent,
  BrowserStoppedEvent,
  TargetCrashedEvent,
} from '../src/browser/events.js';
import { CrashWatchdog } from '../src/browser/watchdogs/crash-watchdog.js';

describe('crash watchdog alignment', () => {
  it('attaches crash listeners and emits crash/error events', async () => {
    const session = new BrowserSession();
    (session as any)._tabs = [
      {
        page_id: 1,
        tab_id: '0001',
        target_id: 'target-crash-1',
        url: 'https://crash.test',
        title: 'Crash Test',
      },
    ];
    session.session_manager.set_focused_target('target-crash-1');

    const listeners: Record<string, (payload?: unknown) => void> = {};
    const page = {
      on: vi.fn((event: string, handler: (payload?: unknown) => void) => {
        listeners[event] = handler;
      }),
      off: vi.fn(),
      url: vi.fn(() => 'https://crash.test'),
    };
    session.browser_context = {
      pages: vi.fn(() => [page]),
    } as any;

    const crashedEvents: TargetCrashedEvent[] = [];
    const browserErrors: BrowserErrorEvent[] = [];
    session.event_bus.on(
      'TargetCrashedEvent',
      (event) => {
        crashedEvents.push(event as TargetCrashedEvent);
      },
      { handler_id: 'test.crash.target' }
    );
    session.event_bus.on(
      'BrowserErrorEvent',
      (event) => {
        browserErrors.push(event as BrowserErrorEvent);
      },
      { handler_id: 'test.crash.error' }
    );

    const watchdog = new CrashWatchdog({ browser_session: session });
    session.attach_watchdog(watchdog);

    await session.event_bus.dispatch_or_throw(
      new BrowserConnectedEvent({ cdp_url: 'http://localhost:9222' })
    );

    expect(page.on).toHaveBeenCalledWith('crash', expect.any(Function));
    await listeners.crash?.(new Error('renderer crashed'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(crashedEvents).toHaveLength(1);
    expect(crashedEvents[0].target_id).toBe('target-crash-1');
    expect(crashedEvents[0].error).toBe('renderer crashed');

    expect(browserErrors).toHaveLength(1);
    expect(browserErrors[0].error_type).toBe('TargetCrash');
    expect(browserErrors[0].message).toBe('renderer crashed');
  });

  it('detaches crash listeners when browser stops', async () => {
    const session = new BrowserSession();
    const page = {
      on: vi.fn(),
      off: vi.fn(),
      url: vi.fn(() => 'https://crash.test'),
    };
    session.browser_context = {
      pages: vi.fn(() => [page]),
    } as any;

    const watchdog = new CrashWatchdog({ browser_session: session });
    session.attach_watchdog(watchdog);

    await session.event_bus.dispatch_or_throw(
      new BrowserConnectedEvent({ cdp_url: 'http://localhost:9222' })
    );
    await session.event_bus.dispatch_or_throw(new BrowserStoppedEvent());

    expect(page.on).toHaveBeenCalledWith('crash', expect.any(Function));
    expect(page.off).toHaveBeenCalledWith('crash', expect.any(Function));
  });
});
