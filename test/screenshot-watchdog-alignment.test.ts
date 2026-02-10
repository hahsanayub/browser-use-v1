import { describe, expect, it, vi } from 'vitest';
import { BrowserSession } from '../src/browser/session.js';
import { ScreenshotEvent } from '../src/browser/events.js';
import { ScreenshotWatchdog } from '../src/browser/watchdogs/screenshot-watchdog.js';

describe('screenshot watchdog alignment', () => {
  it('routes ScreenshotEvent to BrowserSession.take_screenshot', async () => {
    const session = new BrowserSession();
    const watchdog = new ScreenshotWatchdog({ browser_session: session });
    session.attach_watchdog(watchdog);

    const screenshotSpy = vi
      .spyOn(session, 'take_screenshot')
      .mockResolvedValue('base64-image-data');

    const result = await session.event_bus.dispatch_or_throw(
      new ScreenshotEvent({ full_page: true })
    );

    expect(screenshotSpy).toHaveBeenCalledWith(true);
    expect(result.event.event_result).toBe('base64-image-data');
  });
});
