import { describe, expect, it, vi } from 'vitest';
import { log_response } from '../src/agent/service.js';
import { AgentOutput } from '../src/agent/views.js';

describe('log_response alignment', () => {
  it('logs thinking at debug level and uses c011 success formatting', () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
    } as any;

    const output = new AgentOutput({
      thinking: 'Analyze page',
      evaluation_previous_goal: 'successfully clicked login',
      memory: 'Login button exists',
      next_goal: 'Fill credentials',
      action: [],
    });

    log_response(output, undefined, logger);

    expect(logger.debug).toHaveBeenCalledWith('💡 Thinking:\nAnalyze page');
    expect(logger.info).toHaveBeenCalledWith(
      '  \x1b[32m👍 Eval: successfully clicked login\x1b[0m'
    );
    expect(logger.info).toHaveBeenCalledWith(
      '  🧠 Memory: Login button exists'
    );
    expect(logger.info).toHaveBeenCalledWith(
      '  \x1b[34m🎯 Next goal: Fill credentials\x1b[0m'
    );
  });

  it('uses c011 failure formatting for evaluation logs', () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
    } as any;

    const output = new AgentOutput({
      evaluation_previous_goal: 'failure: element not found',
      action: [],
    });

    log_response(output, undefined, logger);

    expect(logger.info).toHaveBeenCalledWith(
      '  \x1b[31m⚠️ Eval: failure: element not found\x1b[0m'
    );
  });

  it('does not emit legacy empty info lines when next_goal is missing', () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
    } as any;

    const output = new AgentOutput({
      action: [],
    });

    log_response(output, undefined, logger);

    expect(logger.debug).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });
});
