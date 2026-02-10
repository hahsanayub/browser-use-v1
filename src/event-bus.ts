import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface EventPayload {
  event_type?: string;
  event_id?: string;
  event_parent_id?: string | null;
  event_timeout?: number | null;
  event_created_at?: Date;
  event_result?: unknown;
  event_error?: unknown;
}

export interface EventBusEventInit<TResult = unknown> {
  event_id?: string;
  event_parent_id?: string | null;
  event_timeout?: number | null;
  event_created_at?: Date;
  event_result?: TResult | null;
  event_error?: unknown;
}

export class EventBusEvent<TResult = unknown> implements EventPayload {
  event_type: string;
  event_id: string;
  event_parent_id: string | null;
  event_timeout: number | null;
  event_created_at: Date;
  event_result: TResult | null;
  event_error: unknown;

  constructor(event_type: string, init: EventBusEventInit<TResult> = {}) {
    this.event_type = event_type;
    this.event_id = init.event_id ?? randomUUID();
    this.event_parent_id = init.event_parent_id ?? null;
    this.event_timeout = init.event_timeout ?? null;
    this.event_created_at = init.event_created_at ?? new Date();
    this.event_result = init.event_result ?? null;
    this.event_error = init.event_error ?? null;
  }
}

export type EventTypeReference<TEvent extends EventPayload = EventPayload> =
  | string
  | (new (...args: any[]) => TEvent);

export type EventHandler<
  TEvent extends EventPayload = EventPayload,
  TResult = unknown,
> = (event: TEvent) => TResult | Promise<TResult>;

export interface EventSubscriptionOptions {
  once?: boolean;
  handler_id?: string;
  allow_duplicate?: boolean;
}

export interface EventDispatchOptions {
  throw_on_error?: boolean;
  timeout_ms?: number | null;
  parallel_handlers?: boolean;
}

export interface EventBusOptions {
  event_history_limit?: number;
  throw_on_error_by_default?: boolean;
}

export interface EventHandlerExecutionResult {
  handler_id: string;
  event_type: string;
  status: 'fulfilled' | 'rejected' | 'timed_out';
  started_at: Date;
  completed_at: Date;
  duration_ms: number;
  result?: unknown;
  error?: unknown;
}

export interface EventDispatchResult<
  TEvent extends EventPayload = EventPayload,
> {
  event: TEvent;
  event_id: string;
  event_type: string;
  event_parent_id: string | null;
  event_timeout: number | null;
  started_at: Date;
  completed_at: Date;
  duration_ms: number;
  status: 'pending' | 'fulfilled' | 'rejected' | 'timed_out';
  handler_results: EventHandlerExecutionResult[];
  errors: unknown[];
}

export class EventHandlerTimeoutError extends Error {
  event_type: string;
  handler_id: string;
  timeout_ms: number;

  constructor(event_type: string, handler_id: string, timeout_ms: number) {
    super(
      `Handler ${handler_id} timed out after ${timeout_ms}ms for ${event_type}`
    );
    this.name = 'EventHandlerTimeoutError';
    this.event_type = event_type;
    this.handler_id = handler_id;
    this.timeout_ms = timeout_ms;
  }
}

export class EventDispatchError extends Error {
  dispatch_result: EventDispatchResult<EventPayload>;

  constructor(dispatch_result: EventDispatchResult<EventPayload>) {
    super(
      `Event ${dispatch_result.event_type}#${dispatch_result.event_id} failed with ${dispatch_result.errors.length} error(s)`
    );
    this.name = 'EventDispatchError';
    this.dispatch_result = dispatch_result;
  }
}

interface EventHandlerRegistration {
  event_type: string;
  handler: EventHandler<any, any>;
  handler_id: string;
  once: boolean;
}

export class EventBus {
  readonly handlers = new Map<string, EventHandlerRegistration[]>();
  readonly event_history = new Map<string, EventDispatchResult<EventPayload>>();

  private readonly history_limit: number;
  private readonly throw_on_error_by_default: boolean;
  private readonly dispatch_context = new AsyncLocalStorage<{
    event_id: string;
  }>();

  constructor(
    public readonly name: string,
    options: EventBusOptions = {}
  ) {
    this.history_limit = options.event_history_limit ?? 500;
    this.throw_on_error_by_default = options.throw_on_error_by_default ?? false;
  }

  on<TEvent extends EventPayload = EventPayload, TResult = unknown>(
    event_type_ref: EventTypeReference<TEvent>,
    handler: EventHandler<TEvent, TResult>,
    options: EventSubscriptionOptions = {}
  ): () => void {
    const event_type = this.resolveEventTypeFromRef(event_type_ref);
    const handler_id =
      options.handler_id ??
      this.resolveHandlerId(event_type, handler as EventHandler<any, any>);
    const registrations = this.handlers.get(event_type) ?? [];

    if (!options.allow_duplicate) {
      const hasDuplicate = registrations.some(
        (existing) =>
          existing.handler === handler || existing.handler_id === handler_id
      );
      if (hasDuplicate) {
        throw new Error(
          `Duplicate handler registration for ${event_type} (${handler_id})`
        );
      }
    }

    const registration: EventHandlerRegistration = {
      event_type,
      handler: handler as EventHandler<any, any>,
      handler_id,
      once: options.once ?? false,
    };
    registrations.push(registration);
    this.handlers.set(event_type, registrations);

    return () => {
      this.off(event_type_ref, handler_id);
    };
  }

