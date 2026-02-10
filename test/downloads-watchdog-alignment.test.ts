import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BrowserSession } from '../src/browser/session.js';
import {
  BrowserLaunchEvent,
  BrowserStoppedEvent,
  DownloadStartedEvent,
  FileDownloadedEvent,
} from '../src/browser/events.js';
import { DownloadsWatchdog } from '../src/browser/watchdogs/downloads-watchdog.js';

describe('downloads watchdog alignment', () => {
  it('tracks active downloads and records completed files in session state', async () => {
    const session = new BrowserSession();
    const watchdog = new DownloadsWatchdog({ browser_session: session });
    session.attach_watchdog(watchdog);

    await session.event_bus.dispatch_or_throw(
      new DownloadStartedEvent({
        guid: 'download-guid-1',
        url: 'https://example.com/file.pdf',
        suggested_filename: 'file.pdf',
      })
    );
    expect(watchdog.get_active_downloads()).toHaveLength(1);

    await session.event_bus.dispatch_or_throw(
      new FileDownloadedEvent({
        guid: 'download-guid-1',
        url: 'https://example.com/file.pdf',
        path: '/tmp/file.pdf',
        file_name: 'file.pdf',
        file_size: 128,
      })
    );

    expect(watchdog.get_active_downloads()).toHaveLength(0);
    expect(session.get_downloaded_files()).toEqual(['/tmp/file.pdf']);
  });

  it('does not duplicate tracked file paths for repeated download events', async () => {
    const session = new BrowserSession();
    const watchdog = new DownloadsWatchdog({ browser_session: session });
    session.attach_watchdog(watchdog);

    const fileEvent = new FileDownloadedEvent({
      guid: 'download-guid-2',
      url: 'https://example.com/archive.zip',
      path: '/tmp/archive.zip',
      file_name: 'archive.zip',
      file_size: 512,
    });

    await session.event_bus.dispatch_or_throw(fileEvent);
    await session.event_bus.dispatch_or_throw(fileEvent);

    expect(session.get_downloaded_files()).toEqual(['/tmp/archive.zip']);
  });

  it('ensures downloads directory exists on BrowserLaunchEvent', async () => {
    const downloadsPath = `/tmp/browser-use-downloads-${Date.now()}`;
    const session = new BrowserSession({
      profile: {
        downloads_path: downloadsPath,
      },
    });
    const watchdog = new DownloadsWatchdog({ browser_session: session });
    session.attach_watchdog(watchdog);

    await session.event_bus.dispatch_or_throw(new BrowserLaunchEvent());

    expect(fs.existsSync(downloadsPath)).toBe(true);
    fs.rmSync(downloadsPath, { recursive: true, force: true });
  });

  it('clears active download cache on BrowserStoppedEvent', async () => {
    const session = new BrowserSession();
    const watchdog = new DownloadsWatchdog({ browser_session: session });
    session.attach_watchdog(watchdog);

    await session.event_bus.dispatch_or_throw(
      new DownloadStartedEvent({
        guid: 'download-guid-3',
        url: 'https://example.com/large.bin',
        suggested_filename: 'large.bin',
      })
    );
    expect(watchdog.get_active_downloads()).toHaveLength(1);

    await session.event_bus.dispatch_or_throw(new BrowserStoppedEvent());

    expect(watchdog.get_active_downloads()).toHaveLength(0);
  });
});
