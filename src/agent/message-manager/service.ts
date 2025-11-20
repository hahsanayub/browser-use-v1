import { ContentPartTextParam, SystemMessage, UserMessage, type Message } from '../../llm/messages.js';
import { ActionResult, AgentOutput, AgentStepInfo } from '../views.js';
import { BrowserStateSummary } from '../../browser/views.js';
import { FileSystem } from '../../filesystem/file-system.js';
import { AgentMessagePrompt } from '../prompts.js';
import { MessageManagerState, HistoryItem } from './views.js';
import { match_url_with_domain_pattern } from '../../utils.js';
import { createLogger } from '../../logging-config.js';

const logger = createLogger('browser_use.agent.message_manager');

export class MessageManager {
	private task: string;
	private systemPrompt: SystemMessage;
	private sensitiveDataDescription = '';
	private lastInputMessages: Message[] = [];
	private includeAttributes: string[];

	constructor(
		task: string,
		systemMessage: SystemMessage,
		private readonly fileSystem: FileSystem,
		private readonly state: MessageManagerState = new MessageManagerState(),
		private readonly useThinking = true,
		includeAttributes: string[] | null = null,
		private readonly sensitiveData?: Record<string, string | Record<string, string>>,
		private readonly maxHistoryItems: number | null = null,
		private readonly visionDetailLevel: 'auto' | 'low' | 'high' = 'auto',
		private readonly includeToolCallExamples = false,
	) {
		this.task = task;
		this.systemPrompt = systemMessage;
		this.includeAttributes = includeAttributes ?? [];

		if (!this.state.history.system_message) {
			this.setMessageWithType(this.systemPrompt, 'system');
		}
	}

	get agent_history_description() {
		if (this.maxHistoryItems == null) {
			return this.state.agent_history_items.map((item) => item.to_string()).join('\n');
		}

		const totalItems = this.state.agent_history_items.length;
		if (totalItems <= this.maxHistoryItems) {
			return this.state.agent_history_items.map((item) => item.to_string()).join('\n');
		}

		const omitted = totalItems - this.maxHistoryItems;
		const keepRecent = this.maxHistoryItems - 1;
		const parts: string[] = [];
		parts.push(this.state.agent_history_items[0].to_string());
		parts.push(`<sys>[... ${omitted} previous steps omitted...]</sys>`);
		parts.push(
			...this.state.agent_history_items.slice(-keepRecent).map((item) => item.to_string()),
		);
		return parts.join('\n');
	}

	add_new_task(new_task: string) {
		this.task = new_task;
		this.state.agent_history_items.push(
			new HistoryItem(null, null, null, null, null, null, `User updated <user_request> to: ${new_task}`),
		);
	}

	private updateAgentHistoryDescription(
		model_output: AgentOutput | null,
		result: ActionResult[] | null,
		step_info: AgentStepInfo | null,
	) {
		const results = result ?? [];
		const stepNumber = step_info?.step_number ?? null;
		this.state.read_state_description = '';

		let actionText = '';
		results.forEach((action, idx) => {
			const suffix = `Action ${idx + 1}/${results.length}: `;
			if (action.include_extracted_content_only_once && action.extracted_content) {
				this.state.read_state_description += `${action.extracted_content}\n`;
			}

			if (action.long_term_memory) {
				actionText += `${suffix}${action.long_term_memory}\n`;
			} else if (action.extracted_content && !action.include_extracted_content_only_once) {
				actionText += `${suffix}${action.extracted_content}\n`;
			}

			if (action.error) {
				const err = action.error.length > 200
					? `${action.error.slice(0, 100)}......${action.error.slice(-100)}`
					: action.error;
				actionText += `${suffix}${err}\n`;
			}
		});

		const normalizedActionText = actionText ? actionText.trim() : null;

		if (!model_output) {
			if (stepNumber != null && stepNumber > 0) {
				this.state.agent_history_items.push(
					new HistoryItem(stepNumber, null, null, null, null, 'Agent failed to output in the right format.', null),
				);
			}
			return;
		}

		const brain = model_output.current_state;
		this.state.agent_history_items.push(
			new HistoryItem(stepNumber, brain.evaluation_previous_goal, brain.memory, brain.next_goal, normalizedActionText, null, null),
		);
	}

