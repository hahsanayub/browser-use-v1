import fs from 'node:fs';
import path from 'node:path';
import type { ActionModel } from '../controller/registry/views.js';
import { BrowserStateHistory } from '../browser/views.js';
import type { DOMHistoryElement } from '../dom/history-tree-processor/view.js';
import { HistoryTreeProcessor } from '../dom/history-tree-processor/service.js';
import type { DOMElementNode, SelectorMap } from '../dom/views.js';
import type { FileSystemState } from '../filesystem/file-system.js';
import { MessageManagerState } from './message-manager/views.js';
import type { UsageSummary } from '../tokens/views.js';

export interface StructuredOutputParser<T = unknown> {
	parse?: (input: string) => T;
	model_validate_json?: (input: string) => T;
}

const parseStructuredOutput = <T>(schema: StructuredOutputParser<T> | null | undefined, value: string): T | null => {
	if (!schema) {
		return null;
	}
	if (schema.parse) {
		return schema.parse(value);
	}
	if (schema.model_validate_json) {
		return schema.model_validate_json(value);
	}
	return null;
};

export interface ActionResultInit {
	is_done?: boolean | null;
	success?: boolean | null;
	error?: string | null;
	attachments?: string[] | null;
	long_term_memory?: string | null;
	extracted_content?: string | null;
	include_extracted_content_only_once?: boolean;
	include_in_memory?: boolean;
}

export class ActionResult {
	is_done: boolean | null;
	success: boolean | null;
	error: string | null;
	attachments: string[] | null;
	long_term_memory: string | null;
	extracted_content: string | null;
	include_extracted_content_only_once: boolean;
	include_in_memory: boolean;

	constructor(init: ActionResultInit = {}) {
		this.is_done = init.is_done ?? false;
		this.success = init.success ?? null;
		this.error = init.error ?? null;
		this.attachments = init.attachments ?? null;
		this.long_term_memory = init.long_term_memory ?? null;
		this.extracted_content = init.extracted_content ?? null;
		this.include_extracted_content_only_once = init.include_extracted_content_only_once ?? false;
		this.include_in_memory = init.include_in_memory ?? false;
		this.validate();
	}

	private validate() {
		if (this.success === true && this.is_done !== true) {
			throw new Error(
				'success=True can only be set when is_done=True. For regular actions that succeed, leave success as None. Use success=False only for actions that fail.',
			);
		}
	}

	toJSON() {
		return {
			is_done: this.is_done,
			success: this.success,
			error: this.error,
			attachments: this.attachments,
			long_term_memory: this.long_term_memory,
			extracted_content: this.extracted_content,
			include_extracted_content_only_once: this.include_extracted_content_only_once,
			include_in_memory: this.include_in_memory,
		};
	}

	model_dump() {
		return this.toJSON();
	}

	model_dump_json() {
		return JSON.stringify(this.toJSON());
	}
}

export interface AgentSettings {
	use_vision: boolean;
	vision_detail_level: 'auto' | 'low' | 'high';
	use_vision_for_planner: boolean;
	save_conversation_path: string | null;
	save_conversation_path_encoding: string | null;
	max_failures: number;
	retry_delay: number;
	validate_output: boolean;
	generate_gif: boolean | string;
	override_system_message: string | null;
	extend_system_message: string | null;
	include_attributes: string[];
	max_actions_per_step: number;
	use_thinking: boolean;
	flash_mode: boolean;
	max_history_items: number | null;
	page_extraction_llm: unknown | null;
	planner_llm: unknown | null;
	planner_interval: number;
	is_planner_reasoning: boolean;
	extend_planner_system_message: string | null;
	calculate_cost: boolean;
	include_tool_call_examples: boolean;
	llm_timeout: number;
	step_timeout: number;
}

export const defaultAgentSettings = (): AgentSettings => ({
	use_vision: true,
	vision_detail_level: 'auto',
	use_vision_for_planner: false,
	save_conversation_path: null,
	save_conversation_path_encoding: 'utf-8',
	max_failures: 3,
	retry_delay: 10,
	validate_output: false,
	generate_gif: false,
	override_system_message: null,
	extend_system_message: null,
	include_attributes: ['title', 'type', 'name', 'role', 'tabindex', 'aria-label', 'placeholder', 'value', 'alt', 'aria-expanded'],
	max_actions_per_step: 10,
	use_thinking: true,
	flash_mode: false,
	max_history_items: null,
	page_extraction_llm: null,
	planner_llm: null,
	planner_interval: 1,
	is_planner_reasoning: false,
	extend_planner_system_message: null,
	calculate_cost: false,
	include_tool_call_examples: false,
	llm_timeout: 60,
	step_timeout: 180,
});

