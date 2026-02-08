import { describe, expect, it, vi } from 'vitest';
import type { BaseChatModel } from '../src/llm/base.js';
import { Agent } from '../src/agent/service.js';

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

const getContextMessageTexts = (agent: Agent) =>
  agent.state.message_manager_state.history.context_messages
    .map((message: any) =>
      typeof message?.content === 'string' ? message.content : null
    )
    .filter((message): message is string => typeof message === 'string');

describe('Agent final response after failure', () => {
  it('extends failure budget by one when enabled', async () => {
    const agent = new Agent({
      task: 'test task',
      llm: createLlm(),
      max_failures: 3,
      final_response_after_failure: true,
    });

    try {
      expect((agent as any)._max_total_failures()).toBe(4);
    } finally {
      await agent.close();
    }
  });

  it('injects done-only recovery guidance at max_failures', async () => {
    const agent = new Agent({
      task: 'test task',
      llm: createLlm(),
      max_failures: 3,
      final_response_after_failure: true,
    });

    try {
      agent.state.consecutive_failures = 3;
      await (agent as any)._handle_failure_limit_recovery();

      const messages = getContextMessageTexts(agent);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('You failed 3 times');
      expect(messages[0]).toContain('only tool available is the "done" tool');
      expect((agent as any)._enforceDoneOnlyForCurrentStep).toBe(true);
    } finally {
      await agent.close();
    }
  });

  it('does not inject recovery guidance when disabled', async () => {
    const agent = new Agent({
      task: 'test task',
      llm: createLlm(),
      max_failures: 3,
      final_response_after_failure: false,
    });

    try {
      agent.state.consecutive_failures = 3;
      await (agent as any)._handle_failure_limit_recovery();

      expect(getContextMessageTexts(agent)).toHaveLength(0);
      expect((agent as any)._enforceDoneOnlyForCurrentStep).toBe(false);
      expect((agent as any)._max_total_failures()).toBe(3);
    } finally {
      await agent.close();
    }
  });
});
