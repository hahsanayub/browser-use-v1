import { describe, expect, it } from 'vitest';
import {
  CreateAgentStepEvent,
  UpdateAgentSessionEvent,
} from '../src/agent/cloud-events.js';

describe('cloud events alignment', () => {
  it('CreateAgentStepEvent.fromAgentStep includes screenshot as data URL', () => {
    const event = CreateAgentStepEvent.fromAgentStep(
      {
        task_id: 'task-1',
        state: { n_steps: 3 },
        cloud_sync: { auth_client: { device_id: 'device-1' } },
      } as any,
      {
        current_state: {
          evaluation_previous_goal: 'goal-check',
          memory: 'memory-note',
          next_goal: 'next-goal',
        },
        action: [],
      } as any,
      [],
      [{ click: { index: 4 } }],
      {
        screenshot: 'abc123',
        url: 'https://example.com',
      }
    );

    expect(event.screenshot_url).toBe('data:image/png;base64,abc123');
    expect(event.url).toBe('https://example.com');
  });

  it('CreateAgentStepEvent.fromAgentStep keeps screenshot_url null without screenshot', () => {
    const event = CreateAgentStepEvent.fromAgentStep(
      {
        task_id: 'task-2',
        state: { n_steps: 1 },
        cloud_sync: { auth_client: { device_id: 'device-2' } },
      } as any,
      {
        current_state: {
          evaluation_previous_goal: '',
          memory: '',
          next_goal: '',
        },
        action: [],
      } as any,
      [],
      [],
      {
        screenshot: null,
        url: 'https://example.org',
      }
    );

    expect(event.screenshot_url).toBeNull();
  });

  it('UpdateAgentSessionEvent serializes optional update fields', () => {
    const stoppedAt = new Date('2026-02-10T10:11:12.000Z');
    const event = new UpdateAgentSessionEvent({
      id: 'session-1',
      device_id: 'device-1',
      browser_session_stopped: true,
      browser_session_stopped_at: stoppedAt,
      end_reason: 'completed',
    });

    expect(event.event_type).toBe('UpdateAgentSessionEvent');
    expect(event.toJSON()).toMatchObject({
      event_type: 'UpdateAgentSessionEvent',
      id: 'session-1',
      device_id: 'device-1',
      browser_session_stopped: true,
      browser_session_stopped_at: '2026-02-10T10:11:12.000Z',
      end_reason: 'completed',
    });
  });

  it('UpdateAgentSessionEvent enforces python-aligned end_reason max length', () => {
    expect(
      () =>
        new UpdateAgentSessionEvent({
          id: 'session-2',
          end_reason: 'x'.repeat(101),
        })
    ).toThrow('end_reason exceeds maximum length of 100');
  });
});
