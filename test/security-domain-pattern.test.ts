import { describe, expect, it } from 'vitest';
import { BrowserSession } from '../src/browser/session.js';
import { BrowserProfile } from '../src/browser/profile.js';

describe('Allowed Domains Security', () => {
  it('blocks URLs that only contain allowed domains in query strings', () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['example.com'],
      }),
    });

    const isAllowed = (session as any)._is_url_allowed(
      'https://evil.com/?next=https://example.com'
    );
    expect(isAllowed).toBe(false);
  });

  it('defaults to https-only matching when no scheme is specified', () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['example.com'],
      }),
    });

    expect((session as any)._is_url_allowed('https://example.com')).toBe(true);
    expect((session as any)._is_url_allowed('http://example.com')).toBe(false);
  });

  it('supports explicit scheme wildcard patterns', () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['http*://example.com'],
      }),
    });

    expect((session as any)._is_url_allowed('https://example.com')).toBe(true);
    expect((session as any)._is_url_allowed('http://example.com')).toBe(true);
  });
});
