import { describe, expect, it } from 'vitest';
import { AgentMessagePrompt } from '../src/agent/prompts.js';
import { BrowserStateSummary } from '../src/browser/views.js';
import { DOMElementNode, DOMState } from '../src/dom/views.js';

describe('AgentMessagePrompt browser state enrichment', () => {
  it('includes recent events, pending requests, pagination, and popup messages', () => {
    const root = new DOMElementNode(true, null, 'body', '/body', {}, []);
    const domState = new DOMState(root, {});
    const browserState = new BrowserStateSummary(domState, {
      url: 'https://example.com/list',
      title: 'List',
      tabs: [{ page_id: 0, url: 'https://example.com/list', title: 'List' }],
      recent_events:
        '[{"event_type":"tab_switched","timestamp":"2026-01-01T00:00:00Z"}]',
      pending_network_requests: [
        {
          url: 'https://example.com/api/items',
          method: 'GET',
          loading_duration_ms: 120,
          resource_type: 'fetch',
        },
      ],
      pagination_buttons: [
        {
          button_type: 'next',
          backend_node_id: 8,
          text: 'Next',
          selector: '/html/body/nav/button[2]',
          is_disabled: false,
        },
      ],
      closed_popup_messages: ['[alert] Session expired soon'],
    });

    const prompt = new AgentMessagePrompt({
      browser_state_summary: browserState,
      file_system: {
        describe: () => '/tmp',
        get_todo_contents: () => '',
      } as any,
      task: 'test',
      include_recent_events: true,
    });

    const userMessage = prompt.get_user_message(false) as any;
    const content = String(userMessage.content ?? '');

    expect(content).toContain('Recent browser events:');
    expect(content).toContain('Pending network requests:');
    expect(content).toContain('Detected pagination buttons:');
    expect(content).toContain('Auto-closed JavaScript dialogs:');
  });

  it('does not include recent events by default', () => {
    const root = new DOMElementNode(true, null, 'body', '/body', {}, []);
    const domState = new DOMState(root, {});
    const browserState = new BrowserStateSummary(domState, {
      url: 'https://example.com/list',
      title: 'List',
      tabs: [{ page_id: 0, url: 'https://example.com/list', title: 'List' }],
      recent_events: '[{"event_type":"tab_switched"}]',
    });

    const prompt = new AgentMessagePrompt({
      browser_state_summary: browserState,
      file_system: {
        describe: () => '/tmp',
        get_todo_contents: () => '',
      } as any,
      task: 'test',
    });

    const userMessage = prompt.get_user_message(false) as any;
    const content = String(userMessage.content ?? '');
    expect(content).not.toContain('Recent browser events:');
  });
});
