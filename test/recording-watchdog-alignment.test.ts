import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BrowserSession } from '../src/browser/session.js';
import {
  AgentFocusChangedEvent,
  BrowserConnectedEvent,
  BrowserErrorEvent,
  BrowserStopEvent,
} from '../src/browser/events.js';
import { RecordingWatchdog } from '../src/browser/watchdogs/recording-watchdog.js';

describe('recording watchdog alignment', () => {
  it('prepares recording dirs and routes trace lifecycle through BrowserSession', async () => {
    const tmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-recording-watchdog-')
    );
    try {
      const session = new BrowserSession({
        profile: {
          traces_dir: path.join(tmpRoot, 'traces'),
          record_video_dir: path.join(tmpRoot, 'videos'),
        },
      });
      const watchdog = new RecordingWatchdog({ browser_session: session });
      session.attach_watchdog(watchdog);

      const startSpy = vi
        .spyOn(session, 'start_trace_recording')
        .mockResolvedValue();
      const stopSpy = vi
        .spyOn(session, 'save_trace_recording')
        .mockResolvedValue();

      await session.event_bus.dispatch_or_throw(
        new BrowserConnectedEvent({
          cdp_url: 'http://127.0.0.1:9222',
        })
      );

      expect(startSpy).toHaveBeenCalledTimes(1);
      expect(
        fs.existsSync(session.browser_profile.config.record_video_dir!)
      ).toBe(true);

      await session.event_bus.dispatch_or_throw(
        new AgentFocusChangedEvent({
          target_id: 'target-1',
          url: 'https://example.com/focus',
        })
      );
      expect(startSpy).toHaveBeenCalledTimes(1);

      await session.event_bus.dispatch_or_throw(new BrowserStopEvent());
      expect(stopSpy).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('emits BrowserErrorEvent when starting trace recording fails', async () => {
    const session = new BrowserSession({
      profile: {
        traces_dir: path.join(os.tmpdir(), `browser-use-traces-${Date.now()}`),
      },
    });
    const watchdog = new RecordingWatchdog({ browser_session: session });
    session.attach_watchdog(watchdog);

    const errors: BrowserErrorEvent[] = [];
    session.event_bus.on(
      'BrowserErrorEvent',
      (event) => {
        errors.push(event as BrowserErrorEvent);
      },
      { handler_id: 'test.recording.watchdog.errors' }
    );
    vi.spyOn(session, 'start_trace_recording').mockRejectedValue(
      new Error('trace init failed')
    );

    await session.event_bus.dispatch_or_throw(
      new BrowserConnectedEvent({
        cdp_url: 'http://127.0.0.1:9222',
      })
    );

    expect(errors).toHaveLength(1);
    expect(errors[0].error_type).toBe('RecordingStartFailed');
  });
});
