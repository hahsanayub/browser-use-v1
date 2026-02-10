import fs from 'node:fs';
import path from 'node:path';
import {
  BrowserConnectedEvent,
  BrowserStopEvent,
  LoadStorageStateEvent,
  SaveStorageStateEvent,
  StorageStateLoadedEvent,
  StorageStateSavedEvent,
} from '../events.js';
import { BaseWatchdog } from './base.js';

type StorageStatePayload = {
  cookies?: unknown[];
  origins?: unknown[];
};

export class StorageStateWatchdog extends BaseWatchdog {
  static override LISTENS_TO = [
    BrowserConnectedEvent,
    BrowserStopEvent,
    SaveStorageStateEvent,
    LoadStorageStateEvent,
  ];

  static override EMITS = [StorageStateSavedEvent, StorageStateLoadedEvent];
  private _monitorInterval: NodeJS.Timeout | null = null;
  private _autoSaveIntervalMs = 30_000;
  private _monitoring = false;
  private _lastSavedSnapshot: string | null = null;

  async on_BrowserConnectedEvent() {
    this._startMonitoring();
    await this.event_bus.dispatch(new LoadStorageStateEvent());
  }

  async on_BrowserStopEvent() {
    this._stopMonitoring();
    await this.event_bus.dispatch(new SaveStorageStateEvent());
  }

  async on_SaveStorageStateEvent(event: SaveStorageStateEvent) {
    const targetPath = this._resolveStoragePath(event.path);
    if (!targetPath) {
      return;
    }

    const browserContext = this.browser_session.browser_context;
    if (!browserContext?.storageState) {
      this.browser_session.logger.debug(
        '[StorageStateWatchdog] Browser context unavailable for save'
      );
      return;
    }

    const storageState = (await browserContext.storageState()) as
      | StorageStatePayload
      | null
      | undefined;
    const normalized = storageState ?? {};
    this._lastSavedSnapshot = this._snapshotStorageState(normalized);

    const dirPath = path.dirname(targetPath);
    fs.mkdirSync(dirPath, { recursive: true });

    const tempPath = `${targetPath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(normalized, null, 2));

    if (fs.existsSync(targetPath)) {
      const backupPath = `${targetPath}.bak`;
      try {
        fs.renameSync(targetPath, backupPath);
      } catch {
        // Ignore backup failures and continue with atomic swap.
      }
    }

    fs.renameSync(tempPath, targetPath);

    await this.event_bus.dispatch(
      new StorageStateSavedEvent({
        path: targetPath,
        cookies_count: Array.isArray(normalized.cookies)
          ? normalized.cookies.length
          : 0,
        origins_count: Array.isArray(normalized.origins)
          ? normalized.origins.length
          : 0,
      })
    );
  }

  async on_LoadStorageStateEvent(event: LoadStorageStateEvent) {
    const targetPath = this._resolveStoragePath(event.path);
    if (!targetPath || !fs.existsSync(targetPath)) {
      return;
    }

    const browserContext = this.browser_session.browser_context;
    if (!browserContext) {
      this.browser_session.logger.debug(
        '[StorageStateWatchdog] Browser context unavailable for load'
      );
      return;
    }

    const raw = fs.readFileSync(targetPath, 'utf-8');
    const parsed = JSON.parse(raw) as StorageStatePayload;
    const cookies = Array.isArray(parsed.cookies) ? parsed.cookies : [];
    const origins = Array.isArray(parsed.origins) ? parsed.origins : [];
    this._lastSavedSnapshot = this._snapshotStorageState({
      cookies,
      origins,
    });

    if (cookies.length > 0 && typeof browserContext.addCookies === 'function') {
      await browserContext.addCookies(cookies as any[]);
    }

    await this.event_bus.dispatch(
      new StorageStateLoadedEvent({
        path: targetPath,
        cookies_count: cookies.length,
        origins_count: origins.length,
      })
    );
  }

  protected override onDetached() {
    this._stopMonitoring();
  }

  private _resolveStoragePath(pathFromEvent: string | null): string | null {
    if (typeof pathFromEvent === 'string' && pathFromEvent.trim().length > 0) {
      return path.resolve(pathFromEvent);
    }

    const configured =
      this.browser_session.browser_profile.config.storage_state;
    if (typeof configured === 'string' && configured.trim().length > 0) {
      return path.resolve(configured);
    }

    const cookiesFile = this.browser_session.browser_profile.cookies_file;
    if (typeof cookiesFile === 'string' && cookiesFile.trim().length > 0) {
      return path.resolve(cookiesFile);
    }

    return null;
  }

  private _startMonitoring() {
    if (this._monitorInterval) {
      return;
    }
    if (!this._resolveStoragePath(null)) {
      return;
    }
    this._monitorInterval = setInterval(() => {
      void this._checkAndAutoSave().catch((error) => {
        this.browser_session.logger.debug(
          `[StorageStateWatchdog] Auto-save monitor failed: ${(error as Error).message}`
        );
      });
    }, this._autoSaveIntervalMs);
  }

  private _stopMonitoring() {
    if (!this._monitorInterval) {
      return;
    }
    clearInterval(this._monitorInterval);
    this._monitorInterval = null;
  }

  private async _checkAndAutoSave() {
    if (this._monitoring) {
      return;
    }

    const browserContext = this.browser_session.browser_context;
    if (!browserContext?.storageState) {
      return;
    }

    this._monitoring = true;
    try {
      const storageState = (await browserContext.storageState()) as
        | StorageStatePayload
        | null
        | undefined;
      const normalized = storageState ?? {};
      const snapshot = this._snapshotStorageState(normalized);
      if (snapshot === this._lastSavedSnapshot) {
        return;
      }
      await this.event_bus.dispatch(new SaveStorageStateEvent());
    } finally {
      this._monitoring = false;
    }
  }

  private _snapshotStorageState(state: StorageStatePayload) {
    const cookies = Array.isArray(state.cookies) ? state.cookies : [];
    const origins = Array.isArray(state.origins) ? state.origins : [];
    return JSON.stringify({
      cookies,
      origins,
    });
  }
}
