import { describe, expect, it } from 'vitest';
import { AgentMessagePrompt, SystemPrompt } from '../src/agent/prompts.js';
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

  it('injects current plan block into agent state', () => {
    const root = new DOMElementNode(true, null, 'body', '/body', {}, []);
    const domState = new DOMState(root, {});
    const browserState = new BrowserStateSummary(domState, {
      url: 'https://example.com',
      title: 'Example',
      tabs: [{ page_id: 0, url: 'https://example.com', title: 'Example' }],
    });

    const prompt = new AgentMessagePrompt({
      browser_state_summary: browserState,
      file_system: {
        describe: () => '/tmp',
        get_todo_contents: () => '',
      } as any,
      task: 'test',
      plan_description: '[>] 0: open page\n[ ] 1: extract table',
    });

    const userMessage = prompt.get_user_message(false) as any;
    const content = String(userMessage.content ?? '');
    expect(content).toContain('<plan>');
    expect(content).toContain('[>] 0: open page');
    expect(content).toContain('[ ] 1: extract table');
  });

  it('includes read_state_images even when use_vision is disabled', () => {
    const root = new DOMElementNode(true, null, 'body', '/body', {}, []);
    const domState = new DOMState(root, {});
    const browserState = new BrowserStateSummary(domState, {
      url: 'https://example.com',
      title: 'Example',
      tabs: [{ page_id: 0, url: 'https://example.com', title: 'Example' }],
    });

    const prompt = new AgentMessagePrompt({
      browser_state_summary: browserState,
      file_system: {
        describe: () => '/tmp',
        get_todo_contents: () => '',
      } as any,
      task: 'test',
      screenshots: [],
      read_state_images: [{ name: 'chart.png', data: 'ZmFrZS1iYXNlNjQ=' }],
    });

    const userMessage = prompt.get_user_message(false) as any;
    expect(Array.isArray(userMessage.content)).toBe(true);
    const imageParts = userMessage.content.filter(
      (part: any) => part?.image_url?.url?.startsWith?.('data:image/png;base64,')
    );
    expect(imageParts).toHaveLength(1);
  });
});

describe('SystemPrompt template selection parity', () => {
  it('uses browser-use thinking template for browser-use models', () => {
    const prompt = new SystemPrompt(
      'actions',
      5,
      null,
      null,
      true,
      false,
      false,
      true,
      'browser-use/agent'
    );
    expect(prompt.get_system_message().text).toContain(
      'You are a browser-use agent operating in thinking mode.'
    );
  });

  it('uses browser-use flash template in flash mode', () => {
    const prompt = new SystemPrompt(
      'actions',
      5,
      null,
      null,
      true,
      true,
      false,
      true,
      'browser-use/agent'
    );
    expect(prompt.get_system_message().text).toContain(
      'You are a browser-use agent operating in flash mode.'
    );
  });

  it('uses anthropic flash template for anthropic models in flash mode', () => {
    const prompt = new SystemPrompt(
      'actions',
      5,
      null,
      null,
      true,
      true,
      true,
      false,
      'claude-3-7-sonnet'
    );
    expect(prompt.get_system_message().text).toContain(
      'You must call the AgentOutput tool with the following schema for the arguments'
    );
  });

  it('uses anthropic 4.5 flash template for opus/haiku 4.5 models', () => {
    const prompt = new SystemPrompt(
      'actions',
      5,
      null,
      null,
      true,
      true,
      true,
      false,
      'claude-opus-4.5'
    );
    expect(prompt.get_system_message().text).toContain(
      'Operating effectively in an agent loop with persistent state'
    );
  });
});
