import fs from 'node:fs';
import path from 'node:path';
import type { BrowserStateHistory } from '../browser/views.js';
import type { DOMHistoryElement } from '../dom/history-tree-processor/view.js';
import { HistoryTreeProcessor } from '../dom/history-tree-processor/service.js';
import type { DOMElementNode, SelectorMap } from '../dom/views.js';
import type { UsageSummary } from '../tokens/views.js';

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
	message_manager_state: Record<string, unknown>;
	file_system_state: Record<string, unknown> | null;

	constructor(init?: Partial<AgentState>) {
		this.agent_id = init?.agent_id ?? '';
		this.n_steps = init?.n_steps ?? 1;
		this.consecutive_failures = init?.consecutive_failures ?? 0;
		this.last_result = init?.last_result ?? null;
		this.last_plan = init?.last_plan ?? null;
		this.last_model_output = init?.last_model_output ?? null;
		this.paused = init?.paused ?? false;
		this.stopped = init?.stopped ?? false;
		this.message_manager_state = init?.message_manager_state ?? {};
		this.file_system_state = init?.file_system_state ?? null;
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
	action: any[];

	constructor(init?: Partial<AgentOutput>) {
		this.thinking = init?.thinking ?? null;
		this.evaluation_previous_goal = init?.evaluation_previous_goal ?? null;
		this.memory = init?.memory ?? null;
		this.next_goal = init?.next_goal ?? null;
		this.action = init?.action ?? [];
	}

	get current_state(): AgentBrain {
		return {
			thinking: this.thinking,
			evaluation_previous_goal: this.evaluation_previous_goal ?? '',
			memory: this.memory ?? '',
			next_goal: this.next_goal ?? '',
		};
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
}

export class AgentHistoryList {
	history: AgentHistory[];
	usage?: UsageSummary | null;

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

	save_to_file(filepath: string) {
		const dir = path.dirname(filepath);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(filepath, JSON.stringify(this.toJSON(), null, 2), 'utf-8');
	}

	toJSON() {
		return {
			history: this.history.map((item) => ({
				model_output: item.model_output,
				result: item.result.map((r) => r.toJSON()),
				state: item.state,
				metadata: item.metadata
					? {
							step_start_time: item.metadata.step_start_time,
							step_end_time: item.metadata.step_end_time,
							step_number: item.metadata.step_number,
						}
					: null,
			})),
		};
	}
}
