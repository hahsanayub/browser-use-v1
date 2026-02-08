import { describe, expect, it, vi } from 'vitest';
import type { BaseChatModel } from '../src/llm/base.js';
import { Agent } from '../src/agent/service.js';
import { AgentStepInfo } from '../src/agent/views.js';

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

describe('Agent budget warning', () => {
  it('injects budget warning at 75% threshold', async () => {
    const agent = new Agent({ task: 'test task', llm: createLlm() });
    try {
      (agent as any)._inject_budget_warning(new AgentStepInfo(74, 100));
      const messages = getContextMessageTexts(agent);

      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('BUDGET WARNING');
      expect(messages[0]).toContain('75/100');
      expect(messages[0]).toContain('25 steps remaining');
    } finally {
      await agent.close();
    }
  });

  it('does not inject budget warning below threshold', async () => {
    const agent = new Agent({ task: 'test task', llm: createLlm() });
    try {
      (agent as any)._inject_budget_warning(new AgentStepInfo(73, 100));
      expect(getContextMessageTexts(agent)).toHaveLength(0);
    } finally {
      await agent.close();
    }
  });

  it('does not inject budget warning on final step', async () => {
    const agent = new Agent({ task: 'test task', llm: createLlm() });
    try {
      (agent as any)._inject_budget_warning(new AgentStepInfo(99, 100));
      expect(getContextMessageTexts(agent)).toHaveLength(0);
    } finally {
      await agent.close();
    }
  });
});
