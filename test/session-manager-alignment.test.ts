import { describe, expect, it } from 'vitest';
import { SessionManager } from '../src/browser/session-manager.js';
import type { TabInfo } from '../src/browser/views.js';
import { BrowserSession } from '../src/browser/session.js';

describe('session manager alignment', () => {
  it('syncs tab-based targets and focused target as single source of truth', () => {
    const manager = new SessionManager();
    const tabs: TabInfo[] = [
      {
        page_id: 3,
        tab_id: '0003',
        url: 'https://example.com',
        title: 'Example',
      },
      {
        page_id: 4,
        tab_id: '0004',
        url: 'https://example.org',
        title: 'Example Org',
      },
    ];

    manager.sync_tabs(tabs, 1, (page_id) => `target-${page_id}`);

    expect(tabs[0].target_id).toBe('target-3');
    expect(tabs[1].target_id).toBe('target-4');
    expect(manager.get_target_id_for_page(3)).toBe('target-3');
    expect(manager.get_target_id_for_page(4)).toBe('target-4');
    expect(manager.get_focused_target_id()).toBe('target-4');
    expect(manager.get_all_targets()).toHaveLength(2);
  });

  it('keeps target until all attached sessions are detached', () => {
    const manager = new SessionManager();
    manager.handle_target_attached({
      target_id: 'cdp-target-1',
      session_id: 'session-a',
      target_type: 'page',
      url: 'https://one.test',
    });
    manager.handle_target_attached({
      target_id: 'cdp-target-1',
      session_id: 'session-b',
      target_type: 'page',
      url: 'https://one.test',
    });

    manager.handle_target_detached({
      target_id: 'cdp-target-1',
      session_id: 'session-a',
    });
    expect(manager.get_target('cdp-target-1')).not.toBeNull();

    manager.handle_target_detached({
      target_id: 'cdp-target-1',
      session_id: 'session-b',
    });
    expect(manager.get_target('cdp-target-1')).toBeNull();
  });

  it('prunes stale tab targets when tabs are removed', () => {
    const manager = new SessionManager();
    const tabs: TabInfo[] = [
      {
        page_id: 11,
        tab_id: '0011',
        url: 'https://one.test',
        title: 'One',
      },
      {
        page_id: 12,
        tab_id: '0012',
        url: 'https://two.test',
        title: 'Two',
      },
    ];
    manager.sync_tabs(tabs, 0, (page_id) => `tab-target-${page_id}`);

    const remainingTabs: TabInfo[] = [tabs[0]];
    manager.sync_tabs(remainingTabs, 0, (page_id) => `tab-target-${page_id}`);

    expect(manager.get_target('tab-target-11')).not.toBeNull();
    expect(manager.get_target('tab-target-12')).toBeNull();
  });

  it('BrowserSession initializes with session_manager target tracking enabled', () => {
    const session = new BrowserSession({ id: 'session-for-manager-test' });
    const tabs = session.tabs;

    expect(tabs).toHaveLength(1);
    const initialTab = tabs[0];
    expect(initialTab.target_id).toBeTruthy();
    expect(
      session.session_manager.get_target_id_for_page(initialTab.page_id)
    ).toBe(initialTab.target_id);
    expect(session.session_manager.get_focused_target_id()).toBe(
      initialTab.target_id
    );
  });
});
