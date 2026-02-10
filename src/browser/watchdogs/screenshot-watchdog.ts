import { ScreenshotEvent } from '../events.js';
import { BaseWatchdog } from './base.js';

export class ScreenshotWatchdog extends BaseWatchdog {
  static override LISTENS_TO = [ScreenshotEvent];

  async on_ScreenshotEvent(event: ScreenshotEvent) {
    try {
      return await this.browser_session.take_screenshot(event.full_page);
    } finally {
      await this.browser_session.remove_highlights();
    }
  }
}
