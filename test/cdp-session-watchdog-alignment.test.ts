import { describe, expect, it, vi } from 'vitest';
import { BrowserSession } from '../src/browser/session.js';
import {
  BrowserConnectedEvent,
  BrowserStoppedEvent,
  NavigationCompleteEvent,
  TabClosedEvent,
  TabCreatedEvent,
} from '../src/browser/events.js';
import { CDPSessionWatchdog } from '../src/browser/watchdogs/cdp-session-watchdog.js';

describe('cdp session watchdog alignment', () => {
  it('initializes CDP target monitoring and syncs target/session state', async () => {
    const session = new BrowserSession();
    const watchdog = new CDPSessionWatchdog({ browser_session: session });
    session.attach_watchdog(watchdog);
    const dispatchSpy = vi.spyOn(session.event_bus, 'dispatch');

    const listeners: Record<string, (payload: any) => void> = {};
    const cdpSession = {
      send: vi.fn(async (method: string) => {
        if (method === 'Target.getTargets') {
          return {
            targetInfos: [
              {
                targetId: 'target-1',
                type: 'page',
                url: 'https://example.com',
                title: 'Example',
              },
            ],
          };
        }
        return {};
      }),
      on: vi.fn((event: string, handler: (payload: any) => void) => {
        listeners[event] = handler;
      }),
      off: vi.fn(),
      detach: vi.fn(async () => {}),
    };

    const fakePage = {} as any;
    vi.spyOn(session, 'get_current_page').mockResolvedValue(fakePage);
    session.browser_context = {
      newCDPSession: vi.fn(async () => cdpSession),
    } as any;

    await session.event_bus.dispatch_or_throw(
      new BrowserConnectedEvent({ cdp_url: 'http://localhost:9222' })
    );

    expect(cdpSession.send).toHaveBeenCalledWith('Target.setDiscoverTargets', {
      discover: true,
      filter: [{ type: 'page' }, { type: 'iframe' }],
    });
    expect(cdpSession.send).toHaveBeenCalledWith('Target.getTargets');
    expect(session.session_manager.get_target('target-1')).not.toBeNull();

    listeners['Target.attachedToTarget']?.({
      sessionId: 'session-1',
      targetInfo: {
        targetId: 'target-2',
        type: 'page',
        url: 'https://attached.test',
        title: 'Attached',
      },
    });
    expect(session.session_manager.get_target('target-2')).not.toBeNull();
    expect(session.session_manager.get_target_id_for_session('session-1')).toBe(
      'target-2'
    );
    await Promise.resolve();
    const createdCall = dispatchSpy.mock.calls.find(
      ([event]) =>
        event instanceof TabCreatedEvent && event.target_id === 'target-2'
    );
    expect(createdCall).toBeDefined();

    listeners['Target.targetInfoChanged']?.({
      targetInfo: {
        targetId: 'target-2',
        type: 'page',
        url: 'https://attached.test/dashboard',
        title: 'Attached Dashboard',
      },
    });
    await Promise.resolve();
    const navigationCall = dispatchSpy.mock.calls.find(
      ([event]) =>
        event instanceof NavigationCompleteEvent &&
        event.target_id === 'target-2' &&
        event.url === 'https://attached.test/dashboard'
    );
    expect(navigationCall).toBeDefined();

    listeners['Target.detachedFromTarget']?.({
      sessionId: 'session-1',
      targetId: 'target-2',
    });
    expect(session.session_manager.get_target('target-2')).toBeNull();
    await Promise.resolve();
    const closedCall = dispatchSpy.mock.calls.find(
      ([event]) =>
        event instanceof TabClosedEvent && event.target_id === 'target-2'
    );
    expect(closedCall).toBeDefined();
  });

  it('tears down CDP monitoring listeners when browser stops', async () => {
    const session = new BrowserSession();
    const watchdog = new CDPSessionWatchdog({ browser_session: session });
    session.attach_watchdog(watchdog);

    const listeners: Record<string, (payload: any) => void> = {};
    const cdpSession = {
      send: vi.fn(async () => ({ targetInfos: [] })),
      on: vi.fn((event: string, handler: (payload: any) => void) => {
        listeners[event] = handler;
      }),
      off: vi.fn(),
      detach: vi.fn(async () => {}),
    };

    vi.spyOn(session, 'get_current_page').mockResolvedValue({} as any);
    session.browser_context = {
      newCDPSession: vi.fn(async () => cdpSession),
    } as any;

    await session.event_bus.dispatch_or_throw(
      new BrowserConnectedEvent({ cdp_url: 'http://localhost:9222' })
    );
    await session.event_bus.dispatch_or_throw(new BrowserStoppedEvent());

    expect(cdpSession.off).toHaveBeenCalled();
    expect(cdpSession.detach).toHaveBeenCalledTimes(1);
  });
});
