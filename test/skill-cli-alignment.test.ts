import { describe, expect, it, vi } from 'vitest';
import { BrowserSession } from '../src/browser/session.js';
import {
  Request,
  Response,
  SessionRegistry,
  SkillCliServer,
} from '../src/skill-cli/index.js';

describe('skill-cli alignment', () => {
  it('round-trips protocol request/response JSON payloads', () => {
    const request = new Request({
      id: 'r1',
      action: 'open',
      session: 'default',
      params: { url: 'https://example.com' },
    });
    const parsedRequest = Request.from_json(request.to_json());
    expect(parsedRequest).toEqual(request);

    const response = new Response({
      id: 'r1',
      success: true,
      data: { ok: true },
    });
    const parsedResponse = Response.from_json(response.to_json());
    expect(parsedResponse).toEqual(response);
  });

  it('handles open action through session registry and browser session', async () => {
    const session = new BrowserSession();
    const navigateSpy = vi
      .spyOn(session, 'navigate_to')
      .mockResolvedValue(null as any);
    const registry = new SessionRegistry({
      session_factory: () => session,
    });
    const server = new SkillCliServer({ registry });

    const response = await server.handle_request(
      new Request({
        id: 'r2',
        action: 'open',
        session: 'default',
        params: { url: 'https://example.com' },
      })
    );

    expect(response.success).toBe(true);
    expect(response.data).toEqual({ url: 'https://example.com' });
    expect(navigateSpy).toHaveBeenCalledWith('https://example.com');
  });

  it('returns error response when click target index is not found', async () => {
    const session = new BrowserSession();
    vi.spyOn(session, 'get_dom_element_by_index').mockResolvedValue(null);
    const registry = new SessionRegistry({
      session_factory: () => session,
    });
    const server = new SkillCliServer({ registry });

    const response = await server.handle_request(
      new Request({
        id: 'r3',
        action: 'click',
        session: 'default',
        params: { index: 99 },
      })
    );

    expect(response.success).toBe(false);
    expect(String(response.error)).toContain('not found');
  });

  it('lists sessions and closes session via close action', async () => {
    const session = new BrowserSession();
    vi.spyOn(session, 'navigate_to').mockResolvedValue(null as any);
    const stopSpy = vi.spyOn(session, 'stop').mockResolvedValue();
    const registry = new SessionRegistry({
      session_factory: () => session,
    });
    const server = new SkillCliServer({ registry });

    await server.handle_request(
      new Request({
        id: 'r4',
        action: 'open',
        session: 'default',
        params: { url: 'https://example.com' },
      })
    );

    const listed = await server.handle_request(
      new Request({
        id: 'r5',
        action: 'sessions',
        session: 'default',
      })
    );
    expect(listed.success).toBe(true);
    expect((listed.data as any).count).toBe(1);

    const closed = await server.handle_request(
      new Request({
        id: 'r6',
        action: 'close',
        session: 'default',
      })
    );
    expect(closed.success).toBe(true);
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });
});
