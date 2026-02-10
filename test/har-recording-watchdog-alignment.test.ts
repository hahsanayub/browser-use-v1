import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BrowserSession } from '../src/browser/session.js';
import {
  BrowserErrorEvent,
  BrowserStartEvent,
  BrowserStoppedEvent,
} from '../src/browser/events.js';
import { HarRecordingWatchdog } from '../src/browser/watchdogs/har-recording-watchdog.js';

describe('har recording watchdog alignment', () => {
  it('normalizes record_har_path on BrowserStartEvent and creates parent dir', async () => {
    const tmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-har-watchdog-')
    );
    try {
      const absoluteHarPath = path.join(tmpRoot, 'nested', 'session.har');
      const relativeHarPath = path.relative(process.cwd(), absoluteHarPath);

      const session = new BrowserSession({
        profile: {
          record_har_path: relativeHarPath,
        },
      });
      const watchdog = new HarRecordingWatchdog({ browser_session: session });
      session.attach_watchdog(watchdog);

      await session.event_bus.dispatch_or_throw(new BrowserStartEvent());

      expect(session.browser_profile.config.record_har_path).toBe(
        absoluteHarPath
      );
      expect(fs.existsSync(path.dirname(absoluteHarPath))).toBe(true);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('emits BrowserErrorEvent when HAR file is missing after BrowserStoppedEvent', async () => {
    const tmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-har-watchdog-missing-')
    );
    try {
      const harPath = path.join(tmpRoot, 'missing.har');
      const session = new BrowserSession({
        profile: {
          record_har_path: harPath,
        },
      });
      const watchdog = new HarRecordingWatchdog({ browser_session: session });
      session.attach_watchdog(watchdog);

      const errors: BrowserErrorEvent[] = [];
      session.event_bus.on(
        'BrowserErrorEvent',
        (event) => {
          errors.push(event as BrowserErrorEvent);
        },
        { handler_id: 'test.har.watchdog.missing.errors' }
      );

      await session.event_bus.dispatch_or_throw(new BrowserStartEvent());
      await session.event_bus.dispatch_or_throw(new BrowserStoppedEvent());

      expect(errors).toHaveLength(1);
      expect(errors[0].error_type).toBe('HarRecordingMissing');
      expect(errors[0].details.record_har_path).toBe(harPath);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('does not emit error when HAR file exists and has content', async () => {
    const tmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-har-watchdog-present-')
    );
    try {
      const harPath = path.join(tmpRoot, 'present.har');
      const session = new BrowserSession({
        profile: {
          record_har_path: harPath,
        },
      });
      const watchdog = new HarRecordingWatchdog({ browser_session: session });
      session.attach_watchdog(watchdog);

      const errors: BrowserErrorEvent[] = [];
      session.event_bus.on(
        'BrowserErrorEvent',
        (event) => {
          errors.push(event as BrowserErrorEvent);
        },
        { handler_id: 'test.har.watchdog.present.errors' }
      );

      await session.event_bus.dispatch_or_throw(new BrowserStartEvent());
      fs.writeFileSync(harPath, '{"log":{"version":"1.2"}}');
      await session.event_bus.dispatch_or_throw(new BrowserStoppedEvent());

      expect(errors).toHaveLength(0);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
