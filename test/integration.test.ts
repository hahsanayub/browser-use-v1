import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BaseChatModel } from '../src/llm/base.js';
import { DOMTextNode } from '../src/dom/views.js';

// Stub heavy utils to avoid build-time duplicate export errors and keep decorators no-op for tests
vi.mock('../src/utils.js', () => {
  let counter = 0;
  const decorator =
    <T extends (...args: any[]) => any>(_label?: string) =>
    (fn: T) =>
      fn;

  class SignalHandler {
    constructor(_opts?: unknown) {}
    register() {}
    reset() {}
    unregister() {}
  }

  const uuid7str = () => `uuid-${++counter}`;
  const is_new_tab_page = (url: string) =>
    url === 'about:blank' || url.startsWith('chrome://');
  const match_url_with_domain_pattern = (url: string, pattern: string) => {
    if (!pattern) return false;
    const normalized = pattern.replace(/\*/g, '');
    return url.includes(normalized);
  };

  return {
    uuid7str,
    time_execution_sync: decorator,
    time_execution_async: decorator,
    SignalHandler,
    get_browser_use_version: () => 'test-version',
    is_new_tab_page,
    match_url_with_domain_pattern,
    wait_until: async (predicate: () => boolean, timeout = 1000) => {
      const start = Date.now();
      while (!predicate() && Date.now() - start < timeout) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    },
  };
});

vi.mock('../src/llm/messages.js', () => {
  class MessageBase {
    cache = false;
    constructor(init?: { cache?: boolean }) {
      if (init?.cache !== undefined) {
        this.cache = init.cache;
      }
    }
  }

  class SystemMessage extends MessageBase {
    role = 'system' as const;
    constructor(
      public content: any,
      public name: string | null = null
    ) {
      super();
    }
    get text() {
      return typeof this.content === 'string' ? this.content : '';
    }
  }

  class UserMessage extends MessageBase {
    role = 'user' as const;
    constructor(
      public content: any,
      public name: string | null = null
    ) {
      super();
    }
    get text() {
      return typeof this.content === 'string' ? this.content : '';
    }
  }

  class AssistantMessage extends MessageBase {
    role = 'assistant' as const;
    content: any;
    tool_calls: any;
    refusal: any;
    constructor(init: any = {}) {
      super();
      this.content = init.content ?? null;
      this.tool_calls = init.tool_calls ?? null;
      this.refusal = init.refusal ?? null;
    }
    get text() {
      return typeof this.content === 'string' ? this.content : '';
    }
  }

  class ContentPartTextParam {
    type = 'text' as const;
    constructor(public text: string) {}
  }

  class ContentPartRefusalParam {
    type = 'refusal' as const;
    constructor(public refusal: string) {}
  }

  class ImageURL {
    constructor(
      public url: string,
      public detail: 'auto' | 'low' | 'high' = 'auto',
      public media_type: string = 'image/png'
    ) {}
    toString() {
      return this.url;
    }
  }

  class ContentPartImageParam {
    type = 'image_url' as const;
    constructor(public image_url: ImageURL) {}
  }

  class FunctionCall {
    constructor(
      public name: string,
      public args: string
    ) {}
  }

  class ToolCall {
    type = 'function' as const;
    constructor(
      public id: string,
      public functionCall: FunctionCall
    ) {}
  }

  return {
    MessageBase,
    SystemMessage,
    UserMessage,
    AssistantMessage,
    ContentPartTextParam,
    ContentPartRefusalParam,
    ContentPartImageParam,
    ImageURL,
    FunctionCall,
    ToolCall,
  };
});

const { Agent } = await import('../src/agent/service.js');
const { ActionResult } = await import('../src/agent/views.js');
const { Registry } = await import('../src/controller/registry/service.js');
const {
  GoToUrlActionSchema,
  DoneActionSchema,
} = await import('../src/controller/views.js');
const { DOMElementNode, DOMState } = await import('../src/dom/views.js');
const { BrowserStateSummary } = await import('../src/browser/views.js');
const { DomService } = await import('../src/dom/service.js');
const { ActionModel: RegistryActionModel } = await import(
  '../src/controller/registry/views.js'
);

(globalThis as any).ActionModel = RegistryActionModel;

class MockLLM implements BaseChatModel {
  model = 'mock-model';
  private readonly responses: Array<{ completion: any }>;
  calls: any[][] = [];

  constructor(responses: Array<{ completion: any }>) {
    this.responses = responses;
  }

  get provider() {
    return 'mock';
  }
  get name() {
    return this.model;
  }
  get model_name() {
    return this.model;
  }

  async ainvoke(messages: any[]) {
    this.calls.push(messages);
    const idx = Math.min(this.calls.length - 1, this.responses.length - 1);
    return this.responses[idx] ?? { completion: { action: [] } };
  }
}

