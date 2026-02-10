import { describe, expect, it } from 'vitest';
import { BrowserSession } from '../src/browser/session.js';
import {
  AgentFocusChangedEvent,
  TabClosedEvent,
  TabCreatedEvent,
} from '../src/browser/events.js';

describe('browser session tab events alignment', () => {
  it('emits TabCreatedEvent when creating a new tab', async () => {
    const session = new BrowserSession();
    const createdEvents: TabCreatedEvent[] = [];
    session.event_bus.on(
      'TabCreatedEvent',
      (event) => {
        createdEvents.push(event as TabCreatedEvent);
      },
      { handler_id: 'test.tab.created' }
    );

    await session.create_new_tab('https://example.com/new-tab');

    expect(createdEvents).toHaveLength(1);
    expect(createdEvents[0].url).toBe('https://example.com/new-tab');
    expect(createdEvents[0].target_id).toBeTruthy();
  });

  it('emits AgentFocusChangedEvent when switching tabs', async () => {
    const session = new BrowserSession();
    await session.create_new_tab('https://example.com/second');

    const focusEvents: AgentFocusChangedEvent[] = [];
    session.event_bus.on(
      'AgentFocusChangedEvent',
      (event) => {
        focusEvents.push(event as AgentFocusChangedEvent);
      },
      { handler_id: 'test.tab.focus' }
    );

    await session.switch_to_tab(0);

    expect(focusEvents).toHaveLength(1);
    expect(focusEvents[0].url).toBe('about:blank');
    expect(focusEvents[0].target_id).toBe(session.tabs[0].target_id);
  });

  it('emits TabClosedEvent and focus change when closing active tab', async () => {
    const session = new BrowserSession();
    await session.create_new_tab('https://example.com/close-me');

    const closedEvents: TabClosedEvent[] = [];
    const focusEvents: AgentFocusChangedEvent[] = [];
    session.event_bus.on(
      'TabClosedEvent',
      (event) => {
        closedEvents.push(event as TabClosedEvent);
      },
      { handler_id: 'test.tab.closed' }
    );
    session.event_bus.on(
      'AgentFocusChangedEvent',
      (event) => {
        focusEvents.push(event as AgentFocusChangedEvent);
      },
      { handler_id: 'test.tab.closed.focus' }
    );

    const closingTargetId = session.active_tab?.target_id ?? null;
    await session.close_tab(-1);

    expect(closedEvents).toHaveLength(1);
    expect(closedEvents[0].target_id).toBe(closingTargetId);
    expect(focusEvents).toHaveLength(1);
    expect(focusEvents[0].target_id).toBe(
      session.active_tab?.target_id ?? null
    );
  });
});
