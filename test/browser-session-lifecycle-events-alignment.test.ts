import { describe, expect, it, vi } from 'vitest';
import { BrowserSession } from '../src/browser/session.js';

describe('browser session lifecycle events alignment', () => {
  it('dispatches start/connected/stop/stopped events in lifecycle order', async () => {
    const page = {
      isClosed: vi.fn(() => false),
      url: vi.fn(() => 'https://example.com'),
      title: vi.fn(async () => 'Example'),
    } as any;
    const browserContext = {
      pages: vi.fn(() => [page]),
      newPage: vi.fn(async () => page),
    } as any;

    const session = new BrowserSession({
      browser_context: browserContext,
      page,
    });

    const dispatchSpy = vi.spyOn(session.event_bus, 'dispatch');

    await session.start();
    await session.stop();

    const dispatchedTypes = dispatchSpy.mock.calls.map(
      ([event]) =>
        (event as { event_type?: string })?.event_type ??
        (event as { constructor?: { name?: string } })?.constructor?.name
    );

    expect(dispatchedTypes).toContain('BrowserStartEvent');
    expect(dispatchedTypes).toContain('BrowserConnectedEvent');
    expect(dispatchedTypes).toContain('BrowserStopEvent');
    expect(dispatchedTypes).toContain('BrowserStoppedEvent');

    const startIndex = dispatchedTypes.indexOf('BrowserStartEvent');
    const connectedIndex = dispatchedTypes.indexOf('BrowserConnectedEvent');
    const stopIndex = dispatchedTypes.indexOf('BrowserStopEvent');
    const stoppedIndex = dispatchedTypes.indexOf('BrowserStoppedEvent');

    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(connectedIndex).toBeGreaterThan(startIndex);
    expect(stopIndex).toBeGreaterThan(connectedIndex);
    expect(stoppedIndex).toBeGreaterThan(stopIndex);
  });
});
