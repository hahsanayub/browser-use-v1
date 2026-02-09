import { describe, expect, it } from 'vitest';
import { sanitize_surrogates } from '../src/utils.js';

describe('sanitize_surrogates alignment', () => {
  it('removes unpaired surrogate code units while preserving normal text', () => {
    // eslint-disable-next-line no-control-regex
    const input = `a\uD800b\uDC00c`;
    expect(sanitize_surrogates(input)).toBe('abc');
  });

  it('preserves valid surrogate pairs such as emoji', () => {
    const emoji = '😀';
    const input = `prefix-${emoji}-suffix`;
    expect(sanitize_surrogates(input)).toBe(input);
  });
});
