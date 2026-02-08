import { describe, expect, it, vi } from 'vitest';
import type { BaseChatModel } from '../src/llm/base.js';
import { Agent } from '../src/agent/service.js';
import { AgentOutput, PlanItem } from '../src/agent/views.js';

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

describe('Agent planning alignment', () => {
  it('creates plan state from model plan_update', async () => {
    const agent = new Agent({ task: 'test task', llm: createLlm() });
    try {
      (agent as any)._update_plan_from_model_output(
        new AgentOutput({
          plan_update: ['Open results page', 'Extract first 5 rows'],
          action: [],
        })
      );

      expect(agent.state.plan?.map((item) => item.text)).toEqual([
        'Open results page',
        'Extract first 5 rows',
      ]);
      expect(agent.state.plan?.[0].status).toBe('current');
      expect(agent.state.current_plan_item_index).toBe(0);
      expect(agent.state.plan_generation_step).toBe(agent.state.n_steps);
    } finally {
      await agent.close();
    }
  });

  it('advances current plan item and marks prior steps as done', async () => {
    const agent = new Agent({ task: 'test task', llm: createLlm() });
    try {
      agent.state.plan = [
        new PlanItem({ text: 'step 0', status: 'current' }),
        new PlanItem({ text: 'step 1', status: 'pending' }),
        new PlanItem({ text: 'step 2', status: 'pending' }),
      ];
      agent.state.current_plan_item_index = 0;

      (agent as any)._update_plan_from_model_output(
        new AgentOutput({
          current_plan_item: 2,
          action: [],
        })
      );

      expect(agent.state.plan?.[0].status).toBe('done');
      expect(agent.state.plan?.[1].status).toBe('done');
      expect(agent.state.plan?.[2].status).toBe('current');
      expect(agent.state.current_plan_item_index).toBe(2);
    } finally {
      await agent.close();
    }
  });

  it('renders plan description markers for prompt injection', async () => {
    const agent = new Agent({ task: 'test task', llm: createLlm() });
    try {
      agent.state.plan = [
        new PlanItem({ text: 'done step', status: 'done' }),
        new PlanItem({ text: 'current step', status: 'current' }),
        new PlanItem({ text: 'pending step', status: 'pending' }),
      ];

      const rendered = (agent as any)._render_plan_description();
      expect(rendered).toContain('[x] 0: done step');
      expect(rendered).toContain('[>] 1: current step');
      expect(rendered).toContain('[ ] 2: pending step');
    } finally {
      await agent.close();
    }
  });

  it('injects replan nudge after repeated failures with existing plan', async () => {
    const agent = new Agent({
      task: 'test task',
      llm: createLlm(),
      planning_replan_on_stall: 2,
    });
    try {
      agent.state.plan = [
        new PlanItem({ text: 'retry search', status: 'current' }),
      ];
      agent.state.consecutive_failures = 2;

      (agent as any)._inject_replan_nudge();
      const messages = getContextMessageTexts(agent);

      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('REPLAN SUGGESTED');
      expect(messages[0]).toContain('plan_update');
    } finally {
      await agent.close();
    }
  });

  it('injects exploration nudge when running without a plan', async () => {
    const agent = new Agent({
      task: 'test task',
      llm: createLlm(),
      planning_exploration_limit: 3,
    });
    try {
      agent.state.plan = null;
      agent.state.n_steps = 3;

      (agent as any)._inject_exploration_nudge();
      const messages = getContextMessageTexts(agent);

      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('PLANNING NUDGE');
      expect(messages[0]).toContain('plan_update');
    } finally {
      await agent.close();
    }
  });

  it('disables planning automatically in flash mode', async () => {
    const agent = new Agent({
      task: 'test task',
      llm: createLlm(),
      flash_mode: true,
      enable_planning: true,
    });
    try {
      expect(agent.settings.enable_planning).toBe(false);
    } finally {
      await agent.close();
    }
  });
});
