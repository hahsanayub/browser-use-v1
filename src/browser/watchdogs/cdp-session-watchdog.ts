import { BrowserConnectedEvent, BrowserStoppedEvent } from '../events.js';
import { BaseWatchdog } from './base.js';

type CDPSessionLike = {
  send?: (method: string, params?: Record<string, unknown>) => Promise<any>;
  on?: (event: string, listener: (payload: any) => void) => void;
  off?: (event: string, listener: (payload: any) => void) => void;
  detach?: () => Promise<void>;
};

export class CDPSessionWatchdog extends BaseWatchdog {
  static override LISTENS_TO = [BrowserConnectedEvent, BrowserStoppedEvent];

  private _rootCdpSession: CDPSessionLike | null = null;
  private _listeners: Array<{
    event: string;
    handler: (payload: any) => void;
  }> = [];

  async on_BrowserConnectedEvent() {
    await this._ensureCdpMonitoring();
  }

  async on_BrowserStoppedEvent() {
    await this._teardownCdpMonitoring();
  }

  protected override onDetached() {
    void this._teardownCdpMonitoring();
  }

  private async _ensureCdpMonitoring() {
    if (this._rootCdpSession) {
      return;
    }
    if (!this.browser_session.browser_context?.newCDPSession) {
      return;
    }

    const page = await this.browser_session.get_current_page();
    if (!page) {
      return;
    }

    try {
      const cdpSession =
        (await this.browser_session.browser_context.newCDPSession(
          page
        )) as CDPSessionLike;
      this._rootCdpSession = cdpSession;

      await cdpSession.send?.('Target.setDiscoverTargets', {
        discover: true,
        filter: [{ type: 'page' }, { type: 'iframe' }],
      });

      const targetsPayload = await cdpSession.send?.('Target.getTargets');
      const targetInfos = Array.isArray(targetsPayload?.targetInfos)
        ? targetsPayload.targetInfos
        : [];
      for (const targetInfo of targetInfos) {
        const target_id = String(targetInfo?.targetId ?? '');
        if (!target_id) {
          continue;
        }
        this.browser_session.session_manager.handle_target_info_changed({
          target_id,
          target_type:
            typeof targetInfo?.type === 'string' ? targetInfo.type : 'page',
          url: typeof targetInfo?.url === 'string' ? targetInfo.url : '',
          title: typeof targetInfo?.title === 'string' ? targetInfo.title : '',
        });
      }

      const onAttached = (payload: any) => {
        const targetInfo = payload?.targetInfo ?? {};
        const target_id = String(targetInfo?.targetId ?? '');
        if (!target_id) {
          return;
        }
        this.browser_session.session_manager.handle_target_attached({
          target_id,
          session_id:
            typeof payload?.sessionId === 'string' ? payload.sessionId : null,
          target_type:
            typeof targetInfo?.type === 'string' ? targetInfo.type : 'page',
          url: typeof targetInfo?.url === 'string' ? targetInfo.url : '',
          title: typeof targetInfo?.title === 'string' ? targetInfo.title : '',
        });
      };
      const onDetached = (payload: any) => {
        const target_id = String(payload?.targetId ?? '');
        if (!target_id) {
          return;
        }
        this.browser_session.session_manager.handle_target_detached({
          target_id,
          session_id:
            typeof payload?.sessionId === 'string' ? payload.sessionId : null,
        });
      };
      const onTargetInfoChanged = (payload: any) => {
        const targetInfo = payload?.targetInfo ?? {};
        const target_id = String(targetInfo?.targetId ?? '');
        if (!target_id) {
          return;
        }
        this.browser_session.session_manager.handle_target_info_changed({
          target_id,
          target_type:
            typeof targetInfo?.type === 'string' ? targetInfo.type : 'page',
          url: typeof targetInfo?.url === 'string' ? targetInfo.url : '',
          title: typeof targetInfo?.title === 'string' ? targetInfo.title : '',
        });
      };

      cdpSession.on?.('Target.attachedToTarget', onAttached);
      cdpSession.on?.('Target.detachedFromTarget', onDetached);
      cdpSession.on?.('Target.targetInfoChanged', onTargetInfoChanged);
      this._listeners = [
        { event: 'Target.attachedToTarget', handler: onAttached },
        { event: 'Target.detachedFromTarget', handler: onDetached },
        { event: 'Target.targetInfoChanged', handler: onTargetInfoChanged },
      ];
    } catch (error) {
      this.browser_session.logger.debug(
        `CDPSessionWatchdog monitoring unavailable: ${(error as Error).message}`
      );
      await this._teardownCdpMonitoring();
    }
  }

  private async _teardownCdpMonitoring() {
    if (!this._rootCdpSession) {
      return;
    }

    for (const listener of this._listeners) {
      this._rootCdpSession.off?.(listener.event, listener.handler);
    }
    this._listeners = [];

    try {
      await this._rootCdpSession.detach?.();
    } catch {
      // Ignore CDP detach errors during shutdown.
    } finally {
      this._rootCdpSession = null;
    }
  }
}
