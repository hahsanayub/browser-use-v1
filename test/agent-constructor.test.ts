import { describe, expect, it, vi } from 'vitest';
import type { BaseChatModel } from '../src/llm/base.js';
import { Agent } from '../src/agent/service.js';
import { ActionResult } from '../src/agent/views.js';
import {
  ModelProviderError,
  ModelRateLimitError,
} from '../src/llm/exceptions.js';
import { UserMessage } from '../src/llm/messages.js';
import { BrowserSession } from '../src/browser/session.js';
import { BrowserProfile } from '../src/browser/profile.js';
import { DOMElementNode } from '../src/dom/views.js';
import { HistoryTreeProcessor } from '../src/dom/history-tree-processor/service.js';

const createLlm = (
  model = 'gpt-test',
  provider = 'test'
): BaseChatModel =>
  ({
    model,
    get provider() {
      return provider;
    },
    get name() {
      return 'test';
    },
    get model_name() {
      return 'gpt-test';
    },
    ainvoke: vi.fn(async () => ({ completion: 'ok', usage: null })),
  }) as unknown as BaseChatModel;

describe('Agent constructor browser session alignment', () => {
  it('creates BrowserSession from page/context when browser_session is omitted', async () => {
    const fakeContext = { id: 'ctx-1' };
    const fakePage = {
      context: () => fakeContext,
    } as any;

    const agent = new Agent({
      task: 'test auto session from page',
      llm: createLlm(),
      page: fakePage,
    });

    expect(agent.browser_session).toBeInstanceOf(BrowserSession);
    expect(agent.browser_session?.agent_current_page).toBe(fakePage);
    expect(agent.browser_session?.browser_context).toBe(fakeContext);
    expect(agent.browser_session?.id.slice(-4)).toBe(agent.id.slice(-4));

    await agent.close();
  });

  it('accepts BrowserSession passed via browser parameter', async () => {
    const browserSession = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    });

    const agent = new Agent({
      task: 'test browser as session',
      llm: createLlm(),
      browser: browserSession,
    });

    expect(agent.browser_session).toBe(browserSession);

    await agent.close();
  });

  it('auto-enables flash mode for browser-use provider and disables planning', async () => {
    const agent = new Agent({
      task: 'browser-use provider flash mode',
      llm: createLlm('browser-use/agent', 'browser-use'),
      flash_mode: false,
      enable_planning: true,
    });

    expect(agent.settings.flash_mode).toBe(true);
    expect(agent.settings.enable_planning).toBe(false);

    await agent.close();
  });

  it('uses model-aware llm_timeout defaults when not explicitly set', async () => {
    const geminiAgent = new Agent({
      task: 'gemini timeout',
      llm: createLlm('gemini-3-pro', 'google'),
    });
    const groqAgent = new Agent({
      task: 'groq timeout',
      llm: createLlm('groq/llama-3.1-70b', 'groq'),
    });
    const genericAgent = new Agent({
      task: 'generic timeout',
      llm: createLlm('gpt-4o-mini', 'openai'),
    });
    const overrideAgent = new Agent({
      task: 'override timeout',
      llm: createLlm('gemini-2.5-flash', 'google'),
      llm_timeout: 123,
    });

    expect(geminiAgent.settings.llm_timeout).toBe(90);
    expect(groqAgent.settings.llm_timeout).toBe(30);
    expect(genericAgent.settings.llm_timeout).toBe(75);
    expect(overrideAgent.settings.llm_timeout).toBe(123);

    await geminiAgent.close();
    await groqAgent.close();
    await genericAgent.close();
    await overrideAgent.close();
  });

  it('only disables vision automatically for grok-3/grok-code models', async () => {
    const grok2Agent = new Agent({
      task: 'grok-2 vision',
      llm: createLlm('grok-2-vision', 'xai'),
      use_vision: true,
    });
    const grok3Agent = new Agent({
      task: 'grok-3 vision',
      llm: createLlm('grok-3-beta', 'xai'),
      use_vision: true,
    });
    const grokCodeAgent = new Agent({
      task: 'grok-code vision',
      llm: createLlm('grok-code-fast', 'xai'),
      use_vision: true,
    });

    expect(grok2Agent.settings.use_vision).toBe(true);
    expect(grok3Agent.settings.use_vision).toBe(false);
    expect(grokCodeAgent.settings.use_vision).toBe(false);

    await grok2Agent.close();
    await grok3Agent.close();
    await grokCodeAgent.close();
  });

  it('initializes fallback llm state and exposes model tracking getters', async () => {
    const primary = createLlm('primary-model', 'openai');
    const fallback = createLlm('fallback-model', 'anthropic');
    const agent = new Agent({
      task: 'fallback state init',
      llm: primary,
      fallback_llm: fallback,
    });

    expect(agent.is_using_fallback_llm).toBe(false);
    expect(agent.current_llm_model).toBe('primary-model');
    expect((agent as any)._fallback_llm).toBe(fallback);
    expect((agent as any)._original_llm).toBe(primary);

    await agent.close();
  });

  it('switches to fallback llm on retryable provider errors', async () => {
    const primary = createLlm('primary-model');
    const fallback = createLlm('fallback-model');
    const agent = new Agent({
      task: 'fallback switch',
      llm: primary,
      fallback_llm: fallback,
    });
    const registerSpy = vi.spyOn(
      (agent as any).token_cost_service,
      'register_llm'
    );

    const switched = (agent as any)._try_switch_to_fallback_llm(
      new ModelProviderError('Service unavailable', 503, 'primary-model')
    );

    expect(switched).toBe(true);
    expect(agent.llm).toBe(fallback);
    expect(agent.is_using_fallback_llm).toBe(true);
    expect(agent.current_llm_model).toBe('fallback-model');
    expect(registerSpy).toHaveBeenCalledWith(fallback);

    await agent.close();
  });

  it('does not switch to fallback llm for non-retryable provider errors', async () => {
    const primary = createLlm('primary-model');
    const fallback = createLlm('fallback-model');
    const agent = new Agent({
      task: 'fallback non retryable',
      llm: primary,
      fallback_llm: fallback,
    });

    const switched = (agent as any)._try_switch_to_fallback_llm(
      new ModelProviderError('Bad request', 400, 'primary-model')
    );

    expect(switched).toBe(false);
    expect(agent.llm).toBe(primary);
    expect(agent.is_using_fallback_llm).toBe(false);
    expect(agent.current_llm_model).toBe('primary-model');

    await agent.close();
  });

  it('retries model output generation with fallback llm after rate limit', async () => {
    const primaryInvoke = vi.fn(async () => {
      throw new ModelRateLimitError('Rate limit exceeded', 429, 'primary-model');
    });
    const fallbackInvoke = vi.fn(async () => ({
      completion: {
        thinking: null,
        evaluation_previous_goal: 'none',
        memory: 'none',
        next_goal: 'finish',
        action: [
          {
            done: {
              text: 'Task completed',
              success: true,
            },
          },
        ],
      },
      usage: null,
    }));
    const primary = {
      ...createLlm('primary-model'),
      ainvoke: primaryInvoke,
    } as BaseChatModel;
    const fallback = {
      ...createLlm('fallback-model'),
      ainvoke: fallbackInvoke,
    } as BaseChatModel;
    const agent = new Agent({
      task: 'fallback invoke retry',
      llm: primary,
      fallback_llm: fallback,
    });

    const output = await (agent as any)._get_model_output_with_retry(
      [{ role: 'user', content: 'test' }],
      null
    );

    expect(primaryInvoke).toHaveBeenCalledTimes(1);
    expect(fallbackInvoke).toHaveBeenCalledTimes(1);
    expect(agent.llm).toBe(fallback);
    expect(agent.is_using_fallback_llm).toBe(true);
    expect(output.action).toHaveLength(1);
    expect(output.action[0].model_dump()).toEqual({
      done: {
        text: 'Task completed',
        success: true,
        files_to_display: [],
      },
    });

    await agent.close();
  });

  it('shortens long URLs before invoke and restores original URLs in model output', async () => {
    const longUrl = `https://example.com/path?token=${'x'.repeat(80)}`;
    const seenMessages: any[] = [];
    const llm = {
      ...createLlm('primary-model'),
      ainvoke: vi.fn(async (messages: any[]) => {
        seenMessages.push(messages);
        const promptText =
          typeof messages?.[0]?.content === 'string'
            ? messages[0].content
            : '';
        return {
          completion: {
            thinking: null,
            evaluation_previous_goal: 'none',
            memory: 'none',
            next_goal: `Inspect ${promptText}`,
            action: [
              {
                done: {
                  text: `Processed ${promptText}`,
                  success: true,
                },
              },
            ],
          },
          usage: null,
        };
      }),
    } as BaseChatModel;
    const agent = new Agent({
      task: 'url shortening',
      llm,
      _url_shortening_limit: 12,
    });

    const inputMessages = [new UserMessage(`Visit ${longUrl} and summarize.`)];
    const output = await (agent as any)._get_model_output_with_retry(
      inputMessages,
      null
    );

    const forwardedPrompt = String(seenMessages[0]?.[0]?.content ?? '');
    expect(forwardedPrompt).not.toContain(longUrl);
    expect(forwardedPrompt).toContain('...');
    expect(output.next_goal).toContain(longUrl);
    expect(output.action[0].model_dump().done.text).toContain(longUrl);

    await agent.close();
  });

  it('logger getter works on partially initialized agent instances', () => {
    const partialAgent = Object.create(Agent.prototype) as Agent<any, any>;
    (partialAgent as any)._logger = null;

    expect(() => (partialAgent as any).logger).not.toThrow();
  });

  it('multi_act skips remaining actions after terminating navigation actions', async () => {
    const agent = new Agent({
      task: 'multi_act terminating action guard',
      llm: createLlm(),
    });
    const executeActionSpy = vi
      .spyOn(agent.controller.registry as any, 'execute_action')
      .mockResolvedValue(new ActionResult({ extracted_content: 'ok' }));

    const results = await agent.multi_act(
      [
        { go_to_url: { url: 'https://example.com', new_tab: false } },
        { wait: { seconds: 1 } },
      ],
      { check_for_new_elements: false }
    );

    expect(executeActionSpy).toHaveBeenCalledTimes(1);
    expect(executeActionSpy.mock.calls[0]?.[0]).toBe('go_to_url');
    expect(results).toHaveLength(1);

    await agent.close();
  });

  it('multi_act skips remaining actions when page URL changes after an action', async () => {
    const agent = new Agent({
      task: 'multi_act runtime page-change guard',
      llm: createLlm(),
    });
    let currentUrl = 'https://start.test';
    vi.spyOn(agent.browser_session as any, 'get_current_page').mockImplementation(
      async () =>
        ({
          url: () => currentUrl,
        }) as any
    );
    const executeActionSpy = vi
      .spyOn(agent.controller.registry as any, 'execute_action')
      .mockImplementation(async (_name: string, _params: any) => {
        currentUrl = 'https://changed.test';
        return new ActionResult({ extracted_content: 'ok' });
      });

    const results = await agent.multi_act(
      [{ wait: { seconds: 1 } }, { wait: { seconds: 1 } }],
      { check_for_new_elements: false }
    );

    expect(executeActionSpy).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);

    await agent.close();
  });

  it('copies non-owning BrowserSession instances to avoid shared-agent state', async () => {
    const sharedSession = new BrowserSession({
      browser_profile: new BrowserProfile({}),
      browser: {} as any,
    });
    const copySpy = vi.spyOn(sharedSession, 'model_copy');

    const agent = new Agent({
      task: 'test shared session copy',
      llm: createLlm(),
      browser_session: sharedSession,
    });

    expect(copySpy).toHaveBeenCalledTimes(1);
    expect(agent.browser_session).toBeInstanceOf(BrowserSession);
    expect(agent.browser_session).not.toBe(sharedSession);

    await agent.close();
  });

  it('reuses non-owning BrowserSession in shared attachment mode without cloning', async () => {
    const sharedSession = new BrowserSession({
      browser_profile: new BrowserProfile({}),
      browser: {} as any,
    });
    const copySpy = vi.spyOn(sharedSession, 'model_copy');

    const agent1 = new Agent({
      task: 'shared non-owning agent 1',
      llm: createLlm(),
      browser_session: sharedSession,
      session_attachment_mode: 'shared',
    });
    const agent2 = new Agent({
      task: 'shared non-owning agent 2',
      llm: createLlm(),
      browser_session: sharedSession,
      session_attachment_mode: 'shared',
    });

    expect(copySpy).toHaveBeenCalledTimes(0);
    expect(agent1.browser_session).toBe(sharedSession);
    expect(agent2.browser_session).toBe(sharedSession);
    expect(sharedSession.get_attached_agent_ids().sort()).toEqual(
      [agent1.id, agent2.id].sort()
    );

    await agent1.close();
    await agent2.close();
  });

  it('creates isolated copy when BrowserSession is already attached to another agent', async () => {
    const sharedSession = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    });
    expect(sharedSession.claim_agent('existing-agent')).toBe(true);

    const agent = new Agent({
      task: 'test attached session isolation',
      llm: createLlm(),
      browser_session: sharedSession,
    });

    expect(agent.browser_session).toBeInstanceOf(BrowserSession);
    expect(agent.browser_session).not.toBe(sharedSession);
    expect(sharedSession.get_attached_agent_id()).toBe('existing-agent');
    expect(
      (agent.browser_session as BrowserSession).get_attached_agent_id()
    ).toBe(agent.id);

    await agent.close();
  });

  it('releases BrowserSession claim on close', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    });

    const agent = new Agent({
      task: 'test claim release',
      llm: createLlm(),
      browser_session: session,
    });

    expect(session.get_attached_agent_id()).toBe(agent.id);
    await agent.close();
    expect(session.get_attached_agent_id()).toBeNull();
  });

  it('deduplicates concurrent close calls and releases claim once', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    });
    const stopSpy = vi.spyOn(session as any, 'stop').mockImplementation(
      async () =>
        await new Promise((resolve) => {
          setTimeout(resolve, 20);
        })
    );
    const releaseSpy = vi.spyOn(session as any, 'release_agent');

    const agent = new Agent({
      task: 'test concurrent close',
      llm: createLlm(),
      browser_session: session,
    });

    expect(session.get_attached_agent_id()).toBe(agent.id);
    await Promise.all([agent.close(), agent.close(), agent.close()]);
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(releaseSpy).toHaveBeenCalledTimes(1);
    expect(session.get_attached_agent_id()).toBeNull();
  });

  it('throws in strict attachment mode when BrowserSession is already attached', () => {
    const sharedSession = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    });
    expect(sharedSession.claim_agent('existing-agent')).toBe(true);

    expect(
      () =>
        new Agent({
          task: 'strict attachment',
          llm: createLlm(),
          browser_session: sharedSession,
          session_attachment_mode: 'strict',
        })
    ).toThrow(/already attached to Agent existing-agent/);
  });

  it('throws in strict attachment mode when BrowserSession does not support claims', () => {
    const legacySession = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    }) as any;
    legacySession.claim_agent = undefined;
    legacySession.claimAgent = undefined;

    expect(
      () =>
        new Agent({
          task: 'strict unsupported claims',
          llm: createLlm(),
          browser_session: legacySession,
          session_attachment_mode: 'strict',
        })
    ).toThrow(
      /requires BrowserSession\.claim_agent\(\)\/release_agent\(\) support/
    );
  });

  it('reuses BrowserSession in shared attachment mode and defers shutdown until last agent closes', async () => {
    const sharedSession = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    });
    const stopSpy = vi
      .spyOn(sharedSession as any, 'stop')
      .mockImplementation(async () => {});

    const agent1 = new Agent({
      task: 'shared agent 1',
      llm: createLlm(),
      browser_session: sharedSession,
      session_attachment_mode: 'shared',
    });
    const agent2 = new Agent({
      task: 'shared agent 2',
      llm: createLlm(),
      browser_session: sharedSession,
      session_attachment_mode: 'shared',
    });

    expect(agent1.browser_session).toBe(sharedSession);
    expect(agent2.browser_session).toBe(sharedSession);
    expect(sharedSession.get_attached_agent_ids().sort()).toEqual(
      [agent1.id, agent2.id].sort()
    );

    await agent1.close();
    expect(stopSpy).toHaveBeenCalledTimes(0);
    expect(sharedSession.get_attached_agent_ids()).toEqual([agent2.id]);

    await agent2.close();
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(sharedSession.get_attached_agent_ids()).toEqual([]);
  });

  it('throws in shared attachment mode when session is already exclusively attached', async () => {
    const sharedSession = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    });
    const exclusiveAgent = new Agent({
      task: 'exclusive owner',
      llm: createLlm(),
      browser_session: sharedSession,
    });

    expect(
      () =>
        new Agent({
          task: 'shared join fails',
          llm: createLlm(),
          browser_session: sharedSession,
          session_attachment_mode: 'shared',
        })
    ).toThrow(/already attached in exclusive mode/);

    await exclusiveAgent.close();
  });

  it('throws in shared attachment mode when BrowserSession does not support claims', () => {
    const legacySession = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    }) as any;
    legacySession.claim_agent = undefined;
    legacySession.claimAgent = undefined;

    expect(
      () =>
        new Agent({
          task: 'shared unsupported claims',
          llm: createLlm(),
          browser_session: legacySession,
          session_attachment_mode: 'shared',
        })
    ).toThrow(
      /requires BrowserSession\.claim_agent\(\)\/release_agent\(\) support/
    );
  });

  it('defaults page_extraction_llm to the main llm when omitted', async () => {
    const llm = createLlm();
    const agent = new Agent({
      task: 'test extraction llm default',
      llm,
    });

    expect(agent.settings.page_extraction_llm).toBe(llm);

    await agent.close();
  });

  it('auto-adds go_to_url initial action when task contains a single navigable URL', async () => {
    const agent = new Agent({
      task: 'Open https://example.com and verify the page title.',
      llm: createLlm(),
    });

    expect(agent.initial_actions).toHaveLength(1);
    expect(agent.initial_url).toBe('https://example.com');
    expect(agent.initial_actions?.[0]).toEqual({
      go_to_url: {
        url: 'https://example.com',
        new_tab: false,
      },
    });

    await agent.close();
  });

  it('does not auto-open URL when multiple URLs are present in task text', async () => {
    const agent = new Agent({
      task: 'Compare https://example.com with https://example.org and summarize.',
      llm: createLlm(),
    });

    expect(agent.initial_url).toBeNull();
    expect(agent.initial_actions).toBeNull();

    await agent.close();
  });

  it('respects directly_open_url=false and skips URL auto-navigation', async () => {
    const agent = new Agent({
      task: 'Open https://example.com and verify the page title.',
      llm: createLlm(),
      directly_open_url: false,
    });

    expect(agent.initial_url).toBeNull();
    expect(agent.initial_actions).toBeNull();

    await agent.close();
  });

  it('ignores file-like URLs for automatic navigation', async () => {
    const agent = new Agent({
      task: 'Read data from https://example.com/report.pdf and summarize it.',
      llm: createLlm(),
    });

    expect(agent.initial_url).toBeNull();
    expect(agent.initial_actions).toBeNull();

    await agent.close();
  });

  it('enhances task text with structured output schema when provided', async () => {
    const outputSchema = {
      name: 'ResultSchema',
      parse: (input: string) => JSON.parse(input),
      model_json_schema: () => ({
        type: 'object',
        properties: {
          answer: { type: 'string' },
        },
      }),
    };

    const agent = new Agent({
      task: 'Extract the answer from the page',
      llm: createLlm(),
      output_model_schema: outputSchema as any,
    });

    expect(agent.task).toContain('Expected output format: ResultSchema');
    expect(agent.task).toContain('"answer"');

    await agent.close();
  });

  it('clears timeout handles when timed execution rejects early', async () => {
    const agent = new Agent({
      task: 'test timeout cleanup',
      llm: createLlm(),
    });

    const clearSpy = vi.spyOn(global, 'clearTimeout');
    await expect(
      (agent as any)._executeWithTimeout(Promise.reject(new Error('boom')), 5)
    ).rejects.toThrow('boom');
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();

    await agent.close();
  });

  it('throws when sensitive_data is used without allowed_domains lock-down', async () => {
    const agent = new Agent({
      task: 'test allowed domains empty',
      llm: createLlm(),
      browser_session: new BrowserSession({
        browser_profile: new BrowserProfile({
          allowed_domains: [],
        }),
      }),
    });

    (agent as any).sensitive_data = {
      '*.example.com': {
        password: 'secret',
      },
    };

    expect(() => (agent as any)._validateSecuritySettings()).toThrow(
      /allowed_domains/
    );

    await agent.close();
  });

  it('triggers blocking warning delay in TTY mode for unlocked sensitive_data', async () => {
    const agent = new Agent({
      task: 'test tty delay',
      llm: createLlm(),
      allow_insecure_sensitive_data: true,
      browser_session: new BrowserSession({
        browser_profile: new BrowserProfile({
          allowed_domains: [],
        }),
      }),
    });

    (agent as any).sensitive_data = {
      '*.example.com': {
        password: 'secret',
      },
    };

    const originalIsTTY = (process.stdin as any).isTTY;
    const sleepSpy = vi
      .spyOn(agent as any, '_sleep_blocking')
      .mockImplementation(() => {});

    (process.stdin as any).isTTY = true;
    try {
      (agent as any)._validateSecuritySettings();
      expect(sleepSpy).toHaveBeenCalledWith(10_000);
    } finally {
      (process.stdin as any).isTTY = originalIsTTY;
      sleepSpy.mockRestore();
    }

    await agent.close();
  });

  it('fails fast at construction when sensitive_data is provided without domain restrictions', () => {
    expect(
      () =>
        new Agent({
          task: 'constructor strict security',
          llm: createLlm(),
          sensitive_data: {
            password: 'secret',
          },
          browser_session: new BrowserSession({
            browser_profile: new BrowserProfile({
              allowed_domains: [],
            }),
          }),
        })
    ).toThrow(/allowed_domains/);
  });

  it('passes signal through rerun_history to history step execution', async () => {
    const agent = new Agent({
      task: 'test rerun signal propagation',
      llm: createLlm(),
    });
    const executeSpy = vi
      .spyOn(agent as any, '_execute_history_step')
      .mockResolvedValue([
        new ActionResult({ extracted_content: 'replayed step' }),
      ]);
    const signalController = new AbortController();
    const history = {
      history: [
        {
          model_output: {
            current_state: { next_goal: 'Replay action' },
            action: [{}],
          },
        },
      ],
    } as any;

    const result = await agent.rerun_history(history, {
      signal: signalController.signal,
    });

    expect(result).toHaveLength(2);
    expect(result[1]?.is_done).toBe(true);
    expect(executeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        model_output: expect.objectContaining({
          current_state: expect.objectContaining({
            next_goal: 'Replay action',
          }),
        }),
      }),
      2,
      signalController.signal,
      false
    );

    await agent.close();
  });

  it('uses saved step_interval and caps it by max_step_interval during rerun_history', async () => {
    const agent = new Agent({
      task: 'test rerun step timing',
      llm: createLlm(),
    });
    const executeSpy = vi
      .spyOn(agent as any, '_execute_history_step')
      .mockResolvedValue([new ActionResult({ extracted_content: 'ok' })]);
    const history = {
      history: [
        {
          model_output: {
            current_state: { next_goal: 'Replay slow step' },
            action: [{}],
          },
          metadata: {
            step_number: 1,
            step_interval: 90,
          },
        },
        {
          model_output: {
            current_state: { next_goal: 'Replay fast step' },
            action: [{}],
          },
          metadata: {
            step_number: 2,
            step_interval: 0.25,
          },
        },
      ],
    } as any;

    const result = await agent.rerun_history(history, {
      max_step_interval: 45,
    });

    expect(result).toHaveLength(3);
    expect(executeSpy).toHaveBeenCalledTimes(2);
    expect(executeSpy.mock.calls[0]?.[1]).toBe(45);
    expect(executeSpy.mock.calls[1]?.[1]).toBe(0.25);

    await agent.close();
  });

  it('aborts rerun_history before replay execution when signal is already aborted', async () => {
    const agent = new Agent({
      task: 'test rerun abort',
      llm: createLlm(),
    });
    const executeSpy = vi.spyOn(agent as any, '_execute_history_step');
    const signalController = new AbortController();
    signalController.abort();
    const history = {
      history: [
        {
          model_output: {
            current_state: { next_goal: 'Replay action' },
            action: [{}],
          },
        },
      ],
    } as any;

    await expect(
      agent.rerun_history(history, { signal: signalController.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(executeSpy).not.toHaveBeenCalled();

    await agent.close();
  });

  it('skips originally failed history steps when skip_failures=true', async () => {
    const agent = new Agent({
      task: 'test rerun skip original failures',
      llm: createLlm(),
    });
    const executeSpy = vi
      .spyOn(agent as any, '_execute_history_step')
      .mockResolvedValue([new ActionResult({ extracted_content: 'should not run' })]);
    const history = {
      history: [
        {
          model_output: {
            current_state: { next_goal: 'Replay action' },
            action: [{}],
          },
          metadata: {
            step_number: 1,
          },
          result: [new ActionResult({ error: 'element not found in previous run' })],
        },
      ],
    } as any;

    const results = await agent.rerun_history(history, {
      skip_failures: true,
    });

    expect(executeSpy).not.toHaveBeenCalled();
    expect(results).toHaveLength(2);
    expect(results[0]?.error).toContain('Skipped - original step had error');

    await agent.close();
  });

  it('uses exponential backoff delays for rerun retries', async () => {
    const agent = new Agent({
      task: 'test rerun retry backoff',
      llm: createLlm(),
    });
    const executeSpy = vi
      .spyOn(agent as any, '_execute_history_step')
      .mockRejectedValueOnce(new Error('first failure'))
      .mockRejectedValueOnce(new Error('second failure'))
      .mockResolvedValue([new ActionResult({ extracted_content: 'ok' })]);
    const sleepSpy = vi.spyOn(agent as any, '_sleep').mockResolvedValue(undefined);

    const history = {
      history: [
        {
          model_output: {
            current_state: { next_goal: 'Replay action with retries' },
            action: [{}],
          },
        },
      ],
    } as any;

    const results = await agent.rerun_history(history, {
      max_retries: 3,
    });

    expect(executeSpy).toHaveBeenCalledTimes(3);
    expect(results).toHaveLength(2);
    const retryDelays = sleepSpy.mock.calls.map((call) => call[0]);
    expect(retryDelays).toEqual([5, 10]);

    await agent.close();
  });

  it('skips redundant retry steps when previous equivalent step already succeeded', async () => {
    const agent = new Agent({
      task: 'test rerun redundant retry skip',
      llm: createLlm(),
    });
    const executeSpy = vi
      .spyOn(agent as any, '_execute_history_step')
      .mockResolvedValue([new ActionResult({ extracted_content: 'clicked' })]);

    const clickAction = {
      get_index: () => 7,
      model_dump: () => ({ click: { index: 7 } }),
    };

    const history = {
      history: [
        {
          model_output: {
            current_state: { next_goal: 'Open menu' },
            action: [clickAction],
          },
          state: {
            interacted_element: [
              {
                tag_name: 'button',
                xpath: '/html/body/button[1]',
                attributes: { 'aria-label': 'Open menu' },
              },
            ],
          },
          result: [],
        },
        {
          model_output: {
            current_state: { next_goal: 'Retry open menu' },
            action: [clickAction],
          },
          state: {
            interacted_element: [
              {
                tag_name: 'button',
                xpath: '/html/body/button[1]',
                attributes: { 'aria-label': 'Open menu' },
              },
            ],
          },
          result: [],
        },
      ],
    } as any;

    const results = await agent.rerun_history(history, {
      max_retries: 1,
    });

    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(3);
    expect(results[1]?.extracted_content).toContain(
      'Skipped - redundant retry'
    );

    await agent.close();
  });

  it('forwards wait_for_elements option to history step execution', async () => {
    const agent = new Agent({
      task: 'test wait_for_elements forwarding',
      llm: createLlm(),
    });
    const executeSpy = vi
      .spyOn(agent as any, '_execute_history_step')
      .mockResolvedValue([new ActionResult({ extracted_content: 'ok' })]);
    const history = {
      history: [
        {
          model_output: {
            current_state: { next_goal: 'Replay action' },
            action: [{}],
          },
        },
      ],
    } as any;

    await agent.rerun_history(history, {
      wait_for_elements: true,
    });

    expect(executeSpy.mock.calls[0]?.[3]).toBe(true);

    await agent.close();
  });

  it('forwards ai_step_llm option to history step execution', async () => {
    const agent = new Agent({
      task: 'test ai_step_llm forwarding',
      llm: createLlm(),
    });
    const executeSpy = vi
      .spyOn(agent as any, '_execute_history_step')
      .mockResolvedValue([new ActionResult({ extracted_content: 'ok' })]);
    const aiStepLlm = createLlm('gpt-ai-step', 'openai');
    const history = {
      history: [
        {
          model_output: {
            current_state: { next_goal: 'Replay action' },
            action: [{}],
          },
        },
      ],
    } as any;

    await agent.rerun_history(history, {
      ai_step_llm: aiStepLlm,
    });

    expect(executeSpy.mock.calls[0]?.[4]).toBe(aiStepLlm);

    await agent.close();
  });

  it('executes extract actions via AI step during history replay', async () => {
    const agent = new Agent({
      task: 'test extract ai-step replay',
      llm: createLlm(),
    });

    vi.spyOn(agent.browser_session as any, 'get_browser_state_with_recovery')
      .mockResolvedValue({
        element_tree: {
          clickable_elements_to_string: () => '',
        },
        selector_map: {},
      } as any);
    const multiActSpy = vi
      .spyOn(agent, 'multi_act')
      .mockResolvedValue([
        new ActionResult({ extracted_content: 'clicked menu button' }),
      ]);
    const aiStepSpy = vi
      .spyOn(agent as any, '_execute_ai_step')
      .mockResolvedValue(
        new ActionResult({ extracted_content: 'ai extracted content' })
      );
    vi.spyOn(agent as any, '_sleep').mockResolvedValue(undefined);

    const clickAction = {
      get_index: () => 3,
      model_dump: () => ({ click: { index: 3 } }),
    };
    const extractAction = {
      get_index: () => null,
      model_dump: () => ({
        extract_structured_data: { query: 'Find pricing', extract_links: true },
      }),
    };

    const results = await (agent as any)._execute_history_step(
      {
        model_output: {
          action: [clickAction, extractAction],
        },
        state: {
          interacted_element: [null, null],
        },
      },
      0,
      null,
      false,
      createLlm('gpt-ai-step', 'openai')
    );

    expect(multiActSpy).toHaveBeenCalledTimes(1);
    expect(multiActSpy.mock.calls[0]?.[0]).toEqual([{ click: { index: 3 } }]);
    expect(aiStepSpy).toHaveBeenCalledWith(
      'Find pricing',
      false,
      true,
      expect.anything(),
      null
    );
    expect(results.map((result: ActionResult) => result.extracted_content)).toEqual(
      ['clicked menu button', 'ai extracted content']
    );

    await agent.close();
  });

  it('waits step delay before executing replayed actions', async () => {
    const agent = new Agent({
      task: 'test replay delay ordering',
      llm: createLlm(),
    });

    vi.spyOn(agent.browser_session as any, 'get_browser_state_with_recovery')
      .mockResolvedValue({
        element_tree: {
          clickable_elements_to_string: () => '',
        },
        selector_map: {},
      } as any);
    const sleepSpy = vi
      .spyOn(agent as any, '_sleep')
      .mockResolvedValue(undefined);
    const multiActSpy = vi
      .spyOn(agent, 'multi_act')
      .mockResolvedValue([new ActionResult({ extracted_content: 'done' })]);

    const action = {
      get_index: () => null,
      model_dump: () => ({ done: { text: 'ok', success: true } }),
    };

    await (agent as any)._execute_history_step(
      {
        model_output: { action: [action] },
        state: { interacted_element: [null] },
      },
      0.75,
      null,
      false,
      null
    );

    expect(sleepSpy).toHaveBeenCalledWith(0.75, null);
    const sleepOrder = sleepSpy.mock.invocationCallOrder[0] ?? 0;
    const multiActOrder = multiActSpy.mock.invocationCallOrder[0] ?? 0;
    expect(sleepOrder).toBeGreaterThan(0);
    expect(multiActOrder).toBeGreaterThan(0);
    expect(sleepOrder).toBeLessThan(multiActOrder);

    await agent.close();
  });

  it('wait_for_elements skips minimum-element wait for non-element actions', async () => {
    const agent = new Agent({
      task: 'test conditional wait - skip',
      llm: createLlm(),
    });

    const waitSpy = vi
      .spyOn(agent as any, '_waitForMinimumElements')
      .mockResolvedValue(null);
    vi.spyOn(agent.browser_session as any, 'get_browser_state_with_recovery')
      .mockResolvedValue({
        element_tree: {
          clickable_elements_to_string: () => '',
        },
        selector_map: {},
      } as any);
    vi.spyOn(agent, 'multi_act').mockResolvedValue([
      new ActionResult({ extracted_content: 'done' }),
    ]);
    vi.spyOn(agent as any, '_sleep').mockResolvedValue(undefined);

    await (agent as any)._execute_history_step(
      {
        model_output: {
          action: [
            {
              get_index: () => null,
              model_dump: () => ({ done: { text: 'ok', success: true } }),
            },
          ],
        },
        state: { interacted_element: [null] },
      },
      0,
      null,
      true,
      null
    );

    expect(waitSpy).not.toHaveBeenCalled();

    await agent.close();
  });

  it('wait_for_elements waits for element-targeting actions with history element', async () => {
    const agent = new Agent({
      task: 'test conditional wait - use',
      llm: createLlm(),
    });

    const liveNode = new DOMElementNode(
      true,
      null,
      'button',
      '/html/body/button[1]',
      { id: 'cta' },
      []
    );
    liveNode.highlight_index = 0;

    const waitedState = {
      element_tree: {
        clickable_elements_to_string: () => '',
      },
      selector_map: {
        0: liveNode,
      },
    } as any;
    const waitSpy = vi
      .spyOn(agent as any, '_waitForMinimumElements')
      .mockResolvedValue(waitedState);
    const stateSpy = vi.spyOn(
      agent.browser_session as any,
      'get_browser_state_with_recovery'
    );
    vi.spyOn(agent as any, '_sleep').mockResolvedValue(undefined);
    vi.spyOn(agent, 'multi_act').mockResolvedValue([
      new ActionResult({ extracted_content: 'clicked' }),
    ]);

    const clickAction = {
      _index: 0,
      get_index() {
        return this._index;
      },
      set_index(index: number) {
        this._index = index;
      },
      model_dump() {
        return { click: { index: this._index } };
      },
    };

    await (agent as any)._execute_history_step(
      {
        model_output: { action: [clickAction] },
        state: {
          interacted_element: [
            {
              tag_name: 'button',
              xpath: '/html/body/button[1]',
              attributes: { id: 'cta' },
            },
          ],
        },
      },
      0,
      null,
      true,
      null
    );

    expect(waitSpy).toHaveBeenCalledWith(1, 15, 1, null);
    expect(stateSpy).not.toHaveBeenCalled();

    await agent.close();
  });

  it('reopens dropdown menu once when rerun cannot match a menu item element', async () => {
    const agent = new Agent({
      task: 'test rerun dropdown reopen',
      llm: createLlm(),
    });

    const executeSpy = vi
      .spyOn(agent as any, '_execute_history_step')
      .mockResolvedValueOnce([new ActionResult({ extracted_content: 'opened' })])
      .mockRejectedValueOnce(
        new Error('Could not find matching element for action 0')
      )
      .mockResolvedValueOnce([
        new ActionResult({ extracted_content: 'menu reopened' }),
      ])
      .mockResolvedValueOnce([
        new ActionResult({ extracted_content: 'menu item clicked' }),
      ]);
    const sleepSpy = vi.spyOn(agent as any, '_sleep').mockResolvedValue(undefined);

    const clickAction = {
      get_index: () => 1,
      model_dump: () => ({ click: { index: 1 } }),
    };

    const history = {
      history: [
        {
          model_output: {
            current_state: { next_goal: 'Open menu' },
            action: [clickAction],
          },
          state: {
            interacted_element: [
              {
                tag_name: 'button',
                xpath: '/html/body/button[1]',
                attributes: {
                  role: 'button',
                  'aria-haspopup': 'true',
                  'aria-expanded': 'false',
                },
              },
            ],
          },
          result: [],
        },
        {
          model_output: {
            current_state: { next_goal: 'Click menu item' },
            action: [clickAction],
          },
          state: {
            interacted_element: [
              {
                tag_name: 'div',
                xpath: '/html/body/div[2]',
                attributes: {
                  role: 'menuitem',
                  class: 'dropdown-menu-item',
                },
                ax_name: 'Settings',
              },
            ],
          },
          result: [],
        },
      ],
    } as any;

    const results = await agent.rerun_history(history, {
      max_retries: 2,
    });

    expect(executeSpy).toHaveBeenCalledTimes(4);
    expect(results).toHaveLength(3);
    expect(results[1]?.extracted_content).toBe('menu item clicked');
    expect(sleepSpy).toHaveBeenCalledWith(0.3, null);

    await agent.close();
  });

  it('matches history elements with ax_name fallback when hash and xpath differ', async () => {
    const agent = new Agent({
      task: 'test ax_name fallback',
      llm: createLlm(),
    });

    const action = {
      _index: 4,
      get_index() {
        return this._index;
      },
      set_index(index: number) {
        this._index = index;
      },
      model_dump() {
        return { click: { index: this._index } };
      },
    };

    const updatedAction = await (agent as any)._update_action_indices(
      {
        tag_name: 'div',
        xpath: '/html/body/div[4]',
        attributes: {},
        ax_name: 'Open Settings',
      },
      action,
      {
        selector_map: {
          11: {
            tag_name: 'div',
            xpath: '/html/body/div[99]',
            attributes: { 'aria-label': 'Open Settings' },
            highlight_index: 11,
            get_all_text_till_next_clickable_element: () => '',
            children: [],
          },
        },
      }
    );

    expect(updatedAction).toBe(action);
    expect(action._index).toBe(11);

    await agent.close();
  });

  it('matches history elements with stable_hash fallback when classes drift', async () => {
    const agent = new Agent({
      task: 'test stable hash fallback',
      llm: createLlm(),
    });

    const historicalNode = new DOMElementNode(
      true,
      null,
      'button',
      '/html/body/button[1]',
      { class: 'btn focus', id: 'settings' },
      []
    );
    const liveNode = new DOMElementNode(
      true,
      null,
      'button',
      '/html/body/button[9]',
      { class: 'btn active', id: 'settings' },
      []
    );
    liveNode.highlight_index = 12;
    const stableHash = HistoryTreeProcessor.compute_stable_hash(historicalNode);

    const action = {
      _index: 4,
      get_index() {
        return this._index;
      },
      set_index(index: number) {
        this._index = index;
      },
      model_dump() {
        return { click: { index: this._index } };
      },
    };

    const updatedAction = await (agent as any)._update_action_indices(
      {
        tag_name: 'button',
        xpath: '/html/body/button[1]',
        attributes: { class: 'btn focus', id: 'settings' },
        element_hash: 'old-hash',
        stable_hash: stableHash,
      },
      action,
      {
        selector_map: {
          12: liveNode,
        },
      }
    );

    expect(updatedAction).toBe(action);
    expect(action._index).toBe(12);

    await agent.close();
  });
});
