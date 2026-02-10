import {
  BrowserConnectedEvent,
  BrowserErrorEvent,
  BrowserStoppedEvent,
  TabClosedEvent,
  TabCreatedEvent,
  TargetCrashedEvent,
} from '../events.js';
import type { Page } from '../types.js';
import { BaseWatchdog } from './base.js';

type PageLike = Page & {
  on?: (event: string, listener: (payload?: unknown) => void) => void;
  off?: (event: string, listener: (payload?: unknown) => void) => void;
  removeListener?: (
    event: string,
    listener: (payload?: unknown) => void
  ) => void;
  url?: () => string;
};

export class CrashWatchdog extends BaseWatchdog {
  static override LISTENS_TO = [
    BrowserConnectedEvent,
    BrowserStoppedEvent,
    TabCreatedEvent,
    TabClosedEvent,
  ];

  static override EMITS = [TargetCrashedEvent, BrowserErrorEvent];

  private _pageListeners = new Map<PageLike, (payload?: unknown) => void>();

  async on_BrowserConnectedEvent() {
    this._attachToKnownPages();
  }

  async on_TabCreatedEvent() {
    this._attachToKnownPages();
  }

  async on_TabClosedEvent() {
    this._dropDetachedPages();
  }

  async on_BrowserStoppedEvent() {
    this._detachAllPages();
  }

  protected override onDetached() {
    this._detachAllPages();
  }

  private _attachToKnownPages() {
    for (const page of this._getKnownPages()) {
      this._attachPage(page);
    }
  }

  private _dropDetachedPages() {
    const livePages = new Set(this._getKnownPages());
    for (const [page, listener] of [...this._pageListeners.entries()]) {
      if (livePages.has(page)) {
        continue;
      }
      this._detachPageListener(page, listener);
      this._pageListeners.delete(page);
    }
  }

  private _detachAllPages() {
    for (const [page, listener] of [...this._pageListeners.entries()]) {
      this._detachPageListener(page, listener);
    }
    this._pageListeners.clear();
  }

  private _attachPage(page: PageLike) {
    if (this._pageListeners.has(page)) {
      return;
    }
    if (typeof page?.on !== 'function') {
      return;
    }

    const listener = (payload?: unknown) => {
      void this._handlePageCrash(page, payload);
    };
    page.on('crash', listener);
    this._pageListeners.set(page, listener);
  }

  private _detachPageListener(
    page: PageLike,
    listener: (payload?: unknown) => void
  ) {
    if (typeof page.off === 'function') {
      page.off('crash', listener);
      return;
    }
    if (typeof page.removeListener === 'function') {
      page.removeListener('crash', listener);
    }
  }

  private _getKnownPages(): PageLike[] {
    const pagesFromContext =
      typeof this.browser_session.browser_context?.pages === 'function'
        ? (this.browser_session.browser_context.pages() as PageLike[])
        : [];
    const activePage = this.browser_session.agent_current_page as PageLike;
    if (!activePage) {
      return pagesFromContext;
    }
    if (pagesFromContext.includes(activePage)) {
      return pagesFromContext;
    }
    return [...pagesFromContext, activePage];
  }

  private async _handlePageCrash(page: PageLike, payload?: unknown) {
    const target_id = this._resolveTargetId(page);
    const url =
      this._safePageUrl(page) ?? this.browser_session.active_tab?.url ?? '';
    const errorMessage = this._normalizeCrashError(payload);

    await this.event_bus.dispatch(
      new TargetCrashedEvent({
        target_id,
        error: errorMessage,
      })
    );

    await this.event_bus.dispatch(
      new BrowserErrorEvent({
        error_type: 'TargetCrash',
        message: errorMessage,
        details: {
          target_id,
          url,
        },
      })
    );
  }

  private _resolveTargetId(page: PageLike) {
    const pageUrl = this._safePageUrl(page);
    if (pageUrl) {
      const tabByUrl = this.browser_session.tabs.find(
        (tab) => tab.url === pageUrl && tab.target_id
      );
      if (tabByUrl?.target_id) {
        return tabByUrl.target_id;
      }
    }

    const activeTargetId = this.browser_session.active_tab?.target_id;
    if (activeTargetId) {
      return activeTargetId;
    }

    return (
      this.browser_session.session_manager.get_focused_target_id() ??
      'unknown_target'
    );
  }

  private _safePageUrl(page: PageLike) {
    try {
      return typeof page.url === 'function' ? page.url() : null;
    } catch {
      return null;
    }
  }

  private _normalizeCrashError(payload?: unknown) {
    if (payload instanceof Error) {
      return payload.message || 'Target crashed';
    }
    if (typeof payload === 'string' && payload.trim().length > 0) {
      return payload.trim();
    }
    if (payload && typeof payload === 'object' && 'message' in payload) {
      const candidate = (payload as { message?: unknown }).message;
      if (typeof candidate === 'string' && candidate.trim().length > 0) {
        return candidate.trim();
      }
    }
    return 'Target crashed';
  }
}
