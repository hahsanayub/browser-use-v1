import { describe, expect, it } from 'vitest';
import {
  EventBus,
  EventBusEvent,
  EventDispatchError,
  EventHandlerTimeoutError,
} from '../src/event-bus.js';
import { NavigateToUrlEvent } from '../src/browser/events.js';

class ParentEvent extends EventBusEvent<void> {
  constructor() {
    super('ParentEvent');
  }
}

class ChildEvent extends EventBusEvent<void> {
  constructor() {
    super('ChildEvent');
  }
}

describe('event bus alignment', () => {
  it('dispatches typed events and stores dispatch history with handler results', async () => {
    const bus = new EventBus('test-bus');
    bus.on(NavigateToUrlEvent, (event) => `navigated:${event.url}`);
    bus.on('*', () => 'wildcard-hit');

    const event = new NavigateToUrlEvent({ url: 'https://example.com' });
    const dispatch = await bus.dispatch(event);

    expect(dispatch.status).toBe('fulfilled');
    expect(dispatch.handler_results).toHaveLength(2);
    expect(event.event_result).toBe('navigated:https://example.com');
    expect(bus.event_history.get(event.event_id)?.status).toBe('fulfilled');
  });

  it('propagates event_parent_id across nested dispatch calls', async () => {
    const bus = new EventBus('nested-dispatch');
    let nestedParentId: string | null = null;

    bus.on(ParentEvent, async (event) => {
      const child = new ChildEvent();
      const childResult = await bus.dispatch(child);
      nestedParentId = childResult.event_parent_id;
      expect(child.event_parent_id).toBe(event.event_id);
    });

    const parent = new ParentEvent();
    await bus.dispatch(parent);

    expect(nestedParentId).toBe(parent.event_id);
  });

  it('captures timeout errors without throwing by default', async () => {
    const bus = new EventBus('timeout-bus');
    bus.on('SlowEvent', async () => {
      await new Promise((resolve) => setTimeout(resolve, 35));
      return 'slow';
    });

    const event = new EventBusEvent('SlowEvent', { event_timeout: 0.01 });
    const result = await bus.dispatch(event);

    expect(result.status).toBe('timed_out');
    expect(result.errors[0]).toBeInstanceOf(EventHandlerTimeoutError);
    expect(event.event_error).toBeInstanceOf(EventHandlerTimeoutError);
  });

  it('throws EventDispatchError when using dispatch_or_throw', async () => {
    const bus = new EventBus('throw-bus');
    bus.on('FailEvent', () => {
      throw new Error('handler boom');
    });

    await expect(
      bus.dispatch_or_throw(new EventBusEvent('FailEvent'))
    ).rejects.toBeInstanceOf(EventDispatchError);
  });

  it('rejects duplicate handler registration by default', () => {
    const bus = new EventBus('duplicate-bus');
    const handler = () => undefined;

    bus.on('DupEvent', handler);

    expect(() => bus.on('DupEvent', handler)).toThrow(
      'Duplicate handler registration'
    );
  });
});
