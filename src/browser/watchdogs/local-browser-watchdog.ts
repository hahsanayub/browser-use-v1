import { BrowserKillEvent, BrowserLaunchEvent } from '../events.js';
import { BaseWatchdog } from './base.js';

export class LocalBrowserWatchdog extends BaseWatchdog {
  static override LISTENS_TO = [BrowserLaunchEvent, BrowserKillEvent];

  async on_BrowserLaunchEvent() {
    await this.browser_session.start();
    return {
      cdp_url:
        this.browser_session.cdp_url ??
        this.browser_session.wss_url ??
        'playwright',
    };
  }

  async on_BrowserKillEvent() {
    await this.browser_session.kill();
  }
}
