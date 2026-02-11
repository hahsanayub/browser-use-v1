import { describe, expect, it } from 'vitest';
import { AgentError } from '../src/agent/views.js';

describe('AgentError.format_error alignment', () => {
  it('returns structured-output guidance for invalid AgentOutput payloads', () => {
    const error = new Error(
      'LLM response missing required fields: action\nExpected format: AgentOutput'
    );

    const formatted = AgentError.format_error(error);
    expect(formatted).toContain('LLM response missing required fields: action');
    expect(formatted).toContain(
      'The previous response had an invalid output structure.'
    );
    expect(formatted).not.toContain('Expected format: AgentOutput');
  });

  it('includes full stacktrace for structured-output errors when include_trace is true', () => {
    const error = new Error(
      'Expected format: AgentOutput\nValidation details follow'
    );
    error.stack = 'Error: Expected format: AgentOutput\n    at test:1:1';

    const formatted = AgentError.format_error(error, true);
    expect(formatted).toContain('Expected format: AgentOutput');
    expect(formatted).toContain('Full stacktrace:');
    expect(formatted).toContain('at test:1:1');
  });
});
