import { DownloadStartedEvent, FileDownloadedEvent } from '../events.js';
import { BaseWatchdog } from './base.js';

export class DownloadsWatchdog extends BaseWatchdog {
  static override LISTENS_TO = [DownloadStartedEvent, FileDownloadedEvent];

  private _activeDownloads = new Map<
    string,
    { url: string; suggested_filename: string; started_at: string }
  >();

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
