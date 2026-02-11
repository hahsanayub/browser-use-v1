import { describe, expect, it, vi } from 'vitest';
import {
  BrowserCreatedData,
  SandboxError,
  sandbox,
  SSEEvent,
  SSEEventType,
} from '../src/sandbox/index.js';

describe('sandbox alignment', () => {
  it('parses browser_created SSE events with typed payload', () => {
    const event = SSEEvent.from_json(
      JSON.stringify({
        type: 'browser_created',
        data: {
          session_id: 'session-1',
          live_url: 'https://live.example/session-1',
          status: 'running',
        },
      })
    );

    expect(event.type).toBe(SSEEventType.BROWSER_CREATED);
    expect(event.is_browser_created()).toBe(true);
    expect(event.data).toBeInstanceOf(BrowserCreatedData);
    expect((event.data as BrowserCreatedData).session_id).toBe('session-1');
  });

  it('runs wrapped function locally when remote options are not provided', async () => {
    const wrapped = sandbox()(async (a: number, b: number) => a + b);
    const result = await wrapped(2, 5);
    expect(result).toBe(7);
  });

  it('executes remote sandbox flow and returns result event payload', async () => {
    const onLog = vi.fn();
    const fetchImpl = vi.fn(async (_url?: string, _init?: RequestInit) => {
      return new Response(
        [
          `data: ${JSON.stringify({
            type: 'browser_created',
            data: {
              session_id: 's-1',
              live_url: 'https://live.example/s-1',
              status: 'running',
            },
          })}`,
          `data: ${JSON.stringify({
            type: 'log',
            data: { message: 'step started', level: 'info' },
          })}`,
          `data: ${JSON.stringify({
            type: 'result',
            data: {
              execution_response: { success: true, result: 'remote-ok' },
            },
          })}`,
        ].join('\n'),
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }
      );
    });

    const wrapped = sandbox({
      api_key: 'sandbox-test-key',
      server_url: 'https://sandbox.example/stream',
      fetch_impl: fetchImpl as unknown as typeof fetch,
      on_log: onLog,
      quiet: true,
    })(async (_name: string) => 'local-result');

    const result = await wrapped('world');
    expect(result).toBe('remote-ok');
    expect(onLog).toHaveBeenCalledTimes(1);

    expect(fetchImpl).toHaveBeenCalled();
    const call = fetchImpl.mock.calls[0];
    expect(call).toBeDefined();
    const [url, init] = call as [string, RequestInit];
    expect(url).toBe('https://sandbox.example/stream');
    expect(init.headers).toMatchObject({
      'X-API-Key': 'sandbox-test-key',
      'Content-Type': 'application/json',
    });

    const payload = JSON.parse(String(init.body));
    expect(typeof payload.code).toBe('string');
    expect(typeof payload.args).toBe('string');
    expect(payload.env.LOG_LEVEL).toBe('INFO');
  });

  it('raises SandboxError when remote execution emits an error event', async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        `data: ${JSON.stringify({
          type: 'error',
          data: { error: 'sandbox failed', status_code: 500 },
        })}`,
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }
      );
    });

    const wrapped = sandbox({
      api_key: 'sandbox-test-key',
      fetch_impl: fetchImpl as unknown as typeof fetch,
      quiet: true,
    })(async () => 'local');

    await expect(wrapped()).rejects.toBeInstanceOf(SandboxError);
  });
});