export class AgentState {
	agent_id: string;
	n_steps: number;
	consecutive_failures: number;
	last_result: ActionResult[] | null;
	last_plan: string | null;
	last_model_output: AgentOutput | null;
	paused: boolean;
	stopped: boolean;
	message_manager_state: MessageManagerState;
	file_system_state: FileSystemState | null;

	constructor(init?: Partial<AgentState>) {
		this.agent_id = init?.agent_id ?? '';
		this.n_steps = init?.n_steps ?? 1;
		this.consecutive_failures = init?.consecutive_failures ?? 0;
		this.last_result = init?.last_result ?? null;
		this.last_plan = init?.last_plan ?? null;
		this.last_model_output = init?.last_model_output ?? null;
		this.paused = init?.paused ?? false;
		this.stopped = init?.stopped ?? false;
		if (init?.message_manager_state instanceof MessageManagerState) {
			this.message_manager_state = init.message_manager_state;
		} else if (init?.message_manager_state) {
			this.message_manager_state = Object.assign(new MessageManagerState(), init.message_manager_state);
		} else {
			this.message_manager_state = new MessageManagerState();
		}
		this.file_system_state = init?.file_system_state ?? null;
	}

	model_dump(): Record<string, unknown> {
		return {
			agent_id: this.agent_id,
			n_steps: this.n_steps,
			consecutive_failures: this.consecutive_failures,
			last_result: this.last_result?.map((result) => result.model_dump()) ?? null,
			last_plan: this.last_plan,
			last_model_output: this.last_model_output?.model_dump() ?? null,
			paused: this.paused,
			stopped: this.stopped,
			message_manager_state: JSON.parse(JSON.stringify(this.message_manager_state)),
			file_system_state: this.file_system_state,
		};
	}

	toJSON() {
		return this.model_dump();
	}
}

export class AgentStepInfo {
	constructor(public step_number: number, public max_steps: number) {}

	is_last_step() {
		return this.step_number >= this.max_steps - 1;
	}
}

export class StepMetadata {
	constructor(public step_start_time: number, public step_end_time: number, public step_number: number) {}

	get duration_seconds() {
		return this.step_end_time - this.step_start_time;
	}
}

export interface AgentBrain {
	thinking: string | null;
	evaluation_previous_goal: string;
	memory: string;
	next_goal: string;
}

export class AgentOutput {
	thinking: string | null;
	evaluation_previous_goal: string | null;
	memory: string | null;
	next_goal: string | null;
	action: ActionModel[];

	constructor(init?: Partial<AgentOutput>) {
		this.thinking = init?.thinking ?? null;
		this.evaluation_previous_goal = init?.evaluation_previous_goal ?? null;
		this.memory = init?.memory ?? null;
		this.next_goal = init?.next_goal ?? null;
		this.action = (init?.action ?? []).map((entry) => (entry instanceof ActionModel ? entry : new ActionModel(entry)));
	}

	get current_state(): AgentBrain {
		return {
			thinking: this.thinking,
			evaluation_previous_goal: this.evaluation_previous_goal ?? '',
			memory: this.memory ?? '',
			next_goal: this.next_goal ?? '',
		};
	}

	model_dump() {
		return {
			thinking: this.thinking,
			evaluation_previous_goal: this.evaluation_previous_goal,
			memory: this.memory,
			next_goal: this.next_goal,
			action: this.action.map((action) => action.model_dump?.() ?? action),
		};
	}

	model_dump_json() {
		return JSON.stringify(this.model_dump());
	}

	toJSON() {
		return this.model_dump();
	}

	static fromJSON(data: any): AgentOutput {
		if (!data) {
			return new AgentOutput();
		}
		const actions = Array.isArray(data.action) ? data.action.map((item) => new ActionModel(item)) : [];
		return new AgentOutput({
			thinking: data.thinking ?? null,
			evaluation_previous_goal: data.evaluation_previous_goal ?? null,
			memory: data.memory ?? null,
			next_goal: data.next_goal ?? null,
			action: actions,
		});
	}

	static type_with_custom_actions<T extends ActionModel>(_custom_actions: new (...args: any[]) => T) {
		return AgentOutput;
	}

	static type_with_custom_actions_no_thinking<T extends ActionModel>(_custom_actions: new (...args: any[]) => T) {
		return AgentOutput;
	}

