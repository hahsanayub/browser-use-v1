import { describe, expect, it, vi } from 'vitest';
import { BrowserSession } from '../src/browser/session.js';
import { DOMElementNode } from '../src/dom/views.js';
import {
  CodeAgent,
  create_namespace,
  detect_token_limit_issue,
  extract_code_blocks,
  extract_url_from_task,
  truncate_message_content,
} from '../src/code-use/index.js';

describe('code-use alignment', () => {
  it('extracts language blocks and utility parsing in python-aligned style', () => {
    const blocks = extract_code_blocks(
      [
        '```python',
        'print("a")',
        '```',
        '',
        '```js dom_script',
        'return document.title;',
        '```',
      ].join('\n')
    );

    expect(blocks.python).toContain('print("a")');
    expect(blocks.python_0).toContain('print("a")');
    expect(blocks.dom_script).toContain('document.title');

    expect(
      detect_token_limit_issue('x'.repeat(10), 95, 100, null)[0]
    ).toBe(true);
    expect(
      extract_url_from_task('Please open docs at https://example.com/docs')
    ).toBe('https://example.com/docs');
    expect(truncate_message_content('x'.repeat(20), 5)).toContain(
      '[... truncated'
    );
  });

  it('builds executable namespace helpers over BrowserSession', async () => {
    const session = new BrowserSession();
    const node = new DOMElementNode(
      true,
      null,
      'button',
      '/html/body/button[1]',
      {},
      []
    );
    vi.spyOn(session, 'get_dom_element_by_index').mockResolvedValue(node);
    const clickSpy = vi
      .spyOn(session, '_click_element_node')
      .mockResolvedValue(null);

    const namespace = create_namespace(session);
    await (namespace.click as (index: number) => Promise<unknown>)(1);
    (namespace.done as (value: unknown, success?: boolean) => unknown)(
      { done: true },
      true
    );

    expect(clickSpy).toHaveBeenCalledWith(node);
    expect(namespace._task_done).toBe(true);
    expect(namespace._task_success).toBe(true);
    expect(namespace._task_result).toContain('"done":true');
  });

  it('executes cells through CodeAgent and records history/state', async () => {
    const session = new BrowserSession();
    vi.spyOn(session, 'get_current_page').mockResolvedValue({
      url: vi.fn(() => 'https://example.com'),
      title: vi.fn(async () => 'Example'),
    } as any);

    const agent = new CodeAgent({
      task: 'Collect data',
      browser_session: session,
      executor: vi.fn(async (source: string, namespace) => {
        (namespace.done as (value: unknown, success?: boolean) => unknown)(
          'done',
          true
        );
        return `executed:${source}`;
      }),
    });

    const cell = await agent.execute_cell('return 1');

    expect(cell.status).toBe('success');
    expect(cell.output).toBe('executed:return 1');
    expect(agent.history.final_result()).toBe('executed:return 1');
    expect(agent.history.is_done()).toBe(true);
    expect(agent.history.is_successful()).toBe(true);
    expect(agent.history.number_of_steps()).toBe(1);
  });
});
