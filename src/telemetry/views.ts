export abstract class BaseTelemetryEvent {
  abstract name: string;

  properties(): Record<string, unknown> {
    const entries = Object.entries(this as Record<string, unknown>).filter(
      ([key]) => key !== 'name'
    );
    return Object.fromEntries(entries);
  }
}

type BaseSequence = Array<string | null | undefined> | undefined;

export interface AgentTelemetryPayload {
  task: string;
  model: string;
  model_provider: string;
  planner_llm: string | null;
  max_steps: number;
  max_actions_per_step: number;
  use_vision: boolean;
  use_validation: boolean;
  version: string;
  source: string;
  cdp_url: string | null;
  action_errors: BaseSequence;
  action_history: Array<Array<Record<string, unknown>> | null> | undefined;
  urls_visited: BaseSequence;
  steps: number;
  total_input_tokens: number;
  total_duration_seconds: number;
  success: boolean | null;
  final_result_response: string | null;
  error_message: string | null;
}

export class AgentTelemetryEvent
  extends BaseTelemetryEvent
  implements AgentTelemetryPayload
{
  name = 'agent_event';
  task: string;
  model: string;
  model_provider: string;
  planner_llm: string | null;
  max_steps: number;
  max_actions_per_step: number;
  use_vision: boolean;
  use_validation: boolean;
  version: string;
  source: string;
  cdp_url: string | null;
  action_errors: BaseSequence;
  action_history: Array<Array<Record<string, unknown>> | null> | undefined;
  urls_visited: BaseSequence;
  steps: number;
  total_input_tokens: number;
  total_duration_seconds: number;
  success: boolean | null;
  final_result_response: string | null;
  error_message: string | null;

  constructor(payload: AgentTelemetryPayload) {
    super();
    this.task = payload.task;
    this.model = payload.model;
    this.model_provider = payload.model_provider;
    this.planner_llm = payload.planner_llm;
    this.max_steps = payload.max_steps;
    this.max_actions_per_step = payload.max_actions_per_step;
    this.use_vision = payload.use_vision;
    this.use_validation = payload.use_validation;
    this.version = payload.version;
    this.source = payload.source;
    this.cdp_url = payload.cdp_url;
    this.action_errors = payload.action_errors;
    this.action_history = payload.action_history;
    this.urls_visited = payload.urls_visited;
    this.steps = payload.steps;
    this.total_input_tokens = payload.total_input_tokens;
    this.total_duration_seconds = payload.total_duration_seconds;
    this.success = payload.success;
    this.final_result_response = payload.final_result_response;
    this.error_message = payload.error_message;
  }
}

export interface MCPClientTelemetryPayload {
  server_name: string;
  command: string;
  tools_discovered: number;
  version: string;
  action: string;
  tool_name?: string | null;
  duration_seconds?: number | null;
  error_message?: string | null;
}

export class MCPClientTelemetryEvent
  extends BaseTelemetryEvent
  implements MCPClientTelemetryPayload
{
  name = 'mcp_client_event';
  server_name: string;
  command: string;
  tools_discovered: number;
  version: string;
  action: string;
  tool_name: string | null;
  duration_seconds: number | null;
  error_message: string | null;

  constructor(payload: MCPClientTelemetryPayload) {
    super();
    this.server_name = payload.server_name;
    this.command = payload.command;
    this.tools_discovered = payload.tools_discovered;
    this.version = payload.version;
    this.action = payload.action;
    this.tool_name = payload.tool_name ?? null;
    this.duration_seconds = payload.duration_seconds ?? null;
    this.error_message = payload.error_message ?? null;
  }
}

export interface MCPServerTelemetryPayload {
  version: string;
  action: string;
  tool_name?: string | null;
  duration_seconds?: number | null;
  error_message?: string | null;
  parent_process_cmdline?: string | null;
}

export class MCPServerTelemetryEvent
  extends BaseTelemetryEvent
  implements MCPServerTelemetryPayload
{
  name = 'mcp_server_event';
  version: string;
  action: string;
  tool_name: string | null;
  duration_seconds: number | null;
  error_message: string | null;
  parent_process_cmdline: string | null;

  constructor(payload: MCPServerTelemetryPayload) {
    super();
    this.version = payload.version;
    this.action = payload.action;
    this.tool_name = payload.tool_name ?? null;
    this.duration_seconds = payload.duration_seconds ?? null;
    this.error_message = payload.error_message ?? null;
    this.parent_process_cmdline = payload.parent_process_cmdline ?? null;
  }
}

export interface CLITelemetryPayload {
  version: string;
  action: string;
  mode: string;
  model?: string | null;
  model_provider?: string | null;
  duration_seconds?: number | null;
  error_message?: string | null;
}

export class CLITelemetryEvent
  extends BaseTelemetryEvent
  implements CLITelemetryPayload
{
  name = 'cli_event';
  version: string;
  action: string;
  mode: string;
  model: string | null;
  model_provider: string | null;
  duration_seconds: number | null;
  error_message: string | null;

  constructor(payload: CLITelemetryPayload) {
    super();
    this.version = payload.version;
    this.action = payload.action;
    this.mode = payload.mode;
    this.model = payload.model ?? null;
    this.model_provider = payload.model_provider ?? null;
    this.duration_seconds = payload.duration_seconds ?? null;
    this.error_message = payload.error_message ?? null;
  }
}
