import {
  ClickCoordinateEvent,
  ClickElementEvent,
  CloseTabEvent,
  GetDropdownOptionsEvent,
  GoBackEvent,
  GoForwardEvent,
  NavigateToUrlEvent,
  RefreshEvent,
  ScrollEvent,
  ScrollToTextEvent,
  SelectDropdownOptionEvent,
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
    GoBackEvent,
    GoForwardEvent,
    RefreshEvent,
    WaitEvent,
    SendKeysEvent,
    ScrollEvent,
    ScrollToTextEvent,
    ClickElementEvent,
    TypeTextEvent,
    UploadFileEvent,
    ClickCoordinateEvent,
    GetDropdownOptionsEvent,
    SelectDropdownOptionEvent,
  ];

  async on_NavigateToUrlEvent(event: NavigateToUrlEvent) {
    if (event.new_tab) {
      await this.browser_session.create_new_tab(event.url, {
        wait_until: event.wait_until,
        timeout_ms: event.timeout_ms,
      });
      return;
    }

    await this.browser_session.navigate_to(event.url, {
      wait_until: event.wait_until,
      timeout_ms: event.timeout_ms,
    });
  }

  async on_SwitchTabEvent(event: SwitchTabEvent) {
    let identifier: number | string;
    if (event.target_id) {
      identifier = event.target_id;
    } else {
      const tabs = this.browser_session.tabs;
      if (tabs.length === 0) {
        await this.browser_session.create_new_tab('about:blank');
        return (
          this.browser_session.active_tab?.target_id ??
          this.browser_session.active_tab?.tab_id ??
          'unknown_target'
        );
      }

      const latestTab = tabs[tabs.length - 1];
      identifier =
        latestTab.target_id ?? latestTab.tab_id ?? latestTab.page_id;
    }

    const page = await this.browser_session.switch_to_tab(identifier);
    const activeTargetId = this.browser_session.active_tab?.target_id ?? null;
    return (
      activeTargetId ?? (page ? this.browser_session.active_tab?.tab_id : null)
    );
  }

  async on_CloseTabEvent(event: CloseTabEvent) {
    await this.browser_session.close_tab(event.target_id);
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

  async on_ScrollEvent(event: ScrollEvent) {
    await this.browser_session.scroll(event.direction, event.amount, {
      node: event.node ?? null,
    });
  }

  async on_ScrollToTextEvent(event: ScrollToTextEvent) {
    await this.browser_session.scroll_to_text(event.text, {
      direction: event.direction,
    });
  }

  async on_ClickElementEvent(event: ClickElementEvent) {
    return this.browser_session._click_element_node(event.node);
  }

  async on_ClickCoordinateEvent(event: ClickCoordinateEvent) {
    await this.browser_session.click_coordinates(
      event.coordinate_x,
      event.coordinate_y,
      {
        button: event.button,
      }
    );
    return {
      coordinate_x: event.coordinate_x,
      coordinate_y: event.coordinate_y,
    };
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

  async on_GetDropdownOptionsEvent(event: GetDropdownOptionsEvent) {
    return this.browser_session.get_dropdown_options(event.node);
  }

  async on_SelectDropdownOptionEvent(event: SelectDropdownOptionEvent) {
    return this.browser_session.select_dropdown_option(event.node, event.text);
  }
}
