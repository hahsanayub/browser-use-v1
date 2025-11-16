import fs from 'node:fs';
import { z } from 'zod';
import { ActionResult } from '../agent/views.js';
import { BrowserError } from '../browser/views.js';
import { FileSystem } from '../filesystem/file-system.js';
import {
	ClickElementActionSchema,
	CloseTabActionSchema,
	DoneActionSchema,
	GoToUrlActionSchema,
	InputTextActionSchema,
	NoParamsActionSchema,
	SearchGoogleActionSchema,
	StructuredOutputActionSchema,
	SwitchTabActionSchema,
	UploadFileActionSchema,
} from './views.js';
import { Registry } from './registry/service.js';

type BrowserSession = any;
type Page = any;
type BaseChatModel = {
	ainvoke: (messages: Array<{ role?: string; content: string }>) => Promise<{ completion: string }>;
};

const DEFAULT_WAIT_OFFSET = 3;
const MAX_WAIT_SECONDS = 10;

export interface ControllerOptions<Context = unknown> {
	exclude_actions?: string[];
	output_model?: z.ZodTypeAny | null;
	display_files_in_done_text?: boolean;
	context?: Context;
}

export interface ActParams<Context = unknown> {
	browser_session: BrowserSession;
	page_extraction_llm?: BaseChatModel | null;
	sensitive_data?: Record<string, string | Record<string, string>> | null;
	available_file_paths?: string[] | null;
	file_system?: FileSystem | null;
	context?: Context | null;
}

const toActionEntries = (action: Record<string, unknown>) => {
	if (!action) {
		return [];
	}
	return Object.entries(action).filter(([, params]) => params != null);
};

export class Controller<Context = unknown> {
	public registry: Registry<Context>;
	private displayFilesInDoneText: boolean;

	constructor(options: ControllerOptions<Context> = {}) {
		const {
			exclude_actions = [],
			output_model = null,
			display_files_in_done_text = true,
		} = options;
		this.registry = new Registry<Context>(exclude_actions);
		this.displayFilesInDoneText = display_files_in_done_text;

		this.registerDefaultActions(output_model);
	}

	private registerDefaultActions(outputModel: z.ZodTypeAny | null) {
		this.registerDoneAction(outputModel);
		this.registerNavigationActions();
		this.registerElementActions();
		this.registerTabActions();
	}