	static type_with_custom_actions_flash_mode<T extends ActionModel>(_custom_actions: new (...args: any[]) => T) {
		return AgentOutput;
	}
}

export class AgentHistory {
	constructor(
		public model_output: AgentOutput | null,
		public result: ActionResult[],
		public state: BrowserStateHistory,
		public metadata: StepMetadata | null = null,
	) {}

	static get_interacted_element(model_output: AgentOutput, selector_map: SelectorMap) {
		const elements: Array<DOMHistoryElement | null> = [];
		for (const action of model_output.action) {
			const index = typeof action.get_index === 'function' ? action.get_index() : null;
			if (index != null && selector_map[index]) {
				const node = selector_map[index] as DOMElementNode;
				elements.push(HistoryTreeProcessor.convert_dom_element_to_history_element(node));
			} else {
				elements.push(null);
			}
		}
		return elements;
	}

	toJSON() {
		return {
			model_output: this.model_output?.toJSON() ?? null,
			result: this.result.map((r) => r.toJSON()),
			state: this.state.to_dict(),
			metadata: this.metadata
				? {
						step_start_time: this.metadata.step_start_time,
						step_end_time: this.metadata.step_end_time,
						step_number: this.metadata.step_number,
					}
				: null,
		};
	}
}

export class AgentHistoryList<TStructured = unknown> {
	history: AgentHistory[];
	usage: UsageSummary | null;
	_output_model_schema: StructuredOutputParser<TStructured> | null = null;

	constructor(history: AgentHistory[] = [], usage: UsageSummary | null = null) {
		this.history = history;
		this.usage = usage ?? null;
	}

	total_duration_seconds() {
		return this.history.reduce((sum, item) => sum + (item.metadata?.duration_seconds ?? 0), 0);
	}

	add_item(history_item: AgentHistory) {
		this.history.push(history_item);
	}

	last_action() {
		if (!this.history.length) {
			return null;
		}
		const last = this.history[this.history.length - 1];
		if (!last.model_output || !last.model_output.action.length) {
			return null;
		}
		const action = last.model_output.action[last.model_output.action.length - 1];
		if (typeof (action as any)?.model_dump === 'function') {
			return (action as any).model_dump();
		}
		return action;
	}

	errors() {
		return this.history.map((historyItem) => {
			const error = historyItem.result.find((result) => result.error);
			return error?.error ?? null;
		});
	}

	final_result(): string | null {
		if (!this.history.length) {
			return null;
		}
		const last = this.history[this.history.length - 1];
		const result = last.result[last.result.length - 1];
		return result?.extracted_content ?? null;
	}

	is_done() {
		if (!this.history.length) {
			return false;
		}
		const last = this.history[this.history.length - 1];
		const result = last.result[last.result.length - 1];
		return result?.is_done === true;
	}

	is_successful(): boolean | null {
		if (!this.history.length) {
			return null;
		}
		const last = this.history[this.history.length - 1];
		const result = last.result[last.result.length - 1];
		if (result?.is_done) {
			return result.success ?? null;
		}
		return null;
	}

	has_errors() {
		return this.errors().some((error) => error != null);
	}

	urls() {
		return this.history.map((item) => item.state.url ?? null);
	}

	screenshot_paths(n_last: number | null = null, return_none_if_not_screenshot = true) {
		if (n_last === 0) {
			return [];
		}
		const items = n_last == null ? this.history : this.history.slice(-n_last);
		return items
			.map((item) => item.state.screenshot_path ?? null)
			.filter((pathValue) => return_none_if_not_screenshot || pathValue !== null);
	}

	screenshots(n_last: number | null = null, return_none_if_not_screenshot = true) {
		if (n_last === 0) {
			return [];
		}
		const items = n_last == null ? this.history : this.history.slice(-n_last);
		const screenshots: Array<string | null> = [];
		for (const item of items) {
			const screenshot = item.state.get_screenshot();
			if (screenshot) {
				screenshots.push(screenshot);
			} else if (return_none_if_not_screenshot) {
				screenshots.push(null);
			}
		}
		return screenshots;
	}

	action_names() {
		const names: string[] = [];
		for (const action of this.model_actions()) {
			const [name] = Object.keys(action);
			if (name) {
				names.push(name);
			}
		}
		return names;
	}

	model_thoughts() {
		return this.history
			.filter((item) => item.model_output)
			.map((item) => item.model_output!.current_state);
	}

	model_outputs() {
		return this.history.filter((item) => item.model_output).map((item) => item.model_output!) ?? [];
	}

