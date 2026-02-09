import { describe, expect, it } from 'vitest';
import { HistoryItem } from '../src/agent/message-manager/views.js';

describe('HistoryItem alignment', () => {
  it('formats regular history entries with python c011 step wrapper semantics', () => {
    const item = new HistoryItem(
      3,
      'Done',
      'Remember this',
      'Next action',
      'Result\nok'
    );

    expect(item.to_string()).toBe(`<step>
Done
Remember this
Next action
Result
ok`);
  });

  it('returns system messages as raw text', () => {
    const item = new HistoryItem(
      null,
      null,
      null,
      null,
      null,
      null,
      'Agent initialized'
    );

    expect(item.to_string()).toBe('Agent initialized');
  });

  it('formats errors in step wrapper without closing tag', () => {
    const item = new HistoryItem(7, null, null, null, null, 'failed to parse');

    expect(item.to_string()).toBe(`<step>
failed to parse`);
  });
});