	private registerNavigationActions() {
		type SearchGoogleAction = z.infer<typeof SearchGoogleActionSchema>;
		this.registry
			.action('Search the query in Google...', { param_model: SearchGoogleActionSchema })
			(async (params: SearchGoogleAction, { browser_session }) => {
				const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(params.query)}&udm=14`;
				const page = await browser_session.get_current_page();
				const currentUrl = page?.url?.replace(/\/+$/, '');
				if (currentUrl === 'https://www.google.com') {
					await browser_session.navigate_to(searchUrl);
				} else {
					await browser_session.create_new_tab(searchUrl);
				}
				const msg = `🔍  Searched for "${params.query}" in Google`;
				return new ActionResult({
					extracted_content: msg,
					include_in_memory: true,
					long_term_memory: `Searched Google for '${params.query}'`,
				});
			});

		type GoToUrlAction = z.infer<typeof GoToUrlActionSchema>;
		this.registry
			.action('Navigate to URL...', { param_model: GoToUrlActionSchema })
			(async (params: GoToUrlAction, { browser_session }) => {
				try {
					if (params.new_tab) {
						const page = await browser_session.create_new_tab(params.url);
						const tabIdx = browser_session.tabs.indexOf(page);
						const msg = `🔗  Opened new tab #${tabIdx} with url ${params.url}`;
						return new ActionResult({
							extracted_content: msg,
							include_in_memory: true,
							long_term_memory: `Opened new tab with URL ${params.url}`,
						});
					}
					await browser_session.navigate_to(params.url);
					const msg = `🔗 Navigated to ${params.url}`;
					return new ActionResult({
						extracted_content: msg,
						include_in_memory: true,
						long_term_memory: `Navigated to ${params.url}`,
					});
				} catch (error: any) {
					const errorMsg = String(error?.message ?? error ?? '');
					const networkFailures = [
						'ERR_NAME_NOT_RESOLVED',
						'ERR_INTERNET_DISCONNECTED',
						'ERR_CONNECTION_REFUSED',
						'ERR_TIMED_OUT',
						'net::',
					];
					if (networkFailures.some((needle) => errorMsg.includes(needle))) {
						const message = `Site unavailable: ${params.url} - ${errorMsg}`;
						throw new BrowserError(message);
					}
					throw error;
				}
			});

		this.registry.action('Go back', { param_model: NoParamsActionSchema })(async (_params, { browser_session }) => {
			await browser_session.go_back();
			const msg = '🔙  Navigated back';
			return new ActionResult({ extracted_content: msg });
		});

		this.registry.action(
			'Wait for x seconds default 3 (max 10 seconds). This can be used to wait until the page is fully loaded.',
		)(async (seconds = 3) => {
			const actualSeconds = Math.min(Math.max(seconds - DEFAULT_WAIT_OFFSET, 0), MAX_WAIT_SECONDS);
			const msg = `🕒  Waiting for ${actualSeconds + DEFAULT_WAIT_OFFSET} seconds`;
			if (actualSeconds > 0) {
				await new Promise((resolve) => setTimeout(resolve, actualSeconds * 1000));
			}
			return new ActionResult({ extracted_content: msg });
		});
	}

	private registerElementActions() {
		type ClickElementAction = z.infer<typeof ClickElementActionSchema>;
		this.registry
			.action('Click element by index', { param_model: ClickElementActionSchema })
			(async (params: ClickElementAction, { browser_session }) => {
				const element = await browser_session.get_dom_element_by_index(params.index);
				if (!element) {
					throw new BrowserError(`Element index ${params.index} does not exist - retry or use alternative actions`);
				}

				const initialTabs = Array.isArray(browser_session.tabs) ? browser_session.tabs.length : 0;
				if (browser_session.is_file_input?.(element)) {
					const msg = `Index ${params.index} - has an element which opens file upload dialog.`;
					return new ActionResult({
						extracted_content: msg,
						include_in_memory: true,
						success: false,
						long_term_memory: msg,
					});
				}

				const downloadPath = await browser_session._click_element_node(element);
				let msg = '';
				if (downloadPath) {
					msg = `💾 Downloaded file to ${downloadPath}`;
				} else {
					const snippet = element.get_all_text_till_next_clickable_element?.(2) ?? '';
					msg = `🖱️  Clicked button with index ${params.index}: ${snippet}`;
				}

				if (Array.isArray(browser_session.tabs) && browser_session.tabs.length > initialTabs) {
					msg += ' - New tab opened - switching to it';
					await browser_session.switch_to_tab(-1);
				}

				return new ActionResult({
					extracted_content: msg,
					include_in_memory: true,
					long_term_memory: msg,
				});
			});

		type InputTextAction = z.infer<typeof InputTextActionSchema>;
		this.registry
			.action('Click and input text into an input interactive element', { param_model: InputTextActionSchema })
			(async (params: InputTextAction, { browser_session, has_sensitive_data }) => {
				const element = await browser_session.get_dom_element_by_index(params.index);
				if (!element) {
					throw new BrowserError(`Element index ${params.index} does not exist - retry or use alternative actions`);
				}
				await browser_session._input_text_element_node(element, params.text);
				const msg = has_sensitive_data
					? `⌨️  Input sensitive data into index ${params.index}`
					: `⌨️  Input ${params.text} into index ${params.index}`;
				return new ActionResult({
					extracted_content: msg,
					include_in_memory: true,
					long_term_memory: `Input '${params.text}' into element ${params.index}.`,
				});
			});

		type UploadFileAction = z.infer<typeof UploadFileActionSchema>;
		this.registry
			.action('Upload file to interactive element with file path', { param_model: UploadFileActionSchema })
			(async (params: UploadFileAction, { browser_session, available_file_paths }) => {
				if (!available_file_paths?.includes(params.path)) {
					throw new BrowserError(`File path ${params.path} is not available`);
				}
				if (!fs.existsSync(params.path)) {
					throw new BrowserError(`File ${params.path} does not exist`);
				}

				const node = await browser_session.find_file_upload_element_by_index(params.index, 3, 3);
				if (!node) {
					throw new BrowserError(`No file upload element found at index ${params.index}`);
				}

				const locator = await browser_session.get_locate_element(node);
				if (!locator) {
					throw new BrowserError(`No file upload element found at index ${params.index}`);
				}

				await locator.set_input_files(params.path);
				const msg = `📁 Successfully uploaded file to index ${params.index}`;
				return new ActionResult({
					extracted_content: msg,
					include_in_memory: true,
					long_term_memory: `Uploaded file ${params.path} to element ${params.index}`,
				});
			});
	}

	private registerTabActions() {
		type SwitchTabAction = z.infer<typeof SwitchTabActionSchema>;
		this.registry.action('Switch tab', { param_model: SwitchTabActionSchema })(async (params: SwitchTabAction, ctx) => {
			const { browser_session } = ctx;
			await browser_session.switch_to_tab(params.page_id);
			const page: Page | null = await browser_session.get_current_page();
			try {
				await page?.wait_for_load_state?.('domcontentloaded', { timeout: 5000 });
			} catch {
				/* ignore */
			}
			const msg = `🔄  Switched to tab #${params.page_id} with url ${page?.url ?? ''}`;
			return new ActionResult({
				extracted_content: msg,
				include_in_memory: true,
				long_term_memory: `Switched to tab ${params.page_id}`,
			});
		});

		type CloseTabAction = z.infer<typeof CloseTabActionSchema>;
		this.registry.action('Close an existing tab', { param_model: CloseTabActionSchema })(
			async (params: CloseTabAction, { browser_session }) => {
				await browser_session.switch_to_tab(params.page_id);
				const page: Page | null = await browser_session.get_current_page();
				const url = page?.url ?? '';
				await page?.close();
				const newPage = await browser_session.get_current_page();
				const newIndex = browser_session.tabs.indexOf(newPage);
				const msg = `❌  Closed tab #${params.page_id} with ${url}, now focused on tab #${newIndex} with url ${newPage?.url ?? ''}`;
				return new ActionResult({
					extracted_content: msg,
					include_in_memory: true,
					long_term_memory: `Closed tab ${params.page_id} with url ${url}, now focused on tab ${newIndex} with url ${newPage?.url ?? ''}.`,
				});
			},
		);
	}

	private registerDoneAction(outputModel: z.ZodTypeAny | null) {
		if (outputModel) {
			const structuredSchema = StructuredOutputActionSchema(outputModel);
			type StructuredParams = z.infer<typeof structuredSchema>;
			this.registry
				.action(
					'Complete task - with return text and success flag.',
					{ param_model: structuredSchema },
				)(async (params: StructuredParams) => {
					const payload: Record<string, unknown> = { ...params.data };
					for (const key of Object.keys(payload)) {
						const value = payload[key];
						if (value && typeof value === 'object' && 'value' in value) {
							payload[key] = (value as any).value;
						}
					}
					return new ActionResult({
						is_done: true,
						success: params.success,
						extracted_content: JSON.stringify(payload),
						long_term_memory: `Task completed. Success Status: ${params.success}`,
					});
				});
			return;
		}

		type DoneAction = z.infer<typeof DoneActionSchema>;
		this.registry
			.action('Complete task - provide a summary to the user.', { param_model: DoneActionSchema })
			(async (params: DoneAction, { file_system }) => {
				const fsInstance = file_system ?? new FileSystem(process.cwd(), false);
				let userMessage = params.text;
				const lenMaxMemory = 100;
				let memory = `Task completed: ${params.success} - ${params.text.slice(0, lenMaxMemory)}`;
				if (params.text.length > lenMaxMemory) {
					memory += ` - ${params.text.length - lenMaxMemory} more characters`;
				}

				const attachments: string[] = [];
				if (params.files_to_display) {
					if (this.displayFilesInDoneText) {
						let attachmentText = '';
						for (const fileName of params.files_to_display) {
							if (fileName === 'todo.md') {
								continue;
							}
							const content = fsInstance.display_file(fileName);
							if (content) {
								attachmentText += `\n\n${fileName}:\n${content}`;
								attachments.push(fileName);
							}
						}
						if (attachmentText) {
							userMessage += '\n\nAttachments:';
							userMessage += attachmentText;
						}
					} else {
						for (const fileName of params.files_to_display) {
							if (fileName === 'todo.md') {
								continue;
							}
							const content = fsInstance.display_file(fileName);
							if (content) {
								attachments.push(fileName);
							}
						}
					}
				}

				const attachmentPaths = attachments.map((name) => `${fsInstance.get_dir()}/${name}`);
				return new ActionResult({
					is_done: true,
					success: params.success,
					extracted_content: userMessage,
					long_term_memory: memory,
					attachments: attachmentPaths,
				});
			});
	}

	use_structured_output_action(outputModel: z.ZodTypeAny) {
		this.registerDoneAction(outputModel);
	}

	action(description: string, options = {}) {
		return this.registry.action(description, options);
	}

	async act(
		action: Record<string, unknown>,
		{
			browser_session,
			page_extraction_llm = null,
			sensitive_data = null,
			available_file_paths = null,
			file_system = null,
			context = null,
		}: ActParams<Context>,
	) {
		const entries = toActionEntries(action);
		for (const [actionName, params] of entries) {
			try {
				const result = await this.registry.execute_action(
					actionName,
					params as Record<string, unknown>,
					{
						browser_session,
						page_extraction_llm,
						sensitive_data,
						available_file_paths,
						file_system,
						context,
					},
				);
				if (typeof result === 'string') {
					return new ActionResult({ extracted_content: result });
				}
				if (result instanceof ActionResult) {
					return result;
				}
				if (result == null) {
					return new ActionResult();
				}
				return new ActionResult({ extracted_content: JSON.stringify(result) });
			} catch (error: any) {
				return new ActionResult({ error: String(error?.message ?? error ?? '') });
			}
		}

		return new ActionResult();
	}
}
