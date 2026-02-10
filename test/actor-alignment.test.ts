import { describe, expect, it, vi } from 'vitest';
import { Page, Mouse, Utils } from '../src/actor/index.js';
import { BrowserSession } from '../src/browser/session.js';
import { DOMElementNode } from '../src/dom/views.js';

describe('actor alignment', () => {
  it('routes page navigation and key press through BrowserSession helpers', async () => {
    const session = new BrowserSession();
    const page = new Page(session);

    const navigateSpy = vi
      .spyOn(session, 'navigate_to')
      .mockResolvedValue(null as any);
    const keySpy = vi.spyOn(session, 'send_keys').mockResolvedValue();

    await page.goto('https://example.com', {
      wait_until: 'networkidle',
      timeout_ms: 2500,
    });
    await page.press('Control+A');

    expect(navigateSpy).toHaveBeenCalledWith('https://example.com', {
      wait_until: 'networkidle',
      timeout_ms: 2500,
    });
    expect(keySpy).toHaveBeenCalledWith('Control+A');
  });

  it('creates Element wrappers from index lookups and delegates click/fill', async () => {
    const session = new BrowserSession();
    const page = new Page(session);

    const node = new DOMElementNode(
      true,
      null,
      'input',
      '/html/body/input[1]',
      { type: 'text' },
      []
    );

    vi.spyOn(session, 'get_dom_element_by_index').mockResolvedValue(node);
    const clickSpy = vi
      .spyOn(session, '_click_element_node')
      .mockResolvedValue(null);
    const fillSpy = vi
      .spyOn(session, '_input_text_element_node')
      .mockResolvedValue(undefined);

    const element = await page.must_get_element_by_index(5);
    await element.click();
    await element.fill('hello', false);

    expect(clickSpy).toHaveBeenCalledWith(node);
    expect(fillSpy).toHaveBeenCalledWith(node, 'hello', { clear: false });
  });

  it('uses Mouse.click to route coordinate clicks through BrowserSession', async () => {
    const session = new BrowserSession();
    const mouse = new Mouse(session);
    const clickSpy = vi.spyOn(session, 'click_coordinates').mockResolvedValue();

    await mouse.click(100, 200, { button: 'right' });

    expect(clickSpy).toHaveBeenCalledWith(100, 200, { button: 'right' });
  });

  it('maps key metadata with python-aligned get_key_info helper', () => {
    expect(Utils.get_key_info('Enter')).toEqual(['Enter', 13]);
    expect(Utils.get_key_info('a')).toEqual(['KeyA', 65]);
    expect(Utils.get_key_info('7')).toEqual(['Digit7', 55]);
  });
});
