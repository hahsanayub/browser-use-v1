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

  async on_BrowserConnectedEvent() {
    await this.event_bus.dispatch(new LoadStorageStateEvent());
  }

  async on_BrowserStopEvent() {
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
}
