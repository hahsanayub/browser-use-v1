import {
  BrowserStateRequestEvent,
  ClickElementEvent,
  CloseTabEvent,
  GoBackEvent,
  GoForwardEvent,
  NavigateToUrlEvent,
  RefreshEvent,
  ScreenshotEvent,
  SendKeysEvent,
  SwitchTabEvent,
  TypeTextEvent,
  UploadFileEvent,
  WaitEvent,
} from '../events.js';
import { BaseWatchdog } from './base.js';

export class DefaultActionWatchdog extends BaseWatchdog {
  static override LISTENS_TO = [
    NavigateToUrlEvent,
    SwitchTabEvent,
    CloseTabEvent,
    ScreenshotEvent,
    BrowserStateRequestEvent,
    GoBackEvent,
    GoForwardEvent,
    RefreshEvent,
    WaitEvent,
    SendKeysEvent,
    ClickElementEvent,
    TypeTextEvent,
    UploadFileEvent,
  ];

  async on_NavigateToUrlEvent(event: NavigateToUrlEvent) {
    await this.browser_session.navigate_to(event.url);
  }

  async on_SwitchTabEvent(event: SwitchTabEvent) {
    const identifier = event.target_id ?? -1;
    const page = await this.browser_session.switch_to_tab(identifier);
    const activeTargetId = this.browser_session.active_tab?.target_id ?? null;
    return (
      activeTargetId ?? (page ? this.browser_session.active_tab?.tab_id : null)
    );
  }

  async on_CloseTabEvent(event: CloseTabEvent) {
    await this.browser_session.close_tab(event.target_id);
  }

  async on_ScreenshotEvent(event: ScreenshotEvent) {
    return this.browser_session.take_screenshot(event.full_page);
  }

  async on_BrowserStateRequestEvent(event: BrowserStateRequestEvent) {
    return this.browser_session.get_browser_state_with_recovery({
      cache_clickable_elements_hashes: true,
      include_screenshot: event.include_screenshot,
      include_recent_events: event.include_recent_events,
    });
  }

  async on_GoBackEvent() {
    await this.browser_session.go_back();
  }

  async on_GoForwardEvent() {
    await this.browser_session.go_forward();
  }

  async on_RefreshEvent() {
    await this.browser_session.refresh();
  }

  async on_WaitEvent(event: WaitEvent) {
    const seconds = Math.min(Math.max(event.seconds, 0), event.max_seconds);
    await this.browser_session.wait(seconds);
  }

  async on_SendKeysEvent(event: SendKeysEvent) {
    await this.browser_session.send_keys(event.keys);
  }

  async on_ClickElementEvent(event: ClickElementEvent) {
    return this.browser_session._click_element_node(event.node);
  }

  async on_TypeTextEvent(event: TypeTextEvent) {
    return this.browser_session._input_text_element_node(
      event.node,
      event.text,
      {
        clear: event.clear,
      }
    );
  }

  async on_UploadFileEvent(event: UploadFileEvent) {
    await this.browser_session.upload_file(event.node, event.file_path);
  }
}
