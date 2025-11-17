import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import process from 'node:process';
import { config as loadEnv } from 'dotenv';
import { createLogger } from '../logging-config.js';
import { CONFIG } from '../config.js';
import { EventBus } from '../event-bus.js';
import { uuid7str, time_execution_sync, time_execution_async, SignalHandler, get_browser_use_version } from '../utils.js';
import type { Controller } from '../controller/service.js';
import { Controller as DefaultController } from '../controller/service.js';
import type { FileSystem } from '../filesystem/file-system.js';
import { FileSystem as AgentFileSystem, DEFAULT_FILE_SYSTEM_PATH } from '../filesystem/file-system.js';
import { SystemPrompt } from './prompts.js';
import { MessageManager } from './message-manager/service.js';
import type { MessageManagerState } from './message-manager/views.js';
import { BrowserStateSummary, BrowserStateHistory } from '../browser/views.js';
import type { BaseChatModel } from '../llm/base.js';
import type { UsageSummary } from '../tokens/views.js';
import type { ActionResultInit } from './views.js';
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
} from './views.js';
import type { StructuredOutputParser } from './views.js';
import { observe, observe_debug } from '../observability.js';
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

loadEnv();

const logger = createLogger('browser_use.agent');

export const log_response = (response: AgentOutput, registry?: Controller, logInstance = logger) => {
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

type BrowserSession = any;
type Browser = any;
type BrowserContext = any;
type Page = any;
type ControllerContext = unknown;

type AgentHookFunc<Context, AgentStructuredOutput> = (agent: Agent<Context, AgentStructuredOutput>) => Promise<void> | void;

interface AgentConstructorParams<Context, AgentStructuredOutput> {
	task: string;
	llm: BaseChatModel;
	page?: Page | null;
	browser?: Browser | BrowserSession | null;
	browser_context?: BrowserContext | null;
	browser_profile?: BrowserSession | null;
	browser_session?: BrowserSession | null;
	controller?: Controller<Context> | null;
	sensitive_data?: Record<string, string | Record<string, string>> | null;
	initial_actions?: Array<Record<string, Record<string, unknown>>> | null;
	register_new_step_callback?: ((summary: BrowserStateSummary, output: AgentOutput, step: number) => void | Promise<void>) | null;
	register_done_callback?: ((history: AgentHistoryList<AgentStructuredOutput>) => void | Promise<void>) | null;
	register_external_agent_status_raise_error_callback?: (() => Promise<boolean>) | null;
	output_model_schema?: StructuredOutputParser<AgentStructuredOutput> | null;
	use_vision?: boolean;
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
	max_history_items?: number | null;
	page_extraction_llm?: BaseChatModel | null;
	planner_llm?: BaseChatModel | null;
	planner_interval?: number;
	is_planner_reasoning?: boolean;
	extend_planner_system_message?: string | null;
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
	llm_timeout?: number;
	step_timeout?: number;
}

const ensureDir = (target: string) => {
	if (!fs.existsSync(target)) {
		fs.mkdirSync(target, { recursive: true });
	}
};

const defaultAgentOptions = () => ({
	use_vision: true,
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
	max_actions_per_step: 10,
	use_thinking: true,
	flash_mode: false,
	max_history_items: null as number | null,
	page_extraction_llm: null as BaseChatModel | null,
	planner_llm: null as BaseChatModel | null,
	planner_interval: 1,
	is_planner_reasoning: false,
	extend_planner_system_message: null as string | null,
	context: null as ControllerContext | null,
	source: null as string | null,
	file_system_path: null as string | null,
	task_id: null as string | null,
	cloud_sync: null as any,
	calculate_cost: false,
	display_files_in_done_text: true,
	include_tool_call_examples: false,
	vision_detail_level: 'auto' as const,
	llm_timeout: 60,
	step_timeout: 180,
});

export class Agent<Context = ControllerContext, AgentStructuredOutput = unknown> {
	static DEFAULT_AGENT_DATA_DIR = path.join(process.cwd(), DEFAULT_FILE_SYSTEM_PATH);

	browser_session: BrowserSession | null = null;
	llm: BaseChatModel;
	unfiltered_actions: string;
	initial_actions: Array<Record<string, Record<string, unknown>>> | null;
	register_new_step_callback: AgentConstructorParams<Context, AgentStructuredOutput>['register_new_step_callback'];
	register_done_callback: AgentConstructorParams<Context, AgentStructuredOutput>['register_done_callback'];
	register_external_agent_status_raise_error_callback: AgentConstructorParams<Context, AgentStructuredOutput>['register_external_agent_status_raise_error_callback'];
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
	_external_pause_event: { resolve: (() => void) | null; promise: Promise<void> } = {
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
			max_actions_per_step = 10,
			use_thinking = true,
			flash_mode = false,
			max_history_items = null,
			page_extraction_llm = null,
			context = null,
			source = null,
			file_system_path = null,
			task_id = null,
			cloud_sync = null,
			calculate_cost = false,
			display_files_in_done_text = true,
			include_tool_call_examples = false,
			vision_detail_level = 'auto',
			llm_timeout = 60,
			step_timeout = 180,
		} = { ...defaultAgentOptions(), ...params };

		if (!llm) {
			throw new Error('Invalid llm, must be provided');
		}

		this.llm = llm;
		this.id = task_id || uuid7str();
		this.task_id = this.id;
		this.session_id = uuid7str();
		this.task = task;
		this.output_model_schema = output_model_schema ?? null;
		this.sensitive_data = sensitive_data;
		this.available_file_paths = available_file_paths || [];
		this.controller = controller ?? new DefaultController({ display_files_in_done_text });
		this.initial_actions = initial_actions;
		this.register_new_step_callback = register_new_step_callback;
		this.register_done_callback = register_done_callback;
		this.register_external_agent_status_raise_error_callback = register_external_agent_status_raise_error_callback;
		this.context = context;

		this.settings = {
			use_vision,
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
			flash_mode,
			max_history_items,
			page_extraction_llm,
			planner_llm: null,
			planner_interval: 1,
			is_planner_reasoning: false,
			extend_planner_system_message: null,
			calculate_cost,
			include_tool_call_examples,
			llm_timeout,
			step_timeout,
		};

		this.token_cost_service = {
			register_llm: () => {},
			register_usage: () => {},
			get_usage_summary: async () => null,
			log_usage_summary: async () => {},
			get_usage_tokens_for_model: () => ({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }),
		};
		if (typeof this.token_cost_service.register_llm === 'function') {
			this.token_cost_service.register_llm(llm);
			if (page_extraction_llm) {
				this.token_cost_service.register_llm(page_extraction_llm);
			}
		}

		this.state = params.injected_agent_state || new AgentState();
		this.history = new AgentHistoryList([], null);
		this.telemetry = productTelemetry;

		this._file_system_path = file_system_path;
		this.file_system = this._initFileSystem(file_system_path);
		this._setScreenshotService();
		this._setup_action_models();
		this._set_browser_use_version_and_source(source);

		this.browser_session = browser_session ?? null;
		this.has_downloads_path = Boolean(this.browser_session?.browser_profile?.downloads_path);
		if (this.has_downloads_path) {
			this._last_known_downloads = [];
			this.logger.info('📁 Initialized download tracking for agent');
		}

		this._message_manager = new MessageManager(
			task,
			new SystemPrompt({
				action_description: this.controller.registry.get_prompt_description(),
				max_actions_per_step: this.settings.max_actions_per_step,
				override_system_message: override_system_message ?? undefined,
				extend_system_message: extend_system_message ?? undefined,
				use_thinking: this.settings.use_thinking,
				flash_mode: this.settings.flash_mode,
			}).get_system_message(),
			this.file_system!,
			this.state.message_manager_state as MessageManagerState,
			this.settings.use_thinking,
			this.settings.include_attributes,
			sensitive_data ?? undefined,
			this.settings.max_history_items,
			this.settings.vision_detail_level,
			this.settings.include_tool_call_examples,
		);

		this.unfiltered_actions = this.controller.registry.get_prompt_description();
		this.eventbus = new EventBus(`Agent_${String(this.id).slice(-4)}`);
		this.enable_cloud_sync = CONFIG.BROWSER_USE_CLOUD_SYNC;
		if (this.enable_cloud_sync || cloud_sync) {
			this.cloud_sync = cloud_sync ?? null;
			if (this.cloud_sync) {
				this.eventbus.on('*', this.cloud_sync.handle_event?.bind(this.cloud_sync) ?? (() => {}));
			}
		}

		this._external_pause_event = {
			resolve: null,
			promise: Promise.resolve(),
		};

		this._session_start_time = 0;
		this._task_start_time = 0;
		this._force_exit_telemetry_logged = false;
	}

	private _initFileSystem(file_system_path: string | null) {
		if (this.state.file_system_state && file_system_path) {
			throw new Error(
				'Cannot provide both file_system_state (from agent state) and file_system_path. Restore from state or create new file system, not both.',
			);
		}

		if (this.state.file_system_state) {
			try {
				this.file_system = AgentFileSystem.from_state_sync(this.state.file_system_state);
				this._file_system_path = this.state.file_system_state.base_dir;
				this.logger.info(`💾 File system restored from state to: ${this._file_system_path}`);
				const timestamp = Date.now();
				this.agent_directory = path.join(os.tmpdir(), `browser_use_agent_${this.id}_${timestamp}`);
				ensureDir(this.agent_directory);
				return this.file_system;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.logger.error(`💾 Failed to restore file system from state: ${message}`);
				throw error;
			}
		}

		const baseDir = file_system_path ?? path.join(Agent.DEFAULT_AGENT_DATA_DIR, this.task_id);
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
		this.agent_directory = path.join(os.tmpdir(), `browser_use_agent_${this.id}_${timestamp}`);
		ensureDir(this.agent_directory);

		this.state.file_system_state = this.file_system.get_state();
		this.logger.info(`💾 File system path: ${this._file_system_path}`);
		return this.file_system;
	}

	private _setScreenshotService() {
		try {
			this.screenshot_service = new ScreenshotService(this.agent_directory);
			this.logger.info(`📸 Screenshot service initialized in: ${path.join(this.agent_directory, 'screenshots')}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.logger.error(`📸 Failed to initialize screenshot service: ${message}`);
			throw error;
		}
	}

	get logger() {
		if (!this._logger) {
			const browserSessionId = (this.browser_session && this.browser_session.id) || this.id;
			this._logger = createLogger(`browser_use.Agent🅰 ${this.task_id.slice(-4)} on 🆂 ${String(browserSessionId).slice(-4)}`);
		}
		return this._logger;
	}

	get message_manager() {
		return this._message_manager;
	}

	private _set_browser_use_version_and_source(sourceOverride: string | null) {
		const version = get_browser_use_version();
		let source = 'npm';

		try {
			const projectRoot = process.cwd();
			const repoIndicators = ['.git', 'README.md', 'docs', 'examples'];
			if (repoIndicators.every((indicator) => fs.existsSync(path.join(projectRoot, indicator)))) {
				source = 'git';
			}
		} catch (error) {
			this.logger.debug(`Error determining browser-use source: ${(error as Error).message}`);
			source = 'unknown';
		}

		if (sourceOverride) {
			source = sourceOverride;
		}

		this.version = version;
		this.source = source;
	}

	private _setup_action_models() {
		/* Placeholder for action model customization */
	}

	async run(
		max_steps = 100,
		on_step_start: AgentHookFunc<Context, AgentStructuredOutput> | null = null,
		on_step_end: AgentHookFunc<Context, AgentStructuredOutput> | null = null,
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
				}`,
			);

			this._session_start_time = Date.now() / 1000;
			this._task_start_time = this._session_start_time;

			this.logger.debug('📡 Dispatching CreateAgentSessionEvent...');
			this.eventbus.dispatch(CreateAgentSessionEvent.from_agent(this as any));

			this.logger.debug('📡 Dispatching CreateAgentTaskEvent...');
			this.eventbus.dispatch(CreateAgentTaskEvent.from_agent(this as any));

			if (this.initial_actions?.length) {
				this.logger.debug(`⚡ Executing ${this.initial_actions.length} initial actions...`);
				const result = await this.multi_act(this.initial_actions, { check_for_new_elements: false });
				this.state.last_result = result;
				this.logger.debug('✅ Initial actions completed');
			}

			this.logger.debug(`🔄 Starting main execution loop with max ${max_steps} steps...`);
			for (let step = 0; step < max_steps; step += 1) {
				if (this.state.paused) {
					this.logger.debug(`⏸️ Step ${step}: Agent paused, waiting to resume...`);
					await this.wait_until_resumed();
					signal_handler.reset();
				}

				if (this.state.consecutive_failures >= this.settings.max_failures) {
					this.logger.error(`❌ Stopping due to ${this.settings.max_failures} consecutive failures`);
					agent_run_error = `Stopped due to ${this.settings.max_failures} consecutive failures`;
					break;
				}

				if (this.state.stopped) {
					this.logger.info('🛑 Agent stopped');
					agent_run_error = 'Agent stopped programmatically';
					break;
				}

				if (this.register_external_agent_status_raise_error_callback) {
					const shouldRaise = await this.register_external_agent_status_raise_error_callback();
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

				try {
					await this._executeWithTimeout(this.step(step_info), this.settings.step_timeout ?? 0);
					this.logger.debug(`✅ Completed step ${step + 1}/${max_steps}`);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					const timeoutMessage = `Step ${step + 1} timed out after ${this.settings.step_timeout} seconds`;
					this.logger.error(`⏰ ${timeoutMessage}`);
					this.state.consecutive_failures += 1;
					this.state.last_result = [new ActionResult({ error: message || timeoutMessage })];
				}

				if (on_step_end) {
					await on_step_end(this);
				}

				if (this.history.is_done()) {
					this.logger.debug(`🎯 Task completed after ${step + 1} steps!`);
					await this.log_completion();

					if (this.register_done_callback) {
						const maybePromise = this.register_done_callback(this.history);
						if (maybePromise && typeof (maybePromise as Promise<void>).then === 'function') {
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
							[new ActionResult({ error: agent_run_error, include_in_memory: true })],
							new BrowserStateHistory('', '', [], [], null),
							null,
						),
					);
					this.logger.info(`❌ ${agent_run_error}`);
				}
			}

			this.logger.debug('📊 Collecting usage summary...');
			this.history.usage = (await this.token_cost_service.get_usage_summary()) as UsageSummary | null;

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
					this.logger.error(`Failed to log telemetry event: ${String(logError)}`);
				} finally {
					try {
						this.telemetry?.flush?.();
					} catch (flushError) {
						this.logger.error(`Failed to flush telemetry client: ${String(flushError)}`);
					}
				}
			} else {
				this.logger.info('Telemetry for force exit (SIGINT) already logged.');
			}

			this.eventbus.dispatch(UpdateAgentTaskEvent.from_agent(this as any));

			if (this.settings.generate_gif) {
				let output_path = 'agent_history.gif';
				if (typeof this.settings.generate_gif === 'string') {
					output_path = this.settings.generate_gif;
				}
				await create_history_gif(this.task, this.history, { output_path });
				if (fs.existsSync(output_path)) {
					const output_event = await CreateAgentOutputFileEvent.from_agent_and_file(this as any, output_path);
					this.eventbus.dispatch(output_event);
				}
			}

			await this.eventbus.stop();
			await this.close();
		}
	}

	private async _executeWithTimeout<T>(promise: Promise<T>, timeoutSeconds: number) {
		if (!timeoutSeconds || timeoutSeconds <= 0) {
			return promise;
		}
		let timeoutHandle: NodeJS.Timeout | null = null;
		const timeoutPromise = new Promise<never>((_, reject) => {
			timeoutHandle = setTimeout(() => reject(new Error('timeout')), timeoutSeconds * 1000);
		});
		const result = await Promise.race([promise, timeoutPromise]);
		if (timeoutHandle) {
			clearTimeout(timeoutHandle);
		}
		return result;
	}

	@time_execution_async('--step')
	async step(step_info: AgentStepInfo | null = null) {
		this.step_start_time = Date.now() / 1000;
		let browser_state_summary: BrowserStateSummary | null = null;

		try {
			browser_state_summary = await this._prepare_context(step_info);
			await this._get_next_action(browser_state_summary);
			await this._execute_actions();
			await this._post_process();
		} catch (error) {
			await this._handle_step_error(error as Error);
		} finally {
			await this._finalize(browser_state_summary);
		}
	}

	private async _prepare_context(step_info: AgentStepInfo | null = null) {
		if (!this.browser_session) {
			throw new Error('BrowserSession is not set up');
		}

		this.logger.debug(`🌐 Step ${this.state.n_steps}: Getting browser state...`);
		const browser_state_summary: BrowserStateSummary = await this.browser_session.get_browser_state_with_recovery?.({
			cache_clickable_elements_hashes: true,
			include_screenshot: this.settings.use_vision,
		});
		const current_page = await this.browser_session.get_current_page?.();

		await this._check_and_update_downloads(`Step ${this.state.n_steps}: after getting browser state`);

		this._log_step_context(current_page, browser_state_summary);
		await this._storeScreenshotForStep(browser_state_summary);
		await this._raise_if_stopped_or_paused();

		this.logger.debug(`📝 Step ${this.state.n_steps}: Updating action models...`);
		await this._update_action_models_for_page(current_page);

		const page_filtered_actions = this.controller.registry.get_prompt_description(current_page);

		this.logger.debug(`💬 Step ${this.state.n_steps}: Creating state messages for context...`);
		this._message_manager.create_state_messages(
			browser_state_summary,
			this.state.last_model_output,
			this.state.last_result,
			step_info,
			this.settings.use_vision,
			page_filtered_actions || null,
			this.sensitive_data ?? null,
			this.available_file_paths,
		);

		await this._handle_final_step(step_info);
		return browser_state_summary;
	}

	private async _storeScreenshotForStep(browser_state_summary: BrowserStateSummary) {
		this._current_screenshot_path = null;
		if (!this.screenshot_service || !browser_state_summary?.screenshot) {
			return;
		}

		try {
			this._current_screenshot_path = await this.screenshot_service.store_screenshot(
				browser_state_summary.screenshot,
				this.state.n_steps,
			);
			this.logger.debug(
				`📸 Step ${this.state.n_steps}: Stored screenshot at ${this._current_screenshot_path}`,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.logger.error(`📸 Failed to store screenshot for step ${this.state.n_steps}: ${message}`);
			this._current_screenshot_path = null;
		}
	}

	@observe_debug({ ignore_input: true, name: 'get_next_action' })
	private async _get_next_action(browser_state_summary: BrowserStateSummary) {
		const input_messages = this._message_manager.get_messages();
		this.logger.debug(
			`🤖 Step ${this.state.n_steps}: Calling LLM with ${input_messages.length} messages (model: ${this.llm.model})...`,
		);

		let model_output: AgentOutput;
		try {
			model_output = await this._executeWithTimeout(
				this._get_model_output_with_retry(input_messages),
				this.settings.llm_timeout,
			);
		} catch (error) {
			if (error instanceof Error && error.message === 'timeout') {
				throw new Error(
					`LLM call timed out after ${this.settings.llm_timeout} seconds. Keep your thinking and output short.`,
				);
			}
			throw error;
		}

		this.state.last_model_output = model_output;

		await this._raise_if_stopped_or_paused();
		await this._handle_post_llm_processing(browser_state_summary, input_messages);
		await this._raise_if_stopped_or_paused();
	}

	private async _execute_actions() {
		if (!this.state.last_model_output) {
			throw new Error('No model output to execute actions from');
		}

		this.logger.debug(
			`⚡ Step ${this.state.n_steps}: Executing ${this.state.last_model_output.action.length} actions...`,
		);
		const result = await this.multi_act(this.state.last_model_output.action);
		this.logger.debug(`✅ Step ${this.state.n_steps}: Actions completed`);
		this.state.last_result = result;
	}

	private async _post_process() {
		if (!this.browser_session) {
			throw new Error('BrowserSession is not set up');
		}
		await this._check_and_update_downloads('after executing actions');
		this.state.consecutive_failures = 0;
	}

	async multi_act(
		_actions: Array<Record<string, Record<string, unknown>>>,
		_options: { check_for_new_elements?: boolean } = {},
	) {
		return [];
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
		/* placeholder for browser cleanup */
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

	private async _handle_post_llm_processing(browser_state_summary: BrowserStateSummary, input_messages: any[]) {
		if (this.register_new_step_callback && this.state.last_model_output) {
			await this.register_new_step_callback(browser_state_summary, this.state.last_model_output, this.state.n_steps);
		}
		log_response(this.state.last_model_output!, this.controller, this.logger);
		if (this.settings.save_conversation_path) {
			const dir = this.settings.save_conversation_path;
			const filepath = path.join(dir, `step_${this.state.n_steps}.json`);
			await fs.promises.mkdir(path.dirname(filepath), { recursive: true });
			await fs.promises.writeFile(
				filepath,
				JSON.stringify({ messages: input_messages, response: this.state.last_model_output?.model_dump() }, null, 2),
				this.settings.save_conversation_path_encoding || 'utf-8',
			);
		}
	}

	private async _handle_step_error(error: Error) {
		const include_trace = this.logger.level === 'debug';
		const error_msg = AgentError.format_error(error, include_trace);
		this.state.consecutive_failures += 1;
		this.logger.error(`❌ Result failed ${this.state.consecutive_failures}/${this.settings.max_failures} times:\n ${error_msg}`);
		this.state.last_result = [new ActionResult({ error: error_msg })];
	}

	private async _finalize(browser_state_summary: BrowserStateSummary | null) {
		const step_end_time = Date.now() / 1000;
		if (!this.state.last_result) {
			return;
		}

		if (browser_state_summary) {
			const metadata = new StepMetadata(this.step_start_time, step_end_time, this.state.n_steps);
			await this._make_history_item(this.state.last_model_output, browser_state_summary, this.state.last_result, metadata);
		}

		this._log_step_completion_summary(this.step_start_time, this.state.last_result);
		this.save_file_system_state();

		if (browser_state_summary && this.state.last_model_output) {
			const actions_data = this.state.last_model_output.action.map((action) =>
				typeof (action as any)?.model_dump === 'function' ? (action as any).model_dump() : action,
			);
			const step_event = CreateAgentStepEvent.from_agent_step(
				this as any,
				this.state.last_model_output,
				this.state.last_result,
				actions_data,
				browser_state_summary,
			);
			this.eventbus.dispatch(step_event);
		}

		this.state.n_steps += 1;
	}

	private async _handle_final_step(step_info: AgentStepInfo | null = null) {
		if (step_info && step_info.is_last_step()) {
			this.logger.info('⚠️ Approaching last step. Prefer done action.');
		}
	}

	private async _get_model_output_with_retry(messages: any[]) {
		const completion = await this.llm.ainvoke(messages as any);
		const action = Array.isArray((completion as any).completion?.action)
			? (completion as any).completion.action
			: [];
		return new AgentOutput({
			thinking: (completion as any).completion?.thinking ?? null,
			evaluation_previous_goal: (completion as any).completion?.evaluation_previous_goal ?? null,
			memory: (completion as any).completion?.memory ?? null,
			next_goal: (completion as any).completion?.next_goal ?? null,
			action,
		});
	}

	private async _update_action_models_for_page(_page: Page | null) {
		/* placeholder for page-specific actions */
	}

	private async _check_and_update_downloads(context = '') {
		if (!this.has_downloads_path || !this.browser_session) {
			return;
		}

		try {
			const current_downloads = Array.isArray(this.browser_session.downloaded_files)
				? [...this.browser_session.downloaded_files]
				: [];
			const changed =
				current_downloads.length !== this._last_known_downloads.length ||
				current_downloads.some((value, index) => value !== this._last_known_downloads[index]);
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
			this.logger.debug(`📁 Failed to check for downloads${errorContext}: ${message}`);
		}
	}

	private _update_available_file_paths(downloads: string[]) {
		if (!this.has_downloads_path) {
			return;
		}

		const existing = this.available_file_paths ? [...this.available_file_paths] : [];
		const known = new Set(existing);
		const new_files = downloads.filter((pathValue) => !known.has(pathValue));

		if (new_files.length) {
			const updated = existing.concat(new_files);
			this.available_file_paths = updated;
			this.logger.info(
				`📁 Added ${new_files.length} downloaded files to available_file_paths (total: ${updated.length} files)`,
			);
			for (const file_path of new_files) {
				this.logger.info(`📄 New file available: ${file_path}`);
			}
		} else {
			this.logger.info(`📁 No new downloads detected (tracking ${existing.length} files)`);
		}
	}

	private _log_step_context(current_page: Page | null, browser_state_summary: BrowserStateSummary | null) {
		const url = current_page?.url ?? '';
		const url_short = url.length > 50 ? `${url.slice(0, 50)}...` : url;
		const interactive_count = browser_state_summary?.selector_map ? Object.keys(browser_state_summary.selector_map).length : 0;
		this.logger.info(
			`📍 Step ${this.state.n_steps}: Evaluating page with ${interactive_count} interactive elements on: ${url_short}`,
		);
	}

	private _log_step_completion_summary(step_start_time: number, result: ActionResult[]) {
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
		this.logger.info(`📍 Step ${this.state.n_steps}: Ran ${action_count} actions in ${step_duration.toFixed(2)}s: ${status_str}`);
	}

	private _log_agent_event(max_steps: number, agent_run_error: string | null) {
		if (!this.telemetry) {
			return;
		}

		const token_summary =
			this.token_cost_service?.get_usage_tokens_for_model?.(this.llm.model) ?? {
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
		const final_result_str = final_result != null ? JSON.stringify(final_result) : null;

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
			(this.settings as any)?.planner_llm && typeof (this.settings as any).planner_llm === 'object'
				? (this.settings as any).planner_llm.model ?? null
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
			}),
		);
	}

	private async _make_history_item(
		model_output: AgentOutput | null,
		browser_state_summary: BrowserStateSummary,
		result: ActionResult[],
		metadata: StepMetadata,
	) {
		const interacted_elements = model_output
			? AgentHistory.get_interacted_element(model_output, browser_state_summary.selector_map)
			: [];
		const state = new BrowserStateHistory(
			browser_state_summary.url,
			browser_state_summary.title,
			browser_state_summary.tabs,
			interacted_elements,
			this._current_screenshot_path,
		);
		this.history.add_item(new AgentHistory(model_output, result, state, metadata));
	}

	save_file_system_state() {
		if (!this.file_system) {
			this.logger.error('💾 File system is not set up. Cannot save state.');
			throw new Error('File system is not set up. Cannot save state.');
		}
		this.state.file_system_state = this.file_system.get_state();
	}
}
