import fs from 'node:fs';
import {
  BrowserLaunchEvent,
  BrowserStoppedEvent,
  DownloadStartedEvent,
  FileDownloadedEvent,
  NavigationCompleteEvent,
  TabClosedEvent,
  TabCreatedEvent,
} from '../events.js';
import { BaseWatchdog } from './base.js';

export class DownloadsWatchdog extends BaseWatchdog {
  static override LISTENS_TO = [
    BrowserLaunchEvent,
    BrowserStoppedEvent,
    TabCreatedEvent,
    TabClosedEvent,
    NavigationCompleteEvent,
    DownloadStartedEvent,
    FileDownloadedEvent,
  ];

  private _activeDownloads = new Map<
    string,
    { url: string; suggested_filename: string; started_at: string }
  >();

  on_BrowserLaunchEvent() {
    const downloadsPath = this.browser_session.browser_profile.downloads_path;
    if (!downloadsPath) {
      return;
    }
    fs.mkdirSync(downloadsPath, { recursive: true });
  }

  on_BrowserStoppedEvent() {
    this._activeDownloads.clear();
  }

  on_TabCreatedEvent() {
    return null;
  }

  on_TabClosedEvent() {
    return null;
  }

  on_NavigationCompleteEvent() {
    return null;
  }

  on_DownloadStartedEvent(event: DownloadStartedEvent) {
    this._activeDownloads.set(event.guid, {
      url: event.url,
      suggested_filename: event.suggested_filename,
      started_at: new Date().toISOString(),
    });
  }

  on_FileDownloadedEvent(event: FileDownloadedEvent) {
    if (event.guid) {
      this._activeDownloads.delete(event.guid);
    }
    this.browser_session.add_downloaded_file(event.path);
    return event.path;
  }

  get_active_downloads() {
    return [...this._activeDownloads.entries()].map(([guid, metadata]) => ({
      guid,
      ...metadata,
    }));
  }
}
