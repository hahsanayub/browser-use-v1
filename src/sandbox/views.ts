export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxError';
  }
}

export enum SSEEventType {
  BROWSER_CREATED = 'browser_created',
  INSTANCE_CREATED = 'instance_created',
  INSTANCE_READY = 'instance_ready',
  LOG = 'log',
  RESULT = 'result',
  ERROR = 'error',
  STREAM_COMPLETE = 'stream_complete',
}

export class BrowserCreatedData {
  session_id: string;
  live_url: string;
  status: string;

  constructor(init: {
    session_id: string;
    live_url: string;
    status: string;
  }) {
    this.session_id = init.session_id;
    this.live_url = init.live_url;
    this.status = init.status;
  }
}

export class LogData {
  message: string;
  level: string;

  constructor(init: { message: string; level?: string }) {
    this.message = init.message;
    this.level = init.level ?? 'info';
  }
}

export interface ExecutionResponse {
  success: boolean;
  result?: unknown;
  error?: string | null;
  traceback?: string | null;
}

export class ResultData {
  execution_response: ExecutionResponse;

  constructor(init: { execution_response: ExecutionResponse }) {
    this.execution_response = init.execution_response;
  }
}

export class ErrorData {
  error: string;
  traceback: string | null;
  status_code: number;

  constructor(init: {
    error: string;
    traceback?: string | null;
    status_code?: number;
  }) {
    this.error = init.error;
    this.traceback = init.traceback ?? null;
    this.status_code = init.status_code ?? 500;
  }
}

export class SSEEvent {
  type: SSEEventType;
  data:
    | BrowserCreatedData
    | LogData
    | ResultData
    | ErrorData
    | Record<string, unknown>;
  timestamp: string | null;

  constructor(init: {
    type: SSEEventType;
    data:
      | BrowserCreatedData
      | LogData
      | ResultData
      | ErrorData
      | Record<string, unknown>;
    timestamp?: string | null;
  }) {
    this.type = init.type;
    this.data = init.data;
    this.timestamp = init.timestamp ?? null;
  }

  static from_json(event_json: string) {
    const raw = JSON.parse(event_json) as {
      type: string;
      data?: Record<string, unknown>;
      timestamp?: string | null;
    };
    const type = raw.type as SSEEventType;
    const payload = raw.data ?? {};

    let data:
      | BrowserCreatedData
      | LogData
      | ResultData
      | ErrorData
      | Record<string, unknown>;
    if (type === SSEEventType.BROWSER_CREATED) {
      data = new BrowserCreatedData({
        session_id: String(payload.session_id ?? ''),
        live_url: String(payload.live_url ?? ''),
        status: String(payload.status ?? ''),
      });
    } else if (type === SSEEventType.LOG) {
      data = new LogData({
        message: String(payload.message ?? ''),
        level:
          payload.level == null ? undefined : String(payload.level),
      });
    } else if (type === SSEEventType.RESULT) {
      data = new ResultData({
        execution_response: {
          success: Boolean((payload.execution_response as any)?.success),
          result: (payload.execution_response as any)?.result,
          error:
            (payload.execution_response as any)?.error == null
              ? null
              : String((payload.execution_response as any)?.error),
          traceback:
            (payload.execution_response as any)?.traceback == null
              ? null
              : String((payload.execution_response as any)?.traceback),
        },
      });
    } else if (type === SSEEventType.ERROR) {
      data = new ErrorData({
        error: String(payload.error ?? ''),
        traceback:
          payload.traceback == null ? null : String(payload.traceback),
        status_code:
          payload.status_code == null
            ? undefined
            : Number(payload.status_code),
      });
    } else {
      data = payload;
    }

    return new SSEEvent({
      type,
      data,
      timestamp: raw.timestamp ?? null,
    });
  }

  is_browser_created() {
    return (
      this.type === SSEEventType.BROWSER_CREATED &&
      this.data instanceof BrowserCreatedData
    );
  }

  is_log() {
    return this.type === SSEEventType.LOG && this.data instanceof LogData;
  }

  is_result() {
    return this.type === SSEEventType.RESULT && this.data instanceof ResultData;
  }

  is_error() {
    return this.type === SSEEventType.ERROR && this.data instanceof ErrorData;
  }
}
