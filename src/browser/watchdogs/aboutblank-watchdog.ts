import {
  AboutBlankDVDScreensaverShownEvent,
  BrowserStopEvent,
  BrowserStoppedEvent,
  TabCreatedEvent,
} from '../events.js';
import { BaseWatchdog } from './base.js';

export class AboutBlankWatchdog extends BaseWatchdog {
  static override LISTENS_TO = [
    BrowserStopEvent,
    BrowserStoppedEvent,
    TabCreatedEvent,
  ];

  static override EMITS = [AboutBlankDVDScreensaverShownEvent];

  private _stopping = false;

  async on_BrowserStopEvent() {
    this._stopping = true;
  }

  async on_BrowserStoppedEvent() {
    this._stopping = true;
  }

  async on_TabCreatedEvent(event: TabCreatedEvent) {
    if (this._stopping) {
      return;
    }
    if (event.url !== 'about:blank') {
      return;
    }

    await this.event_bus.dispatch(
      new AboutBlankDVDScreensaverShownEvent({
        target_id: event.target_id,
        error: null,
      })
    );
  }
}
