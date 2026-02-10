import { BrowserConnectedEvent, BrowserErrorEvent } from '../events.js';
import { BaseWatchdog } from './base.js';

type BrowserCDPSessionLike = {
  send?: (method: string, params?: Record<string, unknown>) => Promise<any>;
  detach?: () => Promise<void>;
};

export class PermissionsWatchdog extends BaseWatchdog {
  static override LISTENS_TO = [BrowserConnectedEvent];
  static override EMITS = [BrowserErrorEvent];

  async on_BrowserConnectedEvent() {
    const permissions = this.browser_session.browser_profile.config.permissions;
    if (!Array.isArray(permissions) || permissions.length === 0) {
      return;
    }

    let cdpError: Error | null = null;
    try {
      const grantedWithCdp = await this._grantPermissionsViaCdp(permissions);
      if (grantedWithCdp) {
        return;
      }
    } catch (error) {
      cdpError = error as Error;
    }

    const context = this.browser_session.browser_context as {
      grantPermissions?: (
        permissions: string[],
        options?: { origin?: string }
      ) => Promise<void>;
    } | null;

    if (!context?.grantPermissions) {
      if (!cdpError) {
        return;
      }
      await this.event_bus.dispatch(
        new BrowserErrorEvent({
          error_type: 'PermissionsWatchdogError',
          message: cdpError.message || 'Failed to grant permissions via CDP',
          details: {
            permissions,
            mode: 'cdp',
          },
        })
      );
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
            cdp_error: cdpError?.message ?? null,
            mode: 'playwright',
          },
        })
      );
    }
  }

  private async _grantPermissionsViaCdp(permissions: string[]) {
    const browser = this.browser_session.browser as {
      newBrowserCDPSession?: () => Promise<BrowserCDPSessionLike>;
    } | null;
    if (!browser?.newBrowserCDPSession) {
      return false;
    }

    const cdpSession = await browser.newBrowserCDPSession();
    try {
      await cdpSession.send?.('Browser.grantPermissions', {
        permissions,
      });
      return true;
    } finally {
      try {
        await cdpSession.detach?.();
      } catch {
        // Ignore detach failures.
      }
    }
  }
}
