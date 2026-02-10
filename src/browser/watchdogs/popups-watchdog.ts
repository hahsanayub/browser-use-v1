import { TabCreatedEvent } from '../events.js';
import type { Page } from '../types.js';
import { BaseWatchdog } from './base.js';

export class PopupsWatchdog extends BaseWatchdog {
  static override LISTENS_TO = [TabCreatedEvent];

  async on_TabCreatedEvent() {
    const page = (await this.browser_session.get_current_page()) as Page | null;
    if (!page) {
      return;
    }

    const attachDialogHandler = (this.browser_session as any)
      ?._attachDialogHandler;
    if (typeof attachDialogHandler === 'function') {
      attachDialogHandler.call(this.browser_session, page);
    }
  }
}
