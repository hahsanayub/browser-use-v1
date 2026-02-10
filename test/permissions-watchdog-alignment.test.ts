import { describe, expect, it, vi } from 'vitest';
import { BrowserSession } from '../src/browser/session.js';
import {
  BrowserConnectedEvent,
  BrowserErrorEvent,
} from '../src/browser/events.js';
import { PermissionsWatchdog } from '../src/browser/watchdogs/permissions-watchdog.js';

describe('permissions watchdog alignment', () => {
  it('grants configured browser permissions on browser connected', async () => {
    const session = new BrowserSession({
      profile: {
        permissions: ['geolocation', 'clipboard-read'],
      },
    });
    const grantPermissions = vi.fn(async () => {});
    session.browser_context = {
      grantPermissions,
    } as any;

    const watchdog = new PermissionsWatchdog({ browser_session: session });
    session.attach_watchdog(watchdog);

    await session.event_bus.dispatch_or_throw(
      new BrowserConnectedEvent({ cdp_url: 'ws://localhost:9222' })
    );

    expect(grantPermissions).toHaveBeenCalledTimes(1);
    expect(grantPermissions).toHaveBeenCalledWith([
      'geolocation',
      'clipboard-read',
    ]);
  });

  it('emits BrowserErrorEvent when permission grant fails', async () => {
    const session = new BrowserSession({
      profile: {
        permissions: ['notifications'],
      },
    });
    session.browser_context = {
      grantPermissions: vi.fn(async () => {
        throw new Error('permission denied');
      }),
    } as any;

    const watchdog = new PermissionsWatchdog({ browser_session: session });
    session.attach_watchdog(watchdog);

    const errors: BrowserErrorEvent[] = [];
    session.event_bus.on(
      'BrowserErrorEvent',
      (event) => {
        errors.push(event as BrowserErrorEvent);
      },
      { handler_id: 'test.permissions.errors' }
    );

    await session.event_bus.dispatch_or_throw(
      new BrowserConnectedEvent({ cdp_url: 'ws://localhost:9222' })
    );

    expect(errors).toHaveLength(1);
    expect(errors[0].error_type).toBe('PermissionsWatchdogError');
    expect(errors[0].message).toContain('permission denied');
  });
});
