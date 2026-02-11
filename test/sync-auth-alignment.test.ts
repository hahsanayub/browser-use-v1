import fs from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceAuthClient } from '../src/sync/auth.js';

describe('DeviceAuthClient alignment', () => {
  const originalConfigDir = process.env.BROWSER_USE_CONFIG_DIR;
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'browser-use-sync-auth-'));
    process.env.BROWSER_USE_CONFIG_DIR = tempDir;
  });

  afterEach(async () => {
    if (originalConfigDir === undefined) {
      delete process.env.BROWSER_USE_CONFIG_DIR;
    } else {
      process.env.BROWSER_USE_CONFIG_DIR = originalConfigDir;
    }
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('sends empty agent_session_id when none is provided', async () => {
    const post = vi.fn(
      async (_url?: string, _form?: URLSearchParams) => ({ data: {} })
    );
    const client = new DeviceAuthClient('https://api.example.com', {
      post,
    } as any);

    await client.start_device_authorization(null);

    expect(post).toHaveBeenCalled();
    const form = post.mock.calls[0]?.[1];
    expect(form).toBeInstanceOf(URLSearchParams);
    const params = form as URLSearchParams;
    expect(params.get('agent_session_id')).toBe('');
  });

  it('clear_auth removes cloud auth file instead of writing empty values', async () => {
    const authFile = path.join(tempDir, 'cloud_auth.json');
    await writeFile(
      authFile,
      JSON.stringify({
        api_token: 'token',
        user_id: 'user',
        authorized_at: '2026-01-01T00:00:00.000Z',
      }),
      'utf-8'
    );
    const client = new DeviceAuthClient('https://api.example.com', {
      post: vi.fn(async () => ({ data: {} })),
    } as any);

    expect(fs.existsSync(authFile)).toBe(true);
    client.clear_auth();
    expect(fs.existsSync(authFile)).toBe(false);
  });
});
