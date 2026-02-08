import { describe, expect, it, vi } from 'vitest';
import type { BaseChatModel } from '../src/llm/base.js';
import { Agent } from '../src/agent/service.js';
import { ActionResult } from '../src/agent/views.js';
import { BrowserSession } from '../src/browser/session.js';
import { BrowserProfile } from '../src/browser/profile.js';

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

    expect(result).toHaveLength(1);
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

    expect(result).toHaveLength(2);
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
    expect(results).toHaveLength(1);
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
    expect(results).toHaveLength(1);
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
    expect(results).toHaveLength(2);
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
});
