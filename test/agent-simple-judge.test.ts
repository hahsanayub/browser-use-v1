import { describe, expect, it, vi } from 'vitest';
import type { BaseChatModel } from '../src/llm/base.js';
import { Agent } from '../src/agent/service.js';
import { BrowserStateHistory } from '../src/browser/views.js';
import { ActionResult, AgentHistory } from '../src/agent/views.js';
import { construct_simple_judge_messages } from '../src/agent/judge.js';

const createLlm = (completion: string) => {
  const ainvoke = vi.fn(async () => ({ completion, usage: null }));
  const llm = {
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
    ainvoke,
  } as unknown as BaseChatModel;

  return { llm, ainvoke };
};

describe('Agent simple judge alignment', () => {
  it('injects current_date into simple judge prompt with c011 wording', () => {
    const messages = construct_simple_judge_messages({
      task: 'Check latest stock close price',
      final_result: 'AAPL closed at 199.10',
      current_date: '2026-02-10',
    });

    const systemPrompt = (messages[0] as any)?.text ?? '';
    expect(systemPrompt).toContain("Today's date is 2026-02-10.");
    expect(systemPrompt).toContain(
      "dates and times close to today's date (2026-02-10) are NOT fabricated"
    );
  });

  it('falls back to no-task/no-response placeholders in simple judge prompts', () => {
    const messages = construct_simple_judge_messages({
      task: '',
      final_result: '',
      current_date: '2026-02-10',
    });

    const userPrompt = (messages[1] as any)?.text ?? '';
    expect(userPrompt).toContain('No task provided');
    expect(userPrompt).toContain('No response provided');
  });

  it('overrides done success when simple judge rejects final response', async () => {
    const { llm, ainvoke } = createLlm(
      '{"is_correct": false, "reason": "Missing required fields"}'
    );
    const agent = new Agent({ task: 'Extract 5 rows as JSON', llm });
    try {
      agent.history.add_item(
        new AgentHistory(
          null,
          [
            new ActionResult({
              is_done: true,
              success: true,
              extracted_content: 'Only extracted 2 rows',
            }),
          ],
          new BrowserStateHistory(
            'https://example.com',
            'Example',
            [],
            [],
            null
          ),
          null
        )
      );

      await (agent as any)._run_simple_judge();

      const finalResult = agent.history.history[0].result[0];
      expect(finalResult.success).toBe(false);
      expect(finalResult.extracted_content).toContain(
        '[Simple judge: Missing required fields]'
      );
      expect(ainvoke).toHaveBeenCalledTimes(1);
    } finally {
      await agent.close();
    }
  });

  it('skips simple judge when final result is not done success', async () => {
    const { llm, ainvoke } = createLlm(
      '{"is_correct": false, "reason": "Should not be used"}'
    );
    const agent = new Agent({ task: 'Extract rows', llm });
    try {
      agent.history.add_item(
        new AgentHistory(
          null,
          [
            new ActionResult({
              is_done: true,
              success: false,
              extracted_content: 'Task failed',
            }),
          ],
          new BrowserStateHistory(
            'https://example.com',
            'Example',
            [],
            [],
            null
          ),
          null
        )
      );

      await (agent as any)._run_simple_judge();

      expect(ainvoke).not.toHaveBeenCalled();
      expect(agent.history.history[0].result[0].success).toBe(false);
    } finally {
      await agent.close();
    }
  });
});
