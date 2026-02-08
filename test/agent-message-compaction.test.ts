import { describe, expect, it, vi } from 'vitest';
import type { BaseChatModel } from '../src/llm/base.js';
import { Agent } from '../src/agent/service.js';
import { AgentStepInfo } from '../src/agent/views.js';
import { HistoryItem } from '../src/agent/message-manager/views.js';

const createLlm = (
  completion = 'ok',
  model = 'gpt-test'
): BaseChatModel =>
  ({
    model,
    get provider() {
      return 'test';
    },
    get name() {
      return 'test';
    },
    get model_name() {
      return model;
    },
    ainvoke: vi.fn(async () => ({ completion, usage: null })),
  }) as unknown as BaseChatModel;

describe('Agent message compaction', () => {
  it('compacts history into compacted_memory when thresholds are met', async () => {
    const compactionInvoke = vi.fn(async () => ({
      completion: 'Summary of history',
      usage: null,
    }));
    const compactionLlm = {
      ...createLlm('Summary of history', 'compact-model'),
      ainvoke: compactionInvoke,
    } as BaseChatModel;
    const agent = new Agent({
      task: 'test task',
      llm: createLlm(),
      message_compaction: {
        enabled: true,
        compact_every_n_steps: 1,
        trigger_char_count: 20,
        trigger_token_count: null,
        chars_per_token: 4,
        keep_last_items: 2,
        summary_max_chars: 200,
        include_read_state: false,
        compaction_llm: compactionLlm,
      },
    });

    try {
      agent.state.message_manager_state.agent_history_items.push(
        new HistoryItem(
          1,
          'ok',
          'memory',
          'goal',
          'A'.repeat(120),
          null,
          null
        )
      );

      await (agent as any)._maybe_compact_messages(new AgentStepInfo(2, 20));

      expect(agent.state.message_manager_state.compaction_count).toBe(1);
      expect(agent.state.message_manager_state.compacted_memory).toBe(
        'Summary of history'
      );
      expect(agent.state.message_manager_state.agent_history_items.length).toBe(
        2
      );
      expect((agent as any)._message_manager.agent_history_description).toContain(
        '<compacted_memory>'
      );
      expect(compactionInvoke).toHaveBeenCalledTimes(1);
    } finally {
      await agent.close();
    }
  });

  it('does not compact before configured step cadence', async () => {
    const compactionInvoke = vi.fn(async () => ({
      completion: 'Should not be used',
      usage: null,
    }));
    const compactionLlm = {
      ...createLlm('Should not be used', 'compact-model'),
      ainvoke: compactionInvoke,
    } as BaseChatModel;
    const agent = new Agent({
      task: 'test task',
      llm: createLlm(),
      message_compaction: {
        enabled: true,
        compact_every_n_steps: 5,
        trigger_char_count: 20,
        trigger_token_count: null,
        chars_per_token: 4,
        keep_last_items: 2,
        summary_max_chars: 200,
        include_read_state: false,
        compaction_llm: compactionLlm,
      },
    });

    try {
      agent.state.message_manager_state.agent_history_items.push(
        new HistoryItem(
          1,
          'ok',
          'memory',
          'goal',
          'B'.repeat(120),
          null,
          null
        )
      );

      await (agent as any)._maybe_compact_messages(new AgentStepInfo(2, 20));

      expect(agent.state.message_manager_state.compaction_count).toBe(0);
      expect(agent.state.message_manager_state.compacted_memory).toBeNull();
      expect(compactionInvoke).toHaveBeenCalledTimes(0);
    } finally {
      await agent.close();
    }
  });
});
