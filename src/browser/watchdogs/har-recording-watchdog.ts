import fs from 'node:fs';
import path from 'node:path';
import {
  BrowserErrorEvent,
  BrowserStartEvent,
  BrowserStoppedEvent,
} from '../events.js';
import { BaseWatchdog } from './base.js';

export class HarRecordingWatchdog extends BaseWatchdog {
  static override LISTENS_TO = [BrowserStartEvent, BrowserStoppedEvent];

  private _harPath: string | null = null;

  async on_BrowserStartEvent() {
    const resolvedPath = this._resolveAndPrepareHarPath();
    if (!resolvedPath) {
      return;
    }
    this._harPath = resolvedPath;
  }

  async on_BrowserStoppedEvent() {
    const resolvedPath = this._harPath ?? this._resolveConfiguredHarPath();
    if (!resolvedPath) {
      return;
    }

    if (!fs.existsSync(resolvedPath)) {
      await this.event_bus.dispatch(
        new BrowserErrorEvent({
          error_type: 'HarRecordingMissing',
          message: `HAR file was not created at ${resolvedPath}`,
          details: {
            record_har_path: resolvedPath,
          },
        })
      );
      return;
    }

    try {
      const stat = fs.statSync(resolvedPath);
      if (stat.size === 0) {
        await this.event_bus.dispatch(
          new BrowserErrorEvent({
            error_type: 'HarRecordingEmpty',
            message: `HAR file is empty at ${resolvedPath}`,
            details: {
              record_har_path: resolvedPath,
            },
          })
        );
      }
    } catch (error) {
      await this.event_bus.dispatch(
        new BrowserErrorEvent({
          error_type: 'HarRecordingStatFailed',
          message: `Failed to inspect HAR file: ${(error as Error).message}`,
          details: {
            record_har_path: resolvedPath,
          },
        })
      );
    }
  }

  private _resolveConfiguredHarPath(): string | null {
    const configuredPath =
      this.browser_session.browser_profile.config.record_har_path;
    if (typeof configuredPath !== 'string' || configuredPath.trim() === '') {
      return null;
    }
    return path.resolve(configuredPath);
  }

  private _resolveAndPrepareHarPath(): string | null {
    const resolvedPath = this._resolveConfiguredHarPath();
    if (!resolvedPath) {
      return null;
    }
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    this.browser_session.browser_profile.config.record_har_path = resolvedPath;
    return resolvedPath;
  }
}
