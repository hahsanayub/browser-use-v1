export interface RequestInit {
  id: string;
  action: string;
  session: string;
  params?: Record<string, unknown>;
}

export class Request {
  id: string;
  action: string;
  session: string;
  params: Record<string, unknown>;

  constructor(init: RequestInit) {
    this.id = init.id;
    this.action = init.action;
    this.session = init.session;
    this.params = init.params ?? {};
  }

  to_json() {
    return JSON.stringify({
      id: this.id,
      action: this.action,
      session: this.session,
      params: this.params,
    });
  }

  static from_json(data: string) {
    const parsed = JSON.parse(data) as RequestInit;
    return new Request(parsed);
  }
}

export interface ResponseInit {
  id: string;
  success: boolean;
  data?: unknown;
  error?: string | null;
}

export class Response {
  id: string;
  success: boolean;
  data: unknown;
  error: string | null;

  constructor(init: ResponseInit) {
    this.id = init.id;
    this.success = init.success;
    this.data = init.data ?? null;
    this.error = init.error ?? null;
  }

  to_json() {
    return JSON.stringify({
      id: this.id,
      success: this.success,
      data: this.data,
      error: this.error,
    });
  }

  static from_json(data: string) {
    const parsed = JSON.parse(data) as ResponseInit;
    return new Response(parsed);
  }
}
