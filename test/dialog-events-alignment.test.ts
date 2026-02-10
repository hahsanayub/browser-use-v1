import { describe, expect, it, vi } from 'vitest';
import { BrowserSession } from '../src/browser/session.js';
import { DialogOpenedEvent } from '../src/browser/events.js';

describe('dialog events alignment', () => {
  it('emits DialogOpenedEvent and auto-accepts alert/confirm dialogs', async () => {
    let dialogHandler: ((dialog: any) => Promise<void>) | null = null;
    const page = {
      on: vi.fn((event: string, handler: (dialog: any) => Promise<void>) => {
        if (event === 'dialog') {
          dialogHandler = handler;
        }
      }),
    };
    const session = new BrowserSession({
      page: page as any,
      url: 'https://example.com/checkout',
    });

    const events: DialogOpenedEvent[] = [];
    session.event_bus.on(
      'DialogOpenedEvent',
      (event) => {
        events.push(event as DialogOpenedEvent);
      },
      { handler_id: 'test.dialog.capture' }
    );

    const accept = vi.fn(async () => {});
    const dismiss = vi.fn(async () => {});

    await dialogHandler?.({
      type: () => 'confirm',
      message: () => 'Proceed with checkout?',
      accept,
      dismiss,
    });

    expect(events).toHaveLength(1);
    expect(events[0].dialog_type).toBe('confirm');
    expect(events[0].message).toBe('Proceed with checkout?');
    expect(events[0].url).toBe('https://example.com/checkout');
    expect(accept).toHaveBeenCalledTimes(1);
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('emits DialogOpenedEvent and dismisses prompt dialogs by default', async () => {
    let dialogHandler: ((dialog: any) => Promise<void>) | null = null;
    const page = {
      on: vi.fn((event: string, handler: (dialog: any) => Promise<void>) => {
        if (event === 'dialog') {
          dialogHandler = handler;
        }
      }),
    };
    const session = new BrowserSession({
      page: page as any,
      url: 'https://example.com/form',
    });

    const events: DialogOpenedEvent[] = [];
    session.event_bus.on(
      'DialogOpenedEvent',
      (event) => {
        events.push(event as DialogOpenedEvent);
      },
      { handler_id: 'test.dialog.capture.prompt' }
    );

    const accept = vi.fn(async () => {});
    const dismiss = vi.fn(async () => {});

    await dialogHandler?.({
      type: () => 'prompt',
      message: () => 'Enter value',
      accept,
      dismiss,
    });

    expect(events).toHaveLength(1);
    expect(events[0].dialog_type).toBe('prompt');
    expect(events[0].message).toBe('Enter value');
    expect(events[0].url).toBe('https://example.com/form');
    expect(accept).not.toHaveBeenCalled();
    expect(dismiss).toHaveBeenCalledTimes(1);
  });
});
