import { describe, expect, it, vi } from 'vitest';
import { BrowserSession } from '../src/browser/session.js';
import {
  BrowserStateRequestEvent,
  ClickCoordinateEvent,
  NavigateToUrlEvent,
  SendKeysEvent,
  SwitchTabEvent,
  WaitEvent,
} from '../src/browser/events.js';
import { DefaultActionWatchdog } from '../src/browser/watchdogs/default-action-watchdog.js';
import { CDPSessionWatchdog } from '../src/browser/watchdogs/cdp-session-watchdog.js';
import { DownloadsWatchdog } from '../src/browser/watchdogs/downloads-watchdog.js';
import { DOMWatchdog } from '../src/browser/watchdogs/dom-watchdog.js';
import { LocalBrowserWatchdog } from '../src/browser/watchdogs/local-browser-watchdog.js';

describe('default action watchdog alignment', () => {
  it('attaches default watchdog stack only once', () => {
    const session = new BrowserSession();

    session.attach_default_watchdogs();
    session.attach_default_watchdogs();

    const watchdogs = session.get_watchdogs();
    expect(watchdogs).toHaveLength(5);
    expect(
      watchdogs.some((watchdog) => watchdog instanceof LocalBrowserWatchdog)
    ).toBe(true);
    expect(
      watchdogs.some((watchdog) => watchdog instanceof CDPSessionWatchdog)
    ).toBe(true);
    expect(watchdogs.some((watchdog) => watchdog instanceof DOMWatchdog)).toBe(
      true
    );
    expect(
      watchdogs.some((watchdog) => watchdog instanceof DownloadsWatchdog)
    ).toBe(true);
    expect(
      watchdogs.some((watchdog) => watchdog instanceof DefaultActionWatchdog)
    ).toBe(true);
  });

  it('routes navigation and tab switch events to BrowserSession methods', async () => {
    const session = new BrowserSession();
    session.attach_default_watchdogs();

    const navigateSpy = vi
      .spyOn(session, 'navigate_to')
      .mockResolvedValue(null as any);
    const switchSpy = vi
      .spyOn(session, 'switch_to_tab')
      .mockResolvedValue(null as any);

    await session.event_bus.dispatch_or_throw(
      new NavigateToUrlEvent({ url: 'https://example.com' })
    );
    await session.event_bus.dispatch_or_throw(
      new SwitchTabEvent({ target_id: 'tab_test_target' })
    );

    expect(navigateSpy).toHaveBeenCalledWith('https://example.com');
    expect(switchSpy).toHaveBeenCalledWith('tab_test_target');
  });

  it('routes BrowserStateRequestEvent and returns handler result', async () => {
    const session = new BrowserSession();
    session.attach_default_watchdogs();
    const mockedState = { url: 'https://state.example' } as any;

    const stateSpy = vi
      .spyOn(session, 'get_browser_state_with_recovery')
      .mockResolvedValue(mockedState);

    const result = await session.event_bus.dispatch_or_throw(
      new BrowserStateRequestEvent({
        include_dom: true,
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

  it('routes wait and send-keys events through BrowserSession helpers', async () => {
    const session = new BrowserSession();
    session.attach_default_watchdogs();

    const waitSpy = vi.spyOn(session, 'wait').mockResolvedValue();
    const sendKeysSpy = vi.spyOn(session, 'send_keys').mockResolvedValue();

    await session.event_bus.dispatch_or_throw(new WaitEvent({ seconds: 2 }));
    await session.event_bus.dispatch_or_throw(
      new SendKeysEvent({ keys: 'Control+A' })
    );

    expect(waitSpy).toHaveBeenCalledWith(2);
    expect(sendKeysSpy).toHaveBeenCalledWith('Control+A');
  });

  it('routes coordinate click events through BrowserSession.click_coordinates', async () => {
    const session = new BrowserSession();
    session.attach_default_watchdogs();

    const clickSpy = vi.spyOn(session, 'click_coordinates').mockResolvedValue();

    await session.event_bus.dispatch_or_throw(
      new ClickCoordinateEvent({
        coordinate_x: 120,
        coordinate_y: 260,
        button: 'left',
      })
    );

    expect(clickSpy).toHaveBeenCalledWith(120, 260, { button: 'left' });
  });
});
