import { describe, expect, it, vi } from 'vitest';
import type { BaseChatModel } from '../src/llm/base.js';
import { Agent } from '../src/agent/service.js';
import { ActionResult } from '../src/agent/views.js';

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

const createAgent = () =>
  new Agent({
    task: 'test task',
    llm: createLlm(),
  });

describe('Agent post process alignment', () => {
  it('increments consecutive failures only for single-action error results', async () => {
    const agent = createAgent();
    try {
      (agent as any)._check_and_update_downloads = vi.fn(async () => {});
      (agent as any).browser_session = {};
      agent.state.last_result = [new ActionResult({ error: 'boom' })];
      agent.state.consecutive_failures = 1;

      await (agent as any)._post_process();

      expect(agent.state.consecutive_failures).toBe(2);
    } finally {
      await agent.close();
    }
  });

  it('resets consecutive failures after a non-error post-process step', async () => {
    const agent = createAgent();
    try {
      (agent as any)._check_and_update_downloads = vi.fn(async () => {});
      (agent as any).browser_session = {};
      agent.state.last_result = [new ActionResult({ extracted_content: 'ok' })];
      agent.state.consecutive_failures = 2;

      await (agent as any)._post_process();

      expect(agent.state.consecutive_failures).toBe(0);
    } finally {
      await agent.close();
    }
  });

  it('does not increment failure counter for multi-action results', async () => {
    const agent = createAgent();
    try {
      (agent as any)._check_and_update_downloads = vi.fn(async () => {});
      (agent as any).browser_session = {};
      agent.state.last_result = [
        new ActionResult({ error: 'first failed action' }),
        new ActionResult({ error: 'second failed action' }),
      ];
      agent.state.consecutive_failures = 2;

      await (agent as any)._post_process();

      expect(agent.state.consecutive_failures).toBe(0);
    } finally {
      await agent.close();
    }
  });
});