const tempResources: string[] = [];
afterEach(() => {
  while (tempResources.length) {
    const dir = tempResources.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

const createTempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-use-test-'));
  tempResources.push(dir);
  return dir;
};

const createTestController = () => {
  const registry = new Registry();

  registry.action('Navigate to URL', { param_model: GoToUrlActionSchema })(
    async function go_to_url(params, { browser_session }) {
      if (!browser_session) throw new Error('Missing browser session');
      await browser_session.navigate_to(params.url);
      return new ActionResult({
        extracted_content: `Navigated to ${params.url}`,
        include_in_memory: true,
        long_term_memory: `Navigated to ${params.url}`,
      });
    }
  );

  registry.action('Complete task', { param_model: DoneActionSchema })(
    function done(params) {
      return new ActionResult({
        is_done: true,
        success: params.success,
        extracted_content: params.text,
        long_term_memory: params.text,
      });
    }
  );

  return { registry } as any;
};

const createBrowserSessionStub = (initialUrl = 'https://start.test') => {
  let currentUrl = initialUrl;
  const navigateCalls: string[] = [];

  const buildState = () => {
    const root = new DOMElementNode(
      true,
      null,
      'body',
      '/html/body',
      {},
      [new DOMTextNode(true, null, 'Root text')]
    );
    root.is_top_element = true;
    root.is_in_viewport = true;
    root.highlight_index = 0;
    const domState = new DOMState(root, { 0: root });
    return new BrowserStateSummary(domState, {
      url: currentUrl,
      title: 'Test Page',
      tabs: [{ page_id: 0, url: currentUrl, title: 'Test Page' }],
    });
  };

  return {
    id: 'session-stub',
    browser_profile: {},
    downloaded_files: [],
    navigateCalls,
    async get_browser_state_with_recovery() {
      return buildState();
    },
    async get_current_page() {
      return { url: () => currentUrl };
    },
    async navigate_to(url: string) {
      currentUrl = url;
      navigateCalls.push(url);
    },
    get_selector_map: async () => ({ 0: buildState().element_tree }),
  };
};

describe('Integration', () => {
  it('runs the agent loop with mocked LLM and browser session', async () => {
    const controller = createTestController();
    const browser_session = createBrowserSessionStub();
    const tempDir = createTempDir();
    const llm = new MockLLM([
      {
        completion: {
          action: [{ go_to_url: { url: 'https://example.com' } }],
          thinking: 'navigate then finish',
        },
      },
      {
        completion: {
          action: [{ done: { success: true, text: 'Reached example.com' } }],
          thinking: 'wrap up',
        },
      },
    ]);

    const agent = new Agent({
      task: 'Navigate then finish',
      llm,
      browser_session,
      controller,
      file_system_path: tempDir,
      use_vision: false,
      max_actions_per_step: 3,
    });

    tempResources.push(agent.agent_directory);
    const history = await agent.run(3);

    expect(history.is_done()).toBe(true);
    expect(history.is_successful()).toBe(true);
    expect(history.number_of_steps()).toBe(2);
    expect(browser_session.navigateCalls).toEqual(['https://example.com']);
    expect(history.final_result()).toContain('Reached example.com');
  });

  it('builds a DOM snapshot from the serialized page state', async () => {
    const serializedDom = {
      rootId: '1',
      map: {
        '1': {
          type: 'ELEMENT_NODE',
          tagName: 'body',
          xpath: '/html/body',
          isVisible: true,
          isInViewport: true,
          isTopElement: true,
          children: ['2'],
        },
        '2': {
          type: 'ELEMENT_NODE',
          tagName: 'button',
          xpath: '/html/body/button[1]',
          isVisible: true,
          isInViewport: true,
          isTopElement: true,
          isInteractive: true,
          highlightIndex: 0,
          children: ['3'],
        },
        '3': {
          type: 'TEXT_NODE',
          text: 'Click me',
          isVisible: true,
        },
      },
    };

    const fakePage = {
      url: () => 'https://example.com',
      async evaluate(fn: any, ...args: any[]) {
        if (typeof fn === 'function' && args.length === 0) {
          return fn();
        }
        return serializedDom;
      },
    };

    const domService = new DomService(fakePage as any);
    const domState = await domService.get_clickable_elements();

    expect(domState.selector_map[0]).toBeInstanceOf(DOMElementNode);
    expect(domState.selector_map[0].tag_name).toBe('button');
    expect(domState.selector_map[0].children[0]).toBeInstanceOf(DOMTextNode);
    expect(
      domState.selector_map[0].clickable_elements_to_string()
    ).toContain('<button');
  });
});
