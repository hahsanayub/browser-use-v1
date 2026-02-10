import { describe, expect, it } from 'vitest';
import {
  BROWSER_EVENT_CLASSES,
  BROWSER_EVENT_NAMES,
  BrowserStartEvent,
  BrowserStateRequestEvent,
  NavigateToUrlEvent,
} from '../src/browser/events.js';

describe('browser events alignment', () => {
  it('keeps browser event names unique and Event-suffixed', () => {
    expect(BROWSER_EVENT_CLASSES.length).toBe(BROWSER_EVENT_NAMES.length);
    expect(new Set(BROWSER_EVENT_NAMES).size).toBe(BROWSER_EVENT_NAMES.length);
    for (const eventName of BROWSER_EVENT_NAMES) {
      expect(eventName.endsWith('Event')).toBe(true);
    }
  });

  it('applies environment timeout override for NavigateToUrlEvent', () => {
    const previous = process.env.TIMEOUT_NavigateToUrlEvent;
    process.env.TIMEOUT_NavigateToUrlEvent = '42.5';

    try {
      const event = new NavigateToUrlEvent({ url: 'https://example.com' });
      expect(event.event_timeout).toBe(42.5);
    } finally {
      if (previous === undefined) {
        delete process.env.TIMEOUT_NavigateToUrlEvent;
      } else {
        process.env.TIMEOUT_NavigateToUrlEvent = previous;
      }
    }
  });

  it('preserves python-aligned defaults for key browser lifecycle events', () => {
    const stateEvent = new BrowserStateRequestEvent();
    expect(stateEvent.include_dom).toBe(true);
    expect(stateEvent.include_screenshot).toBe(true);
    expect(stateEvent.include_recent_events).toBe(false);

    const startEvent = new BrowserStartEvent();
    expect(startEvent.cdp_url).toBeNull();
    expect(startEvent.launch_options).toEqual({});
    expect(startEvent.event_timeout).toBe(30);
  });
});
