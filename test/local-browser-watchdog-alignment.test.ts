import { describe, expect, it, vi } from 'vitest';
import { BrowserSession } from '../src/browser/session.js';
import {
  BrowserKillEvent,
  BrowserLaunchEvent,
  BrowserStopEvent,
} from '../src/browser/events.js';
import { LocalBrowserWatchdog } from '../src/browser/watchdogs/local-browser-watchdog.js';

describe('local browser watchdog alignment', () => {
  it('routes BrowserLaunchEvent to BrowserSession.start and returns launch payload', async () => {
    const session = new BrowserSession();
    const watchdog = new LocalBrowserWatchdog({ browser_session: session });
    session.attach_watchdog(watchdog);
    session.cdp_url = 'http://localhost:9222';

    const startSpy = vi.spyOn(session, 'start').mockResolvedValue(session);

    const dispatchResult = await session.event_bus.dispatch_or_throw(
      new BrowserLaunchEvent()
    );

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(dispatchResult.event.event_result).toEqual({
      cdp_url: 'http://localhost:9222',
    });
  });

  it('routes BrowserKillEvent to BrowserSession.kill', async () => {
    const session = new BrowserSession();
    const watchdog = new LocalBrowserWatchdog({ browser_session: session });
    session.attach_watchdog(watchdog);

    const killSpy = vi.spyOn(session, 'kill').mockResolvedValue();

    await session.event_bus.dispatch_or_throw(new BrowserKillEvent());

    expect(killSpy).toHaveBeenCalledTimes(1);
  });

  it('BrowserSession.launch dispatches BrowserLaunchEvent through watchdog stack', async () => {
    const session = new BrowserSession();
    session.cdp_url = 'http://localhost:9333';
    const startSpy = vi.spyOn(session, 'start').mockResolvedValue(session);

    const launchResult = await session.launch();

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(launchResult).toEqual({ cdp_url: 'http://localhost:9333' });
  });

  it('emits BrowserKillEvent asynchronously on BrowserStopEvent', async () => {
    const session = new BrowserSession();
    const watchdog = new LocalBrowserWatchdog({ browser_session: session });
    session.attach_watchdog(watchdog);

    const killEvents: BrowserKillEvent[] = [];
    session.event_bus.on(
      'BrowserKillEvent',
      (event) => {
        killEvents.push(event as BrowserKillEvent);
      },
      { handler_id: 'test.local-watchdog.stop.kill-event' }
    );

    const killSpy = vi.spyOn(session, 'kill').mockResolvedValue();

    await session.event_bus.dispatch_or_throw(new BrowserStopEvent());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(killEvents).toHaveLength(1);
    expect(killSpy).toHaveBeenCalledTimes(1);
  });

  it('does not re-enter kill when BrowserStopEvent is emitted during stop()', async () => {
    const session = new BrowserSession();
    const watchdog = new LocalBrowserWatchdog({ browser_session: session });
    session.attach_watchdog(watchdog);
    (session as any).initialized = true;

    vi.spyOn(session as any, '_shutdown_browser_session').mockImplementation(
      async () => {
        (session as any).initialized = false;
      }
    );
    const killSpy = vi.spyOn(session, 'kill').mockResolvedValue();

    await session.stop();

    expect(killSpy).toHaveBeenCalledTimes(0);
  });

  it('does not dispatch BrowserKillEvent on stop for non-owning sessions', async () => {
    const session = new BrowserSession({
      browser: {} as any,
    });
    const watchdog = new LocalBrowserWatchdog({ browser_session: session });
    session.attach_watchdog(watchdog);

    const killEvents: BrowserKillEvent[] = [];
    session.event_bus.on(
      'BrowserKillEvent',
      (event) => {
        killEvents.push(event as BrowserKillEvent);
      },
      { handler_id: 'test.local-watchdog.non-owning.kill-event' }
    );
    const killSpy = vi.spyOn(session, 'kill').mockResolvedValue();

    await session.event_bus.dispatch_or_throw(new BrowserStopEvent());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(killEvents).toHaveLength(0);
    expect(killSpy).toHaveBeenCalledTimes(0);
  });
});
