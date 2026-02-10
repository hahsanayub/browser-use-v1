import { describe, expect, it } from 'vitest';
import { BrowserSession } from '../src/browser/session.js';
import { BrowserStopEvent, NavigateToUrlEvent } from '../src/browser/events.js';
import { BaseWatchdog } from '../src/browser/watchdogs/base.js';

class TestWatchdog extends BaseWatchdog {
  static override LISTENS_TO = [NavigateToUrlEvent, BrowserStopEvent];

  handled: string[] = [];

  on_NavigateToUrlEvent(event: NavigateToUrlEvent) {
    this.handled.push(event.url);
  }

  on_BrowserStopEvent() {
    this.handled.push('stop');
  }
}

class InvalidWatchdog extends BaseWatchdog {
  static override LISTENS_TO = [NavigateToUrlEvent];

  on_BrowserStopEvent() {}
}

describe('browser watchdog base alignment', () => {
  it('auto-registers on_<EventName> handlers via session attach helpers', async () => {
    const session = new BrowserSession();
    const watchdog = new TestWatchdog({ browser_session: session });

    session.attach_watchdog(watchdog);
    expect(watchdog.is_attached).toBe(true);

    await session.event_bus.dispatch(
      new NavigateToUrlEvent({ url: 'https://example.com' })
    );
    await session.event_bus.dispatch(new BrowserStopEvent());

    expect(watchdog.handled).toEqual(['https://example.com', 'stop']);

    session.detach_watchdog(watchdog);
    expect(watchdog.is_attached).toBe(false);

    await session.event_bus.dispatch(
      new NavigateToUrlEvent({ url: 'https://after-detach.test' })
    );
    expect(watchdog.handled).toEqual(['https://example.com', 'stop']);
  });

  it('enforces LISTENS_TO declarations against handler names', () => {
    const session = new BrowserSession();
    const watchdog = new InvalidWatchdog({ browser_session: session });

    expect(() => watchdog.attach_to_session()).toThrow(
      'is not declared in LISTENS_TO'
    );
  });

  it('guards against duplicate attach calls on the same watchdog', () => {
    const session = new BrowserSession();
    const watchdog = new TestWatchdog({ browser_session: session });

    watchdog.attach_to_session();
    expect(() => watchdog.attach_to_session()).toThrow(
      'attach_to_session() called twice'
    );
  });
});
