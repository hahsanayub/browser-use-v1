import { describe, expect, it } from 'vitest';
import { HistoryItem } from '../src/agent/message-manager/views.js';

describe('HistoryItem alignment', () => {
  it('formats regular history entries with python-style labels and step tags', () => {
    const item = new HistoryItem(
      3,
      'Done',
      'Remember this',
      'Next action',
      'Action Results:\nAction 1/1: ok'
    );

    expect(item.to_string()).toBe(`<step_3>
Evaluation of Previous Step: Done
Memory: Remember this
Next Goal: Next action
Action Results:
Action 1/1: ok
</step_3>`);
  });

  it('formats system messages with <sys> wrapper', () => {
    const item = new HistoryItem(
      null,
      null,
      null,
      null,
      null,
      null,
      'Agent initialized'
    );

    expect(item.to_string()).toBe(`<sys>
Agent initialized
</sys>`);
  });

  it('formats errors in step wrappers with closing tag', () => {
    const item = new HistoryItem(7, null, null, null, null, 'failed to parse');

    expect(item.to_string()).toBe(`<step_7>
failed to parse
</step_7>`);
  });
});
