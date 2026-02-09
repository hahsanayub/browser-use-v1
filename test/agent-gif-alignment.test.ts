import { describe, expect, it } from 'vitest';
import { PLACEHOLDER_4PX_SCREENSHOT } from '../src/browser/views.js';
import { is_valid_gif_screenshot_candidate } from '../src/agent/gif.js';

describe('agent gif alignment', () => {
  it('rejects placeholder screenshots', () => {
    expect(
      is_valid_gif_screenshot_candidate(
        PLACEHOLDER_4PX_SCREENSHOT,
        'https://example.com'
      )
    ).toBe(false);
  });

  it('rejects screenshots captured on new-tab pages', () => {
    expect(
      is_valid_gif_screenshot_candidate('base64-image', 'chrome://newtab/')
    ).toBe(false);
    expect(
      is_valid_gif_screenshot_candidate('base64-image', 'about:blank')
    ).toBe(false);
  });

  it('accepts non-placeholder screenshots on regular pages', () => {
    expect(
      is_valid_gif_screenshot_candidate('base64-image', 'https://example.com')
    ).toBe(true);
  });
});
