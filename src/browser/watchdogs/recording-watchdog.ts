import fs from 'node:fs';
import path from 'node:path';
import {
  AgentFocusChangedEvent,
  BrowserConnectedEvent,
  BrowserErrorEvent,
  BrowserStopEvent,
  BrowserStoppedEvent,
  TabCreatedEvent,
} from '../events.js';
import { BaseWatchdog } from './base.js';

type PageLike = {
  on?: (event: string, listener: () => void) => void;
  off?: (event: string, listener: () => void) => void;
  removeListener?: (event: string, listener: () => void) => void;
  video?: () => { path?: () => Promise<string> } | null;
};

export class RecordingWatchdog extends BaseWatchdog {
  static override LISTENS_TO = [
    BrowserConnectedEvent,
    BrowserStopEvent,
    BrowserStoppedEvent,
    AgentFocusChangedEvent,
    TabCreatedEvent,
  ];

  private _traceStarted = false;
  private _videoCloseListeners = new Map<PageLike, () => void>();

  async on_BrowserConnectedEvent() {
    this._prepareVideoDirectory();
    this._attachVideoListenersToKnownPages();
    await this._startTracingIfConfigured();
  }

  async on_BrowserStopEvent() {
    await this._stopTracingIfStarted();
  }

  async on_BrowserStoppedEvent() {
    this._detachVideoListeners();
  }

  async on_AgentFocusChangedEvent(event: AgentFocusChangedEvent) {
    this._attachVideoListenersToKnownPages();
    if (!this._traceStarted) {
      return;
    }
    this.browser_session.logger.debug(
      `[RecordingWatchdog] Focus changed to ${event.target_id}; tracing remains active`
    );
  }

  async on_TabCreatedEvent() {
    this._attachVideoListenersToKnownPages();
  }

  protected override onDetached() {
    this._detachVideoListeners();
  }

  private _prepareVideoDirectory() {
    const configuredPath =
      this.browser_session.browser_profile.config.record_video_dir;
    if (typeof configuredPath !== 'string' || configuredPath.trim() === '') {
      return;
    }
    const resolvedPath = path.resolve(configuredPath);
    fs.mkdirSync(resolvedPath, { recursive: true });
    this.browser_session.browser_profile.config.record_video_dir = resolvedPath;
  }

  private async _startTracingIfConfigured() {
    if (
      this._traceStarted ||
      !this.browser_session.browser_profile.traces_dir
    ) {
      return;
    }
    try {
      await this.browser_session.start_trace_recording();
      this._traceStarted = true;
    } catch (error) {
      await this.event_bus.dispatch(
        new BrowserErrorEvent({
          error_type: 'RecordingStartFailed',
          message: `Failed to start trace recording: ${(error as Error).message}`,
          details: {
            traces_dir: this.browser_session.browser_profile.traces_dir,
          },
        })
      );
    }
  }

  private async _stopTracingIfStarted() {
    if (!this._traceStarted) {
      return;
    }
    try {
      await this.browser_session.save_trace_recording();
    } catch (error) {
      await this.event_bus.dispatch(
        new BrowserErrorEvent({
          error_type: 'RecordingStopFailed',
          message: `Failed to save trace recording: ${(error as Error).message}`,
          details: {
            traces_dir: this.browser_session.browser_profile.traces_dir,
          },
        })
      );
    } finally {
      this._traceStarted = false;
    }
  }

  private _attachVideoListenersToKnownPages() {
    const configuredPath =
      this.browser_session.browser_profile.config.record_video_dir;
    if (typeof configuredPath !== 'string' || configuredPath.trim() === '') {
      return;
    }

    for (const page of this._getKnownPages()) {
      this._attachVideoListener(page);
    }
  }

  private _attachVideoListener(page: PageLike) {
    if (this._videoCloseListeners.has(page) || typeof page?.on !== 'function') {
      return;
    }

    const listener = () => {
      void this._captureVideoArtifact(page);
    };
    page.on('close', listener);
    this._videoCloseListeners.set(page, listener);
  }

  private _detachVideoListeners() {
    for (const [page, listener] of [...this._videoCloseListeners.entries()]) {
      if (typeof page.off === 'function') {
        page.off('close', listener);
      } else if (typeof page.removeListener === 'function') {
        page.removeListener('close', listener);
      }
    }
    this._videoCloseListeners.clear();
  }

  private _getKnownPages(): PageLike[] {
    const pagesFromContext =
      typeof this.browser_session.browser_context?.pages === 'function'
        ? (this.browser_session.browser_context.pages() as PageLike[])
        : [];
    const activePage = this.browser_session
      .agent_current_page as PageLike | null;
    if (!activePage) {
      return pagesFromContext;
    }
    if (pagesFromContext.includes(activePage)) {
      return pagesFromContext;
    }
    return [...pagesFromContext, activePage];
  }

  private async _captureVideoArtifact(page: PageLike) {
    try {
      const video = typeof page.video === 'function' ? page.video() : null;
      const videoPath = await video?.path?.();
      if (typeof videoPath === 'string' && videoPath.length > 0) {
        this.browser_session.add_downloaded_file(videoPath);
      }
    } catch (error) {
      this.browser_session.logger.debug(
        `[RecordingWatchdog] Failed to capture video artifact: ${(error as Error).message}`
      );
    }
  }
}