	private getSensitiveDataDescription(currentUrl: string) {
		const placeholders = new Set<string>();
		if (!this.sensitiveData) {
			return '';
		}
		for (const [key, value] of Object.entries(this.sensitiveData)) {
			if (value && typeof value === 'object' && !Array.isArray(value)) {
				if (currentUrl && match_url_with_domain_pattern(currentUrl, key, true)) {
					Object.keys(value).forEach((entry) => placeholders.add(entry));
				}
			} else if (typeof value === 'string') {
				placeholders.add(key);
			}
		}
		if (!placeholders.size) {
			return '';
		}
		return `Here are placeholders for sensitive data:\n${Array.from(placeholders).sort().join(', ')}\nTo use them, write <secret>the placeholder name</secret>`;
	}

	create_state_messages(
		browser_state_summary: BrowserStateSummary,
		model_output: AgentOutput | null = null,
		result: ActionResult[] | null = null,
		step_info: AgentStepInfo | null = null,
		use_vision = true,
		page_filtered_actions: string | null = null,
		sensitive_data: Record<string, string | Record<string, string>> | null = null,
		available_file_paths: string[] | null = null,
	) {
		this.state.history.context_messages = [];
		this.updateAgentHistoryDescription(model_output, result, step_info);
		if (sensitive_data) {
			this.sensitiveDataDescription = this.getSensitiveDataDescription(browser_state_summary.url);
		}

		const screenshots: string[] = [];
		if (browser_state_summary.screenshot) {
			screenshots.push(browser_state_summary.screenshot);
		}

		const prompt = new AgentMessagePrompt({
			browser_state_summary,
			file_system: this.fileSystem,
			agent_history_description: this.agent_history_description,
			read_state_description: this.state.read_state_description,
			task: this.task,
			include_attributes: this.includeAttributes,
			step_info,
			page_filtered_actions,
			sensitive_data: this.sensitiveDataDescription,
			available_file_paths,
			screenshots,
			vision_detail_level: this.visionDetailLevel,
		});
		const message = prompt.get_user_message(use_vision);
		this.setMessageWithType(message, 'state');
	}

	get_messages() {
		logger.debug('');
		this.lastInputMessages = this.state.history.get_messages();
		return this.lastInputMessages;
	}

	private setMessageWithType(message: SystemMessage | UserMessage, messageType: 'system' | 'state') {
		const filtered = this.sensitiveData ? this.filterSensitiveData(message) : message;
		if (messageType === 'system') {
			this.state.history.system_message = filtered;
		} else {
			this.state.history.state_message = filtered;
		}
	}

	private addContextMessage(message: SystemMessage | UserMessage) {
		const filtered = this.sensitiveData ? this.filterSensitiveData(message) : message;
		this.state.history.context_messages.push(filtered);
	}

	private filterSensitiveData(message: SystemMessage | UserMessage) {
		if (!this.sensitiveData) {
			return message;
		}

		const replaceSensitive = (value: string) => {
			const placeholders: Record<string, string> = {};
			for (const [keyOrDomain, content] of Object.entries(this.sensitiveData!)) {
				if (content && typeof content === 'object' && !Array.isArray(content)) {
					for (const [k, v] of Object.entries(content)) {
						if (v) placeholders[k] = v;
					}
				} else if (typeof content === 'string') {
					placeholders[keyOrDomain] = content;
				}
			}
			if (!Object.keys(placeholders).length) {
				return value;
			}
			let updated = value;
			for (const [key, val] of Object.entries(placeholders)) {
				updated = updated.replaceAll(val, `<secret>${key}</secret>`);
			}
			return updated;
		};

		if (typeof message.content === 'string') {
			message.content = replaceSensitive(message.content);
		} else if (Array.isArray(message.content)) {
			message.content = message.content.map((part) => {
				if (part instanceof ContentPartTextParam) {
					part.text = replaceSensitive(part.text);
				}
				return part;
			});
		}
		return message;
	}
}
