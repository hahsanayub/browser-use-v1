import { BrowserConnectedEvent, BrowserErrorEvent } from '../events.js';
import { BaseWatchdog } from './base.js';

export class PermissionsWatchdog extends BaseWatchdog {
  static override LISTENS_TO = [BrowserConnectedEvent];
  static override EMITS = [BrowserErrorEvent];

  async on_BrowserConnectedEvent() {
    const permissions = this.browser_session.browser_profile.config.permissions;
    if (!Array.isArray(permissions) || permissions.length === 0) {
      return;
    }

    const context = this.browser_session.browser_context as {
      grantPermissions?: (
        permissions: string[],
        options?: { origin?: string }
      ) => Promise<void>;
    } | null;

    if (!context?.grantPermissions) {
      return;
    }

    try {
      await context.grantPermissions(permissions);
    } catch (error) {
      const message = (error as Error).message ?? 'Failed to grant permissions';
      await this.event_bus.dispatch(
        new BrowserErrorEvent({
          error_type: 'PermissionsWatchdogError',
          message,
          details: {
            permissions,
          },
        })
      );
    }
  }
}
