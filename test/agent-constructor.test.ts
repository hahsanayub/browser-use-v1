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
});
