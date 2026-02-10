import { BrowserStateRequestEvent } from '../events.js';
import { BaseWatchdog } from './base.js';

export class DOMWatchdog extends BaseWatchdog {
  static override LISTENS_TO = [BrowserStateRequestEvent];

  async on_BrowserStateRequestEvent(event: BrowserStateRequestEvent) {
    return this.browser_session.get_browser_state_with_recovery({
      cache_clickable_elements_hashes: true,
      include_screenshot: event.include_screenshot,
      include_recent_events: event.include_recent_events,
    });
  }
}