	model_actions() {
		const outputs: Record<string, unknown>[] = [];
		for (const item of this.history) {
			if (!item.model_output) {
				continue;
			}
			const interacted = item.state.interacted_element ?? [];
			for (let index = 0; index < item.model_output.action.length; index += 1) {
				const action = item.model_output.action[index];
				const interactedElement = interacted[index] ?? null;
				const payload =
					typeof (action as any)?.model_dump === 'function' ? (action as any).model_dump() : action;
				if (payload && typeof payload === 'object' && interactedElement) {
					(payload as Record<string, unknown>).interacted_element = interactedElement;
				} else if (payload && typeof payload === 'object') {
					(payload as Record<string, unknown>).interacted_element = interactedElement;
				}
				outputs.push(payload);
			}
		}
		return outputs;
	}

	action_history() {
		const history: Array<Array<Record<string, unknown>>> = [];
		for (const item of this.history) {
			const stepActions: Array<Record<string, unknown>> = [];
			if (item.model_output) {
				const interacted = item.state.interacted_element ?? [];
				for (let index = 0; index < item.model_output.action.length; index += 1) {
					const action = item.model_output.action[index];
					const interactedElement = interacted[index] ?? null;
					const result = item.result[index];
					const payload =
						typeof (action as any)?.model_dump === 'function' ? (action as any).model_dump() : action;
					const enriched: Record<string, unknown> =
						payload && typeof payload === 'object' ? { ...payload } : { action: payload };
					enriched.interacted_element = interactedElement;
					enriched.result = result?.long_term_memory ?? null;
					stepActions.push(enriched);
				}
			}
			history.push(stepActions);
		}
		return history;
	}

	action_results() {
		return this.history.flatMap((item) => item.result);
	}

	extracted_content() {
		return this.history.flatMap((item) => item.result.map((result) => result.extracted_content).filter(Boolean));
	}

	model_actions_filtered(include: string[] = []) {
		if (!include.length) {
			return this.model_actions();
		}
		return this.model_actions().filter((action) => {
			const [name] = Object.keys(action);
			return include.includes(name);
		});
	}

	number_of_steps() {
		return this.history.length;
	}

	get structured_output(): TStructured | null {
		const final_result = this.final_result();
		if (!final_result || !this._output_model_schema) {
			return null;
		}
		return parseStructuredOutput(this._output_model_schema, final_result);
	}

	save_to_file(filepath: string) {
		const dir = path.dirname(filepath);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(filepath, JSON.stringify(this.toJSON(), null, 2), 'utf-8');
	}

	static load_from_file(filepath: string, outputModel: typeof AgentOutput): AgentHistoryList {
		const content = fs.readFileSync(filepath, 'utf-8');
		const payload = JSON.parse(content) as { history?: any[] };
		const historyItems = (payload.history ?? []).map((entry) => {
			const modelOutput = entry.model_output ? outputModel.fromJSON(entry.model_output) : null;
			const result = (entry.result ?? []).map((item: ActionResultInit) => new ActionResult(item));
			const state = new (BrowserStateHistory as any)(
				entry.state?.url ?? '',
				entry.state?.title ?? '',
				entry.state?.tabs ?? [],
				entry.state?.interacted_element ?? [],
				entry.state?.screenshot_path ?? null,
			) as BrowserStateHistory;
			const metadata = entry.metadata
				? new StepMetadata(entry.metadata.step_start_time, entry.metadata.step_end_time, entry.metadata.step_number)
				: null;
			return new AgentHistory(modelOutput, result, state, metadata);
		});
		return new AgentHistoryList(historyItems);
	}

	toJSON() {
		return {
			history: this.history.map((item) => item.toJSON()),
			usage: this.usage,
		};
	}
}

export class AgentError extends Error {
	static VALIDATION_ERROR =
		'Invalid model output format. Please follow the correct schema.';
	static RATE_LIMIT_ERROR = 'Rate limit reached. Waiting before retry.';
	static NO_VALID_ACTION = 'No valid action found';

	static format_error(error: Error, include_trace = false) {
		if ((error as any)?.name === 'ValidationError') {
			return `${AgentError.VALIDATION_ERROR}\nDetails: ${error.message}`;
		}
		if (error.name === 'RateLimitError') {
			return AgentError.RATE_LIMIT_ERROR;
		}
		if (include_trace && (error as any)?.stack) {
			return `${error.message}\nStacktrace:\n${(error as any).stack}`;
		}
		return error.message;
	}
}
