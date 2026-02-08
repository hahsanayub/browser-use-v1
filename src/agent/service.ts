import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import process from 'node:process';
import { config as loadEnv } from 'dotenv';
import { z } from 'zod';
import { createLogger } from '../logging-config.js';
import { CONFIG } from '../config.js';
import { EventBus } from '../event-bus.js';
import { uuid7str, SignalHandler, get_browser_use_version } from '../utils.js';
import type { Controller } from '../controller/service.js';
import { Controller as DefaultController } from '../controller/service.js';
import type { FileSystem } from '../filesystem/file-system.js';
import {
  FileSystem as AgentFileSystem,
  DEFAULT_FILE_SYSTEM_PATH,
} from '../filesystem/file-system.js';
import { SystemPrompt } from './prompts.js';
import { MessageManager } from './message-manager/service.js';
import type { MessageManagerState } from './message-manager/views.js';
import { BrowserStateSummary, BrowserStateHistory } from '../browser/views.js';
import { BrowserSession } from '../browser/session.js';
import { BrowserProfile, DEFAULT_BROWSER_PROFILE } from '../browser/profile.js';
import type { Browser, BrowserContext, Page } from '../browser/types.js';
import { InsecureSensitiveDataError } from '../exceptions.js';
import { HistoryTreeProcessor } from '../dom/history-tree-processor/service.js';
import { DOMHistoryElement } from '../dom/history-tree-processor/view.js';
import type { BaseChatModel } from '../llm/base.js';
import { UserMessage } from '../llm/messages.js';
import type { UsageSummary } from '../tokens/views.js';
import {
  ActionResult,
  AgentHistory,
  AgentHistoryList,
  AgentOutput,
  AgentSettings,
  AgentState,
  AgentStepInfo,
  AgentError,
  StepMetadata,
  ActionModel,
  PlanItem,
  MessageCompactionSettings,
  defaultMessageCompactionSettings,
  normalizeMessageCompactionSettings,
} from './views.js';
import type { StructuredOutputParser } from './views.js';
import {
  CreateAgentOutputFileEvent,
  CreateAgentSessionEvent,
  CreateAgentTaskEvent,
  CreateAgentStepEvent,
  UpdateAgentTaskEvent,
} from './cloud-events.js';
import { create_history_gif } from './gif.js';
import { ScreenshotService } from '../screenshots/service.js';
import { ProductTelemetry, productTelemetry } from '../telemetry/service.js';
import { AgentTelemetryEvent } from '../telemetry/views.js';
import { TokenCost } from '../tokens/service.js';
import {
  construct_judge_messages,
  construct_simple_judge_messages,
} from './judge.js';

loadEnv();

const logger = createLogger('browser_use.agent');

export const log_response = (
  response: AgentOutput,
  registry?: Controller<any>,
  logInstance = logger
) => {
  if (response.current_state.thinking) {
    logInstance.info(`💡 Thinking:\n${response.current_state.thinking}`);
  }

  const evalGoal = response.current_state.evaluation_previous_goal;
  if (evalGoal) {
    let emoji = '❔';
    if (evalGoal.toLowerCase().includes('success')) emoji = '👍';
    else if (evalGoal.toLowerCase().includes('failure')) emoji = '⚠️';
    logInstance.info(`${emoji} Eval: ${evalGoal}`);
  }

  if (response.current_state.memory) {
    logInstance.info(`🧠 Memory: ${response.current_state.memory}`);
  }

  const nextGoal = response.current_state.next_goal;
  if (nextGoal) {
    logInstance.info(`🎯 Next goal: ${nextGoal}\n`);
  } else {
    logInstance.info('');
  }
};

type ControllerContext = unknown;

type AgentHookFunc<Context, AgentStructuredOutput> = (
  agent: Agent<Context, AgentStructuredOutput>
) => Promise<void> | void;

class AsyncMutex {
  private locked = false;
  private waiters: Array<() => void> = [];

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        this.release();
      };
    }

    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.locked = true;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.release();
    };
  }

  private release() {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.locked = false;
  }
}

class ExecutionTimeoutError extends Error {
  constructor() {
    super('Operation timed out');
    this.name = 'ExecutionTimeoutError';
  }
}

interface RerunHistoryOptions {
  max_retries?: number;
  skip_failures?: boolean;
  delay_between_actions?: number;
  max_step_interval?: number;
  signal?: AbortSignal | null;
}

interface AgentConstructorParams<Context, AgentStructuredOutput> {
  task: string;
  llm: BaseChatModel;
  page?: Page | null;
  browser?: Browser | BrowserSession | null;
  browser_context?: BrowserContext | null;
  browser_profile?: BrowserProfile | null;
  browser_session?: BrowserSession | null;
  controller?: Controller<Context> | null;
  sensitive_data?: Record<string, string | Record<string, string>> | null;
  initial_actions?: Array<Record<string, Record<string, unknown>>> | null;
  register_new_step_callback?:
    | ((
        summary: BrowserStateSummary,
        output: AgentOutput,
        step: number
      ) => void | Promise<void>)
    | null;
  register_done_callback?:
    | ((
        history: AgentHistoryList<AgentStructuredOutput>
      ) => void | Promise<void>)
    | null;
  register_external_agent_status_raise_error_callback?:
    | (() => Promise<boolean>)
    | null;
  output_model_schema?: StructuredOutputParser<AgentStructuredOutput> | null;
  use_vision?: boolean;
  include_recent_events?: boolean;
  use_vision_for_planner?: boolean;
  save_conversation_path?: string | null;
  save_conversation_path_encoding?: BufferEncoding | null;
  max_failures?: number;
  retry_delay?: number;
  override_system_message?: string | null;
  extend_system_message?: string | null;
  validate_output?: boolean;
  generate_gif?: boolean | string;
  available_file_paths?: string[] | null;
  include_attributes?: string[];
  max_actions_per_step?: number;
  use_thinking?: boolean;
  flash_mode?: boolean;
  use_judge?: boolean;
  ground_truth?: string | null;
  max_history_items?: number | null;
  page_extraction_llm?: BaseChatModel | null;
  judge_llm?: BaseChatModel | null;
  planner_llm?: BaseChatModel | null;
  planner_interval?: number;
  is_planner_reasoning?: boolean;
  extend_planner_system_message?: string | null;
  enable_planning?: boolean;
  planning_replan_on_stall?: number;
  planning_exploration_limit?: number;
  injected_agent_state?: AgentState | null;
  context?: Context | null;
  source?: string | null;
  file_system_path?: string | null;
  task_id?: string | null;
  cloud_sync?: any;
  calculate_cost?: boolean;
  display_files_in_done_text?: boolean;
  include_tool_call_examples?: boolean;
  vision_detail_level?: AgentSettings['vision_detail_level'];
  session_attachment_mode?: AgentSettings['session_attachment_mode'];
  allow_insecure_sensitive_data?: boolean;
  llm_timeout?: number | null;
  step_timeout?: number;
  final_response_after_failure?: boolean;
  message_compaction?: MessageCompactionSettings | boolean | null;
  loop_detection_window?: number;
  loop_detection_enabled?: boolean;
}

const ensureDir = (target: string) => {
  if (!fs.existsSync(target)) {
    fs.mkdirSync(target, { recursive: true });
  }
};

const get_model_timeout = (llm: BaseChatModel) => {
  const modelName = String(llm?.model ?? '').toLowerCase();
  if (modelName.includes('gemini')) {
    if (modelName.includes('3-pro')) {
      return 90;
    }
    return 75;
  }
  if (modelName.includes('groq')) {
    return 30;
  }
  if (
    modelName.includes('o3') ||
    modelName.includes('claude') ||
    modelName.includes('sonnet') ||
    modelName.includes('deepseek')
  ) {
    return 90;
  }
  return 75;
};

const defaultAgentOptions = () => ({
  use_vision: true,
  include_recent_events: false,
  use_vision_for_planner: false,
  save_conversation_path: null,
  save_conversation_path_encoding: 'utf-8' as BufferEncoding,
  max_failures: 3,
  retry_delay: 10,
  override_system_message: null,
  extend_system_message: null,
  validate_output: false,
  generate_gif: false,
  available_file_paths: [] as string[],
  include_attributes: undefined as string[] | undefined,
  max_actions_per_step: 5,
  use_thinking: true,
  flash_mode: false,
  use_judge: true,
  ground_truth: null as string | null,
  max_history_items: null as number | null,
  page_extraction_llm: null as BaseChatModel | null,
  judge_llm: null as BaseChatModel | null,
  planner_llm: null as BaseChatModel | null,
  planner_interval: 1,
  is_planner_reasoning: false,
  extend_planner_system_message: null as string | null,
  enable_planning: true,
  planning_replan_on_stall: 3,
  planning_exploration_limit: 5,
  context: null as ControllerContext | null,
  source: null as string | null,
  file_system_path: null as string | null,
  task_id: null as string | null,
  cloud_sync: null as any,
  calculate_cost: false,
  display_files_in_done_text: true,
  include_tool_call_examples: false,
  session_attachment_mode: 'copy' as const,
  allow_insecure_sensitive_data: false,
  vision_detail_level: 'auto' as const,
  llm_timeout: null as number | null,
  step_timeout: 180,
  final_response_after_failure: true,
  message_compaction: true as MessageCompactionSettings | boolean,
  loop_detection_window: 20,
  loop_detection_enabled: true,
});

const AgentLLMOutputSchema = z.object({
  thinking: z.string().optional().nullable(),
  evaluation_previous_goal: z.string().optional().nullable(),
  memory: z.string().optional().nullable(),
  next_goal: z.string().optional().nullable(),
  current_plan_item: z.number().int().optional().nullable(),
  plan_update: z.array(z.string()).optional().nullable(),
  action: z
    .array(z.record(z.string(), z.any()))
    .optional()
    .nullable()
    .default([]),
});

const SimpleJudgeSchema = z.object({
  is_correct: z.boolean(),
  reason: z.string().optional().default(''),
});

const JudgeSchema = z.object({
  reasoning: z.string().optional().nullable().default(''),
  verdict: z.boolean(),
  failure_reason: z.string().optional().nullable().default(''),
  impossible_task: z.boolean().optional().default(false),
  reached_captcha: z.boolean().optional().default(false),
});

const AgentLLMOutputFormat =
  AgentLLMOutputSchema as typeof AgentLLMOutputSchema & {
    schema: typeof AgentLLMOutputSchema;
  };
AgentLLMOutputFormat.schema = AgentLLMOutputSchema;

const SimpleJudgeOutputFormat =
  SimpleJudgeSchema as typeof SimpleJudgeSchema & {
    schema: typeof SimpleJudgeSchema;
  };
SimpleJudgeOutputFormat.schema = SimpleJudgeSchema;

const JudgeOutputFormat = JudgeSchema as typeof JudgeSchema & {
  schema: typeof JudgeSchema;
};
JudgeOutputFormat.schema = JudgeSchema;

export class Agent<
  Context = ControllerContext,
  AgentStructuredOutput = unknown,
