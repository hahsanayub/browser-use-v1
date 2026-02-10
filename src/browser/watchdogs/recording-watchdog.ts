import fs from 'node:fs';
import path from 'node:path';
import {
  AgentFocusChangedEvent,
  BrowserConnectedEvent,
  BrowserErrorEvent,
  BrowserStopEvent,
} from '../events.js';
import { BaseWatchdog } from './base.js';

export class RecordingWatchdog extends BaseWatchdog {
  static override LISTENS_TO = [
    BrowserConnectedEvent,
    BrowserStopEvent,
    AgentFocusChangedEvent,
  ];

  private _traceStarted = false;

  async on_BrowserConnectedEvent() {
    this._prepareVideoDirectory();
    await this._startTracingIfConfigured();
  }

  async on_BrowserStopEvent() {
    await this._stopTracingIfStarted();
  }

  async on_AgentFocusChangedEvent(event: AgentFocusChangedEvent) {
    if (!this._traceStarted) {
      return;
    }
    this.browser_session.logger.debug(
      `[RecordingWatchdog] Focus changed to ${event.target_id}; tracing remains active`
    );
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
}