  once<TEvent extends EventPayload = EventPayload, TResult = unknown>(
    event_type_ref: EventTypeReference<TEvent>,
    handler: EventHandler<TEvent, TResult>,
    options: Omit<EventSubscriptionOptions, 'once'> = {}
  ): () => void {
    return this.on(event_type_ref, handler, { ...options, once: true });
  }

  off<TEvent extends EventPayload = EventPayload>(
    event_type_ref: EventTypeReference<TEvent>,
    handler_or_id?: EventHandler<TEvent, unknown> | string
  ) {
    const event_type = this.resolveEventTypeFromRef(event_type_ref);
    const registrations = this.handlers.get(event_type);
    if (!registrations || registrations.length === 0) {
      return;
    }

    if (!handler_or_id) {
      this.handlers.delete(event_type);
      return;
    }

    const next = registrations.filter((entry) => {
      if (typeof handler_or_id === 'string') {
        return entry.handler_id !== handler_or_id;
      }
      return entry.handler !== handler_or_id;
    });

    if (next.length) {
      this.handlers.set(event_type, next);
    } else {
      this.handlers.delete(event_type);
    }
  }

  async dispatch<TEvent extends EventPayload>(
    event: TEvent,
    options: EventDispatchOptions = {}
  ): Promise<EventDispatchResult<TEvent>> {
    const event_type =
      this.resolveEventType(event) ?? this.resolveEventTypeFromRef('event');
    const event_id = this.resolveEventId(event);
    const event_parent_id = this.resolveParentEventId(event);
    const timeout_ms = this.resolveTimeoutMs(event, options.timeout_ms);
    const timeout_seconds = timeout_ms == null ? null : timeout_ms / 1000;

    this.assignEventMetadata(event, {
      event_type,
      event_id,
      event_parent_id,
      event_timeout: timeout_seconds,
    });

    const started_at = new Date();
    const registrations = [
      ...(this.handlers.get(event_type) ?? []),
      ...(event_type === '*' ? [] : (this.handlers.get('*') ?? [])),
    ];

    const dispatch_result: EventDispatchResult<TEvent> = {
      event,
      event_id,
      event_type,
      event_parent_id,
      event_timeout: timeout_seconds,
      started_at,
      completed_at: started_at,
      duration_ms: 0,
      status: 'pending',
      handler_results: [],
      errors: [],
    };

    this.event_history.set(
      event_id,
      dispatch_result as EventDispatchResult<EventPayload>
    );
    this.pruneHistory();

    const runHandler = async (registration: EventHandlerRegistration) => {
      const handler_started_at = new Date();
      const safeTimeoutMs = timeout_ms ?? undefined;
      let handler_status: EventHandlerExecutionResult['status'] = 'fulfilled';
      let handler_result: unknown;
      let handler_error: unknown;

      try {
        const execution = this.dispatch_context.run({ event_id }, () =>
          Promise.resolve(registration.handler(event))
        );
        handler_result =
          safeTimeoutMs == null
            ? await execution
            : await this.withTimeout(
                execution,
                safeTimeoutMs,
                event_type,
                registration.handler_id
              );
      } catch (error) {
        handler_error = error;
        handler_status =
          error instanceof EventHandlerTimeoutError ? 'timed_out' : 'rejected';
        dispatch_result.errors.push(error);
      }

      const handler_completed_at = new Date();
      const handler_execution_result: EventHandlerExecutionResult = {
        handler_id: registration.handler_id,
        event_type: registration.event_type,
        status: handler_status,
        started_at: handler_started_at,
        completed_at: handler_completed_at,
        duration_ms:
          handler_completed_at.getTime() - handler_started_at.getTime(),
      };
      if (handler_result !== undefined) {
        handler_execution_result.result = handler_result;
      }
      if (handler_error !== undefined) {
        handler_execution_result.error = handler_error;
      }
      dispatch_result.handler_results.push(handler_execution_result);

      if (registration.once) {
        this.off(registration.event_type, registration.handler_id);
      }
    };

    if (options.parallel_handlers) {
      await Promise.all(
        registrations.map((registration) => runHandler(registration))
      );
    } else {
      for (const registration of registrations) {
        await runHandler(registration);
      }
    }

    const completed_at = new Date();
    dispatch_result.completed_at = completed_at;
    dispatch_result.duration_ms = completed_at.getTime() - started_at.getTime();

    if (dispatch_result.errors.length > 0) {
      const hasTimeout = dispatch_result.handler_results.some(
        (result) => result.status === 'timed_out'
      );
      dispatch_result.status = hasTimeout ? 'timed_out' : 'rejected';
    } else {
      dispatch_result.status = 'fulfilled';
    }

    this.assignEventResult(event, dispatch_result.handler_results);
    if (dispatch_result.errors.length > 0) {
      this.assignEventError(event, dispatch_result.errors[0] ?? null);
    }

    const throw_on_error =
      options.throw_on_error ?? this.throw_on_error_by_default;
    if (throw_on_error && dispatch_result.errors.length > 0) {
      throw new EventDispatchError(
        dispatch_result as EventDispatchResult<EventPayload>
      );
    }

    return dispatch_result;
  }