> {
  private static _sharedSessionStepLocks = new Map<string, AsyncMutex>();

  static DEFAULT_AGENT_DATA_DIR = path.join(
    process.cwd(),
    DEFAULT_FILE_SYSTEM_PATH
  );

  browser_session: BrowserSession | null = null;
  llm: BaseChatModel;
  judge_llm: BaseChatModel;
  unfiltered_actions: string;
  initial_actions: Array<Record<string, Record<string, unknown>>> | null;
  register_new_step_callback: AgentConstructorParams<
    Context,
    AgentStructuredOutput
  >['register_new_step_callback'];
  register_done_callback: AgentConstructorParams<
    Context,
    AgentStructuredOutput
  >['register_done_callback'];
  register_external_agent_status_raise_error_callback: AgentConstructorParams<
    Context,
    AgentStructuredOutput
  >['register_external_agent_status_raise_error_callback'];
  context: Context | null;
  telemetry: ProductTelemetry;
  eventbus: EventBus;
  enable_cloud_sync: boolean;
  cloud_sync: any = null;
  file_system: FileSystem | null = null;
  screenshot_service: ScreenshotService | null = null;
  agent_directory: string;
  private _current_screenshot_path: string | null = null;
  has_downloads_path = false;
  private _last_known_downloads: string[] = [];
  version = 'unknown';
  source = 'unknown';
  step_start_time = 0;
  _external_pause_event: {
    resolve: (() => void) | null;
    promise: Promise<void>;
  } = {
    resolve: null,
    promise: Promise.resolve(),
  };
  output_model_schema: StructuredOutputParser<AgentStructuredOutput> | null;
  id: string;
  task_id: string;
  session_id: string;
  task: string;
  controller: Controller<Context>;
  settings: AgentSettings;
  token_cost_service: any;
  state: AgentState;
  history: AgentHistoryList<AgentStructuredOutput>;
  _message_manager!: MessageManager;
  available_file_paths: string[] = [];
  sensitive_data: Record<string, string | Record<string, string>> | null;
  _logger: ReturnType<typeof createLogger> | null = null;
  _file_system_path: string | null = null;
  agent_current_page: Page | null = null;
  _session_start_time = 0;
  _task_start_time = 0;
  _force_exit_telemetry_logged = false;
  private _closePromise: Promise<void> | null = null;
  private _hasBrowserSessionClaim = false;
  private _sharedPinnedTabId: number | null = null;
  private _enforceDoneOnlyForCurrentStep = false;
  system_prompt_class: SystemPrompt;
  ActionModel: typeof ActionModel = ActionModel;
  AgentOutput: typeof AgentOutput = AgentOutput;
  DoneActionModel: typeof ActionModel = ActionModel;
  DoneAgentOutput: typeof AgentOutput = AgentOutput;

  constructor(params: AgentConstructorParams<Context, AgentStructuredOutput>) {
    const {
      task,
      llm,
      page = null,
      browser = null,
      browser_context = null,
      browser_profile = null,
      browser_session = null,
      controller = null,
      sensitive_data = null,
      initial_actions = null,
      register_new_step_callback = null,
      register_done_callback = null,
      register_external_agent_status_raise_error_callback = null,
      output_model_schema = null,
      use_vision = true,
      include_recent_events = false,
      save_conversation_path = null,
      save_conversation_path_encoding = 'utf-8',
      max_failures = 3,
      retry_delay = 10,
      override_system_message = null,
      extend_system_message = null,
      validate_output = false,
      generate_gif = false,
      available_file_paths = [],
      include_attributes,
      max_actions_per_step = 5,
      use_thinking = true,
      flash_mode = false,
      use_judge = true,
      ground_truth = null,
      max_history_items = null,
      page_extraction_llm = null,
      judge_llm = null,
      enable_planning = true,
      planning_replan_on_stall = 3,
      planning_exploration_limit = 5,
      context = null,
      source = null,
      file_system_path = null,
      task_id = null,
      cloud_sync = null,
      calculate_cost = false,
      display_files_in_done_text = true,
      include_tool_call_examples = false,
      vision_detail_level = 'auto',
      session_attachment_mode = 'copy',
      allow_insecure_sensitive_data = false,
      llm_timeout = null,
      step_timeout = 180,
      final_response_after_failure = true,
      message_compaction = true,
      loop_detection_window = 20,
      loop_detection_enabled = true,
    } = { ...defaultAgentOptions(), ...params };

    if (!llm) {
      throw new Error('Invalid llm, must be provided');
    }
    const effectivePageExtractionLlm = page_extraction_llm ?? llm;
    const effectiveJudgeLlm = judge_llm ?? llm;
    const effectiveFlashMode =
      flash_mode || (llm as any)?.provider === 'browser-use';
    const effectiveEnablePlanning = effectiveFlashMode
      ? false
      : enable_planning;
    const effectiveLlmTimeout = llm_timeout ?? get_model_timeout(llm);
    const normalizedMessageCompaction =
      this._normalizeMessageCompactionSetting(message_compaction);

    this.llm = llm;
    this.judge_llm = effectiveJudgeLlm;
    this.id = task_id || uuid7str();
    this.task_id = this.id;
    this.session_id = uuid7str();
    this.task = task;
    this.output_model_schema = output_model_schema ?? null;
    this.sensitive_data = sensitive_data;
    this.available_file_paths = available_file_paths || [];
    this.controller = (controller ??
      new DefaultController({
        display_files_in_done_text,
      })) as Controller<Context>;
    this.initial_actions = initial_actions
      ? this._convertInitialActions(initial_actions)
      : null;
    this.register_new_step_callback = register_new_step_callback;
    this.register_done_callback = register_done_callback;
    this.register_external_agent_status_raise_error_callback =
      register_external_agent_status_raise_error_callback;
    this.context = context as Context | null;
    this.agent_directory = Agent.DEFAULT_AGENT_DATA_DIR;

    this.settings = {
      use_vision,
      include_recent_events,
      vision_detail_level,
      use_vision_for_planner: false,
      save_conversation_path,
      save_conversation_path_encoding,
      max_failures,
      retry_delay,
      validate_output,
      generate_gif,
      override_system_message,
      extend_system_message,
      include_attributes: include_attributes ?? ['title', 'type', 'name'],
      max_actions_per_step,
      use_thinking,
      flash_mode: effectiveFlashMode,
      use_judge,
      ground_truth,
      max_history_items,
      page_extraction_llm: effectivePageExtractionLlm,
      planner_llm: null,
      planner_interval: 1,
      is_planner_reasoning: false,
      extend_planner_system_message: null,
      enable_planning: effectiveEnablePlanning,
      planning_replan_on_stall,
      planning_exploration_limit,
      calculate_cost,
      include_tool_call_examples,
      session_attachment_mode,
      allow_insecure_sensitive_data,
      llm_timeout: effectiveLlmTimeout,
      step_timeout,
      final_response_after_failure,
      message_compaction: normalizedMessageCompaction,
      loop_detection_window,
      loop_detection_enabled,
    };

    this.token_cost_service = new TokenCost(calculate_cost);
    if (calculate_cost) {
      this.token_cost_service.initialize().catch((error: Error) => {
        this.logger.debug(
          `Failed to initialize token cost service: ${error.message}`
        );
      });
    }
    this.token_cost_service.register_llm(llm);
    this.token_cost_service.register_llm(effectivePageExtractionLlm);
    this.token_cost_service.register_llm(effectiveJudgeLlm);
    if (normalizedMessageCompaction?.compaction_llm) {
      this.token_cost_service.register_llm(
        normalizedMessageCompaction.compaction_llm
      );
    }

    this.state = params.injected_agent_state || new AgentState();
    this.state.loop_detector.window_size = this.settings.loop_detection_window;
    this.history = new AgentHistoryList([], null);
    this.telemetry = productTelemetry;

    this._file_system_path = file_system_path;
    this.file_system = this._initFileSystem(file_system_path);
    this._setScreenshotService();
    this._setup_action_models();
    this._set_browser_use_version_and_source(source);

    this.browser_session = this._init_browser_session({
      page,
      browser,
      browser_context,
      browser_profile,
      browser_session,
    });
    this.has_downloads_path = Boolean(
      this.browser_session?.browser_profile?.downloads_path
    );
    if (this.has_downloads_path) {
      this._last_known_downloads = [];
      this.logger.info('📁 Initialized download tracking for agent');
    }

    this.system_prompt_class = new SystemPrompt(
      this.controller.registry.get_prompt_description(),
      this.settings.max_actions_per_step,
      this.settings.override_system_message,
      this.settings.extend_system_message,
      this.settings.use_thinking,
      this.settings.flash_mode,
      String((this.llm as any)?.provider ?? '').toLowerCase() === 'anthropic',
      String((this.llm as any)?.model ?? '')
        .toLowerCase()
        .includes('browser-use/'),
      String((this.llm as any)?.model ?? '')
    );

    this._message_manager = new MessageManager(
      task,
      this.system_prompt_class.get_system_message(),
      this.file_system!,
      this.state.message_manager_state as MessageManagerState,
      this.settings.use_thinking,
      this.settings.include_attributes,
      sensitive_data ?? undefined,
      this.settings.max_history_items,
      this.settings.vision_detail_level,
      this.settings.include_tool_call_examples
    );

    this.unfiltered_actions = this.controller.registry.get_prompt_description();
    this.eventbus = new EventBus(`Agent_${String(this.id).slice(-4)}`);
    this.enable_cloud_sync = CONFIG.BROWSER_USE_CLOUD_SYNC;
    if (this.enable_cloud_sync || cloud_sync) {
      this.cloud_sync = cloud_sync ?? null;
      if (this.cloud_sync) {
        this.eventbus.on(
          '*',
          this.cloud_sync.handle_event?.bind(this.cloud_sync) ?? (() => {})
        );
      }
    }

    this._external_pause_event = {
      resolve: null,
      promise: Promise.resolve(),
    };

    this._session_start_time = 0;
    this._task_start_time = 0;
    this._force_exit_telemetry_logged = false;

    // Security validation for sensitive_data and allowed_domains
    this._validateSecuritySettings();
    this._capture_shared_pinned_tab();

    // LLM verification and setup
    this._verifyAndSetupLlm();

    // Model-specific vision handling
    this._handleModelSpecificVision();
  }

  private _normalizeMessageCompactionSetting(
    messageCompaction: MessageCompactionSettings | boolean | null | undefined
  ): MessageCompactionSettings | null {
    if (messageCompaction == null) {
      return null;
    }
    if (typeof messageCompaction === 'boolean') {
      return normalizeMessageCompactionSettings({
        ...defaultMessageCompactionSettings(),
        enabled: messageCompaction,
      });
    }
    return normalizeMessageCompactionSettings({
      ...defaultMessageCompactionSettings(),
      ...messageCompaction,
    });
  }

  private _createSessionIdWithAgentSuffix(): string {
    const suffix = this.id.slice(-4);
    const generated = uuid7str();
    return `${generated.slice(0, -4)}${suffix}`;
  }

  private _copyBrowserProfile(profile: BrowserProfile | null): BrowserProfile {
    const source = profile ?? DEFAULT_BROWSER_PROFILE;
    const clonedConfig =
      typeof structuredClone === 'function'
        ? structuredClone(source.config)
        : JSON.parse(JSON.stringify(source.config));
    return new BrowserProfile(clonedConfig);
  }

  private _getBrowserContextFromPage(
    page: Page | null,
    browser_context: BrowserContext | null
  ): BrowserContext | null {
    if (!page) {
      return browser_context;
    }

    const contextAttr = (page as any).context;
    if (typeof contextAttr === 'function') {
      try {
        const resolved = contextAttr.call(page) as BrowserContext | null;
        return resolved ?? browser_context;
      } catch {
        return browser_context;
      }
    }

    return (contextAttr as BrowserContext | null) ?? browser_context;
  }

  private _claim_or_isolate_browser_session(
    browser_session: BrowserSession
  ): BrowserSession {
    const claimMode =
      this.settings.session_attachment_mode === 'shared'
        ? 'shared'
        : 'exclusive';
    this._hasBrowserSessionClaim = false;

    const claimSession = (
      session: BrowserSession
    ): 'claimed' | 'noop' | 'failed' => {
      const claimFn =
        (session as any).claim_agent ?? (session as any).claimAgent;
      if (typeof claimFn !== 'function') {
        if (
          this.settings.session_attachment_mode === 'strict' ||
          this.settings.session_attachment_mode === 'shared'
        ) {
          throw new Error(
            `session_attachment_mode='${this.settings.session_attachment_mode}' requires BrowserSession.claim_agent()/release_agent() support.`
          );
        }
        return 'noop';
      }
      const claimed = Boolean(claimFn.call(session, this.id, claimMode));
      return claimed ? 'claimed' : 'failed';
    };

    const getAttachedAgentIds = (session: BrowserSession): string[] => {
      const pluralGetter =
        (session as any).get_attached_agent_ids ??
        (session as any).getAttachedAgentIds;
      if (typeof pluralGetter === 'function') {
        const value = pluralGetter.call(session);
        if (Array.isArray(value)) {
          return value.filter((item) => typeof item === 'string');
        }
      }

      const singleGetter =
        (session as any).get_attached_agent_id ??
        (session as any).getAttachedAgentId;
      if (typeof singleGetter !== 'function') {
        return [];
      }
      const value = singleGetter.call(session);
      return typeof value === 'string' ? [value] : [];
    };

    const claimResult = claimSession(browser_session);
    if (claimResult !== 'failed') {
      this._hasBrowserSessionClaim = claimResult === 'claimed';
      return browser_session;
    }

    const currentOwners = getAttachedAgentIds(browser_session);
    const ownerLabel =
      currentOwners.length > 0 ? currentOwners.join(', ') : 'unknown';
    if (this.settings.session_attachment_mode === 'strict') {
      throw new Error(
        `BrowserSession is already attached to Agent ${ownerLabel}. Set session_attachment_mode='copy' to allow automatic isolation.`
      );
    }

    if (this.settings.session_attachment_mode === 'shared') {
      throw new Error(
        `BrowserSession is already attached in exclusive mode by Agent ${ownerLabel}. Configure all participating agents with session_attachment_mode='shared' or use session_attachment_mode='copy'.`
      );
    }

    this.logger.warning(
      `⚠️ BrowserSession is already attached to Agent ${ownerLabel}. Creating an isolated copy for this Agent.`
    );

    const modelCopyFn =
      (browser_session as any).model_copy ?? (browser_session as any).modelCopy;
    if (typeof modelCopyFn !== 'function') {
      throw new Error(
        `BrowserSession is attached to another Agent (${ownerLabel}) and cannot be safely reused. Provide a separate BrowserSession.`
      );
    }

    const isolated = modelCopyFn.call(browser_session) as BrowserSession;
    const isolatedClaimResult = claimSession(isolated);
    if (isolatedClaimResult === 'failed') {
      throw new Error(
        'Failed to claim isolated BrowserSession for current Agent'
      );
    }
    this._hasBrowserSessionClaim = isolatedClaimResult === 'claimed';
    return isolated;
  }

  private _release_browser_session_claim(
    browser_session: BrowserSession | null
  ) {
    if (!browser_session || !this._hasBrowserSessionClaim) {
      return;
    }

    const releaseFn =
      (browser_session as any).release_agent ??
      (browser_session as any).releaseAgent;
    if (typeof releaseFn !== 'function') {
      return;
    }

    const released = releaseFn.call(browser_session, this.id);
    if (!released) {
      this.logger.warning(
        '⚠️ BrowserSession claim was not released because it is currently attached to another Agent.'
      );
    }
    this._hasBrowserSessionClaim = false;
  }

  private _has_any_browser_session_attachments(
    browser_session: BrowserSession | null
  ): boolean {
    if (!browser_session) {
      return false;
    }

    const pluralGetter =
      (browser_session as any).get_attached_agent_ids ??
      (browser_session as any).getAttachedAgentIds;
    if (typeof pluralGetter === 'function') {
      const value = pluralGetter.call(browser_session);
      if (Array.isArray(value)) {
        return value.some((item) => typeof item === 'string');
      }
    }

    const singleGetter =
      (browser_session as any).get_attached_agent_id ??
      (browser_session as any).getAttachedAgentId;
    if (typeof singleGetter !== 'function') {
      return false;
    }
    return typeof singleGetter.call(browser_session) === 'string';
  }

  private _is_shared_session_mode() {
    return this.settings.session_attachment_mode === 'shared';
  }

  private _capture_shared_pinned_tab() {
    if (!this._is_shared_session_mode() || !this.browser_session) {
      return;
    }

    const activeTab = (this.browser_session as any).active_tab;
    const pageId = activeTab?.page_id;
    if (typeof pageId === 'number') {
      this._sharedPinnedTabId = pageId;
    }
  }

  private async _restore_shared_pinned_tab_if_needed() {
    if (!this._is_shared_session_mode() || !this.browser_session) {
      return;
    }

    const switchFn =
      (this.browser_session as any).switch_to_tab ??
      (this.browser_session as any).switchToTab;
    if (typeof switchFn !== 'function') {
      return;
    }

    if (this._sharedPinnedTabId == null) {
      this._capture_shared_pinned_tab();
      return;
    }

    try {
      await switchFn.call(this.browser_session, this._sharedPinnedTabId);
    } catch {
      this._capture_shared_pinned_tab();
    }
  }

  private async _run_with_shared_session_step_lock<T>(
    callback: () => Promise<T>
  ): Promise<T> {
    if (!this._is_shared_session_mode() || !this.browser_session) {
      return callback();
    }

    const sessionId = this.browser_session.id;
    let lock = Agent._sharedSessionStepLocks.get(sessionId);
    if (!lock) {
      lock = new AsyncMutex();
      Agent._sharedSessionStepLocks.set(sessionId, lock);
    }

    const release = await lock.acquire();
    try {
      return await callback();
    } finally {
      release();
    }
  }

  private _cleanup_shared_session_step_lock_if_unused(
    browser_session: BrowserSession | null
  ) {
    if (!browser_session) {
      return;
    }
    if (this._has_any_browser_session_attachments(browser_session)) {
      return;
    }
    Agent._sharedSessionStepLocks.delete(browser_session.id);
  }

  private _init_browser_session(init: {
    page: Page | null;
    browser: Browser | BrowserSession | null;
    browser_context: BrowserContext | null;
    browser_profile: BrowserProfile | null;
    browser_session: BrowserSession | null;
  }): BrowserSession {
    let { page, browser, browser_context, browser_profile, browser_session } =
      init;

    if (browser instanceof BrowserSession) {
      browser_session = browser_session ?? browser;
      browser = null;
    }

    if (browser_session) {
      const ownsResources = (browser_session as any)._owns_browser_resources;
      if (
        ownsResources === false &&
        this.settings.session_attachment_mode === 'copy'
      ) {
        this.logger.warning(
          "⚠️ Non-owning BrowserSession detected. session_attachment_mode='copy' will isolate this Agent with a cloned BrowserSession."
        );
        const modelCopyFn =
          (browser_session as any).model_copy ??
          (browser_session as any).modelCopy;
        if (typeof modelCopyFn === 'function') {
          const isolated = modelCopyFn.call(browser_session) as BrowserSession;
          return this._claim_or_isolate_browser_session(isolated);
        }
      }
      return this._claim_or_isolate_browser_session(browser_session);
    }

    const resolvedContext = this._getBrowserContextFromPage(
      page,
      browser_context
    );
    const resolvedProfile = this._copyBrowserProfile(browser_profile);

    return this._claim_or_isolate_browser_session(
      new BrowserSession({
        browser_profile: resolvedProfile,
        browser: (browser as Browser | null) ?? null,
        browser_context: resolvedContext,
        page,
        id: this._createSessionIdWithAgentSuffix(),
      })
    );
  }

  private _sleep_blocking(ms: number) {
    if (ms <= 0) {
      return;
    }

    if (typeof SharedArrayBuffer === 'function' && Atomics?.wait) {
      const lock = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(lock, 0, 0, ms);
      return;
    }

    const end = Date.now() + ms;
    while (Date.now() < end) {
      // Intentional busy-wait fallback for runtimes without Atomics.wait.
    }
  }

  /**
   * Convert dictionary-based actions to ActionModel instances
   */
  private _convertInitialActions(
    actions: Array<Record<string, Record<string, unknown>>>
  ): Array<Record<string, Record<string, unknown>>> {
    const convertedActions: Array<Record<string, Record<string, unknown>>> = [];

    for (const actionDict of actions) {
      // Each actionDict should have a single key-value pair
      const actionName = Object.keys(actionDict)[0];
      const params = actionDict[actionName];

      try {
        // Get the parameter model for this action from registry
        const actionInfo =
          this.controller.registry.get_all_actions().get(actionName) ?? null;
        if (!actionInfo) {
          this.logger.warning(
            `⚠️ Unknown action "${actionName}" in initial_actions, skipping`
          );
          continue;
        }

        const paramModel = actionInfo.paramSchema;
        if (!paramModel) {
          this.logger.warning(
            `⚠️ No parameter model for action "${actionName}", using raw params`
          );
          convertedActions.push(actionDict);
          continue;
        }

        // Validate parameters using Zod schema
        const validatedParams = paramModel.parse(params);
        if (
          !validatedParams ||
          typeof validatedParams !== 'object' ||
          Array.isArray(validatedParams)
        ) {
          this.logger.warning(
            `⚠️ Parsed params for action "${actionName}" are not an object, skipping`
          );
          continue;
        }

        // Create action with validated parameters
        convertedActions.push({
          [actionName]: validatedParams as Record<string, unknown>,
        });
      } catch (error) {
        this.logger.error(
          `❌ Failed to validate initial action "${actionName}": ${error}`
        );
        // Skip invalid actions
        continue;
      }
    }

    return convertedActions;
  }

  /**
   * Handle model-specific vision capabilities
   * Some models like DeepSeek and Grok don't support vision yet
   */
  private _handleModelSpecificVision() {
    const modelName = this.llm.model?.toLowerCase() || '';

    // Handle DeepSeek models
    if (modelName.includes('deepseek') && this.settings.use_vision) {
      this.logger.warning(
        '⚠️ DeepSeek models do not support use_vision=True yet. Setting use_vision=False for now...'
      );
      this.settings.use_vision = false;
    }

    // Handle XAI models that currently do not support vision
    if (
      (modelName.includes('grok-3') || modelName.includes('grok-code')) &&
      this.settings.use_vision
    ) {
      this.logger.warning(
        '⚠️ This XAI model does not support use_vision=True yet. Setting use_vision=False for now...'
      );
      this.settings.use_vision = false;
    }
  }

  /**
   * Verify that the LLM API keys are setup and the LLM API is responding properly.
   * Also handles model capability detection.
   */
  private _verifyAndSetupLlm() {
    // Skip verification if already done or if configured to skip
    if (
      (this.llm as any)._verified_api_keys === true ||
      CONFIG.SKIP_LLM_API_KEY_VERIFICATION
    ) {
      (this.llm as any)._verified_api_keys = true;
      return true;
    }

    // Mark as verified
    (this.llm as any)._verified_api_keys = true;

    // Log LLM information
    this.logger.debug(`🤖 Using LLM: ${this.llm.model || 'unknown model'}`);

    return true;
  }

  /**
   * Validates security settings when sensitive_data is provided
   * Checks if allowed_domains is properly configured to prevent credential leakage
   */
  private _validateSecuritySettings() {
    if (!this.sensitive_data) {
      return;
    }

    // Check if sensitive_data has domain-specific credentials
    const hasDomainSpecificCredentials = Object.values(
      this.sensitive_data
    ).some((value) => typeof value === 'object' && value !== null);

    const allowedDomainsConfig =
      this.browser_session?.browser_profile?.config?.allowed_domains;
    const hasAllowedDomains = Array.isArray(allowedDomainsConfig)
      ? allowedDomainsConfig.length > 0
      : Boolean(allowedDomainsConfig);

    // If no allowed_domains are configured, show a security warning
    if (!hasAllowedDomains) {
      if (!this.settings.allow_insecure_sensitive_data) {
        throw new InsecureSensitiveDataError();
      }

      this.logger.error(
        '⚠️⚠️⚠️ Agent(sensitive_data=••••••••) was provided but BrowserSession(allowed_domains=[...]) is not locked down! ⚠️⚠️⚠️\n' +
          '          ☠️ If the agent visits a malicious website and encounters a prompt-injection attack, your sensitive_data may be exposed!\n\n' +
          '             https://docs.browser-use.com/customize/browser-settings#restrict-urls\n' +
          'Waiting 10 seconds before continuing... Press [Ctrl+C] to abort.'
      );

      // Check if we're in an interactive shell (TTY)
      if (process.stdin.isTTY) {
        // Block startup for 10 seconds to match Python warning behavior.
        // User can still abort process with Ctrl+C.
        this._sleep_blocking(10_000);
      }

      this.logger.warning(
        '‼️ Continuing with insecure settings because allow_insecure_sensitive_data=true is enabled.'
      );
    }
    // If we're using domain-specific credentials, validate domain patterns
    else if (hasDomainSpecificCredentials) {
      const allowedDomains =
        this.browser_session!.browser_profile!.config.allowed_domains!;

      // Get domain patterns from sensitive_data where value is an object
      const domainPatterns = Object.keys(this.sensitive_data).filter(
        (key) =>
          typeof this.sensitive_data![key] === 'object' &&
          this.sensitive_data![key] !== null
      );

      // Validate each domain pattern against allowed_domains
      for (const domainPattern of domainPatterns) {
        let isAllowed = false;

        for (const allowedDomain of allowedDomains) {
          // Special cases that don't require URL matching
          if (domainPattern === allowedDomain || allowedDomain === '*') {
            isAllowed = true;
            break;
          }

          // Extract the domain parts, ignoring scheme
          const patternDomain = domainPattern.includes('://')
            ? domainPattern.split('://')[1]
            : domainPattern;
          const allowedDomainPart = allowedDomain.includes('://')
            ? allowedDomain.split('://')[1]
            : allowedDomain;

          // Check if pattern is covered by an allowed domain
          // Example: "google.com" is covered by "*.google.com"
          if (
            patternDomain === allowedDomainPart ||
            (allowedDomainPart.startsWith('*.') &&
              (patternDomain === allowedDomainPart.slice(2) ||
                patternDomain.endsWith('.' + allowedDomainPart.slice(2))))
          ) {
            isAllowed = true;
            break;
          }
        }

        if (!isAllowed) {
          this.logger.warning(
            `⚠️ Domain pattern "${domainPattern}" in sensitive_data is not covered by any pattern in allowed_domains=${JSON.stringify(allowedDomains)}\n` +
              `   This may be a security risk as credentials could be used on unintended domains.`
          );
        }
      }
    }
  }

  private _initFileSystem(file_system_path: string | null) {
    if (this.state.file_system_state && file_system_path) {
      throw new Error(
        'Cannot provide both file_system_state (from agent state) and file_system_path. Restore from state or create new file system, not both.'
      );
    }

    if (this.state.file_system_state) {
      try {
        this.file_system = AgentFileSystem.from_state_sync(
          this.state.file_system_state
        );
        this._file_system_path = this.state.file_system_state.base_dir;
        this.logger.info(
          `💾 File system restored from state to: ${this._file_system_path}`
        );
        const timestamp = Date.now();
        this.agent_directory = path.join(
          os.tmpdir(),
          `browser_use_agent_${this.id}_${timestamp}`
        );
        ensureDir(this.agent_directory);
        return this.file_system;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `💾 Failed to restore file system from state: ${message}`
        );
        throw error;
      }
    }

    const baseDir =
      file_system_path ?? path.join(Agent.DEFAULT_AGENT_DATA_DIR, this.task_id);
    ensureDir(baseDir);

    try {
      this.file_system = new AgentFileSystem(baseDir);
      this._file_system_path = baseDir;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`💾 Failed to initialize file system: ${message}`);
      throw error;
    }

    const timestamp = Date.now();
    this.agent_directory = path.join(
      os.tmpdir(),
      `browser_use_agent_${this.id}_${timestamp}`
    );
    ensureDir(this.agent_directory);

    this.state.file_system_state = this.file_system.get_state();
    this.logger.info(`💾 File system path: ${this._file_system_path}`);
    return this.file_system;
  }

  private _setScreenshotService() {
    try {
      this.screenshot_service = new ScreenshotService(this.agent_directory);
      this.logger.info(
        `📸 Screenshot service initialized in: ${path.join(this.agent_directory, 'screenshots')}`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `📸 Failed to initialize screenshot service: ${message}`
      );
      throw error;
    }
  }

  get logger() {
    if (!this._logger) {
      const browserSessionId =
        (this.browser_session && this.browser_session.id) || this.id;
      this._logger = createLogger(
        `browser_use.Agent🅰 ${this.task_id.slice(-4)} on 🆂 ${String(browserSessionId).slice(-4)}`
      );
    }
    return this._logger;
  }

  get message_manager() {
    return this._message_manager;
  }

  /**
   * Get the browser instance from the browser session
   */
  get browser(): Browser {
    if (!this.browser_session) {
      throw new Error('BrowserSession is not set up');
    }
    if (!this.browser_session.browser) {
      throw new Error('Browser is not set up');
    }
    return this.browser_session.browser;
  }

  /**
   * Get the browser context from the browser session
   */
  get browserContext(): BrowserContext {
    if (!this.browser_session) {
      throw new Error('BrowserSession is not set up');
    }
    if (!this.browser_session.browser_context) {
      throw new Error('BrowserContext is not set up');
    }
    return this.browser_session.browser_context;
  }

  /**
   * Get the browser profile from the browser session
   */
  get browserProfile(): BrowserProfile {
    if (!this.browser_session) {
      throw new Error('BrowserSession is not set up');
    }
    return this.browser_session.browser_profile;
  }

  /**
   * Add a new task to the agent, keeping the same task_id as tasks are continuous
   */
  addNewTask(newTask: string): void {
    // Simply delegate to message manager - no need for new task_id or events
    // The task continues with new instructions, it doesn't end and start a new one
    this.task = newTask;
    this._message_manager.add_new_task(newTask);
  }

  /**
   * Take a step and return whether the task is done and valid
   * @returns Tuple of [is_done, is_valid]
   */
  async takeStep(stepInfo?: AgentStepInfo): Promise<[boolean, boolean]> {
    await this._step(stepInfo ?? null);

    if (this.history.is_done()) {
      await this._run_simple_judge();
      await this.log_completion();
      if (this.settings.use_judge) {
        await this._judge_and_log();
      }
      if (this.register_done_callback) {
        await this.register_done_callback(this.history);
      }
      return [true, true];
    }

    return [false, false];
  }

  /**
   * Remove think tags from text
   */
  private _removeThinkTags(text: string): string {
    const THINK_TAGS = /<think>.*?<\/think>/gs;
    const STRAY_CLOSE_TAG = /.*?<\/think>/gs;
    // Step 1: Remove well-formed <think>...</think>
    text = text.replace(THINK_TAGS, '');
    // Step 2: If there's an unmatched closing tag </think>,
    //         remove everything up to and including that.
    text = text.replace(STRAY_CLOSE_TAG, '');
    return text.trim();
  }

  /**
   * Log a comprehensive summary of the next action(s)
   */
  private _logNextActionSummary(parsed: AgentOutput): void {
    if (!parsed.action || parsed.action.length === 0) {
      return;
    }

    const actionCount = parsed.action.length;

    // Collect action details
    const actionDetails: string[] = [];
    let lastActionName = 'unknown';
    let lastParamStr = '';

    for (const action of parsed.action) {
      const actionData = action.model_dump();
      const actionName = Object.keys(actionData)[0] || 'unknown';
      const actionParams = actionData[actionName] || {};

      // Format key parameters concisely
      const paramSummary: string[] = [];
      if (typeof actionParams === 'object' && actionParams !== null) {
        for (const [key, value] of Object.entries(actionParams)) {
          if (key === 'index') {
            paramSummary.push(`#${value}`);
          } else if (key === 'text' && typeof value === 'string') {
            const textPreview =
              value.length > 30 ? value.slice(0, 30) + '...' : value;
            paramSummary.push(`text="${textPreview}"`);
          } else if (key === 'url') {
            paramSummary.push(`url="${value}"`);
          } else if (key === 'success') {
            paramSummary.push(`success=${value}`);
          } else if (
            typeof value === 'string' ||
            typeof value === 'number' ||
            typeof value === 'boolean'
          ) {
            const valStr = String(value);
            const truncatedVal =
              valStr.length > 30 ? valStr.slice(0, 30) + '...' : valStr;
            paramSummary.push(`${key}=${truncatedVal}`);
          }
        }
      }

      const paramStr =
        paramSummary.length > 0 ? `(${paramSummary.join(', ')})` : '';
      actionDetails.push(`${actionName}${paramStr}`);
      lastActionName = actionName;
      lastParamStr = paramStr;
    }

    // Create summary based on single vs multi-action
    if (actionCount === 1) {
      this.logger.info(
        `☝️ Decided next action: ${lastActionName}${lastParamStr}`
      );
    } else {
      const summaryLines = [`✌️ Decided next ${actionCount} multi-actions:`];
      for (let i = 0; i < actionDetails.length; i++) {
        summaryLines.push(`          ${i + 1}. ${actionDetails[i]}`);
      }
      this.logger.info(summaryLines.join('\n'));
    }
  }

  private _set_browser_use_version_and_source(sourceOverride: string | null) {
    const version = get_browser_use_version();
    let source = 'npm';

    try {
      const projectRoot = process.cwd();
      const repoIndicators = ['.git', 'README.md', 'docs', 'examples'];
      if (
        repoIndicators.every((indicator) =>
          fs.existsSync(path.join(projectRoot, indicator))
        )
      ) {
        source = 'git';
      }
    } catch (error) {
      this.logger.debug(
        `Error determining browser-use source: ${(error as Error).message}`
      );
      source = 'unknown';
    }

    if (sourceOverride) {
      source = sourceOverride;
    }

    this.version = version;
    this.source = source;
  }

  /**
   * Setup dynamic action models from controller's registry
   * Initially only include actions with no filters
   */
  private _setup_action_models() {
    // Initially only include actions with no filters
    this.ActionModel = this.controller.registry.create_action_model();

    // Create output model with the dynamic actions
    if (this.settings.flash_mode) {
      this.AgentOutput = AgentOutput.type_with_custom_actions_flash_mode(
        this.ActionModel
      );
    } else if (this.settings.use_thinking) {
      this.AgentOutput = AgentOutput.type_with_custom_actions(this.ActionModel);
    } else {
      this.AgentOutput = AgentOutput.type_with_custom_actions_no_thinking(
        this.ActionModel
      );
    }

    // Used to force the done action when max_steps is reached
    this.DoneActionModel = this.controller.registry.create_action_model({
      include_actions: ['done'],
    });
    if (this.settings.flash_mode) {
      this.DoneAgentOutput = AgentOutput.type_with_custom_actions_flash_mode(
        this.DoneActionModel
      );
    } else if (this.settings.use_thinking) {
      this.DoneAgentOutput = AgentOutput.type_with_custom_actions(
        this.DoneActionModel
      );
    } else {
      this.DoneAgentOutput = AgentOutput.type_with_custom_actions_no_thinking(
        this.DoneActionModel
      );
    }
  }

  /**
   * Update action models with page-specific actions
   * Called during each step to filter actions based on current page context
   */
  private async _updateActionModelsForPage(page: Page | null) {
    // Create new action model with current page's filtered actions
    this.ActionModel = this.controller.registry.create_action_model({ page });

    // Update output model with the new actions
    if (this.settings.flash_mode) {
      this.AgentOutput = AgentOutput.type_with_custom_actions_flash_mode(
        this.ActionModel
      );
    } else if (this.settings.use_thinking) {
      this.AgentOutput = AgentOutput.type_with_custom_actions(this.ActionModel);
    } else {
      this.AgentOutput = AgentOutput.type_with_custom_actions_no_thinking(
        this.ActionModel
      );
    }

    // Update done action model too
    this.DoneActionModel = this.controller.registry.create_action_model({
      include_actions: ['done'],
      page,
    });
    if (this.settings.flash_mode) {
      this.DoneAgentOutput = AgentOutput.type_with_custom_actions_flash_mode(
        this.DoneActionModel
      );
    } else if (this.settings.use_thinking) {
      this.DoneAgentOutput = AgentOutput.type_with_custom_actions(
        this.DoneActionModel
      );
    } else {
      this.DoneAgentOutput = AgentOutput.type_with_custom_actions_no_thinking(
        this.DoneActionModel
      );
    }
  }

  async run(
    max_steps = 500,
    on_step_start: AgentHookFunc<Context, AgentStructuredOutput> | null = null,
    on_step_end: AgentHookFunc<Context, AgentStructuredOutput> | null = null
  ) {
    let agent_run_error: string | null = null;
    this._force_exit_telemetry_logged = false;

    const signal_handler = new SignalHandler({
      pause_callback: this.pause.bind(this),
      resume_callback: this.resume.bind(this),
      custom_exit_callback: () => {
        this._log_agent_event(max_steps, 'SIGINT: Cancelled by user');
        this.telemetry?.flush?.();
        this._force_exit_telemetry_logged = true;
      },
      exit_on_second_int: true,
    });
    signal_handler.register();

    try {
      this._log_agent_run();

      this.logger.debug(
        `🔧 Agent setup: Task ID ${this.task_id.slice(-4)}, Session ID ${this.session_id.slice(-4)}, Browser Session ID ${
          this.browser_session?.id?.slice?.(-4) ?? 'None'
        }`
      );

      this._session_start_time = Date.now() / 1000;
      this._task_start_time = this._session_start_time;

      this.logger.debug('📡 Dispatching CreateAgentSessionEvent...');
      this.eventbus.dispatch(CreateAgentSessionEvent.fromAgent(this as any));

      this.logger.debug('📡 Dispatching CreateAgentTaskEvent...');
      this.eventbus.dispatch(CreateAgentTaskEvent.fromAgent(this as any));

      if (this.initial_actions?.length) {
        this.logger.debug(
          `⚡ Executing ${this.initial_actions.length} initial actions...`
        );
        const result = await this.multi_act(this.initial_actions, {
          check_for_new_elements: false,
        });
        this.state.last_result = result;
        this.logger.debug('✅ Initial actions completed');
      }

      this.logger.debug(
        `🔄 Starting main execution loop with max ${max_steps} steps...`
      );
      for (let step = 0; step < max_steps; step += 1) {
        if (this.state.paused) {
          this.logger.debug(
            `⏸️ Step ${step}: Agent paused, waiting to resume...`
          );
          await this.wait_until_resumed();
          signal_handler.reset();
        }

        if (this.state.consecutive_failures >= this._max_total_failures()) {
          this.logger.error(
            `❌ Stopping due to ${this.settings.max_failures} consecutive failures`
          );
          agent_run_error = `Stopped due to ${this.settings.max_failures} consecutive failures`;
          break;
        }

        if (this.state.stopped) {
          this.logger.info('🛑 Agent stopped');
          agent_run_error = 'Agent stopped programmatically';
          break;
        }

        if (this.register_external_agent_status_raise_error_callback) {
          const shouldRaise =
            await this.register_external_agent_status_raise_error_callback();
          if (shouldRaise) {
            agent_run_error = 'Agent stopped due to external request';
            break;
          }
        }

        if (on_step_start) {
          await on_step_start(this);
        }

        this.logger.debug(`🚶 Starting step ${step + 1}/${max_steps}...`);
        const step_info = new AgentStepInfo(step, max_steps);
        const stepAbortController = new AbortController();

        try {
          await this._executeWithTimeout(
            this._step(step_info, stepAbortController.signal),
            this.settings.step_timeout ?? 0,
            () => stepAbortController.abort()
          );
          this.logger.debug(`✅ Completed step ${step + 1}/${max_steps}`);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          const isTimeout = error instanceof ExecutionTimeoutError;

          if (isTimeout) {
            const timeoutMessage = `Step ${step + 1} timed out after ${this.settings.step_timeout} seconds`;
            this.logger.error(`⏰ ${timeoutMessage}`);
            this.state.consecutive_failures += 1;
            this.state.last_result = [
              new ActionResult({ error: timeoutMessage }),
            ];
            // JavaScript promises are not force-cancelable; stop the run loop
            // immediately to avoid overlapping timed-out steps with new steps.
            this.stop();
            agent_run_error = timeoutMessage;
            break;
          }

          this.logger.error(
            `❌ Unhandled step error at step ${step + 1}: ${message}`
          );
          this.state.consecutive_failures += 1;
          this.state.last_result = [
            new ActionResult({
              error: message || `Unhandled step error at step ${step + 1}`,
            }),
          ];
        }

        if (on_step_end) {
          await on_step_end(this);
        }

        if (this.history.is_done()) {
          this.logger.debug(`🎯 Task completed after ${step + 1} steps!`);
          await this._run_simple_judge();
          await this.log_completion();
          if (this.settings.use_judge) {
            await this._judge_and_log();
          }

          if (this.register_done_callback) {
            const maybePromise = this.register_done_callback(this.history);
            if (
              maybePromise &&
              typeof (maybePromise as Promise<void>).then === 'function'
            ) {
              await maybePromise;
            }
          }
          break;
        }

        if (step === max_steps - 1) {
          agent_run_error = 'Failed to complete task in maximum steps';
          this.history.add_item(
            new AgentHistory(
              null,
              [
                new ActionResult({
                  error: agent_run_error,
                  include_in_memory: true,
                }),
              ],
              new BrowserStateHistory('', '', [], [], null),
              null
            )
          );
          this.logger.info(`❌ ${agent_run_error}`);
        }
      }

      this.logger.debug('📊 Collecting usage summary...');
      this.history.usage =
        (await this.token_cost_service.get_usage_summary()) as UsageSummary | null;

      if (!this.history._output_model_schema && this.output_model_schema) {
        this.history._output_model_schema = this.output_model_schema;
      }

      this.logger.debug('🏁 Agent.run() completed successfully');
      return this.history;
    } catch (error) {
      agent_run_error = error instanceof Error ? error.message : String(error);
      this.logger.error(`Agent run failed with exception: ${agent_run_error}`);
      throw error;
    } finally {
      await this.token_cost_service.log_usage_summary();
      signal_handler.unregister();

      if (!this._force_exit_telemetry_logged) {
        try {
          this._log_agent_event(max_steps, agent_run_error);
        } catch (logError) {
          this.logger.error(
            `Failed to log telemetry event: ${String(logError)}`
          );
        } finally {
          try {
            this.telemetry?.flush?.();
          } catch (flushError) {
            this.logger.error(
              `Failed to flush telemetry client: ${String(flushError)}`
            );
          }
        }
      } else {
        this.logger.info('Telemetry for force exit (SIGINT) already logged.');
      }

      this.eventbus.dispatch(UpdateAgentTaskEvent.fromAgent(this as any));

      if (this.settings.generate_gif) {
        let output_path = 'agent_history.gif';
        if (typeof this.settings.generate_gif === 'string') {
          output_path = this.settings.generate_gif;
        }
        await create_history_gif(this.task, this.history, { output_path });
        if (fs.existsSync(output_path)) {
          const output_event =
            await CreateAgentOutputFileEvent.fromAgentAndFile(
              this as any,
              output_path
            );
          this.eventbus.dispatch(output_event);
        }
      }

      await this.eventbus.stop();
      await this.close();
    }
  }

  private async _executeWithTimeout<T>(
    promise: Promise<T>,
    timeoutSeconds: number,
    onTimeout?: () => void
  ) {
    if (!timeoutSeconds || timeoutSeconds <= 0) {
      return promise;
    }
    let timeoutHandle: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        try {
          onTimeout?.();
        } catch {
          // Ignore timeout callback errors and preserve timeout semantics.
        }
        reject(new ExecutionTimeoutError());
      }, timeoutSeconds * 1000);
    });
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  async _step(
    step_info: AgentStepInfo | null = null,
    signal: AbortSignal | null = null
  ) {
    await this._run_with_shared_session_step_lock(async () => {
      this._throwIfAborted(signal);
      this.step_start_time = Date.now() / 1000;
      let browser_state_summary: BrowserStateSummary | null = null;

      try {
        browser_state_summary = await this._prepare_context(step_info, signal);
        this._throwIfAborted(signal);
        await this._get_next_action(browser_state_summary, signal);
        this._throwIfAborted(signal);
        await this._execute_actions(signal);
        await this._post_process();
      } catch (error) {
        if (signal?.aborted) {
          const message =
            error instanceof Error ? error.message : String(error);
          this.logger.debug(`Step aborted before completion: ${message}`);
        } else {
          await this._handle_step_error(error as Error);
        }
      } finally {
        await this._finalize(browser_state_summary);
      }
    });
  }

  private async _prepare_context(
    step_info: AgentStepInfo | null = null,
    signal: AbortSignal | null = null
  ) {
    if (!this.browser_session) {
      throw new Error('BrowserSession is not set up');
    }

    this._throwIfAborted(signal);
    await this._restore_shared_pinned_tab_if_needed();
    this._throwIfAborted(signal);

    this.logger.debug(
      `🌐 Step ${this.state.n_steps}: Getting browser state...`
    );
    const browser_state_summary: BrowserStateSummary =
      await this.browser_session.get_browser_state_with_recovery?.({
        cache_clickable_elements_hashes: true,
        include_screenshot: this.settings.use_vision,
        include_recent_events: this.settings.include_recent_events,
        signal,
      });
    this._throwIfAborted(signal);
    const current_page = await this.browser_session.get_current_page?.();

    await this._check_and_update_downloads(
      `Step ${this.state.n_steps}: after getting browser state`
    );

    this._log_step_context(current_page, browser_state_summary);
    await this._storeScreenshotForStep(browser_state_summary);
    await this._raise_if_stopped_or_paused();

    this.logger.debug(
      `📝 Step ${this.state.n_steps}: Updating action models...`
    );
    this._throwIfAborted(signal);
    await this._updateActionModelsForPage(current_page);

    const page_filtered_actions =
      this.controller.registry.get_prompt_description(current_page);

    this.logger.debug(
      `💬 Step ${this.state.n_steps}: Creating state messages for context...`
    );
    this._message_manager.prepare_step_state(
      browser_state_summary,
      this.state.last_model_output,
      this.state.last_result,
      step_info,
      this.sensitive_data ?? null
    );
    await this._maybe_compact_messages(step_info);
    this._message_manager.create_state_messages(
      browser_state_summary,
      this.state.last_model_output,
      this.state.last_result,
      step_info,
      this.settings.use_vision,
      page_filtered_actions || null,
      this.sensitive_data ?? null,
      this.available_file_paths,
      this.settings.include_recent_events,
      this._render_plan_description(),
      true
    );

    this._inject_budget_warning(step_info);
    this._inject_replan_nudge();
    this._inject_exploration_nudge();
    this._update_loop_detector_page_state(browser_state_summary);
    this._inject_loop_detection_nudge();
    await this._handle_final_step(step_info);
    await this._handle_failure_limit_recovery();
    return browser_state_summary;
  }

  private async _maybe_compact_messages(step_info: AgentStepInfo | null = null) {
    const settings = this.settings.message_compaction;
    if (!settings || !settings.enabled) {
      return;
    }

    const compactionLlm =
      settings.compaction_llm ??
      (this.settings.page_extraction_llm as BaseChatModel | null) ??
      this.llm;

    await this._message_manager.maybe_compact_messages(
      compactionLlm,
      settings,
      step_info
    );
  }

  private async _storeScreenshotForStep(
    browser_state_summary: BrowserStateSummary
  ) {
    this._current_screenshot_path = null;
    if (!this.screenshot_service || !browser_state_summary?.screenshot) {
      return;
    }

    try {
      this._current_screenshot_path =
        await this.screenshot_service.store_screenshot(
          browser_state_summary.screenshot,
          this.state.n_steps
        );
      this.logger.debug(
        `📸 Step ${this.state.n_steps}: Stored screenshot at ${this._current_screenshot_path}`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `📸 Failed to store screenshot for step ${this.state.n_steps}: ${message}`
      );
      this._current_screenshot_path = null;
    }
  }

  private async _get_next_action(
    browser_state_summary: BrowserStateSummary,
    signal: AbortSignal | null = null
  ) {
    this._throwIfAborted(signal);
    const input_messages = this._message_manager.get_messages();
    this.logger.debug(
      `🤖 Step ${this.state.n_steps}: Calling LLM with ${input_messages.length} messages (model: ${this.llm.model})...`
    );

    let model_output: AgentOutput;
    const llmAbortController = new AbortController();
    const removeAbortRelay = this._relayAbortSignal(signal, llmAbortController);
    try {
      model_output = await this._executeWithTimeout(
        this._get_model_output_with_retry(
          input_messages,
          llmAbortController.signal
        ),
        this.settings.llm_timeout,
        () => llmAbortController.abort()
      );
    } catch (error) {
      if (error instanceof ExecutionTimeoutError) {
        throw new Error(
          `LLM call timed out after ${this.settings.llm_timeout} seconds. Keep your thinking and output short.`
        );
      }
      throw error;
    } finally {
      removeAbortRelay();
    }

    this._throwIfAborted(signal);
    this.state.last_model_output = model_output;
    let actions: Array<Record<string, Record<string, unknown>>> = [];
    if (model_output) {
      this._logNextActionSummary(model_output);
      actions = model_output.action.map((a) => a.model_dump());
    }
    await this._raise_if_stopped_or_paused();
    await this._handle_post_llm_processing(
      browser_state_summary,
      input_messages,
      actions
    );
    await this._raise_if_stopped_or_paused();
  }

  private async _execute_actions(signal: AbortSignal | null = null) {
    if (!this.state.last_model_output) {
      throw new Error('No model output to execute actions from');
    }

    this.logger.debug(
      `⚡ Step ${this.state.n_steps}: Executing ${this.state.last_model_output.action.length} actions...`
    );
    const result = await this.multi_act(
      this.state.last_model_output.action.map((a) => a.model_dump()),
      { signal }
    );
    this.logger.debug(`✅ Step ${this.state.n_steps}: Actions completed`);
    this.state.last_result = result;
  }

  private async _post_process() {
    if (!this.browser_session) {
      throw new Error('BrowserSession is not set up');
    }
    await this._check_and_update_downloads('after executing actions');
    if (this.state.last_model_output) {
      this._update_plan_from_model_output(this.state.last_model_output);
    }
    this._update_loop_detector_actions();
    this.state.consecutive_failures = 0;
  }

  async multi_act(
    actions: Array<Record<string, Record<string, unknown>>>,
    options: {
      check_for_new_elements?: boolean;
      signal?: AbortSignal | null;
    } = {}
  ) {
    const { check_for_new_elements = true, signal = null } = options;
    const results: ActionResult[] = [];

    if (!this.browser_session) {
      throw new Error('BrowserSession is not set up');
    }

    await this._restore_shared_pinned_tab_if_needed();

    // ==================== Selector Map Caching ====================
    // Check if any action uses an index, if so cache the selector map
    let cached_selector_map: Record<number, any> = {};
    let cached_path_hashes: Set<string> = new Set();

    for (const action of actions) {
      const actionName = Object.keys(action)[0];
      const actionParams = action[actionName];
      const index = (actionParams as any)?.index;

      if (index !== null && index !== undefined) {
        cached_selector_map =
          (await this.browser_session.get_selector_map?.()) || {};
        cached_path_hashes = new Set(
          Object.values(cached_selector_map)
            .map((e: any) => e?.hash?.branch_path_hash)
            .filter(Boolean)
        );
        break;
      }
    }

    // ==================== Execute Actions ====================
    for (let i = 0; i < actions.length; i++) {
      this._throwIfAborted(signal);
      const action = actions[i];
      const actionName = Object.keys(action)[0];
      const actionParams = action[actionName];

      // ==================== Done Action Position Validation ====================
      // ONLY ALLOW TO CALL `done` IF IT IS A SINGLE ACTION
      if (i > 0 && actionName === 'done') {
        const msg = `Done action is allowed only as a single action - stopped after action ${i} / ${actions.length}.`;
        this.logger.info(msg);
        break;
      }

      // ==================== Index Change & New Element Detection ====================
      if (i > 0) {
        const currentIndex = (actionParams as any)?.index;
        if (currentIndex !== null && currentIndex !== undefined) {
          this._throwIfAborted(signal);
          // Get new browser state after previous action
          const new_browser_state_summary =
            await this.browser_session.get_browser_state_with_recovery?.({
              cache_clickable_elements_hashes: false,
              include_screenshot: false,
              signal,
            });
          const new_selector_map =
            new_browser_state_summary?.selector_map || {};

          // Detect index change after previous action
          const orig_target = cached_selector_map[currentIndex];
          const orig_target_hash = orig_target?.hash?.branch_path_hash || null;
          const new_target = new_selector_map[currentIndex];
          const new_target_hash = new_target?.hash?.branch_path_hash || null;

          if (orig_target_hash !== new_target_hash) {
            const msg = `Element index changed after action ${i} / ${actions.length}, because page changed.`;
            this.logger.info(msg);
            results.push(
              new ActionResult({
                extracted_content: msg,
                include_in_memory: true,
                long_term_memory: msg,
              })
            );
            break;
          }

          // Check for new elements on the page
          const new_path_hashes = new Set(
            Object.values(new_selector_map)
              .map((e: any) => e?.hash?.branch_path_hash)
              .filter(Boolean)
          );

          // Check if new elements appeared (new_path_hashes is not a subset of cached_path_hashes)
          const has_new_elements = Array.from(new_path_hashes).some(
            (hash) => !cached_path_hashes.has(hash)
          );

          if (check_for_new_elements && has_new_elements) {
            const msg = `Something new appeared after action ${i} / ${actions.length}, following actions are NOT executed and should be retried.`;
            this.logger.info(msg);
            results.push(
              new ActionResult({
                extracted_content: msg,
                include_in_memory: true,
                long_term_memory: msg,
              })
            );
            break;
          }
        }

        // Wait between actions
        const wait_time =
          (this.browser_session as any)?.browser_profile
            ?.wait_between_actions || 0;
        if (wait_time > 0) {
          await this._sleep(wait_time, signal);
        }
      }

      // ==================== Execute Action ====================
      try {
        this._throwIfAborted(signal);
        await this._raise_if_stopped_or_paused();

        const actResult = await (
          this.controller.registry as any
        ).execute_action(actionName, actionParams, {
          browser_session: this.browser_session,
          page_extraction_llm: this.settings.page_extraction_llm,
          sensitive_data: this.sensitive_data,
          available_file_paths: this.available_file_paths,
          file_system: this.file_system,
          context: this.context ?? undefined,
          signal,
        });
        results.push(actResult);

        // Log action execution
        this.logger.info(
          `☑️ Executed action ${i + 1}/${actions.length}: ${actionName}(${JSON.stringify(actionParams)})`
        );

        // Break early if done, error, or last action
        if (
          results[results.length - 1]?.is_done ||
          results[results.length - 1]?.error ||
          i === actions.length - 1
        ) {
          this._capture_shared_pinned_tab();
          break;
        }
        this._capture_shared_pinned_tab();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`❌ Action ${i + 1} failed: ${message}`);
        this._capture_shared_pinned_tab();
        throw error;
      }
    }

    return results;
  }

  async rerun_history(
    history: AgentHistoryList,
    options: RerunHistoryOptions = {}
  ): Promise<ActionResult[]> {
    const {
      max_retries = 3,
      skip_failures = false,
      delay_between_actions = 2,
      max_step_interval = 45,
      signal = null,
    } = options;

    this._throwIfAborted(signal);
    if (this.initial_actions?.length) {
      const initialResult = await this.multi_act(this.initial_actions, {
        signal,
      });
      this.state.last_result = initialResult;
    }

    const results: ActionResult[] = [];

    for (let index = 0; index < history.history.length; index++) {
      this._throwIfAborted(signal);
      const historyItem = history.history[index];
      const goal = historyItem.model_output?.current_state?.next_goal ?? '';
      const stepNumber = historyItem.metadata?.step_number ?? index + 1;
      const stepName = stepNumber === 0 ? 'Initial actions' : `Step ${stepNumber}`;
      const savedInterval = historyItem.metadata?.step_interval;
      let stepDelay = delay_between_actions;
      let delaySource = `using default delay=${this._formatDelaySeconds(stepDelay)}`;
      if (typeof savedInterval === 'number' && Number.isFinite(savedInterval)) {
        stepDelay = Math.min(savedInterval, max_step_interval);
        if (savedInterval > max_step_interval) {
          delaySource = `capped to ${this._formatDelaySeconds(stepDelay)} (saved was ${savedInterval.toFixed(1)}s)`;
        } else {
          delaySource = `using saved step_interval=${this._formatDelaySeconds(stepDelay)}`;
        }
      }
      this.logger.info(
        `Replaying ${stepName} (${index + 1}/${history.history.length}) [${delaySource}]: ${goal}`
      );

      const actions = historyItem.model_output?.action ?? [];
      const hasValidAction =
        actions.length && !actions.every((action) => action == null);
      if (!historyItem.model_output || !hasValidAction) {
        this.logger.warning(`Step ${index + 1}: No action to replay, skipping`);
        results.push(new ActionResult({ error: 'No action to replay' }));
        continue;
      }

      const originalErrors = Array.isArray(historyItem.result)
        ? historyItem.result
            .map((result) => result?.error)
            .filter((error): error is string => typeof error === 'string')
        : [];
      if (originalErrors.length && skip_failures) {
        const firstError = originalErrors[0] ?? 'unknown';
        const preview =
          firstError.length > 100 ? `${firstError.slice(0, 100)}...` : firstError;
        this.logger.warning(
          `${stepName}: Original step had error(s), skipping (skip_failures=true): ${preview}`
        );
        results.push(
          new ActionResult({
            error: `Skipped - original step had error: ${preview}`,
          })
        );
        continue;
      }

      let attempt = 0;
      while (attempt < max_retries) {
        this._throwIfAborted(signal);
        try {
          const stepResult = await this._execute_history_step(
            historyItem,
            stepDelay,
            signal
          );
          results.push(...stepResult);
          break;
        } catch (error) {
          if (
            signal?.aborted ||
            (error instanceof Error && error.name === 'AbortError')
          ) {
            throw this._createAbortError();
          }
          attempt += 1;
          if (attempt === max_retries) {
            const message = `Step ${index + 1} failed after ${max_retries} attempts: ${
              (error as Error).message ?? error
            }`;
            this.logger.error(message);
            const failure = new ActionResult({ error: message });
            results.push(failure);
            if (!skip_failures) {
              throw new Error(message);
            }
          } else {
            this.logger.warning(
              `Step ${index + 1} failed (attempt ${attempt}/${max_retries}), retrying...`
            );
            await this._sleep(stepDelay, signal);
          }
        }
      }
    }

    return results;
  }

  private async _execute_history_step(
    historyItem: AgentHistory,
    delaySeconds: number,
    signal: AbortSignal | null = null
  ) {
    this._throwIfAborted(signal);
    if (!this.browser_session) {
      throw new Error('BrowserSession is not set up');
    }
    const browser_state_summary: BrowserStateSummary | null =
      await this.browser_session.get_browser_state_with_recovery?.({
        cache_clickable_elements_hashes: false,
        include_screenshot: false,
        signal,
      });
    if (!browser_state_summary || !historyItem.model_output) {
      throw new Error('Invalid browser state or model output');
    }

    const interactedElements = historyItem.state?.interacted_element ?? [];
    const updatedActions: Array<Record<string, Record<string, unknown>>> = [];
    for (
      let actionIndex = 0;
      actionIndex < historyItem.model_output.action.length;
      actionIndex++
    ) {
      this._throwIfAborted(signal);
      const originalAction = historyItem.model_output.action[actionIndex];
      if (!originalAction) {
        continue;
      }
      const updatedAction = await this._update_action_indices(
        this._coerceHistoryElement(interactedElements[actionIndex]),
        originalAction,
        browser_state_summary
      );
      if (!updatedAction) {
        throw new Error(
          `Could not find matching element ${actionIndex} in current page`
        );
      }

      if (typeof (updatedAction as any)?.model_dump === 'function') {
        updatedActions.push(
          (updatedAction as any).model_dump({ exclude_unset: true })
        );
      } else {
        updatedActions.push(updatedAction as any);
      }
    }

    this._throwIfAborted(signal);
    const result = await this.multi_act(updatedActions, { signal });
    await this._sleep(delaySeconds, signal);
    return result;
  }

  private async _update_action_indices(
    historicalElement: DOMHistoryElement | null,
    action: any,
    browserStateSummary: BrowserStateSummary
  ) {
    if (!historicalElement || !browserStateSummary?.element_tree) {
      return action;
    }

    const currentNode = HistoryTreeProcessor.find_history_element_in_tree(
      historicalElement,
      browserStateSummary.element_tree
    );
    if (!currentNode || currentNode.highlight_index == null) {
      return null;
    }

    const currentIndex =
      typeof action?.get_index === 'function' ? action.get_index() : null;
    if (
      currentIndex !== currentNode.highlight_index &&
      typeof action?.set_index === 'function'
    ) {
      action.set_index(currentNode.highlight_index);
      this.logger.info(
        `Element moved in DOM, updated index from ${currentIndex} to ${currentNode.highlight_index}`
      );
    }

    return action;
  }

  async load_and_rerun(
    history_file: string | null = null,
    options: RerunHistoryOptions = {}
  ) {
    const target = history_file ?? 'AgentHistory.json';
    const history = AgentHistoryList.load_from_file(target, this.AgentOutput);
    return this.rerun_history(history, options);
  }

  save_history(file_path: string | null = null) {
    const target = file_path ?? 'AgentHistory.json';
    this.history.save_to_file(target);
  }

  private _coerceHistoryElement(
    element:
      | DOMHistoryElement
      | (Partial<DOMHistoryElement> & Record<string, any>)
      | null
      | undefined
  ): DOMHistoryElement | null {
    if (!element) {
      return null;
    }
    if (element instanceof DOMHistoryElement) {
      return element;
    }
    const payload = element as Record<string, any>;
    return new DOMHistoryElement(
      payload.tag_name ?? '',
      payload.xpath ?? '',
      payload.highlight_index ?? null,
      payload.entire_parent_branch_path ?? [],
      payload.attributes ?? {},
      payload.shadow_root ?? false,
      payload.css_selector ?? null,
      payload.page_coordinates ?? null,
      payload.viewport_coordinates ?? null,
      payload.viewport_info ?? null
    );
  }

  private _createAbortError(): Error {
    const error = new Error('Operation aborted');
    error.name = 'AbortError';
    return error;
  }

  private _throwIfAborted(signal: AbortSignal | null = null) {
    if (signal?.aborted) {
      throw this._createAbortError();
    }
  }

  private _relayAbortSignal(
    signal: AbortSignal | null,
    controller: AbortController
  ): () => void {
    if (!signal) {
      return () => {};
    }
    if (signal.aborted) {
      controller.abort(signal.reason);
      return () => {};
    }
    const handleAbort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', handleAbort, { once: true });
    return () => signal.removeEventListener('abort', handleAbort);
  }

  private _formatDelaySeconds(delaySeconds: number) {
    if (delaySeconds < 1) {
      return `${Math.round(delaySeconds * 1000)}ms`;
    }
    return `${delaySeconds.toFixed(1)}s`;
  }

  private async _sleep(seconds: number, signal: AbortSignal | null = null) {
    if (seconds <= 0) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        resolve();
      }, seconds * 1000);

      const onAbort = () => {
        clearTimeout(timeout);
        cleanup();
        reject(this._createAbortError());
      };

      const cleanup = () => {
        signal?.removeEventListener('abort', onAbort);
      };

      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  async wait_until_resumed() {
    if (!this.state.paused) {
      return;
    }
    if (!this._external_pause_event.resolve) {
      this._external_pause_event.promise = new Promise<void>((resolve) => {
        this._external_pause_event.resolve = resolve;
      });
    }
    await this._external_pause_event.promise;
  }

  async log_completion() {
    this.logger.info('✅ Agent completed task');
  }

  pause() {
    if (this.state.paused) {
      return;
    }
    this.state.paused = true;
    this._external_pause_event.promise = new Promise<void>((resolve) => {
      this._external_pause_event.resolve = resolve;
    });
  }

  resume() {
    if (!this.state.paused) {
      return;
    }
    this.state.paused = false;
    this._external_pause_event.resolve?.();
    this._external_pause_event.resolve = null;
    this._external_pause_event.promise = Promise.resolve();
  }

  stop() {
    this.state.stopped = true;
    this.resume();
  }

  async close() {
    if (this._closePromise) {
      await this._closePromise;
      return;
    }

    const browser_session = this.browser_session;
    if (!browser_session) {
      return;
    }

    this._closePromise = (async () => {
      this._release_browser_session_claim(browser_session);

      if (this._has_any_browser_session_attachments(browser_session)) {
        this.logger.debug(
          'Skipping BrowserSession shutdown because other attached Agents are still active.'
        );
        return;
      }

      this._cleanup_shared_session_step_lock_if_unused(browser_session);

      try {
        if (typeof (browser_session as any).stop === 'function') {
          await (browser_session as any).stop();
        } else if (typeof (browser_session as any).close === 'function') {
          await (browser_session as any).close();
        }
      } catch (error) {
        this.logger.error(
          `Error during agent cleanup: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    })();

    await this._closePromise;
  }

  /**
   * Get the trace and trace_details objects for the agent
   * Contains comprehensive metadata about the agent run for debugging and analysis
   */
  get_trace_object(): {
    trace: Record<string, any>;
    trace_details: Record<string, any>;
  } {
    // Helper to extract website from task text
    const extract_task_website = (task_text: string): string | null => {
      const url_pattern =
        /https?:\/\/[^\s<>"']+|www\.[^\s<>"']+|[^\s<>"']+\.[a-z]{2,}(?:\/[^\s<>"']*)?/i;
      const match = task_text.match(url_pattern);
      return match ? match[0] : null;
    };

    // Helper to get complete history without screenshots
    const get_complete_history_without_screenshots = (
      history_data: any
    ): string => {
      if (history_data.history) {
        for (const item of history_data.history) {
          if (item.state && item.state.screenshot) {
            item.state.screenshot = null;
          }
        }
      }
      return JSON.stringify(history_data);
    };

    // Generate autogenerated fields
    const trace_id = uuid7str();
    const timestamp = new Date().toISOString();

    // Collect data
    const structured_output = this.history.structured_output;
    const structured_output_json = structured_output
      ? JSON.stringify(structured_output)
      : null;
    const final_result = this.history.final_result();
    const action_history = this.history.action_history();
    const action_errors = this.history.errors();
    const urls = this.history.urls();
    const usage = this.history.usage;

    // Build trace object
    const trace = {
      // Autogenerated fields
      trace_id,
      timestamp,
      browser_use_version: this.version,
      git_info: null, // Can be enhanced if needed

      // Direct agent properties
      model: (this.llm as any).model || 'unknown',
      settings: this.settings ? JSON.stringify(this.settings) : null,
      task_id: this.task_id,
      task_truncated:
        this.task.length > 20000 ? this.task.slice(0, 20000) : this.task,
      task_website: extract_task_website(this.task),

      // AgentHistoryList methods
      structured_output_truncated:
        structured_output_json && structured_output_json.length > 20000
          ? structured_output_json.slice(0, 20000)
          : structured_output_json,
      action_history_truncated: action_history
        ? JSON.stringify(action_history)
        : null,
      action_errors: action_errors ? JSON.stringify(action_errors) : null,
      urls: urls ? JSON.stringify(urls) : null,
      final_result_response_truncated:
        final_result && final_result.length > 20000
          ? final_result.slice(0, 20000)
          : final_result,
      self_report_completed: this.history.is_done() ? 1 : 0,
      self_report_success: this.history.is_successful() ? 1 : 0,
      duration: this.history.total_duration_seconds(),
      steps_taken: this.history.number_of_steps(),
      usage: usage ? JSON.stringify(usage) : null,
    };

    // Build trace_details object
    const trace_details = {
      // Autogenerated fields (ensure same as trace)
      trace_id,
      timestamp,

      // Direct agent properties
      task: this.task,

      // AgentHistoryList methods
      structured_output: structured_output_json,
      final_result_response: final_result,
      complete_history: get_complete_history_without_screenshots(
        this.history.model_dump?.() || {}
      ),
    };

    return { trace, trace_details };
  }

  private _log_agent_run() {
    this.logger.info(`🧠 Starting agent for task: ${this.task}`);
  }

  private _raise_if_stopped_or_paused() {
    if (this.state.stopped) {
      throw new Error('Agent stopped');
    }
    if (this.state.paused) {
      throw new Error('Agent paused');
    }
  }

  private async _handle_post_llm_processing(
    browser_state_summary: BrowserStateSummary,
    input_messages: any[],
    _actions: Array<Record<string, Record<string, unknown>>> = []
  ) {
    if (this.register_new_step_callback && this.state.last_model_output) {
      await this.register_new_step_callback(
        browser_state_summary,
        this.state.last_model_output,
        this.state.n_steps
      );
    }
    log_response(this.state.last_model_output!, this.controller, this.logger);
    if (this.settings.save_conversation_path) {
      const dir = this.settings.save_conversation_path;
      const filepath = path.join(dir, `step_${this.state.n_steps}.json`);
      await fs.promises.mkdir(path.dirname(filepath), { recursive: true });
      await fs.promises.writeFile(
        filepath,
        JSON.stringify(
          {
            messages: input_messages,
            response: this.state.last_model_output?.model_dump(),
          },
          null,
          2
        ),
        this.settings.save_conversation_path_encoding as BufferEncoding
      );
    }
  }

  /**
   * Handle all types of errors that can occur during a step
   * Implements comprehensive error categorization with:
   * - Validation error hints
   * - Rate limit auto-retry
   * - Parse error guidance
   * - Token limit warnings
   * - Network error detection
   * - Browser error handling
   * - LLM-specific errors
   */
  private async _handle_step_error(error: Error) {
    const include_trace = this.logger.level === 'debug';
    let error_msg = AgentError.format_error(error, include_trace);
    const prefix =
      `❌ Result failed ${this.state.consecutive_failures + 1}/${this._max_total_failures()} times:\n `;
    this.state.consecutive_failures += 1;

    // 1. Handle Validation Errors (Pydantic/Zod)
    if (
      error.name === 'ValidationError' ||
      error.name === 'ZodError' ||
      error instanceof TypeError
    ) {
      this.logger.error(`${prefix}${error_msg}`);

      // Add context hint for validation errors
      if (
        error_msg.includes('Max token limit reached') ||
        error_msg.includes('token')
      ) {
        error_msg +=
          '\n\n💡 Hint: Your response was too long. Keep your thinking and output concise.';
      } else {
        error_msg +=
          '\n\n💡 Hint: Your output format was invalid. Please follow the exact schema structure required for actions.';
      }
    }
    // 2. Handle Interrupted Errors
    else if (
      error.message.includes('interrupted') ||
      error.message.includes('abort') ||
      error.message.includes('InterruptedError')
    ) {
      error_msg = `The agent was interrupted mid-step${error.message ? ` - ${error.message}` : ''}`;
      this.logger.error(`${prefix}${error_msg}`);
    }
    // 3. Handle Parse Errors
    else if (
      error_msg.includes('Could not parse') ||
      error_msg.includes('tool_use_failed') ||
      error_msg.includes('Failed to parse')
    ) {
      this.logger.debug(
        `Model: ${(this.llm as any).model} failed to parse response`
      );
      error_msg +=
        '\n\n💡 Hint: Return a valid JSON object with the required fields.';
      this.logger.error(`${prefix}${error_msg}`);
    }
    // 4. Handle Rate Limit Errors (OpenAI, Anthropic, Google)
    else if (this._isRateLimitError(error, error_msg)) {
      this.logger.warning(`${prefix}${error_msg}`);
      this.logger.warning(
        `⏳ Rate limit detected, waiting ${this.settings.retry_delay}s before retrying...`
      );

      // Auto-retry: wait before continuing
      await this._sleep(this.settings.retry_delay);
      error_msg += `\n\n⏳ Retrying after ${this.settings.retry_delay}s delay...`;
    }
    // 5. Handle Network Errors
    else if (this._isNetworkError(error, error_msg)) {
      this.logger.error(`${prefix}${error_msg}`);
      error_msg +=
        '\n\n🌐 Network error detected. Please check your internet connection and try again.';
    }
    // 6. Handle Browser Errors
    else if (this._isBrowserError(error, error_msg)) {
      this.logger.error(`${prefix}${error_msg}`);
      error_msg +=
        '\n\n🌍 Browser error detected. The page may have crashed or become unresponsive.';
    }
    // 7. Handle Timeout Errors
    else if (this._isTimeoutError(error, error_msg)) {
      this.logger.error(`${prefix}${error_msg}`);
      error_msg +=
        '\n\n⏱️ Timeout error. The operation took too long to complete.';
    }
    // 8. Handle All Other Errors
    else {
      this.logger.error(`${prefix}${error_msg}`);
    }

    this.state.last_result = [new ActionResult({ error: error_msg })];
  }

  /**
   * Check if an error is a network error
   */
  private _isNetworkError(error: Error, error_msg: string): boolean {
    const networkPatterns = [
      'ECONNREFUSED',
      'ENOTFOUND',
      'ETIMEDOUT',
      'ECONNRESET',
      'network error',
      'Network Error',
      'fetch failed',
      'socket hang up',
      'getaddrinfo',
    ];

    return networkPatterns.some(
      (pattern) =>
        error_msg.includes(pattern) || error.message.includes(pattern)
    );
  }

  /**
   * Check if an error is a browser/Playwright error
   */
  private _isBrowserError(error: Error, error_msg: string): boolean {
    const browserPatterns = [
      'Target page',
      'Page crashed',
      'Browser closed',
      'Context closed',
      'Frame detached',
      'Execution context',
      'Navigation failed',
      'Protocol error',
    ];

    return browserPatterns.some(
      (pattern) =>
        error_msg.includes(pattern) || error.message.includes(pattern)
    );
  }

  /**
   * Check if an error is a timeout error
   */
  private _isTimeoutError(error: Error, error_msg: string): boolean {
    const timeoutPatterns = [
      'timeout',
      'Timeout',
      'timed out',
      'time limit exceeded',
      'deadline exceeded',
    ];

    return timeoutPatterns.some((pattern) =>
      error_msg.toLowerCase().includes(pattern.toLowerCase())
    );
  }

  /**
   * Check if an error is a rate limit error from various LLM providers
   */
  private _isRateLimitError(error: Error, error_msg: string): boolean {
    // Check error class name
    const errorClassName = error.constructor.name;
    if (
      errorClassName === 'RateLimitError' ||
      errorClassName === 'ResourceExhausted'
    ) {
      return true;
    }

    // Check error message patterns
    const rateLimitPatterns = [
      'rate_limit_exceeded',
      'rate limit exceeded',
      'RateLimitError',
      'RESOURCE_EXHAUSTED',
      'ResourceExhausted',
      'tokens per minute',
      'TPM',
      'requests per minute',
      'RPM',
      'quota exceeded',
      'too many requests',
      '429',
    ];

    return rateLimitPatterns.some((pattern) =>
      error_msg.toLowerCase().includes(pattern.toLowerCase())
    );
  }

  private async _finalize(browser_state_summary: BrowserStateSummary | null) {
    const step_end_time = Date.now() / 1000;
    this._enforceDoneOnlyForCurrentStep = false;
    if (!this.state.last_result) {
      return;
    }

    if (browser_state_summary) {
      let stepInterval: number | null = null;
      if (this.history.history.length > 0) {
        const lastMetadata = this.history.history.at(-1)?.metadata;
        if (lastMetadata) {
          stepInterval = Math.max(
            0,
            lastMetadata.step_end_time - lastMetadata.step_start_time
          );
        }
      }
      const metadata = new StepMetadata(
        this.step_start_time,
        step_end_time,
        this.state.n_steps,
        stepInterval
      );
      await this._make_history_item(
        this.state.last_model_output,
        browser_state_summary,
        this.state.last_result,
        metadata,
        this._message_manager.last_state_message_text
      );
    }

    this._log_step_completion_summary(
      this.step_start_time,
      this.state.last_result
    );
    this.save_file_system_state();

    if (browser_state_summary && this.state.last_model_output) {
      const actions_data = this.state.last_model_output.action.map((action) =>
        typeof (action as any)?.model_dump === 'function'
          ? (action as any).model_dump()
          : action
      );
      const step_event = CreateAgentStepEvent.fromAgentStep(
        this as any,
        this.state.last_model_output,
        this.state.last_result,
        actions_data,
        browser_state_summary
      );
      this.eventbus.dispatch(step_event);
    }

    this.state.n_steps += 1;
  }

  private async _handle_final_step(step_info: AgentStepInfo | null = null) {
    const isLastStep = Boolean(step_info && step_info.is_last_step());
    this._enforceDoneOnlyForCurrentStep = isLastStep;

    if (isLastStep) {
      const message =
        'Now comes your last step. Use only the "done" action now. No other actions - so here your action sequence must have length 1.\n' +
        'If the task is not yet fully finished as requested by the user, set success in "done" to false! E.g. if not all steps are fully completed.\n' +
        'If the task is fully finished, set success in "done" to true.\n' +
        'Include everything you found out for the ultimate task in the done text.';
      this._message_manager._add_context_message(new UserMessage(message));
      this.logger.info('⚠️ Approaching last step. Enforcing done-only action.');
    }
  }

  private _max_total_failures() {
    return (
      this.settings.max_failures +
      Number(this.settings.final_response_after_failure)
    );
  }

  private async _handle_failure_limit_recovery() {
    if (
      !this.settings.final_response_after_failure ||
      this.state.consecutive_failures < this.settings.max_failures
    ) {
      return;
    }

    const message =
      `You failed ${this.settings.max_failures} times. Therefore we terminate the agent.\n` +
      'Your only tool available is the "done" tool. No other tools are available.\n' +
      'If the task is not fully finished as requested, set success in "done" to false.\n' +
      'If the task is fully finished, set success in "done" to true.\n' +
      'Include everything you found out for the task in the done text.';
    this._message_manager._add_context_message(new UserMessage(message));
    this._enforceDoneOnlyForCurrentStep = true;
    this.logger.info(
      '⚠️ Max failures reached. Enforcing done-only recovery step.'
    );
  }

  private _update_plan_from_model_output(modelOutput: AgentOutput) {
    if (!this.settings.enable_planning) {
      return;
    }

    if (Array.isArray(modelOutput.plan_update)) {
      this.state.plan = modelOutput.plan_update.map(
        (stepText) =>
          new PlanItem({
            text: stepText,
            status: 'pending',
          })
      );
      this.state.current_plan_item_index = 0;
      this.state.plan_generation_step = this.state.n_steps;
      if (this.state.plan.length > 0) {
        this.state.plan[0].status = 'current';
      }
      this.logger.info(
        `📋 Plan updated with ${this.state.plan.length} steps`
      );
      return;
    }

    if (
      typeof modelOutput.current_plan_item !== 'number' ||
      !this.state.plan ||
      this.state.plan.length === 0
    ) {
      return;
    }

    const oldIndex = this.state.current_plan_item_index;
    const newIndex = Math.max(
      0,
      Math.min(modelOutput.current_plan_item, this.state.plan.length - 1)
    );

    for (let i = oldIndex; i < newIndex; i += 1) {
      if (
        this.state.plan[i] &&
        (this.state.plan[i].status === 'current' ||
          this.state.plan[i].status === 'pending')
      ) {
        this.state.plan[i].status = 'done';
      }
    }

    if (this.state.plan[newIndex]) {
      this.state.plan[newIndex].status = 'current';
    }
    this.state.current_plan_item_index = newIndex;
  }

  private _render_plan_description() {
    if (!this.settings.enable_planning || !this.state.plan) {
      return null;
    }

    const markers: Record<string, string> = {
      done: '[x]',
      current: '[>]',
      pending: '[ ]',
      skipped: '[-]',
    };
    return this.state.plan
      .map(
        (step, index) =>
          `${markers[step.status] ?? '[ ]'} ${index}: ${step.text}`
      )
      .join('\n');
  }

  private _inject_replan_nudge() {
    if (!this.settings.enable_planning || !this.state.plan) {
      return;
    }
    if (this.settings.planning_replan_on_stall <= 0) {
      return;
    }
    if (
      this.state.consecutive_failures <
      this.settings.planning_replan_on_stall
    ) {
      return;
    }
    const message =
      'REPLAN SUGGESTED: You have failed ' +
      `${this.state.consecutive_failures} consecutive times. ` +
      'Your current plan may need revision. ' +
      'Output a new `plan_update` with revised steps to recover.';
    this.logger.info(
      `📋 Replan nudge injected after ${this.state.consecutive_failures} consecutive failures`
    );
    this._message_manager._add_context_message(new UserMessage(message));
  }

  private _inject_exploration_nudge() {
    if (!this.settings.enable_planning || this.state.plan) {
      return;
    }
    if (this.settings.planning_exploration_limit <= 0) {
      return;
    }
    if (this.state.n_steps < this.settings.planning_exploration_limit) {
      return;
    }
    const message =
      'PLANNING NUDGE: You have taken ' +
      `${this.state.n_steps} steps without creating a plan. ` +
      'If the task is complex, output a `plan_update` with clear todo items now. ' +
      'If the task is already done or nearly done, call `done` instead.';
    this.logger.info(
      `📋 Exploration nudge injected after ${this.state.n_steps} steps without a plan`
    );
    this._message_manager._add_context_message(new UserMessage(message));
  }

  private _inject_loop_detection_nudge() {
    if (!this.settings.loop_detection_enabled) {
      return;
    }
    const nudge = this.state.loop_detector.get_nudge_message();
    if (!nudge) {
      return;
    }
    this.logger.info(
      `🔁 Loop detection nudge injected (repetition=${this.state.loop_detector.max_repetition_count}, stagnation=${this.state.loop_detector.consecutive_stagnant_pages})`
    );
    this._message_manager._add_context_message(new UserMessage(nudge));
  }

  private _update_loop_detector_actions() {
    if (!this.settings.loop_detection_enabled || !this.state.last_model_output) {
      return;
    }
    const exemptActions = new Set(['wait', 'done', 'go_back']);
    for (const action of this.state.last_model_output.action) {
      const actionData =
        typeof (action as any)?.model_dump === 'function'
          ? (action as any).model_dump()
          : action;
      if (!actionData || typeof actionData !== 'object') {
        continue;
      }
      const actionName = Object.keys(actionData)[0] ?? 'unknown';
      if (exemptActions.has(actionName)) {
        continue;
      }
      const rawParams = (actionData as Record<string, unknown>)[actionName];
      const params =
        rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams)
          ? (rawParams as Record<string, unknown>)
          : {};
      this.state.loop_detector.record_action(actionName, params);
    }
  }

  private _update_loop_detector_page_state(
    browser_state_summary: BrowserStateSummary
  ) {
    if (!this.settings.loop_detection_enabled) {
      return;
    }
    const url = browser_state_summary.url ?? '';
    const elementCount = browser_state_summary.selector_map
      ? Object.keys(browser_state_summary.selector_map).length
      : 0;
    let domText = '';
    try {
      domText =
        browser_state_summary.element_tree?.clickable_elements_to_string?.() ??
        '';
    } catch {
      domText = '';
    }
    this.state.loop_detector.record_page_state(url, domText, elementCount);
  }

  private _inject_budget_warning(step_info: AgentStepInfo | null = null) {
    if (!step_info) {
      return;
    }

    const stepsUsed = step_info.step_number + 1;
    const budgetRatio = stepsUsed / step_info.max_steps;
    if (budgetRatio < 0.75 || step_info.is_last_step()) {
      return;
    }

    const stepsRemaining = step_info.max_steps - stepsUsed;
    const pct = Math.floor(budgetRatio * 100);
    const message =
      `BUDGET WARNING: You have used ${stepsUsed}/${step_info.max_steps} steps ` +
      `(${pct}%). ${stepsRemaining} steps remaining. ` +
      'If the task cannot be completed in the remaining steps, prioritize: ' +
      '(1) consolidate your results (save to files if the file system is in use), ' +
      '(2) call done with what you have. ' +
      'Partial results are far more valuable than exhausting all steps with nothing saved.';

    this.logger.info(
      `Step budget warning: ${stepsUsed}/${step_info.max_steps} (${pct}%)`
    );
    this._message_manager._add_context_message(new UserMessage(message));
  }

  private async _run_simple_judge() {
    const lastHistoryItem = this.history.history[this.history.history.length - 1];
    if (!lastHistoryItem || !lastHistoryItem.result.length) {
      return;
    }

    const lastResult = lastHistoryItem.result[lastHistoryItem.result.length - 1];
    if (!lastResult.is_done || !lastResult.success) {
      return;
    }

    const messages = construct_simple_judge_messages({
      task: this.task,
      final_result: this.history.final_result() ?? '',
    });

    try {
      const response = await this.llm.ainvoke(
        messages as any,
        SimpleJudgeOutputFormat as any
      );
      const parsed = this._parseCompletionPayload((response as any).completion);
      if (typeof parsed?.is_correct !== 'boolean') {
        this.logger.debug(
          'Simple judge response missing boolean is_correct; skipping override.'
        );
        return;
      }
      const isCorrect = parsed.is_correct;
      const reason =
        typeof parsed?.reason === 'string' && parsed.reason.trim()
          ? parsed.reason.trim()
          : 'Task requirements not fully met';

      if (!isCorrect) {
        this.logger.info(
          `⚠️  Simple judge overriding success to failure: ${reason}`
        );
        lastResult.success = false;
        const note = `[Simple judge: ${reason}]`;
        if (lastResult.extracted_content) {
          lastResult.extracted_content += `\n\n${note}`;
        } else {
          lastResult.extracted_content = note;
        }
      }
    } catch (error) {
      this.logger.warning(
        `Simple judge failed with error: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private async _judge_trace(): Promise<z.infer<typeof JudgeSchema> | null> {
    const messages = construct_judge_messages({
      task: this.task,
      final_result: this.history.final_result() ?? '',
      agent_steps: this.history.agent_steps(),
      screenshot_paths: this.history
        .screenshot_paths()
        .filter((value): value is string => typeof value === 'string'),
      max_images: 10,
      ground_truth: this.settings.ground_truth,
      use_vision: this.settings.use_vision,
    });

    try {
      const invokeOptions =
        (this.judge_llm as any)?.provider === 'browser-use'
          ? ({ request_type: 'judge' } as const)
          : undefined;
      const response = await this.judge_llm.ainvoke(
        messages as any,
        JudgeOutputFormat as any,
        invokeOptions as any
      );
      const parsed = this._parseCompletionPayload((response as any).completion);
      const validation = JudgeSchema.safeParse(parsed);
      if (!validation.success) {
        this.logger.warning(
          'Judge trace response did not match expected schema; skipping judgement.'
        );
        return null;
      }
      return validation.data;
    } catch (error) {
      this.logger.warning(
        `Judge trace failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return null;
    }
  }

  private async _judge_and_log() {
    const lastHistoryItem = this.history.history[this.history.history.length - 1];
    if (!lastHistoryItem || !lastHistoryItem.result.length) {
      return;
    }
    const lastResult = lastHistoryItem.result[lastHistoryItem.result.length - 1];
    if (!lastResult.is_done) {
      return;
    }

    const judgement = await this._judge_trace();
    lastResult.judgement = judgement;

    if (!judgement) {
      return;
    }
    if (lastResult.success === true && judgement.verdict === true) {
      return;
    }

    let judgeLog = '\n';
    if (lastResult.success === true && judgement.verdict === false) {
      judgeLog += '⚠️  Agent reported success but judge thinks task failed\n';
    }
    judgeLog += `⚖️  Judge Verdict: ${judgement.verdict ? 'PASS' : 'FAIL'}\n`;
    if (judgement.failure_reason) {
      judgeLog += `   Failure Reason: ${judgement.failure_reason}\n`;
    }
    if (judgement.reached_captcha) {
      judgeLog += '   Captcha Detected: Agent encountered captcha challenges\n';
      judgeLog +=
        '   Use Browser Use Cloud for stealth browser infra: https://docs.browser-use.com/customize/browser/remote\n';
    }
    if (judgement.reasoning) {
      judgeLog += `   ${judgement.reasoning}\n`;
    }
    this.logger.info(judgeLog);
  }

  private _parseCompletionPayload(
    rawCompletion: unknown
  ): Record<string, unknown> {
    let parsedCompletion = rawCompletion;

    if (typeof parsedCompletion === 'string') {
      let jsonText = this._removeThinkTags(parsedCompletion.trim());

      // Handle common markdown wrappers like ```json ... ```
      const fencedMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (fencedMatch && fencedMatch[1]) {
        jsonText = fencedMatch[1].trim();
      }

      // If extra text surrounds JSON, try to isolate the first JSON object
      const firstBrace = jsonText.indexOf('{');
      const lastBrace = jsonText.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        jsonText = jsonText.slice(firstBrace, lastBrace + 1);
      }

      try {
        parsedCompletion = JSON.parse(jsonText);
      } catch (error) {
        throw new Error(
          `Failed to parse LLM completion as JSON: ${String(error)}`
        );
      }
    }

    if (!parsedCompletion || typeof parsedCompletion !== 'object') {
      throw new Error('Model completion must be a JSON object');
    }

    return parsedCompletion as Record<string, unknown>;
  }

  private _isModelActionMissing(actions: unknown[]): boolean {
    if (actions.length === 0) {
      return true;
    }

    return actions.every((entry) => {
      const candidate =
        entry &&
        typeof entry === 'object' &&
        typeof (entry as any).model_dump === 'function'
          ? (entry as any).model_dump()
          : entry;

      if (
        !candidate ||
        typeof candidate !== 'object' ||
        Array.isArray(candidate)
      ) {
        return false;
      }

      return Object.keys(candidate as Record<string, unknown>).length === 0;
    });
  }

  private async _get_model_output_with_retry(
    messages: any[],
    signal: AbortSignal | null = null
  ) {
    const invokeAndParse = async (inputMessages: any[]) => {
      this._throwIfAborted(signal);
      const completion = await this.llm.ainvoke(
        inputMessages as any,
        AgentLLMOutputFormat as any,
        { signal: signal ?? undefined }
      );
      this._throwIfAborted(signal);
      return this._parseCompletionPayload((completion as any).completion);
    };

    let parsed_completion = await invokeAndParse(messages);

    let rawAction = Array.isArray(parsed_completion?.action)
      ? parsed_completion.action
      : [];

    this.logger.debug(
      `✅ Step ${this.state.n_steps}: Got LLM response with ${rawAction.length} actions`
    );

    if (this._isModelActionMissing(rawAction)) {
      this._throwIfAborted(signal);
      this.logger.warning('Model returned empty action. Retrying...');
      const clarificationMessage = new UserMessage(
        'You forgot to return an action. Please respond only with a valid JSON action according to the expected format.'
      );
      parsed_completion = await invokeAndParse([
        ...messages,
        clarificationMessage,
      ]);
      rawAction = Array.isArray(parsed_completion?.action)
        ? parsed_completion.action
        : [];

      if (this._isModelActionMissing(rawAction)) {
        this.logger.warning(
          'Model still returned empty after retry. Inserting safe noop action.'
        );
        rawAction = [
          {
            done: {
              success: false,
              text: 'No next action returned by LLM!',
            },
          },
        ];
      }
    }

    const action = this._validateAndNormalizeActions(rawAction);
    const toNullableString = (value: unknown): string | null =>
      typeof value === 'string' ? value : null;
    const toNullableNumber = (value: unknown): number | null =>
      typeof value === 'number' && Number.isFinite(value)
        ? Math.trunc(value)
        : null;
    const toNullablePlanUpdate = (value: unknown): string[] | null =>
      Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string')
        : null;
    const AgentOutputModel = this.AgentOutput ?? AgentOutput;
    return new AgentOutputModel({
      thinking: toNullableString(parsed_completion?.thinking),
      evaluation_previous_goal: toNullableString(
        parsed_completion?.evaluation_previous_goal
      ),
      memory: toNullableString(parsed_completion?.memory),
      next_goal: toNullableString(parsed_completion?.next_goal),
      current_plan_item: toNullableNumber(parsed_completion?.current_plan_item),
      plan_update: toNullablePlanUpdate(parsed_completion?.plan_update),
      action,
    });
  }

  private _validateAndNormalizeActions(actions: unknown[]): ActionModel[] {
    const normalizedActions: ActionModel[] = [];
    const registryActions = this.controller.registry.get_all_actions();

    const availableNames = new Set<string>();
    const modelForStep: typeof ActionModel = this._enforceDoneOnlyForCurrentStep
      ? this.DoneActionModel
      : this.ActionModel;
    const modelAvailableNames = (modelForStep as any)?.available_actions;
    if (Array.isArray(modelAvailableNames) && modelAvailableNames.length > 0) {
      for (const actionName of modelAvailableNames) {
        if (typeof actionName === 'string' && actionName.trim()) {
          availableNames.add(actionName);
        }
      }
    } else {
      for (const actionName of registryActions.keys()) {
        availableNames.add(actionName);
      }
    }

    for (let i = 0; i < actions.length; i++) {
      const entry = actions[i];
      const candidate =
        entry &&
        typeof entry === 'object' &&
        typeof (entry as any).model_dump === 'function'
          ? (entry as any).model_dump()
          : entry;

      if (
        !candidate ||
        typeof candidate !== 'object' ||
        Array.isArray(candidate)
      ) {
        throw new Error(
          `Invalid action at index ${i}: expected an object with exactly one action key`
        );
      }

      const actionObject = candidate as Record<string, unknown>;
      const keys = Object.keys(actionObject);
      if (keys.length !== 1) {
        throw new Error(
          `Invalid action at index ${i}: expected exactly one action key, got ${keys.length}`
        );
      }

      const actionName = keys[0];
      if (!availableNames.has(actionName)) {
        const available = Array.from(availableNames).sort().join(', ');
        throw new Error(
          `Action '${actionName}' is not available on the current page. Available actions: ${available}`
        );
      }

      const actionInfo = registryActions.get(actionName);
      if (!actionInfo) {
        throw new Error(`Action '${actionName}' is not registered`);
      }

      const rawParams = (actionObject[actionName] ?? {}) as unknown;
      const paramsResult = actionInfo.paramSchema.safeParse(rawParams);
      if (!paramsResult.success) {
        throw new Error(
          `Invalid parameters for action '${actionName}': ${paramsResult.error.message}`
        );
      }

      normalizedActions.push(
        new modelForStep({
          [actionName]: paramsResult.data,
        })
      );
    }

    if (normalizedActions.length === 0) {
      throw new Error('Model output must contain at least one action');
    }

    if (normalizedActions.length > this.settings.max_actions_per_step) {
      this.logger.warning(
        `Model returned ${normalizedActions.length} actions, trimming to max_actions_per_step=${this.settings.max_actions_per_step}`
      );
      return normalizedActions.slice(0, this.settings.max_actions_per_step);
    }

    return normalizedActions;
  }

  private async _update_action_models_for_page(page: Page | null) {
    await this._updateActionModelsForPage(page);
  }

  private async _check_and_update_downloads(context = '') {
    if (!this.has_downloads_path || !this.browser_session) {
      return;
    }

    try {
      const current_downloads = Array.isArray(
        this.browser_session.downloaded_files
      )
        ? [...this.browser_session.downloaded_files]
        : [];
      const changed =
        current_downloads.length !== this._last_known_downloads.length ||
        current_downloads.some(
          (value, index) => value !== this._last_known_downloads[index]
        );
      if (changed) {
        this._update_available_file_paths(current_downloads);
        this._last_known_downloads = current_downloads;
        if (context) {
          this.logger.debug(`📁 ${context}: Updated available files`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errorContext = context ? ` ${context}` : '';
      this.logger.debug(
        `📁 Failed to check for downloads${errorContext}: ${message}`
      );
    }
  }

  private _update_available_file_paths(downloads: string[]) {
    if (!this.has_downloads_path) {
      return;
    }

    const existing = this.available_file_paths
      ? [...this.available_file_paths]
      : [];
    const known = new Set(existing);
    const new_files = downloads.filter((pathValue) => !known.has(pathValue));

    if (new_files.length) {
      const updated = existing.concat(new_files);
      this.available_file_paths = updated;
      this.logger.info(
        `📁 Added ${new_files.length} downloaded files to available_file_paths (total: ${updated.length} files)`
      );
      for (const file_path of new_files) {
        this.logger.info(`📄 New file available: ${file_path}`);
      }
    } else {
      this.logger.info(
        `📁 No new downloads detected (tracking ${existing.length} files)`
      );
    }
  }

  private _log_step_context(
    current_page: Page | null,
    browser_state_summary: BrowserStateSummary | null
  ) {
    const url =
      typeof current_page?.url === 'function' ? current_page.url() : '';
    const url_short = url.length > 50 ? `${url.slice(0, 50)}...` : url;
    const interactive_count = browser_state_summary?.selector_map
      ? Object.keys(browser_state_summary.selector_map).length
      : 0;
    this.logger.info(
      `📍 Step ${this.state.n_steps}: Evaluating page with ${interactive_count} interactive elements on: ${url_short}`
    );
  }

  private _log_step_completion_summary(
    step_start_time: number,
    result: ActionResult[]
  ) {
    if (!result.length) {
      return;
    }
    const step_duration = Date.now() / 1000 - step_start_time;
    const action_count = result.length;
    const success_count = result.filter((r) => !r.error).length;
    const failure_count = action_count - success_count;
    const success_indicator = success_count ? `✅ ${success_count}` : '';
    const failure_indicator = failure_count ? `❌ ${failure_count}` : '';
    const status_parts = [success_indicator, failure_indicator].filter(Boolean);
    const status_str = status_parts.length ? status_parts.join(' | ') : '✅ 0';
    this.logger.info(
      `📍 Step ${this.state.n_steps}: Ran ${action_count} actions in ${step_duration.toFixed(2)}s: ${status_str}`
    );
  }

  private _log_agent_event(max_steps: number, agent_run_error: string | null) {
    if (!this.telemetry) {
      return;
    }

    const token_summary = this.token_cost_service?.get_usage_tokens_for_model?.(
      this.llm.model
    ) ?? {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    };

    const action_history_data = this.history.history.map((historyItem) => {
      if (!historyItem.model_output) {
        return null;
      }
      return historyItem.model_output.action.map((action) => {
        if (typeof (action as any)?.model_dump === 'function') {
          return (action as any).model_dump({ exclude_unset: true });
        }
        return action;
      });
    });

    const final_result = this.history.final_result();
    const final_result_str =
      final_result != null ? JSON.stringify(final_result) : null;
    const judgement_data = this.history.judgement();
    const judge_verdict =
      judgement_data && typeof judgement_data.verdict === 'boolean'
        ? judgement_data.verdict
        : null;
    const judge_reasoning =
      judgement_data && typeof judgement_data.reasoning === 'string'
        ? judgement_data.reasoning
        : null;
    const judge_failure_reason =
      judgement_data && typeof judgement_data.failure_reason === 'string'
        ? judgement_data.failure_reason
        : null;
    const judge_reached_captcha =
      judgement_data && typeof judgement_data.reached_captcha === 'boolean'
        ? judgement_data.reached_captcha
        : null;
    const judge_impossible_task =
      judgement_data && typeof judgement_data.impossible_task === 'boolean'
        ? judgement_data.impossible_task
        : null;

    let cdpHost: string | null = null;
    const cdpUrl = (this.browser_session as any)?.cdp_url;
    if (typeof cdpUrl === 'string' && cdpUrl) {
      try {
        const parsed = new URL(cdpUrl);
        cdpHost = parsed.hostname || cdpUrl;
      } catch {
        cdpHost = cdpUrl;
      }
    }

    const plannerModel =
      (this.settings as any)?.planner_llm &&
      typeof (this.settings as any).planner_llm === 'object'
        ? ((this.settings as any).planner_llm.model ?? null)
        : null;

    this.telemetry.capture(
      new AgentTelemetryEvent({
        task: this.task,
        model: this.llm.model,
        model_provider: (this.llm as any).provider ?? 'unknown',
        planner_llm: plannerModel,
        max_steps: max_steps,
        max_actions_per_step: this.settings.max_actions_per_step,
        use_vision: this.settings.use_vision,
        use_validation: this.settings.validate_output,
        version: this.version,
        source: this.source,
        cdp_url: cdpHost,
        action_errors: this.history.errors(),
        action_history: action_history_data,
        urls_visited: this.history.urls(),
        steps: this.state.n_steps,
        total_input_tokens: token_summary.prompt_tokens ?? 0,
        total_duration_seconds: this.history.total_duration_seconds(),
        success: this.history.is_successful(),
        final_result_response: final_result_str,
        error_message: agent_run_error,
        judge_verdict,
        judge_reasoning,
        judge_failure_reason,
        judge_reached_captcha,
        judge_impossible_task,
      })
    );
  }

  private async _make_history_item(
    model_output: AgentOutput | null,
    browser_state_summary: BrowserStateSummary,
    result: ActionResult[],
    metadata: StepMetadata,
    state_message: string | null = null
  ) {
    const interacted_elements = model_output
      ? AgentHistory.get_interacted_element(
          model_output,
          browser_state_summary.selector_map
        )
      : [];
    const state = new BrowserStateHistory(
      browser_state_summary.url,
      browser_state_summary.title,
      browser_state_summary.tabs,
      interacted_elements,
      this._current_screenshot_path
    );
    this.history.add_item(
      new AgentHistory(model_output, result, state, metadata, state_message)
    );
  }

  save_file_system_state() {
    if (!this.file_system) {
      this.logger.error('💾 File system is not set up. Cannot save state.');
      throw new Error('File system is not set up. Cannot save state.');
    }
    this.state.file_system_state = this.file_system.get_state();
  }
}
