import fs from 'node:fs';
import {
  BrowserLaunchEvent,
  BrowserStateRequestEvent,
  BrowserStoppedEvent,
  DownloadProgressEvent,
  DownloadStartedEvent,
  FileDownloadedEvent,
  NavigationCompleteEvent,
  TabClosedEvent,
  TabCreatedEvent,
} from '../events.js';
import { BaseWatchdog } from './base.js';

type ActiveDownload = {
  url: string;
  suggested_filename: string;
  started_at: string;
  received_bytes: number;
  total_bytes: number;
  state: string;
};

type DownloadStartInfo = {
  guid: string;
  url: string;
  suggested_filename: string;
  auto_download: boolean;
};

type DownloadProgressInfo = {
  guid: string;
  received_bytes: number;
  total_bytes: number;
  state: string;
};

type DownloadCompleteInfo = {
  guid: string | null;
  url: string;
  path: string;
  file_name: string;
  file_size: number;
  file_type: string | null;
  mime_type: string | null;
  auto_download: boolean;
};

export class DownloadsWatchdog extends BaseWatchdog {
  static override LISTENS_TO = [
    BrowserLaunchEvent,
    BrowserStateRequestEvent,
    BrowserStoppedEvent,
    TabCreatedEvent,
    TabClosedEvent,
    NavigationCompleteEvent,
    DownloadStartedEvent,
    DownloadProgressEvent,
    FileDownloadedEvent,
  ];

  private _activeDownloads = new Map<string, ActiveDownload>();
  private _downloadStartCallbacks: Array<(info: DownloadStartInfo) => void> =
    [];
  private _downloadProgressCallbacks: Array<
    (info: DownloadProgressInfo) => void
  > = [];
  private _downloadCompleteCallbacks: Array<
    (info: DownloadCompleteInfo) => void
  > = [];

  on_BrowserLaunchEvent() {
    const downloadsPath = this.browser_session.browser_profile.downloads_path;
    if (!downloadsPath) {
      return;
    }
    fs.mkdirSync(downloadsPath, { recursive: true });
  }

  async on_BrowserStateRequestEvent(event: BrowserStateRequestEvent) {
    const activeTab = this.browser_session.active_tab;
    if (!activeTab?.target_id || !activeTab.url) {
      return;
    }

    await this.event_bus.dispatch(
      new NavigationCompleteEvent({
        target_id: activeTab.target_id,
        url: activeTab.url,
        status: null,
        error_message: null,
        loading_status: null,
        event_parent_id: event.event_id,
      })
    );
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
    const startInfo: DownloadStartInfo = {
      guid: event.guid,
      url: event.url,
      suggested_filename: event.suggested_filename,
      auto_download: event.auto_download,
    };
    this._activeDownloads.set(event.guid, {
      url: event.url,
      suggested_filename: event.suggested_filename,
      started_at: new Date().toISOString(),
      received_bytes: 0,
      total_bytes: 0,
      state: 'inProgress',
    });

    for (const callback of this._downloadStartCallbacks) {
      try {
        callback(startInfo);
      } catch (error) {
        this.browser_session.logger.debug(
          `[DownloadsWatchdog] Error in download start callback: ${(error as Error).message}`
        );
      }
    }
  }

  on_DownloadProgressEvent(event: DownloadProgressEvent) {
    const existing = this._activeDownloads.get(event.guid);
    if (existing) {
      existing.received_bytes = event.received_bytes;
      existing.total_bytes = event.total_bytes;
      existing.state = event.state;
    }

    const progressInfo: DownloadProgressInfo = {
      guid: event.guid,
      received_bytes: event.received_bytes,
      total_bytes: event.total_bytes,
      state: event.state,
    };
    for (const callback of this._downloadProgressCallbacks) {
      try {
        callback(progressInfo);
      } catch (error) {
        this.browser_session.logger.debug(
          `[DownloadsWatchdog] Error in download progress callback: ${(error as Error).message}`
        );
      }
    }
  }

  on_FileDownloadedEvent(event: FileDownloadedEvent) {
    if (event.guid) {
      this._activeDownloads.delete(event.guid);
    }
    this.browser_session.add_downloaded_file(event.path);

    const completeInfo: DownloadCompleteInfo = {
      guid: event.guid,
      url: event.url,
      path: event.path,
      file_name: event.file_name,
      file_size: event.file_size,
      file_type: event.file_type,
      mime_type: event.mime_type,
      auto_download: event.auto_download,
    };
    for (const callback of this._downloadCompleteCallbacks) {
      try {
        callback(completeInfo);
      } catch (error) {
        this.browser_session.logger.debug(
          `[DownloadsWatchdog] Error in download complete callback: ${(error as Error).message}`
        );
      }
    }

    return event.path;
  }

  get_active_downloads() {
    return [...this._activeDownloads.entries()].map(([guid, metadata]) => ({
      guid,
      ...metadata,
    }));
  }

  register_download_callbacks({
    on_start,
    on_progress,
    on_complete,
  }: {
    on_start?: ((info: DownloadStartInfo) => void) | null;
    on_progress?: ((info: DownloadProgressInfo) => void) | null;
    on_complete?: ((info: DownloadCompleteInfo) => void) | null;
  } = {}) {
    if (on_start) {
      this._downloadStartCallbacks.push(on_start);
    }
    if (on_progress) {
      this._downloadProgressCallbacks.push(on_progress);
    }
    if (on_complete) {
      this._downloadCompleteCallbacks.push(on_complete);
    }
  }

  unregister_download_callbacks({
    on_start,
    on_progress,
    on_complete,
  }: {
    on_start?: ((info: DownloadStartInfo) => void) | null;
    on_progress?: ((info: DownloadProgressInfo) => void) | null;
    on_complete?: ((info: DownloadCompleteInfo) => void) | null;
  } = {}) {
    if (on_start) {
      this._downloadStartCallbacks = this._downloadStartCallbacks.filter(
        (callback) => callback !== on_start
      );
    }
    if (on_progress) {
      this._downloadProgressCallbacks = this._downloadProgressCallbacks.filter(
        (callback) => callback !== on_progress
      );
    }
    if (on_complete) {
      this._downloadCompleteCallbacks = this._downloadCompleteCallbacks.filter(
        (callback) => callback !== on_complete
      );
    }
  }
}