  async dispatch_or_throw<TEvent extends EventPayload>(
    event: TEvent,
    options: Omit<EventDispatchOptions, 'throw_on_error'> = {}
  ) {
    return this.dispatch(event, { ...options, throw_on_error: true });
  }

  getHandlers<TEvent extends EventPayload = EventPayload>(
    event_type_ref: EventTypeReference<TEvent>
  ) {
    const event_type = this.resolveEventTypeFromRef(event_type_ref);
    return [...(this.handlers.get(event_type) ?? [])];
  }

  async stop() {
    this.handlers.clear();
    this.event_history.clear();
  }

  private resolveEventType(event: EventPayload): string | null {
    const event_type =
      event.event_type ??
      (event as { constructor?: { name?: string } }).constructor?.name ??
      null;
    return event_type && event_type.length > 0 ? event_type : null;
  }

  private resolveEventTypeFromRef<TEvent extends EventPayload>(
    event_type_ref: EventTypeReference<TEvent>
  ): string {
    if (typeof event_type_ref === 'string') {
      return event_type_ref;
    }
    return event_type_ref.name;
  }

  private resolveHandlerId(
    event_type: string,
    handler: EventHandler<any, any>
  ) {
    const suffix =
      typeof handler.name === 'string' && handler.name.length > 0
        ? handler.name
        : `handler_${randomUUID().slice(0, 8)}`;
    return `${event_type}:${suffix}`;
  }

  private resolveEventId(event: EventPayload) {
    if (event.event_id && event.event_id.length > 0) {
      return event.event_id;
    }
    return randomUUID();
  }

  private resolveParentEventId(event: EventPayload): string | null {
    if (
      typeof event.event_parent_id === 'string' &&
      event.event_parent_id.length > 0
    ) {
      return event.event_parent_id;
    }
    return this.dispatch_context.getStore()?.event_id ?? null;
  }

  private resolveTimeoutMs(
    event: EventPayload,
    dispatch_timeout_ms?: number | null
  ): number | null {
    if (dispatch_timeout_ms !== undefined) {
      return dispatch_timeout_ms;
    }

    if (event.event_timeout == null) {
      return null;
    }

    if (!Number.isFinite(event.event_timeout)) {
      return null;
    }

    if (event.event_timeout < 0) {
      return null;
    }

    return event.event_timeout * 1000;
  }

  private assignEventMetadata(
    event: EventPayload,
    metadata: {
      event_type: string;
      event_id: string;
      event_parent_id: string | null;
      event_timeout: number | null;
    }
  ) {
    this.safeAssign(event, 'event_type', metadata.event_type);
    this.safeAssign(event, 'event_id', metadata.event_id);
    this.safeAssign(event, 'event_parent_id', metadata.event_parent_id);
    if (event.event_timeout === undefined) {
      this.safeAssign(event, 'event_timeout', metadata.event_timeout);
    }
    if (event.event_created_at === undefined) {
      this.safeAssign(event, 'event_created_at', new Date());
    }
  }

  private assignEventResult(
    event: EventPayload,
    handler_results: EventHandlerExecutionResult[]
  ) {
    const first_defined_result = handler_results.find(
      (result) =>
        result.status === 'fulfilled' &&
        Object.prototype.hasOwnProperty.call(result, 'result')
    );
    if (!first_defined_result) {
      return;
    }
    this.safeAssign(event, 'event_result', first_defined_result.result);
  }

  private assignEventError(event: EventPayload, error: unknown) {
    this.safeAssign(event, 'event_error', error);
  }

  private safeAssign<T extends keyof EventPayload>(
    event: EventPayload,
    key: T,
    value: EventPayload[T]
  ) {
    try {
      (event as any)[key] = value;
    } catch {
      // Read-only event objects should still be dispatchable.
    }
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeout_ms: number,
    event_type: string,
    handler_id: string
  ): Promise<T> {
    if (timeout_ms <= 0) {
      throw new EventHandlerTimeoutError(event_type, handler_id, timeout_ms);
    }

    let timeout_handle: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timeout_handle = setTimeout(() => {
            reject(
              new EventHandlerTimeoutError(event_type, handler_id, timeout_ms)
            );
          }, timeout_ms);
        }),
      ]);
    } finally {
      if (timeout_handle) {
        clearTimeout(timeout_handle);
      }
    }
  }

  private pruneHistory() {
    if (this.history_limit <= 0) {
      this.event_history.clear();
      return;
    }

    while (this.event_history.size > this.history_limit) {
      const firstKey = this.event_history.keys().next().value;
      if (!firstKey) {
        break;
      }
      this.event_history.delete(firstKey);
    }
  }
}
