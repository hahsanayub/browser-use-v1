import fs from 'node:fs';
import { z } from 'zod';
import { ActionResult } from '../agent/views.js';
import { BrowserError } from '../browser/views.js';
import { FileSystem } from '../filesystem/file-system.js';
import {
	ClickElementActionSchema,
	CloseTabActionSchema,
	DoneActionSchema,
	ExtractStructuredDataActionSchema,
	DropdownOptionsActionSchema,
	SelectDropdownActionSchema,
	GoToUrlActionSchema,
	InputTextActionSchema,
	NoParamsActionSchema,
	ReadFileActionSchema,
	ReplaceFileStrActionSchema,
	ScrollActionSchema,
	ScrollToTextActionSchema,
	SearchGoogleActionSchema,
	StructuredOutputActionSchema,
	SwitchTabActionSchema,
	UploadFileActionSchema,
	WriteFileActionSchema,
	SendKeysActionSchema,
	SheetsRangeActionSchema,
	SheetsUpdateActionSchema,
	SheetsInputActionSchema,
} from './views.js';
import { Registry } from './registry/service.js';
import TurndownService from 'turndown';
import { UserMessage } from '../llm/messages.js';

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
		this.registerContentActions();
		this.registerScrollActions();
		this.registerFileSystemActions();
		this.registerKeyboardActions();
		this.registerDropdownActions();
		this.registerSheetsActions();
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

	private registerContentActions() {
		type ExtractStructuredAction = z.infer<typeof ExtractStructuredDataActionSchema>;
		this.registry
			.action(
				'Extract structured, semantic data from the current webpage based on a textual query.',
				{
					param_model: ExtractStructuredDataActionSchema,
				},
			)(async (params: ExtractStructuredAction, { page, page_extraction_llm, file_system }) => {
				if (!page) {
					throw new BrowserError('No active page available for extraction.');
				}
				if (!page_extraction_llm) {
					throw new BrowserError('page_extraction_llm is not configured.');
				}
				const fsInstance = file_system ?? new FileSystem(process.cwd(), false);
				const html = await page.content?.();
				if (!html) {
					throw new BrowserError('Unable to extract page content.');
				}

				const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
				let rawHtml = html;
				if (!params.extract_links) {
					rawHtml = rawHtml.replace(/<a\b[^>]*>/gi, '').replace(/<\/a>/gi, '');
				}
				let content = turndown.turndown(rawHtml);
				content = content.replace(/\n+/g, '\n');
				const maxChars = 30000;
				if (content.length > maxChars) {
					const head = content.slice(0, maxChars / 2);
					const tail = content.slice(-maxChars / 2);
					content = `${head}\n... left out the middle because it was too long ...\n${tail}`;
				}

				const prompt = `You convert websites into structured information. Extract information from this webpage based on the query. Focus only on content relevant to the query. If 
1. The query is vague
2. Does not make sense for the page
3. Some/all of the information is not available

Explain the content of the page and that the requested information is not available in the page. Respond in JSON format.
Query: ${params.query}
Website:
${content}`;

				const response = await page_extraction_llm.ainvoke([new UserMessage(prompt)]);
				const completion = response?.completion ?? '';
				const extracted_content = `Page Link: ${page.url}\nQuery: ${params.query}\nExtracted Content:\n${completion}`;

				let includeOnce = false;
				let memory = extracted_content;
				const MAX_MEMORY_SIZE = 600;
				if (extracted_content.length > MAX_MEMORY_SIZE) {
					const lines = extracted_content.split('\n');
					let display = '';
					let count = 0;
					for (const line of lines) {
						if (display.length + line.length > MAX_MEMORY_SIZE) break;
						display += `${line}\n`;
						count += 1;
					}
					const saveResult = await fsInstance.save_extracted_content(extracted_content);
					memory = `Extracted content from ${page.url}\n<query>${params.query}\n</query>\n<extracted_content>\n${display}${lines.length - count} more lines...\n</extracted_content>\n<file_system>${saveResult}</file_system>`;
					includeOnce = true;
				}

				return new ActionResult({
					extracted_content,
					include_extracted_content_only_once: includeOnce,
					long_term_memory: memory,
				});
			});
	}

	private registerScrollActions() {
		type ScrollAction = z.infer<typeof ScrollActionSchema>;
		this.registry
			.action(
				'Scroll the page by specified number of pages (down=True scrolls down, down=False scrolls up).',
				{ param_model: ScrollActionSchema },
			)(async (params: ScrollAction, { browser_session }) => {
				const page: Page | null = await browser_session.get_current_page();
				if (!page || !page.evaluate) {
					throw new BrowserError('Unable to access current page for scrolling.');
				}

				const deltaPages = Math.max(Math.min(params.num_pages, 5), -5);
				const direction = params.down ? 1 : -1;
				const scrollBy = direction * deltaPages * 0.8;

				await page.evaluate(
					({ amount }) => {
						const distance = amount * window.innerHeight;
						window.scrollBy({ top: distance, behavior: 'smooth' });
					},
					{ amount: scrollBy },
				);

				const msg = `📜 Scrolled ${params.down ? 'down' : 'up'} ${Math.abs(deltaPages)} page(s)`;
				return new ActionResult({
					extracted_content: msg,
					include_in_memory: true,
					long_term_memory: msg,
				});
			});
		type ScrollToTextAction = z.infer<typeof ScrollToTextActionSchema>;
		this.registry
			.action('Scroll to a text in the current page', { param_model: ScrollToTextActionSchema })
			(async (params: ScrollToTextAction, { browser_session }) => {
				const page: Page | null = await browser_session.get_current_page();
				if (!page?.evaluate) {
					throw new BrowserError('Unable to access page for scrolling.');
				}

				const success = await page.evaluate(
					({ text }) => {
						const iterator = document.createNodeIterator(document.body, NodeFilter.SHOW_ELEMENT);
						let node: Node | null;
						while ((node = iterator.nextNode())) {
							const el = node as HTMLElement;
							if (!el || !el.textContent) continue;
							if (el.textContent.toLowerCase().includes(text.toLowerCase())) {
								el.scrollIntoView({ behavior: 'smooth', block: 'center' });
								return true;
							}
						}
						return false;
					},
					{ text: params.text },
				);

				if (!success) {
					throw new BrowserError(`Text '${params.text}' not found on page`);
				}

				const msg = `🔍  Scrolled to text: ${params.text}`;
				return new ActionResult({
					extracted_content: msg,
					include_in_memory: true,
					long_term_memory: msg,
				});
			});
	}

	private registerFileSystemActions() {
		type ReadFileAction = z.infer<typeof ReadFileActionSchema>;
		this.registry
			.action('Read file_name from file system', { param_model: ReadFileActionSchema })
			(async (params: ReadFileAction, { file_system, available_file_paths }) => {
				const fsInstance = file_system ?? new FileSystem(process.cwd(), false);
				const allowed = Array.isArray(available_file_paths) && available_file_paths.includes(params.file_name);
				const result = await fsInstance.read_file(params.file_name, allowed);
				const MAX_MEMORY_SIZE = 1000;
				let memory = result;
				if (result.length > MAX_MEMORY_SIZE) {
					const lines = result.split('\n');
					let preview = '';
					let used = 0;
					for (const line of lines) {
						if (preview.length + line.length > MAX_MEMORY_SIZE) break;
						preview += `${line}\n`;
						used += 1;
					}
					const remaining = lines.length - used;
					memory = remaining > 0 ? `${preview}${remaining} more lines...` : preview;
				}
				return new ActionResult({
					extracted_content: result,
					include_in_memory: true,
					long_term_memory: memory,
					include_extracted_content_only_once: true,
				});
			});

		type WriteFileAction = z.infer<typeof WriteFileActionSchema>;
		this.registry
			.action('Write content to file', { param_model: WriteFileActionSchema })
			(async (params: WriteFileAction, { file_system }) => {
				const fsInstance = file_system ?? new FileSystem(process.cwd(), false);
				let content = params.content;
				const trailing = params.trailing_newline ?? true;
				const leading = params.leading_newline ?? false;
				if (trailing) {
					content = `${content}\n`;
				}
				if (leading) {
					content = `\n${content}`;
				}
				const append = params.append ?? false;
				const result = append
					? await fsInstance.append_file(params.file_name, content)
					: await fsInstance.write_file(params.file_name, content);
				const msg = `📝  ${result}`;
				return new ActionResult({
					extracted_content: result,
					include_in_memory: true,
					long_term_memory: result,
				});
			});

		type ReplaceAction = z.infer<typeof ReplaceFileStrActionSchema>;
		this.registry
			.action('Replace text within an existing file', { param_model: ReplaceFileStrActionSchema })
			(async (params: ReplaceAction, { file_system }) => {
				const fsInstance = file_system ?? new FileSystem(process.cwd(), false);
				const result = await fsInstance.replace_file_str(params.file_name, params.old_str, params.new_str);
				return new ActionResult({
					extracted_content: result,
					include_in_memory: true,
					long_term_memory: result,
				});
			});
	}

	private registerKeyboardActions() {
		type SendKeysAction = z.infer<typeof SendKeysActionSchema>;
		this.registry.action('Send keys to the active page', { param_model: SendKeysActionSchema })(
			async (params: SendKeysAction, { browser_session }) => {
				const page: Page | null = await browser_session.get_current_page();
				const keyboard = page?.keyboard;
				if (!keyboard) {
					throw new BrowserError('Keyboard input is not available on the current page.');
				}
				try {
					await keyboard.press(params.keys);
				} catch (error) {
					if (error instanceof Error && error.message.includes('Unknown key')) {
						for (const char of params.keys) {
							await keyboard.press(char);
						}
					} else {
						throw error;
					}
				}
				const msg = `⌨️  Sent keys: ${params.keys}`;
				return new ActionResult({
					extracted_content: msg,
					include_in_memory: true,
					long_term_memory: msg,
				});
			},
		);
	}

	private registerDropdownActions() {
		type DropdownAction = z.infer<typeof DropdownOptionsActionSchema>;
		this.registry
			.action('Get all options from a native dropdown or ARIA menu', { param_model: DropdownOptionsActionSchema })
			(async (params: DropdownAction, { browser_session }) => {
				const page: Page | null = await browser_session.get_current_page();
				const domElement = await browser_session.get_dom_element_by_index(params.index);
				if (!domElement) {
					throw new BrowserError(`Element index ${params.index} does not exist.`);
				}
				if (!page?.evaluate) {
					throw new BrowserError('Unable to evaluate dropdown options on current page.');
				}
				if (!domElement.xpath) {
					throw new BrowserError('DOM element does not include an XPath selector.');
				}

				const payload = await page.evaluate(
					({ xpath }) => {
						const element = document.evaluate(
							xpath,
							document,
							null,
							XPathResult.FIRST_ORDERED_NODE_TYPE,
							null,
						).singleNodeValue as HTMLElement | null;
						if (!element) return null;
						if (element.tagName?.toLowerCase() === 'select') {
							const options = Array.from((element as HTMLSelectElement).options).map((opt, index) => ({
								text: opt.text,
								value: opt.value,
								index,
							}));
							return { type: 'select', options };
						}
						const ariaRoles = new Set(['menu', 'listbox', 'combobox']);
						const role = element.getAttribute('role');
						if (role && ariaRoles.has(role)) {
							const nodes = element.querySelectorAll('[role="menuitem"],[role="option"]');
							const options = Array.from(nodes).map((node, index) => ({
								text: node.textContent?.trim() ?? '',
								value: node.textContent?.trim() ?? '',
								index,
							}));
							return { type: 'aria', options };
						}
						return null;
					},
					{ xpath: domElement.xpath },
				);

				if (!payload || !payload.options?.length) {
					throw new BrowserError('No options found for the specified dropdown.');
				}

				const formatted = payload.options.map(
					(opt: any) => `${opt.index}: text=${JSON.stringify(opt.text ?? '')}`,
				);
				formatted.push('Use the exact text string in select_dropdown_option');

				const message = formatted.join('\n');
				return new ActionResult({
					extracted_content: message,
					include_in_memory: true,
					include_extracted_content_only_once: true,
					long_term_memory: `Found dropdown options for index ${params.index}.`,
				});
			});

		type SelectAction = z.infer<typeof SelectDropdownActionSchema>;
		this.registry
			.action('Select dropdown option or ARIA menu item by text', { param_model: SelectDropdownActionSchema })
			(async (params: SelectAction, { browser_session }) => {
				const page: Page | null = await browser_session.get_current_page();
				const domElement = await browser_session.get_dom_element_by_index(params.index);
				if (!domElement?.xpath) {
					throw new BrowserError('DOM element does not include an XPath selector.');
				}
				if (!page) {
					throw new BrowserError('No active page for selection.');
				}

				for (const frame of page.frames ?? []) {
					try {
						const typeInfo = await frame.evaluate(
							(xpath) => {
								const element = document.evaluate(
									xpath,
									document,
									null,
									XPathResult.FIRST_ORDERED_NODE_TYPE,
									null,
								).singleNodeValue as HTMLElement | null;
								if (!element) return { found: false };
								const tagName = element.tagName?.toLowerCase();
								const role = element.getAttribute?.('role');
								if (tagName === 'select') return { found: true, type: 'select' };
								if (role && ['menu', 'listbox', 'combobox'].includes(role)) return { found: true, type: 'aria' };
								return { found: false };
							},
							domElement.xpath,
						);

						if (!typeInfo?.found) continue;

						if (typeInfo.type === 'select') {
							await frame.locator(domElement.xpath).first().select_option({ label: params.text });
							const msg = `Selected option ${params.text}`;
							return new ActionResult({
								extracted_content: msg,
								include_in_memory: true,
								long_term_memory: msg,
							});
						}

						const clicked = await frame.evaluate(
							({ xpath, text }) => {
								const root = document.evaluate(
									xpath,
									document,
									null,
									XPathResult.FIRST_ORDERED_NODE_TYPE,
									null,
								).singleNodeValue as HTMLElement | null;
								if (!root) return false;
								const nodes = root.querySelectorAll('[role="menuitem"],[role="option"]');
								for (const node of Array.from(nodes)) {
									if (node.textContent?.trim() === text) {
										(node as HTMLElement).click();
										return true;
									}
								}
								return false;
							},
							{ xpath: domElement.xpath, text: params.text },
						);

						if (clicked) {
							const msg = `Selected menu item ${params.text}`;
							return new ActionResult({
								extracted_content: msg,
								include_in_memory: true,
								long_term_memory: msg,
							});
						}
					} catch (error) {
						continue;
					}
				}

				throw new BrowserError(`Could not select option '${params.text}' for index ${params.index}`);
			});
	}

	private registerSheetsActions() {
		this.registry
			.action('Google Sheets: Get the contents of the entire sheet', {
				domains: ['https://docs.google.com'],
			})(async (_params, { browser_session }) => {
				const page: Page | null = await browser_session.get_current_page();
				await page?.keyboard?.press('Enter');
				await page?.keyboard?.press('Escape');
				await page?.keyboard?.press('ControlOrMeta+A');
				await page?.keyboard?.press('ControlOrMeta+C');
				const content = await page?.evaluate?.(() => navigator.clipboard.readText());
				return new ActionResult({
					extracted_content: content ?? '',
					include_in_memory: true,
					long_term_memory: 'Retrieved sheet contents',
					include_extracted_content_only_once: true,
				});
			});

		type SheetsRange = z.infer<typeof SheetsRangeActionSchema>;
		this.registry
			.action('Google Sheets: Get the contents of a cell or range of cells', {
				domains: ['https://docs.google.com'],
				param_model: SheetsRangeActionSchema,
			})(async (params: SheetsRange, { browser_session }) => {
				const page: Page | null = await browser_session.get_current_page();
				await this.gotoSheetsRange(page, params.cell_or_range);
				await page?.keyboard?.press('ControlOrMeta+C');
				await new Promise((resolve) => setTimeout(resolve, 100));
				const content = await page?.evaluate?.(() => navigator.clipboard.readText());
				return new ActionResult({
					extracted_content: content ?? '',
					include_in_memory: true,
					long_term_memory: `Retrieved contents from ${params.cell_or_range}`,
					include_extracted_content_only_once: true,
				});
			});

		type SheetsUpdate = z.infer<typeof SheetsUpdateActionSchema>;
		this.registry
			.action('Google Sheets: Update the content of a cell or range of cells', {
				domains: ['https://docs.google.com'],
				param_model: SheetsUpdateActionSchema,
			})(async (params: SheetsUpdate, { browser_session }) => {
				const page: Page | null = await browser_session.get_current_page();
				await this.gotoSheetsRange(page, params.cell_or_range);
				await page?.evaluate?.(
					(value) => {
						const clipboardData = new DataTransfer();
						clipboardData.setData('text/plain', value);
						document.activeElement?.dispatchEvent(new ClipboardEvent('paste', { clipboardData }));
					},
					params.value,
				);
				return new ActionResult({
					extracted_content: `Updated cells: ${params.cell_or_range} = ${params.value}`,
					long_term_memory: `Updated cells ${params.cell_or_range} with ${params.value}`,
				});
			});

		this.registry
			.action('Google Sheets: Clear whatever cells are currently selected', {
				domains: ['https://docs.google.com'],
				param_model: SheetsRangeActionSchema,
			})(async (params: SheetsRange, { browser_session }) => {
				const page: Page | null = await browser_session.get_current_page();
				await this.gotoSheetsRange(page, params.cell_or_range);
				await page?.keyboard?.press('Backspace');
				return new ActionResult({
					extracted_content: `Cleared cells: ${params.cell_or_range}`,
					long_term_memory: `Cleared cells ${params.cell_or_range}`,
				});
			});

		this.registry
			.action('Google Sheets: Select a specific cell or range of cells', {
				domains: ['https://docs.google.com'],
				param_model: SheetsRangeActionSchema,
			})(async (params: SheetsRange, { browser_session }) => {
				const page: Page | null = await browser_session.get_current_page();
				await this.gotoSheetsRange(page, params.cell_or_range);
				return new ActionResult({
					extracted_content: `Selected cells: ${params.cell_or_range}`,
					long_term_memory: `Selected cells ${params.cell_or_range}`,
				});
			});

		this.registry
			.action(
				'Google Sheets: Fallback method to type text into the currently selected cell',
				{ domains: ['https://docs.google.com'], param_model: SheetsInputActionSchema },
			)(async (params: z.infer<typeof SheetsInputActionSchema>, { browser_session }) => {
				const page: Page | null = await browser_session.get_current_page();
				await page?.keyboard?.type(params.text, { delay: 100 });
				await page?.keyboard?.press('Enter');
				await page?.keyboard?.press('ArrowUp');
				return new ActionResult({
					extracted_content: `Inputted text ${params.text}`,
					long_term_memory: `Inputted text '${params.text}' into cell`,
				});
			});
	}

	private async gotoSheetsRange(page: Page | null, cell_or_range: string) {
		if (!page?.keyboard) {
			throw new BrowserError('No keyboard available for Google Sheets actions.');
		}
		await page.keyboard.press('Enter');
		await page.keyboard.press('Escape');
		await new Promise((resolve) => setTimeout(resolve, 100));
		await page.keyboard.press('Home');
		await page.keyboard.press('ArrowUp');
		await new Promise((resolve) => setTimeout(resolve, 100));
		await page.keyboard.press('Control+G');
		await new Promise((resolve) => setTimeout(resolve, 200));
		await page.keyboard.type(cell_or_range, { delay: 50 });
		await page.keyboard.press('Enter');
		await new Promise((resolve) => setTimeout(resolve, 200));
		await page.keyboard.press('Escape');
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
