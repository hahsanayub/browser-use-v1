import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { BrowserSession } from '../src/browser/session.js';
import {
  BrowserLaunchEvent,
  BrowserStateRequestEvent,
  DownloadProgressEvent,
  BrowserStoppedEvent,
  DownloadStartedEvent,
  FileDownloadedEvent,
  NavigationCompleteEvent,
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

  it('tracks progress and notifies direct download callbacks', async () => {
    const session = new BrowserSession();
    const watchdog = new DownloadsWatchdog({ browser_session: session });
    session.attach_watchdog(watchdog);

    const onStart = vi.fn();
    const onProgress = vi.fn();
    const onComplete = vi.fn();
    watchdog.register_download_callbacks({
      on_start: onStart,
      on_progress: onProgress,
      on_complete: onComplete,
    });

    await session.event_bus.dispatch_or_throw(
      new DownloadStartedEvent({
        guid: 'download-guid-callback',
        url: 'https://example.com/report.csv',
        suggested_filename: 'report.csv',
      })
    );
    await session.event_bus.dispatch_or_throw(
      new DownloadProgressEvent({
        guid: 'download-guid-callback',
        received_bytes: 64,
        total_bytes: 128,
        state: 'inProgress',
      })
    );
    await session.event_bus.dispatch_or_throw(
      new FileDownloadedEvent({
        guid: 'download-guid-callback',
        url: 'https://example.com/report.csv',
        path: '/tmp/report.csv',
        file_name: 'report.csv',
        file_size: 128,
      })
    );

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledTimes(1);

    const tracked = watchdog.get_active_downloads();
    expect(tracked).toHaveLength(0);
  });

  it('supports unregistering direct download callbacks', async () => {
    const session = new BrowserSession();
    const watchdog = new DownloadsWatchdog({ browser_session: session });
    session.attach_watchdog(watchdog);

    const onStart = vi.fn();
    watchdog.register_download_callbacks({
      on_start: onStart,
    });
    watchdog.unregister_download_callbacks({
      on_start: onStart,
    });

    await session.event_bus.dispatch_or_throw(
      new DownloadStartedEvent({
        guid: 'download-guid-unregister',
        url: 'https://example.com/unregister.bin',
        suggested_filename: 'unregister.bin',
      })
    );

    expect(onStart).not.toHaveBeenCalled();
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

  it('bridges BrowserStateRequestEvent to NavigationCompleteEvent for active tab', async () => {
    const session = new BrowserSession();
    const watchdog = new DownloadsWatchdog({ browser_session: session });
    session.attach_watchdog(watchdog);

    const navigationEvents: NavigationCompleteEvent[] = [];
    session.event_bus.on(
      'NavigationCompleteEvent',
      (event) => {
        navigationEvents.push(event as NavigationCompleteEvent);
      },
      { handler_id: 'test.downloads.state.nav-complete' }
    );

    const stateEvent = new BrowserStateRequestEvent({
      include_screenshot: false,
      include_recent_events: false,
    });
    await session.event_bus.dispatch_or_throw(stateEvent);

    expect(navigationEvents).toHaveLength(1);
    expect(navigationEvents[0].target_id).toBe(session.active_tab?.target_id);
    expect(navigationEvents[0].url).toBe(session.active_tab?.url);
    expect(navigationEvents[0].event_parent_id).toBe(stateEvent.event_id);
  });
});
