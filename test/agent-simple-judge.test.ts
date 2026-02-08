import { describe, expect, it, vi } from 'vitest';
import type { BaseChatModel } from '../src/llm/base.js';
import { Agent } from '../src/agent/service.js';
import { BrowserStateHistory } from '../src/browser/views.js';
import { ActionResult, AgentHistory } from '../src/agent/views.js';

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
          new BrowserStateHistory('https://example.com', 'Example', [], [], null),
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
          new BrowserStateHistory('https://example.com', 'Example', [], [], null),
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
