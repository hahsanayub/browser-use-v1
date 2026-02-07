import { describe, expect, it, vi } from 'vitest';
import type { BaseChatModel } from '../src/llm/base.js';
import { Agent } from '../src/agent/service.js';
import { BrowserSession } from '../src/browser/session.js';
import { BrowserProfile } from '../src/browser/profile.js';

const createLlm = (): BaseChatModel =>
  ({
    model: 'gpt-test',
    get provider() {
      return 'test';
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
    expect((agent.browser_session as BrowserSession).get_attached_agent_id()).toBe(
      agent.id
    );

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

  it('defaults page_extraction_llm to the main llm when omitted', async () => {
    const llm = createLlm();
    const agent = new Agent({
      task: 'test extraction llm default',
      llm,
    });

    expect(agent.settings.page_extraction_llm).toBe(llm);

    await agent.close();
  });

  it('treats allowed_domains=[] as unlocked when sensitive_data is used', async () => {
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

    const errorSpy = vi.spyOn(agent.logger, 'error');
    (agent as any)._validateSecuritySettings();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('not locked down')
    );

    await agent.close();
  });

  it('triggers blocking warning delay in TTY mode for unlocked sensitive_data', async () => {
    const agent = new Agent({
      task: 'test tty delay',
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
});
