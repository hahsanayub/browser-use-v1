import { afterEach, describe, expect, it, vi } from 'vitest';
import { check_latest_browser_use_version } from '../src/utils.js';

const originalFetch = globalThis.fetch;

describe('check_latest_browser_use_version alignment', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns version from npm registry payload', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ version: '9.9.9' }),
    }));
    globalThis.fetch = fetchMock as any;

    const latest = await check_latest_browser_use_version();

    expect(latest).toBe('9.9.9');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://registry.npmjs.org/browser-use/latest',
      expect.objectContaining({
        method: 'GET',
      })
    );
  });

  it('returns null when npm registry request fails', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network failed');
    }) as any;

    const latest = await check_latest_browser_use_version();
    expect(latest).toBeNull();
  });

  it('returns null when payload does not contain a valid version', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ version: '' }),
    })) as any;

    const latest = await check_latest_browser_use_version();
    expect(latest).toBeNull();
  });
});
