import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BrowserSession } from '../src/browser/session.js';
import {
  BrowserConnectedEvent,
  BrowserStopEvent,
  LoadStorageStateEvent,
  SaveStorageStateEvent,
  StorageStateLoadedEvent,
  StorageStateSavedEvent,
} from '../src/browser/events.js';
import { StorageStateWatchdog } from '../src/browser/watchdogs/storage-state-watchdog.js';

const createTempStoragePath = () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'browser-use-storage-watchdog-')
  );
  return {
    tempDir,
    storagePath: path.join(tempDir, 'storage-state.json'),
  };
};

describe('storage state watchdog alignment', () => {
  it('saves storage state and emits StorageStateSavedEvent', async () => {
    const { tempDir, storagePath } = createTempStoragePath();
    try {
      const session = new BrowserSession({
        profile: {
          storage_state: storagePath,
        },
      });
      session.browser_context = {
        storageState: vi.fn(async () => ({
          cookies: [{ name: 'sid', value: '123' }],
          origins: [{ origin: 'https://example.com', localStorage: [] }],
        })),
      } as any;
      session.attach_watchdog(
        new StorageStateWatchdog({ browser_session: session })
      );

      const dispatchSpy = vi.spyOn(session.event_bus, 'dispatch');
      await session.event_bus.dispatch_or_throw(new SaveStorageStateEvent());

      expect(fs.existsSync(storagePath)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(storagePath, 'utf-8'));
      expect(parsed.cookies).toHaveLength(1);
      expect(parsed.origins).toHaveLength(1);

      const savedCall = dispatchSpy.mock.calls.find(
        ([event]) => event instanceof StorageStateSavedEvent
      );
      expect(savedCall).toBeDefined();
      const savedEvent = savedCall?.[0] as StorageStateSavedEvent;
      expect(savedEvent.path).toBe(path.resolve(storagePath));
      expect(savedEvent.cookies_count).toBe(1);
      expect(savedEvent.origins_count).toBe(1);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('loads storage state cookies and emits StorageStateLoadedEvent', async () => {
    const { tempDir, storagePath } = createTempStoragePath();
    try {
      fs.writeFileSync(
        storagePath,
        JSON.stringify(
          {
            cookies: [{ name: 'sid', value: '123' }],
            origins: [{ origin: 'https://example.com', localStorage: [] }],
          },
          null,
          2
        )
      );

      const addCookies = vi.fn(async () => {});
      const session = new BrowserSession({
        profile: {
          storage_state: storagePath,
        },
      });
      session.browser_context = {
        addCookies,
      } as any;
      session.attach_watchdog(
        new StorageStateWatchdog({ browser_session: session })
      );

      const dispatchSpy = vi.spyOn(session.event_bus, 'dispatch');
      await session.event_bus.dispatch_or_throw(new LoadStorageStateEvent());

      expect(addCookies).toHaveBeenCalledTimes(1);
      expect(addCookies).toHaveBeenCalledWith([{ name: 'sid', value: '123' }]);

      const loadedCall = dispatchSpy.mock.calls.find(
        ([event]) => event instanceof StorageStateLoadedEvent
      );
      expect(loadedCall).toBeDefined();
      const loadedEvent = loadedCall?.[0] as StorageStateLoadedEvent;
      expect(loadedEvent.path).toBe(path.resolve(storagePath));
      expect(loadedEvent.cookies_count).toBe(1);
      expect(loadedEvent.origins_count).toBe(1);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('merges existing storage state entries when saving', async () => {
    const { tempDir, storagePath } = createTempStoragePath();
    try {
      fs.writeFileSync(
        storagePath,
        JSON.stringify(
          {
            cookies: [
              {
                name: 'old',
                value: '1',
                domain: '.example.com',
                path: '/',
              },
            ],
            origins: [
              {
                origin: 'https://persisted.example.com',
                localStorage: [{ name: 'a', value: '1' }],
              },
            ],
          },
          null,
          2
        )
      );

      const session = new BrowserSession({
        profile: {
          storage_state: storagePath,
        },
      });
      session.browser_context = {
        storageState: vi.fn(async () => ({
          cookies: [
            {
              name: 'new',
              value: '2',
              domain: '.example.com',
              path: '/',
            },
          ],
          origins: [
            {
              origin: 'https://fresh.example.com',
              localStorage: [{ name: 'b', value: '2' }],
            },
          ],
        })),
      } as any;
      session.attach_watchdog(
        new StorageStateWatchdog({ browser_session: session })
      );

      await session.event_bus.dispatch_or_throw(new SaveStorageStateEvent());

      const merged = JSON.parse(fs.readFileSync(storagePath, 'utf-8'));
      expect(merged.cookies).toHaveLength(2);
      expect(merged.origins).toHaveLength(2);
      expect(
        merged.cookies.some((cookie: any) => cookie.name === 'old')
      ).toBe(true);
      expect(
        merged.cookies.some((cookie: any) => cookie.name === 'new')
      ).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('bridges browser lifecycle events to load/save storage events', async () => {
    const { tempDir, storagePath } = createTempStoragePath();
    try {
      const session = new BrowserSession({
        profile: {
          storage_state: storagePath,
        },
      });
      session.browser_context = {
        storageState: vi.fn(async () => ({ cookies: [], origins: [] })),
        addCookies: vi.fn(async () => {}),
      } as any;
      session.attach_watchdog(
        new StorageStateWatchdog({ browser_session: session })
      );

      const dispatchSpy = vi.spyOn(session.event_bus, 'dispatch');

      await session.event_bus.dispatch_or_throw(
        new BrowserConnectedEvent({ cdp_url: 'ws://example' })
      );
      await session.event_bus.dispatch_or_throw(new BrowserStopEvent());

      expect(
        dispatchSpy.mock.calls.some(
          ([event]) => event instanceof LoadStorageStateEvent
        )
      ).toBe(true);
      expect(
        dispatchSpy.mock.calls.some(
          ([event]) => event instanceof SaveStorageStateEvent
        )
      ).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('starts periodic auto-save on connect and stops it on browser stop', async () => {
    vi.useFakeTimers();
    const { tempDir, storagePath } = createTempStoragePath();
    try {
      const storageState = vi
        .fn()
        .mockResolvedValueOnce({
          cookies: [{ name: 'sid', value: '1' }],
          origins: [],
        })
        .mockResolvedValue({
          cookies: [{ name: 'sid', value: '2' }],
          origins: [],
        });

      const session = new BrowserSession({
        profile: {
          storage_state: storagePath,
        },
      });
      session.browser_context = {
        storageState,
        addCookies: vi.fn(async () => {}),
      } as any;

      const watchdog = new StorageStateWatchdog({ browser_session: session });
      (watchdog as any)._autoSaveIntervalMs = 10;
      session.attach_watchdog(watchdog);

      await session.event_bus.dispatch_or_throw(
        new BrowserConnectedEvent({ cdp_url: 'ws://example' })
      );
      await vi.advanceTimersByTimeAsync(30);

      expect(storageState).toHaveBeenCalled();

      await session.event_bus.dispatch_or_throw(new BrowserStopEvent());
      const callCountAfterStop = storageState.mock.calls.length;

      await vi.advanceTimersByTimeAsync(50);
      expect(storageState.mock.calls.length).toBe(callCountAfterStop);
    } finally {
      vi.useRealTimers();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
