import { describe, expect, it, vi } from 'vitest';
import { create_task_with_error_handling } from '../src/utils.js';

describe('create_task_with_error_handling alignment', () => {
  it('suppresses and logs background task errors when configured', async () => {
    const logger = {
      error: vi.fn(),
      warning: vi.fn(),
    } as any;

    const result = await create_task_with_error_handling(
      Promise.reject(new Error('boom')),
      {
        name: 'log_token_usage',
        logger_instance: logger,
        suppress_exceptions: true,
      }
    );

    expect(result).toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('log_token_usage')
    );
    expect(logger.warning).not.toHaveBeenCalled();
  });

  it('propagates errors when suppression is disabled', async () => {
    const logger = {
      error: vi.fn(),
      warning: vi.fn(),
    } as any;

    await expect(
      create_task_with_error_handling(Promise.reject(new Error('failed')), {
        name: 'critical_task',
        logger_instance: logger,
        suppress_exceptions: false,
      })
    ).rejects.toThrow('failed');

    expect(logger.warning).toHaveBeenCalledWith(
      expect.stringContaining('critical_task')
    );
    expect(logger.error).not.toHaveBeenCalled();
  });
});
