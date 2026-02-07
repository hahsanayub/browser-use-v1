import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/controller/service.js', () => {
  class Controller {
    registry = {
      get_all_actions: () => new Map(),
    };
  }
  return { Controller };
});

import { MCPServer } from '../src/mcp/server.js';

describe('MCPServer browser_click new_tab', () => {
  it('opens href targets in a new tab and reports tab index', async () => {
    const server = new MCPServer('test-mcp', '1.0.0');
    const createNewTab = vi.fn(async () => ({}));
    const browserSession = {
      initialized: true,
      start: vi.fn(),
      get_dom_element_by_index: vi.fn(async () => ({
        attributes: { href: '/next' },
      })),
      get_current_page: vi.fn(async () => ({
        url: () => 'https://example.com/current',
      })),
      create_new_tab: createNewTab,
      active_tab_index: 2,
    };

    (server as any).ensureBrowserSession = vi.fn(async () => browserSession);
    (server as any).executeControllerAction = vi.fn(async () => 'fallback');

    const result = await (server as any).tools.browser_click.handler({
      index: 7,
      new_tab: true,
    });

    expect(createNewTab).toHaveBeenCalledWith('https://example.com/next');
    expect(result).toContain('new tab #2');
    expect((server as any).executeControllerAction).not.toHaveBeenCalled();
  });

  it('uses modifier click for non-link elements when new_tab=true', async () => {
    vi.useFakeTimers();
    try {
      const server = new MCPServer('test-mcp', '1.0.0');
      const locatorClick = vi.fn(async () => undefined);
      const browserSession = {
        initialized: true,
        start: vi.fn(),
        get_dom_element_by_index: vi.fn(async () => ({
          attributes: {},
        })),
        get_locate_element: vi.fn(async () => ({
          click: locatorClick,
        })),
      };

      (server as any).ensureBrowserSession = vi.fn(async () => browserSession);
      (server as any).executeControllerAction = vi.fn(async () => 'fallback');

      const handlerPromise = (server as any).tools.browser_click.handler({
        index: 9,
        new_tab: true,
      });
      await vi.advanceTimersByTimeAsync(500);
      const result = await handlerPromise;

      const expectedModifier = process.platform === 'darwin' ? 'Meta' : 'Control';
      expect(locatorClick).toHaveBeenCalledWith({
        modifiers: [expectedModifier],
      });
      expect(result).toContain('new tab if supported');
      expect((server as any).executeControllerAction).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
