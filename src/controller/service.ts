import fs, { promises as fsp } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ActionResult } from '../agent/views.js';
import { BrowserError } from '../browser/views.js';
import { extractPdfText, FileSystem } from '../filesystem/file-system.js';
import {
  ClickElementActionSchema,
  CloseTabActionSchema,
  DoneActionSchema,
  EvaluateActionSchema,
  ExtractStructuredDataActionSchema,
  FindElementsActionSchema,
  DropdownOptionsActionSchema,
  SelectDropdownActionSchema,
  GoToUrlActionSchema,
  InputTextActionSchema,
  NoParamsActionSchema,
  ReadLongContentActionSchema,
  ReadFileActionSchema,
  ReplaceFileStrActionSchema,
  ScrollActionSchema,
  ScrollToTextActionSchema,
  SearchActionSchema,
  SearchPageActionSchema,
  SearchGoogleActionSchema,
  ScreenshotActionSchema,
  StructuredOutputActionSchema,
  SwitchTabActionSchema,
  UploadFileActionSchema,
  WaitActionSchema,
  WriteFileActionSchema,
  SendKeysActionSchema,
  SheetsRangeActionSchema,
  SheetsUpdateActionSchema,
  SheetsInputActionSchema,
} from './views.js';
import { Registry } from './registry/service.js';
import TurndownService from 'turndown';
import { UserMessage } from '../llm/messages.js';
import { createLogger } from '../logging-config.js';

type BrowserSession = any;
type Page = any;
type BaseChatModel = {
  ainvoke: (
    messages: any[],
    output_format?: undefined,
    options?: { signal?: AbortSignal }
  ) => Promise<{ completion: string }>;
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
  signal?: AbortSignal | null;
}

const toActionEntries = (action: Record<string, unknown>) => {
  if (!action) {
    return [];
  }
  return Object.entries(action).filter(([, params]) => params != null);
};

const createAbortError = (reason?: unknown) => {
  if (reason instanceof Error) {
    return reason;
  }
  const error = new Error('Operation aborted');
  error.name = 'AbortError';
  return error;
};

const isAbortError = (error: unknown): boolean => {
  return error instanceof Error && error.name === 'AbortError';
};

const throwIfAborted = (signal?: AbortSignal | null) => {
  if (signal?.aborted) {
    throw createAbortError(signal.reason);
  }
};

const waitWithSignal = async (
  timeoutMs: number,
  signal?: AbortSignal | null
) => {
  if (timeoutMs <= 0) {
    throwIfAborted(signal);
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, timeoutMs);

    const onAbort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(createAbortError(signal?.reason));
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
};

const runWithTimeoutAndSignal = async <T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal | null,
  timeoutMessage = 'Operation timed out'
): Promise<T> => {
  throwIfAborted(signal);
  if (timeoutMs <= 0) {
    return operation();
  }

  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(createAbortError(signal?.reason));
    };

    const onTimeout = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(new Error(timeoutMessage));
    };

    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      signal?.removeEventListener('abort', onAbort);
    };

    const timeout = setTimeout(onTimeout, timeoutMs);

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    void operation()
      .then((value) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      })
      .catch((error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      });
  });
};

export class Controller<Context = unknown> {
  public registry: Registry<Context>;
  private displayFilesInDoneText: boolean;
  private logger: ReturnType<typeof createLogger>;

  constructor(options: ControllerOptions<Context> = {}) {
    const {
      exclude_actions = [],
      output_model = null,
      display_files_in_done_text = true,
    } = options;
    this.registry = new Registry<Context>(exclude_actions);
    this.displayFilesInDoneText = display_files_in_done_text;
    this.logger = createLogger('browser_use.controller');

    this.registerDefaultActions(output_model);
  }

  private registerDefaultActions(outputModel: z.ZodTypeAny | null) {
    this.registerDoneAction(outputModel);
    this.registerNavigationActions();
    this.registerElementActions();
    this.registerTabActions();
    this.registerContentActions();
    this.registerExplorationActions();
    this.registerScrollActions();
    this.registerFileSystemActions();
    this.registerUtilityActions();
    this.registerKeyboardActions();
    this.registerDropdownActions();
    this.registerSheetsActions();
  }

  private registerNavigationActions() {
    type SearchAction = z.infer<typeof SearchActionSchema>;
    this.registry.action(
      'Search the query on a web search engine (duckduckgo, google, or bing).',
      { param_model: SearchActionSchema, terminates_sequence: true }
    )(async function search(params: SearchAction, { browser_session, signal }) {
      if (!browser_session) throw new Error('Browser session missing');
      throwIfAborted(signal);

      const engine = params.engine ?? 'duckduckgo';
      const searchUrlByEngine: Record<SearchAction['engine'], string> = {
        duckduckgo: `https://duckduckgo.com/?q=${encodeURIComponent(params.query)}`,
        google: `https://www.google.com/search?q=${encodeURIComponent(params.query)}&udm=14`,
        bing: `https://www.bing.com/search?q=${encodeURIComponent(params.query)}`,
      };
      const searchUrl = searchUrlByEngine[engine];

      const page = await browser_session.get_current_page();
      const currentUrl = page?.url?.().replace(/\/+$/, '');
      if (
        currentUrl === 'https://www.google.com' ||
        currentUrl === 'https://duckduckgo.com' ||
        currentUrl === 'https://www.bing.com'
      ) {
        await browser_session.navigate_to(searchUrl, { signal });
      } else {
        await browser_session.create_new_tab(searchUrl, { signal });
      }

      const msg = `🔍 Searched for "${params.query}" on ${engine}`;
      return new ActionResult({
        extracted_content: msg,
        include_in_memory: true,
        long_term_memory: `Searched ${engine} for '${params.query}'`,
      });
    });

    type SearchGoogleAction = z.infer<typeof SearchGoogleActionSchema>;
    this.registry.action('Search the query in Google...', {
      param_model: SearchGoogleActionSchema,
      terminates_sequence: true,
    })(async function search_google(
      params: SearchGoogleAction,
      { browser_session, signal }
    ) {
      if (!browser_session) throw new Error('Browser session missing');
      throwIfAborted(signal);
      const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(params.query)}&udm=14`;
      const page = await browser_session.get_current_page();
      const currentUrl = page?.url().replace(/\/+$/, '');
      if (currentUrl === 'https://www.google.com') {
        await browser_session.navigate_to(searchUrl, { signal });
      } else {
        await browser_session.create_new_tab(searchUrl, { signal });
      }
      const msg = `🔍  Searched for "${params.query}" in Google`;
      return new ActionResult({
        extracted_content: msg,
        include_in_memory: true,
        long_term_memory: `Searched Google for '${params.query}'`,
      });
    });

    type GoToUrlAction = z.infer<typeof GoToUrlActionSchema>;
    this.registry.action('Navigate to URL...', {
      param_model: GoToUrlActionSchema,
      terminates_sequence: true,
    })(async function go_to_url(
      params: GoToUrlAction,
      { browser_session, signal }
    ) {
      if (!browser_session) throw new Error('Browser session missing');
      throwIfAborted(signal);
      try {
        if (params.new_tab) {
          await browser_session.create_new_tab(params.url, { signal });
          const tabIdx = browser_session.active_tab_index;
          const msg = `🔗  Opened new tab #${tabIdx} with url ${params.url}`;
          return new ActionResult({
            extracted_content: msg,
            include_in_memory: true,
            long_term_memory: `Opened new tab with URL ${params.url}`,
          });
        }
        await browser_session.navigate_to(params.url, { signal });
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

    this.registry.action('Go back', {
      param_model: NoParamsActionSchema,
      terminates_sequence: true,
    })(
      async function go_back(_params, { browser_session, signal }) {
        if (!browser_session) throw new Error('Browser session missing');
        throwIfAborted(signal);
        await browser_session.go_back({ signal });
        const msg = '🔙  Navigated back';
        return new ActionResult({ extracted_content: msg });
      }
    );

    type WaitAction = z.infer<typeof WaitActionSchema>;
    this.registry.action(
      'Wait for x seconds default 3 (max 10 seconds). This can be used to wait until the page is fully loaded.',
      { param_model: WaitActionSchema }
    )(async function wait(params: WaitAction, { signal }) {
      const seconds = params.seconds ?? 3;
      const actualSeconds = Math.min(
        Math.max(seconds - DEFAULT_WAIT_OFFSET, 0),
        MAX_WAIT_SECONDS
      );
      const msg = `🕒  Waiting for ${actualSeconds + DEFAULT_WAIT_OFFSET} seconds`;
      if (actualSeconds > 0) {
        await waitWithSignal(actualSeconds * 1000, signal);
      }
      return new ActionResult({ extracted_content: msg });
    });
  }

  private registerElementActions() {
    type ClickElementAction = z.infer<typeof ClickElementActionSchema>;
    const clickDescription =
      'Click element by index or by viewport coordinates (coordinate_x/coordinate_y).';
    const clickImpl = async (
      params: ClickElementAction,
      { browser_session, signal }: any
    ) => {
      if (!browser_session) throw new Error('Browser session missing');
      throwIfAborted(signal);
      const collectTabIds = (): Set<number> => {
        if (!Array.isArray(browser_session.tabs)) {
          return new Set<number>();
        }
        return new Set<number>(
          browser_session.tabs
            .map((tab: any) => tab?.page_id)
            .filter(
              (pageId: unknown): pageId is number =>
                typeof pageId === 'number' && Number.isFinite(pageId)
            )
        );
      };
      const detectNewTabNote = async (tabsBefore: Set<number>) => {
        try {
          await waitWithSignal(50, signal);
          const tabsAfter = Array.isArray(browser_session.tabs)
            ? browser_session.tabs
            : [];
          const newTab = tabsAfter.find((tab: any) => {
            const pageId = tab?.page_id;
            return typeof pageId === 'number' && !tabsBefore.has(pageId);
          });
          if (!newTab) {
            return '';
          }
          const tabId = String(newTab.page_id);
          return `. Note: This opened a new tab (tab_id: ${tabId}) - switch to it if you need to interact with the new page.`;
        } catch {
          return '';
        }
      };

      if (
        params.coordinate_x != null &&
        params.coordinate_y != null &&
        params.index == null
      ) {
        const tabsBefore = collectTabIds();
        const page: Page | null = await browser_session.get_current_page();
        if (!page?.mouse?.click) {
          throw new BrowserError(
            'Unable to perform coordinate click on the current page.'
          );
        }
        await page.mouse.click(params.coordinate_x, params.coordinate_y);
        const coordinateMessage =
          `🖱️ Clicked at coordinates (${params.coordinate_x}, ${params.coordinate_y})` +
          (await detectNewTabNote(tabsBefore));
        return new ActionResult({
          extracted_content: coordinateMessage,
          include_in_memory: true,
          long_term_memory: coordinateMessage,
        });
      }

      if (params.index == null) {
        throw new BrowserError(
          'Provide element index or both coordinate_x and coordinate_y.'
        );
      }

      const element = await browser_session.get_dom_element_by_index(params.index, {
        signal,
      });
      if (!element) {
        throw new BrowserError(
          `Element index ${params.index} does not exist - retry or use alternative actions`
        );
      }
      const tabsBefore = collectTabIds();
      if (browser_session.is_file_input?.(element)) {
        const msg = `Index ${params.index} - has an element which opens file upload dialog.`;
        return new ActionResult({
          extracted_content: msg,
          include_in_memory: true,
          success: false,
          long_term_memory: msg,
        });
      }

      const downloadPath = await browser_session._click_element_node(element, {
        signal,
      });
      let msg = '';
      if (downloadPath) {
        msg = `💾 Downloaded file to ${downloadPath}`;
      } else {
        const snippet =
          element.get_all_text_till_next_clickable_element?.(2) ?? '';
        msg = `🖱️  Clicked button with index ${params.index}: ${snippet}`;
      }

      msg += await detectNewTabNote(tabsBefore);

      return new ActionResult({
        extracted_content: msg,
        include_in_memory: true,
        long_term_memory: msg,
      });
    };

    this.registry.action(clickDescription, {
      param_model: ClickElementActionSchema,
    })(async function click_element_by_index(params: ClickElementAction, ctx) {
      return clickImpl(params, ctx);
    });
    this.registry.action(clickDescription, {
      param_model: ClickElementActionSchema,
    })(async function click(params: ClickElementAction, ctx) {
      return clickImpl(params, ctx);
    });

    type InputTextAction = z.infer<typeof InputTextActionSchema>;
    this.registry.action(
      'Click and input text into an input interactive element',
      { param_model: InputTextActionSchema }
    )(async function input_text(
      params: InputTextAction,
      { browser_session, has_sensitive_data, signal }
    ) {
      if (!browser_session) throw new Error('Browser session missing');
      throwIfAborted(signal);
      const element = await browser_session.get_dom_element_by_index(
        params.index,
        { signal }
      );
      if (!element) {
        throw new BrowserError(
          `Element index ${params.index} does not exist - retry or use alternative actions`
        );
      }
      await browser_session._input_text_element_node(element, params.text, {
        signal,
      });
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
    this.registry.action('Upload file to interactive element with file path', {
      param_model: UploadFileActionSchema,
    })(async function upload_file(
      params: UploadFileAction,
      { browser_session, available_file_paths, signal }
    ) {
      if (!browser_session) throw new Error('Browser session missing');
      throwIfAborted(signal);
      if (!available_file_paths?.includes(params.path)) {
        throw new BrowserError(`File path ${params.path} is not available`);
      }
      if (!fs.existsSync(params.path)) {
        throw new BrowserError(`File ${params.path} does not exist`);
      }

      const node = await browser_session.find_file_upload_element_by_index(
        params.index,
        3,
        3,
        { signal }
      );
      if (!node) {
        throw new BrowserError(
          `No file upload element found at index ${params.index}`
        );
      }

      const locator = await browser_session.get_locate_element(node);
      if (!locator) {
        throw new BrowserError(
          `No file upload element found at index ${params.index}`
        );
      }

      await locator.setInputFiles(params.path);
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
    this.registry.action('Switch tab', {
      param_model: SwitchTabActionSchema,
      terminates_sequence: true,
    })(
      async function switch_tab(params: SwitchTabAction, ctx) {
        const { browser_session, signal } = ctx;
        if (!browser_session) throw new Error('Browser session missing');
        throwIfAborted(signal);
        await browser_session.switch_to_tab(params.page_id, { signal });
        const page: Page | null = await browser_session.get_current_page();
        try {
          await page?.wait_for_load_state?.('domcontentloaded', {
            timeout: 5000,
          });
        } catch {
          /* ignore */
        }
        const msg = `🔄  Switched to tab #${params.page_id} with url ${page?.url ?? ''}`;
        return new ActionResult({
          extracted_content: msg,
          include_in_memory: true,
          long_term_memory: `Switched to tab ${params.page_id}`,
        });
      }
    );

    type CloseTabAction = z.infer<typeof CloseTabActionSchema>;
    this.registry.action('Close an existing tab', {
      param_model: CloseTabActionSchema,
      terminates_sequence: true,
    })(async function close_tab(
      params: CloseTabAction,
      { browser_session, signal }
    ) {
      if (!browser_session) throw new Error('Browser session missing');
      throwIfAborted(signal);
      await browser_session.switch_to_tab(params.page_id, { signal });
      const page: Page | null = await browser_session.get_current_page();
      const url = page?.url ?? '';
      await page?.close?.();
      const newPage = await browser_session.get_current_page();
      const newIndex = browser_session.active_tab_index;
      const msg = `❌  Closed tab #${params.page_id} with ${url}, now focused on tab #${newIndex} with url ${newPage?.url ?? ''}`;
      return new ActionResult({
        extracted_content: msg,
        include_in_memory: true,
        long_term_memory: `Closed tab ${params.page_id} with url ${url}, now focused on tab ${newIndex} with url ${newPage?.url ?? ''}.`,
      });
    });
  }

  private registerContentActions() {
    type ExtractStructuredAction = z.infer<
      typeof ExtractStructuredDataActionSchema
    >;
    this.registry.action(
      'Extract structured, semantic data from the current webpage based on a textual query.',
      {
        param_model: ExtractStructuredDataActionSchema,
      }
    )(async function extract_structured_data(
      params: ExtractStructuredAction,
      { page, page_extraction_llm, extraction_schema, file_system, signal }
    ) {
      throwIfAborted(signal);
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

      const turndown = new TurndownService({
        headingStyle: 'atx',
        codeBlockStyle: 'fenced',
      });
      let rawHtml = html;
      if (!params.extract_links) {
        rawHtml = rawHtml.replace(/<a\b[^>]*>/gi, '').replace(/<\/a>/gi, '');
      }
      let content = turndown.turndown(rawHtml);
      content = content.replace(/\n+/g, '\n');

      // Manually append iframe text into the content so it's readable by the LLM (includes cross-origin iframes)
      const frames = page.frames?.() || [];
      for (const iframe of frames) {
        throwIfAborted(signal);
        try {
          // Wait for iframe to load with aggressive timeout
          await runWithTimeoutAndSignal(
            async () => {
              await iframe.waitForLoadState?.('load');
            },
            2000,
            signal,
            'Iframe load timeout'
          );
        } catch (error) {
          if (isAbortError(error)) {
            throw error;
          }
          // Ignore iframe load errors
        }

        const iframeUrl = iframe.url?.();
        const pageUrl = page.url?.();
        if (
          iframeUrl &&
          pageUrl &&
          iframeUrl !== pageUrl &&
          !iframeUrl.startsWith('data:') &&
          !iframeUrl.startsWith('about:')
        ) {
          content += `\n\nIFRAME ${iframeUrl}:\n`;
          try {
            const iframeHtml = await runWithTimeoutAndSignal(
              async () => (await iframe.content?.()) ?? '',
              2000,
              signal,
              'Iframe content extraction timeout'
            );
            const iframeMarkdown = turndown.turndown(iframeHtml || '');
            content += iframeMarkdown;
          } catch (error) {
            if (isAbortError(error)) {
              throw error;
            }
            // Skip failed iframes
          }
        }
      }

      // Replace multiple sequential \n with a single \n
      content = content.replace(/\n+/g, '\n');

      const startFromChar = Math.max(0, params.start_from_char ?? 0);
      if (startFromChar >= content.length) {
        return new ActionResult({
          error: `start_from_char (${startFromChar}) exceeds content length ${content.length} characters.`,
        });
      }

      if (startFromChar > 0) {
        content = content.slice(startFromChar);
      }

      const maxChars = 100000;
      let wasTruncated = false;
      let nextStartChar: number | null = null;
      if (content.length > maxChars) {
        wasTruncated = true;
        nextStartChar = startFromChar + maxChars;
        content = content.slice(0, maxChars);
      }

      const formatStats = () => {
        const stats = [
          `processed_chars=${content.length.toLocaleString()}`,
          `start_from_char=${startFromChar.toLocaleString()}`,
        ];
        if (wasTruncated && nextStartChar != null) {
          stats.push(
            `truncated=true`,
            `next_start_char=${nextStartChar.toLocaleString()}`
          );
        }
        return stats.join(', ');
      };

      const parseJsonFromCompletion = (completion: string) => {
        const trimmed = completion.trim();
        const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
        const candidate = fencedMatch?.[1]?.trim() || trimmed;
        return JSON.parse(candidate);
      };

      const basePrompt = `You convert websites into structured information. Extract information from this webpage based on the query. Focus only on content relevant to the query. If 
1. The query is vague
2. Does not make sense for the page
3. Some/all of the information is not available

Explain the content of the page and that the requested information is not available in the page. Respond in JSON format.
Query: ${params.query}
Content Stats: ${formatStats()}
Website:
${content}`;

      const effectiveOutputSchema = params.output_schema ?? extraction_schema;

      const prompt = effectiveOutputSchema
        ? `${basePrompt}

Output Schema (JSON Schema):
${JSON.stringify(effectiveOutputSchema, null, 2)}

Return valid JSON only, matching the schema exactly.`
        : basePrompt;

      const extraction = await (page_extraction_llm as any).ainvoke(
        [new UserMessage(prompt)],
        undefined,
        { signal: signal ?? undefined }
      );
      throwIfAborted(signal);
      const completion = extraction?.completion ?? '';
      const completionText =
        typeof completion === 'string'
          ? completion
          : JSON.stringify(completion ?? {});
      const normalizedResult = effectiveOutputSchema
        ? (() => {
            try {
              return JSON.stringify(parseJsonFromCompletion(completionText));
            } catch (error) {
              throw new BrowserError(
                `Structured extraction returned invalid JSON: ${(error as Error).message}`
              );
            }
          })()
        : completionText;
      const continuationNote =
        wasTruncated && nextStartChar != null
          ? `\n\nContent was truncated. Use start_from_char=${nextStartChar} to continue extraction.`
          : '';
      const extracted_content =
        `Page Link: ${page.url}\n` +
        `Query: ${params.query}\n` +
        `Extracted Content:\n${normalizedResult}${continuationNote}`;

      let includeOnce = false;
      let memory = extracted_content;
      const MAX_MEMORY_SIZE = 10000;
      if (extracted_content.length > MAX_MEMORY_SIZE) {
        const lines = extracted_content.split('\n');
        let display = '';
        let count = 0;
        for (const line of lines) {
          if (display.length + line.length > MAX_MEMORY_SIZE) break;
          display += `${line}\n`;
          count += 1;
        }
        const saveResult =
          await fsInstance.save_extracted_content(extracted_content);
        // NOTE: Do NOT mention file_system tag here as it misleads LLM to use read_file action
        // The extracted content preview above is sufficient for most tasks
        memory = `Extracted content from ${page.url}\n<query>${params.query}</query>\n<extracted_content>\n${display}${lines.length - count} more lines (auto-saved, no need to read)...\n</extracted_content>`;
        includeOnce = true;
      }

      return new ActionResult({
        extracted_content,
        include_extracted_content_only_once: includeOnce,
        long_term_memory: memory,
      });
    });
  }

  private registerExplorationActions() {
    type SearchPageAction = z.infer<typeof SearchPageActionSchema>;
    this.registry.action(
      'Search page text for a pattern (like grep). Zero LLM cost and instant.',
      { param_model: SearchPageActionSchema }
    )(async function search_page(
      params: SearchPageAction,
      { browser_session, signal }
    ) {
      if (!browser_session) throw new Error('Browser session missing');
      throwIfAborted(signal);

      const page: Page | null = await browser_session.get_current_page();
      if (!page?.evaluate) {
        throw new BrowserError('No active page for search_page.');
      }

      const searchResult = (await page.evaluate(
        ({
          pattern,
          regex,
          caseSensitive,
          contextChars,
          cssScope,
          maxResults,
        }: {
          pattern: string;
          regex: boolean;
          caseSensitive: boolean;
          contextChars: number;
          cssScope: string | null;
          maxResults: number;
        }) => {
          const sourceNode = cssScope
            ? document.querySelector(cssScope)
            : document.body;
          if (!sourceNode) {
            return {
              error: `CSS scope not found: ${cssScope}`,
              matches: [],
              total: 0,
            };
          }
          const sourceText =
            (sourceNode as HTMLElement).innerText ||
            sourceNode.textContent ||
            '';
          if (!sourceText.trim()) {
            return {
              matches: [],
              total: 0,
            };
          }

          const safePattern = regex
            ? pattern
            : pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const flags = caseSensitive ? 'g' : 'gi';

          let matcher: RegExp;
          try {
            matcher = new RegExp(safePattern, flags);
          } catch (error: unknown) {
            return {
              error: `Invalid regex pattern: ${String(error)}`,
              matches: [],
              total: 0,
            };
          }

          const matches: Array<{
            position: number;
            match: string;
            snippet: string;
          }> = [];
          let foundTotal = 0;
          let m: RegExpExecArray | null;
          while ((m = matcher.exec(sourceText)) !== null) {
            foundTotal += 1;
            if (matches.length < Math.max(1, maxResults)) {
              const start = Math.max(0, m.index - Math.max(0, contextChars));
              const end = Math.min(
                sourceText.length,
                m.index + m[0].length + Math.max(0, contextChars)
              );
              matches.push({
                position: m.index,
                match: m[0],
                snippet: sourceText.slice(start, end),
              });
            }
            if (m[0].length === 0) {
              matcher.lastIndex += 1;
            }
          }

          return {
            matches,
            total: foundTotal,
            truncated: foundTotal > matches.length,
          };
        },
        {
          pattern: params.pattern,
          regex: params.regex,
          caseSensitive: params.case_sensitive,
          contextChars: params.context_chars,
          cssScope: params.css_scope ?? null,
          maxResults: params.max_results,
        }
      )) as
        | {
            error?: string;
            matches?: Array<{
              position: number;
              match: string;
              snippet: string;
            }>;
            total?: number;
            truncated?: boolean;
          }
        | null;

      if (!searchResult) {
        return new ActionResult({ error: 'search_page returned no result' });
      }
      if (searchResult.error) {
        return new ActionResult({ error: `search_page: ${searchResult.error}` });
      }

      const total = searchResult.total ?? 0;
      const matches = searchResult.matches ?? [];
      if (total === 0 || !matches.length) {
        const noMatchMessage = `No matches found for "${params.pattern}".`;
        return new ActionResult({
          extracted_content: noMatchMessage,
          long_term_memory: `Searched page for "${params.pattern}": 0 matches found.`,
        });
      }

      const lines: string[] = [
        `Found ${total} matches for "${params.pattern}" in page text:`,
      ];
      for (let i = 0; i < matches.length; i += 1) {
        const match = matches[i];
        const compactSnippet = match.snippet.replace(/\s+/g, ' ').trim();
        lines.push(
          `${i + 1}. [pos ${match.position}] "${match.match}" -> ${compactSnippet}`
        );
      }
      if (searchResult.truncated) {
        lines.push(
          `... showing first ${matches.length} matches (increase max_results to see more).`
        );
      }

      const memory = `Searched page for "${params.pattern}": ${total} match${total === 1 ? '' : 'es'} found.`;
      return new ActionResult({
        extracted_content: lines.join('\n'),
        long_term_memory: memory,
      });
    });

    type FindElementsAction = z.infer<typeof FindElementsActionSchema>;
    this.registry.action(
      'Query DOM elements by CSS selector (like find). Zero LLM cost and instant.',
      { param_model: FindElementsActionSchema }
    )(async function find_elements(
      params: FindElementsAction,
      { browser_session, signal }
    ) {
      if (!browser_session) throw new Error('Browser session missing');
      throwIfAborted(signal);

      const page: Page | null = await browser_session.get_current_page();
      if (!page?.evaluate) {
        throw new BrowserError('No active page for find_elements.');
      }

      const result = (await page.evaluate(
        ({
          selector,
          attributes,
          maxResults,
          includeText,
        }: {
          selector: string;
          attributes: string[] | null;
          maxResults: number;
          includeText: boolean;
        }) => {
          let elements: Element[];
          try {
            elements = Array.from(document.querySelectorAll(selector));
          } catch (error: unknown) {
            return {
              error: `Invalid selector: ${String(error)}`,
              elements: [],
              total: 0,
            };
          }

          const selected = elements.slice(0, Math.max(1, maxResults));
          const payload = selected.map((el, idx) => {
            const attrs: Record<string, string> = {};
            if (attributes?.length) {
              for (const attr of attributes) {
                const value = el.getAttribute(attr);
                if (value != null) {
                  attrs[attr] = value;
                }
              }
            }
            return {
              index: idx + 1,
              tag: el.tagName.toLowerCase(),
              text: includeText
                ? (el.textContent || '').replace(/\s+/g, ' ').trim()
                : '',
              attributes: attrs,
            };
          });

          return {
            elements: payload,
            total: elements.length,
            truncated: elements.length > selected.length,
          };
        },
        {
          selector: params.selector,
          attributes: params.attributes ?? null,
          maxResults: params.max_results,
          includeText: params.include_text,
        }
      )) as
        | {
            error?: string;
            elements?: Array<{
              index: number;
              tag: string;
              text: string;
              attributes: Record<string, string>;
            }>;
            total?: number;
            truncated?: boolean;
          }
        | null;

      if (!result) {
        return new ActionResult({ error: 'find_elements returned no result' });
      }
      if (result.error) {
        return new ActionResult({ error: `find_elements: ${result.error}` });
      }

      const elements = result.elements ?? [];
      const total = result.total ?? 0;
      if (!elements.length) {
        const msg = `No elements found for selector "${params.selector}".`;
        return new ActionResult({
          extracted_content: msg,
          long_term_memory: msg,
        });
      }

      const lines: string[] = [
        `Found ${total} element${total === 1 ? '' : 's'} for selector "${params.selector}":`,
      ];
      for (const el of elements) {
        const attrs = Object.entries(el.attributes || {})
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .join(' ');
        const text =
          params.include_text && el.text
            ? ` text=${JSON.stringify(el.text)}`
            : '';
        lines.push(
          `${el.index}. <${el.tag}>${text}${attrs ? ` ${attrs}` : ''}`.trim()
        );
      }
      if (result.truncated) {
        lines.push(
          `... showing first ${elements.length} elements (increase max_results to see more).`
        );
      }

      return new ActionResult({
        extracted_content: lines.join('\n'),
        long_term_memory: `Queried selector "${params.selector}" and found ${total} element${total === 1 ? '' : 's'}.`,
      });
    });
  }

  private registerScrollActions() {
    const scrollLogger = this.logger; // Capture logger reference for use in named function
    type ScrollAction = z.infer<typeof ScrollActionSchema>;

    // Define the scroll handler implementation (shared by multiple action names for LLM compatibility)
    const scrollImpl = async (
      params: ScrollAction,
      { browser_session, signal }: any
    ) => {
      if (!browser_session) throw new Error('Browser session missing');
      throwIfAborted(signal);
      const page: Page | null = await browser_session.get_current_page();
      if (!page || !page.evaluate) {
        throw new BrowserError('Unable to access current page for scrolling.');
      }

      // Helper function to get window height with retries
      const getWindowHeight = async (retries = 3): Promise<number> => {
        for (let i = 0; i < retries; i++) {
          throwIfAborted(signal);
          try {
            const height = await page.evaluate(() => window.innerHeight);
            return height || 0;
          } catch (error) {
            if (i === retries - 1) {
              throw new Error(`Scroll failed due to an error: ${error}`);
            }
            await waitWithSignal(1000, signal);
          }
        }
        return 0;
      };

      const windowHeight = await getWindowHeight();
      const pagesScrolled = params.pages ?? params.num_pages ?? 1;
      const scrollAmount = Math.floor(windowHeight * pagesScrolled);
      const dy = params.down ? scrollAmount : -scrollAmount;
      const direction = params.down ? 'down' : 'up';
      let scrollTarget = 'the page';

      // Element-specific scrolling if index is provided
      if (params.index !== undefined && params.index !== null) {
        try {
          const elementNode = await browser_session.get_dom_element_by_index(
            params.index,
            { signal }
          );
          if (!elementNode) {
            throw new Error(
              `Element index ${params.index} does not exist - retry or use alternative actions`
            );
          }

          // Try direct container scrolling (no events that might close dropdowns)
          const containerScrollJs = `
						(params) => {
							const { dy, elementXPath } = params;

							// Get the target element by XPath
							const targetElement = document.evaluate(elementXPath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
							if (!targetElement) {
								return { success: false, reason: 'Element not found by XPath' };
							}

							console.log('[SCROLL DEBUG] Starting direct container scroll for element:', targetElement.tagName);

							// Try to find scrollable containers in the hierarchy (starting from element itself)
							let currentElement = targetElement;
							let scrollSuccess = false;
							let scrolledElement = null;
							let scrollDelta = 0;
							let attempts = 0;

							// Check up to 10 elements in hierarchy (including the target element itself)
							while (currentElement && attempts < 10) {
								const computedStyle = window.getComputedStyle(currentElement);
								const hasScrollableY = /(auto|scroll|overlay)/.test(computedStyle.overflowY);
								const canScrollVertically = currentElement.scrollHeight > currentElement.clientHeight;

								console.log('[SCROLL DEBUG] Checking element:', currentElement.tagName,
									'hasScrollableY:', hasScrollableY,
									'canScrollVertically:', canScrollVertically,
									'scrollHeight:', currentElement.scrollHeight,
									'clientHeight:', currentElement.clientHeight);

								if (hasScrollableY && canScrollVertically) {
									const beforeScroll = currentElement.scrollTop;
									const maxScroll = currentElement.scrollHeight - currentElement.clientHeight;

									// Calculate scroll amount (1/3 of provided dy for gentler scrolling)
									let scrollAmount = dy / 3;

									// Ensure we don't scroll beyond bounds
									if (scrollAmount > 0) {
										scrollAmount = Math.min(scrollAmount, maxScroll - beforeScroll);
									} else {
										scrollAmount = Math.max(scrollAmount, -beforeScroll);
									}

									// Try direct scrollTop manipulation (most reliable)
									currentElement.scrollTop = beforeScroll + scrollAmount;

									const afterScroll = currentElement.scrollTop;
									const actualScrollDelta = afterScroll - beforeScroll;

									console.log('[SCROLL DEBUG] Scroll attempt:', currentElement.tagName,
										'before:', beforeScroll, 'after:', afterScroll, 'delta:', actualScrollDelta);

									if (Math.abs(actualScrollDelta) > 0.5) {
										scrollSuccess = true;
										scrolledElement = currentElement;
										scrollDelta = actualScrollDelta;
										console.log('[SCROLL DEBUG] Successfully scrolled container:', currentElement.tagName, 'delta:', actualScrollDelta);
										break;
									}
								}

								// Move to parent (but don't go beyond body for dropdown case)
								if (currentElement === document.body || currentElement === document.documentElement) {
									break;
								}
								currentElement = currentElement.parentElement;
								attempts++;
							}

							if (scrollSuccess) {
								// Successfully scrolled a container
								return {
									success: true,
									method: 'direct_container_scroll',
									containerType: 'element',
									containerTag: scrolledElement.tagName.toLowerCase(),
									containerClass: scrolledElement.className || '',
									containerId: scrolledElement.id || '',
									scrollDelta: scrollDelta
								};
							} else {
								// No container found or could scroll
								console.log('[SCROLL DEBUG] No scrollable container found for element');
								return {
									success: false,
									reason: 'No scrollable container found',
									needsPageScroll: true
								};
							}
						}
						`;

          const scrollParams = { dy, elementXPath: elementNode.xpath };
          const result = (await page.evaluate(
            containerScrollJs,
            scrollParams
          )) as any;

          if (result.success) {
            if (result.containerType === 'element') {
              let containerInfo = result.containerTag;
              if (result.containerId) {
                containerInfo += `#${result.containerId}`;
              } else if (result.containerClass) {
                containerInfo += `.${result.containerClass.split(' ')[0]}`;
              }
              scrollTarget = `element ${params.index}'s scroll container (${containerInfo})`;
              // Don't do additional page scrolling since we successfully scrolled the container
            } else {
              scrollTarget = `the page (fallback from element ${params.index})`;
            }
          } else {
            // Container scroll failed, need page-level scrolling
            scrollLogger.debug(
              `Container scroll failed for element ${params.index}: ${result.reason || 'Unknown'}`
            );
            scrollTarget = `the page (no container found for element ${params.index})`;
            // This will trigger page-level scrolling below
          }
        } catch (error) {
          scrollLogger.debug(
            `Element-specific scrolling failed for index ${params.index}: ${error}`
          );
          scrollTarget = `the page (fallback from element ${params.index})`;
          // Fall through to page-level scrolling
        }
      }

      // Page-level scrolling (default or fallback)
      if (
        scrollTarget === 'the page' ||
        scrollTarget.includes('fallback') ||
        scrollTarget.includes('no container found') ||
        scrollTarget.includes('mouse wheel failed')
      ) {
        scrollLogger.debug(
          `🔄 Performing page-level scrolling. Reason: ${scrollTarget}`
        );
        try {
          await (browser_session as any)._scrollContainer(dy);
        } catch (error) {
          // Hard fallback: always works on root scroller
          await page.evaluate((y: number) => window.scrollBy(0, y), dy);
          scrollLogger.debug(
            'Smart scroll failed; used window.scrollBy fallback',
            error
          );
        }
      }

      // Create descriptive message
      let longTermMemory: string;
      if (pagesScrolled === 1.0) {
        longTermMemory = `Scrolled ${direction} ${scrollTarget} by one page`;
      } else {
        longTermMemory = `Scrolled ${direction} ${scrollTarget} by ${pagesScrolled} pages`;
      }

      const msg = `🔍 ${longTermMemory}`;
      scrollLogger.info(msg);

      return new ActionResult({
        extracted_content: msg,
        include_in_memory: true,
        long_term_memory: longTermMemory,
      });
    };

    // Register scroll action with multiple names for LLM compatibility
    // Different LLMs may use different names: scroll, scroll_page, scroll_down
    const scrollDescription =
      'Scroll the page by specified number of pages (set down=True to scroll down, down=False to scroll up, num_pages=number of pages to scroll like 0.5 for half page, 1.0 for one page, etc.). Optional index parameter to scroll within a specific element or its scroll container (works well for dropdowns and custom UI components).';

    // Create named functions that wrap the implementation
    // Different LLMs may use different names: scroll, scroll_page, scroll_down, scroll_by, scroll_page_by, scroll_up
    const scrollAction = async function scroll(p: ScrollAction, ctx: any) {
      return scrollImpl(p, ctx);
    };
    const scrollPageAction = async function scroll_page(
      p: ScrollAction,
      ctx: any
    ) {
      return scrollImpl(p, ctx);
    };
    const scrollDownAction = async function scroll_down(
      p: ScrollAction,
      ctx: any
    ) {
      return scrollImpl(p, ctx);
    };
    const scrollByAction = async function scroll_by(p: ScrollAction, ctx: any) {
      return scrollImpl(p, ctx);
    };
    const scrollPageByAction = async function scroll_page_by(
      p: ScrollAction,
      ctx: any
    ) {
      return scrollImpl(p, ctx);
    };
    const scrollUpAction = async function scroll_up(p: ScrollAction, ctx: any) {
      return scrollImpl(p, ctx);
    };

    this.registry.action(scrollDescription, {
      param_model: ScrollActionSchema,
    })(scrollAction);
    this.registry.action(scrollDescription, {
      param_model: ScrollActionSchema,
    })(scrollPageAction);
    this.registry.action(scrollDescription, {
      param_model: ScrollActionSchema,
    })(scrollDownAction);
    this.registry.action(scrollDescription, {
      param_model: ScrollActionSchema,
    })(scrollByAction);
    this.registry.action(scrollDescription, {
      param_model: ScrollActionSchema,
    })(scrollPageByAction);
    this.registry.action(scrollDescription, {
      param_model: ScrollActionSchema,
    })(scrollUpAction);

    type ScrollToTextAction = z.infer<typeof ScrollToTextActionSchema>;
    this.registry.action('Scroll to a text in the current page', {
      param_model: ScrollToTextActionSchema,
    })(async function scroll_to_text(
      params: ScrollToTextAction,
      { browser_session }
    ) {
      if (!browser_session) throw new Error('Browser session missing');
      const page: Page | null = await browser_session.get_current_page();
      if (!page?.evaluate) {
        throw new BrowserError('Unable to access page for scrolling.');
      }

      const success = await page.evaluate(
        ({ text }: { text: string }) => {
          const iterator = document.createNodeIterator(
            document.body,
            NodeFilter.SHOW_ELEMENT
          );
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
        { text: params.text }
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
    this.registry.action('Read file_name from file system', {
      param_model: ReadFileActionSchema,
    })(async function read_file(
      params: ReadFileAction,
      { file_system, available_file_paths }
    ) {
      const fsInstance = file_system ?? new FileSystem(process.cwd(), false);
      const allowed =
        Array.isArray(available_file_paths) &&
        available_file_paths.includes(params.file_name);
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
        memory =
          remaining > 0 ? `${preview}${remaining} more lines...` : preview;
      }
      return new ActionResult({
        extracted_content: result,
        include_in_memory: true,
        long_term_memory: memory,
        include_extracted_content_only_once: true,
      });
    });

    type ReadLongContentAction = z.infer<typeof ReadLongContentActionSchema>;
    this.registry.action(
      'Intelligently read long page or file content to find goal-relevant information.',
      { param_model: ReadLongContentActionSchema }
    )(async function read_long_content(
      params: ReadLongContentAction,
      {
        browser_session,
        page_extraction_llm,
        available_file_paths,
        signal,
      }
    ) {
      throwIfAborted(signal);

      const goal = params.goal.trim();
      const source = (params.source || 'page').trim();
      const context = (params.context || '').trim();
      const maxChars = 50000;
      const chunkSize = 2000;

      const fallbackSearchTerms = (() => {
        const tokens = `${goal} ${context}`
          .toLowerCase()
          .match(/[a-z0-9][a-z0-9-]{2,}/g);
        if (!tokens?.length) {
          return goal ? [goal] : ['content'];
        }
        return Array.from(new Set(tokens)).slice(0, 5);
      })();

      const extractSearchTerms = async () => {
        const extractionLlm = page_extraction_llm as
          | {
              ainvoke: (
                messages: UserMessage[],
                options?: unknown,
                callOptions?: { signal?: AbortSignal }
              ) => Promise<{ completion?: string }>;
            }
          | null
          | undefined;
        if (!extractionLlm || typeof extractionLlm.ainvoke !== 'function') {
          return fallbackSearchTerms;
        }
        const prompt = `Extract 3-5 key search terms from this goal that would help find relevant sections.
Return only the terms, one per line, no numbering or bullets.

Goal: ${goal}

Context: ${context}`;
        try {
          const response = await runWithTimeoutAndSignal(
            async () =>
              (await extractionLlm.ainvoke(
                [new UserMessage(prompt)],
                undefined,
                { signal: signal ?? undefined }
              )) as { completion?: string },
            12000,
            signal,
            'Timed out extracting search terms'
          );
          const parsed = (response?.completion ?? '')
            .split('\n')
            .map((line) =>
              line
                .trim()
                .replace(/^[\-\d\.\)\s]+/, '')
                .trim()
            )
            .filter(Boolean);
          const unique = Array.from(new Set(parsed)).slice(0, 5);
          return unique.length ? unique : fallbackSearchTerms;
        } catch (error) {
          if (isAbortError(error)) {
            throw error;
          }
          return fallbackSearchTerms;
        }
      };

      const escapeRegExp = (value: string) =>
        value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      const chunkContent = (value: string) => {
        const chunks: Array<{ index: number; text: string }> = [];
        for (let start = 0, index = 0; start < value.length; start += chunkSize) {
          chunks.push({
            index,
            text: value.slice(start, start + chunkSize),
          });
          index += 1;
        }
        return chunks;
      };

      const contentToMarkdown = (html: string) => {
        const turndown = new TurndownService({
          headingStyle: 'atx',
          codeBlockStyle: 'fenced',
        });
        return turndown.turndown(html).replace(/\n+/g, '\n').trim();
      };

      let content = '';
      let sourceName = 'content';

      if (source.toLowerCase() === 'page') {
        if (!browser_session) {
          throw new BrowserError('Browser session missing for page content.');
        }
        const page: Page | null = await browser_session.get_current_page();
        if (!page?.content) {
          throw new BrowserError('No active page available to read content.');
        }
        const html = await page.content();
        content = contentToMarkdown(html || '');
        sourceName = 'current page';
      } else {
        const allowedPaths = new Set(
          Array.isArray(available_file_paths) ? available_file_paths : []
        );
        const downloadedFiles = Array.isArray(browser_session?.downloaded_files)
          ? browser_session.downloaded_files
          : [];
        for (const filePath of downloadedFiles) {
          allowedPaths.add(filePath);
        }

        if (!allowedPaths.has(source)) {
          const message =
            `Error: File path not in available_file_paths: ${source}. ` +
            'The user must add this path to available_file_paths when creating the Agent.';
          return new ActionResult({
            extracted_content: message,
            long_term_memory: `Failed to read: file path not allowed: ${source}`,
          });
        }

        if (!fs.existsSync(source)) {
          return new ActionResult({
            extracted_content: `Error: File not found: ${source}`,
            long_term_memory: 'Failed to read: file not found',
          });
        }

        const ext = path.extname(source).toLowerCase();
        sourceName = path.basename(source);
        if (ext === '.pdf') {
          const buffer = await fsp.readFile(source);
          const parsed = await extractPdfText(buffer);
          content = parsed.text ?? '';
        } else {
          const fileBuffer = await fsp.readFile(source);
          content = fileBuffer.toString('utf-8');
        }
      }

      if (!content.trim()) {
        return new ActionResult({
          extracted_content: `Error: No readable content found in ${sourceName}`,
          long_term_memory: `Failed to read ${sourceName}: no content`,
        });
      }

      if (content.length <= maxChars) {
        return new ActionResult({
          extracted_content: `Content from ${sourceName} (${content.length.toLocaleString()} chars):\n\n${content}`,
          long_term_memory: `Read ${sourceName} (${content.length.toLocaleString()} chars) for goal: ${goal.slice(0, 80)}`,
          include_extracted_content_only_once: true,
        });
      }

      const searchTerms = await extractSearchTerms();
      const chunks = chunkContent(content);
      const chunkScores = new Map<number, number>();

      for (const term of searchTerms) {
        const regex = new RegExp(escapeRegExp(term), 'gi');
        for (const chunk of chunks) {
          const matches = chunk.text.match(regex);
          if (!matches?.length) {
            continue;
          }
          chunkScores.set(
            chunk.index,
            (chunkScores.get(chunk.index) ?? 0) + matches.length
          );
        }
      }

      if (!chunkScores.size) {
        const truncated = content.slice(0, maxChars);
        return new ActionResult({
          extracted_content: `Content from ${sourceName} (first ${maxChars.toLocaleString()} of ${content.length.toLocaleString()} chars):\n\n${truncated}`,
          long_term_memory:
            `Read ${sourceName} (truncated to ${maxChars.toLocaleString()} chars, no search-term matches)`,
          include_extracted_content_only_once: true,
        });
      }

      const selectedIndices = new Set<number>([0]);
      for (const [index] of Array.from(chunkScores.entries()).sort(
        (a, b) => b[1] - a[1]
      )) {
        selectedIndices.add(index);
      }

      const orderedIndices = Array.from(selectedIndices).sort((a, b) => a - b);
      const sections: string[] = [];
      let used = 0;
      for (let i = 0; i < orderedIndices.length; i += 1) {
        const chunkIndex = orderedIndices[i];
        const chunk = chunks[chunkIndex];
        if (!chunk) {
          continue;
        }

        let segment = chunk.text;
        if (used + segment.length > maxChars) {
          segment = segment.slice(0, maxChars - used);
        }
        if (!segment) {
          break;
        }

        const prevChunkIndex = orderedIndices[i - 1];
        if (i > 0 && prevChunkIndex != null && chunkIndex - prevChunkIndex > 1) {
          const gapMarker = '\n[...]\n';
          if (used + gapMarker.length <= maxChars) {
            sections.push(gapMarker);
            used += gapMarker.length;
          }
        }

        sections.push(segment);
        used += segment.length;
        if (used >= maxChars) {
          break;
        }
      }

      const extracted = sections.join('');
      return new ActionResult({
        extracted_content:
          `Content from ${sourceName} (relevant sections, ` +
          `${used.toLocaleString()} of ${content.length.toLocaleString()} chars):\n\n${extracted}`,
        long_term_memory:
          `Read ${sourceName} (${selectedIndices.size} relevant sections of ${chunks.length}) ` +
          `for goal: ${goal.slice(0, 80)}`,
        include_extracted_content_only_once: true,
      });
    });

    type WriteFileAction = z.infer<typeof WriteFileActionSchema>;
    this.registry.action('Write content to file', {
      param_model: WriteFileActionSchema,
    })(async function write_file(params: WriteFileAction, { file_system }) {
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
    this.registry.action('Replace text within an existing file', {
      param_model: ReplaceFileStrActionSchema,
    })(async function replace_file_str(params: ReplaceAction, { file_system }) {
      const fsInstance = file_system ?? new FileSystem(process.cwd(), false);
      const result = await fsInstance.replace_file_str(
        params.file_name,
        params.old_str,
        params.new_str
      );
      return new ActionResult({
        extracted_content: result,
        include_in_memory: true,
        long_term_memory: result,
      });
    });
  }

  private registerUtilityActions() {
    type ScreenshotAction = z.infer<typeof ScreenshotActionSchema>;
    this.registry.action(
      'Capture a screenshot. Optionally save it to file_name and return the path.',
      { param_model: ScreenshotActionSchema }
    )(async function screenshot(
      params: ScreenshotAction,
      { browser_session, file_system, signal }
    ) {
      if (!browser_session) throw new Error('Browser session missing');
      throwIfAborted(signal);

      const screenshotB64 = await browser_session.take_screenshot?.(false);
      if (!screenshotB64) {
        return new ActionResult({
          error: 'Failed to capture screenshot.',
        });
      }

      if (params.file_name) {
        const fsInstance = file_system ?? new FileSystem(process.cwd(), false);
        const parsed = path.parse(params.file_name);
        const safeBase = (parsed.name || 'screenshot').replace(
          /[^a-zA-Z0-9_-]/g,
          '_'
        );
        const ext = parsed.ext ? parsed.ext : '.png';
        const fileName = `${safeBase}${ext}`;
        const filePath = path.join(fsInstance.get_dir(), fileName);
        await fsp.writeFile(filePath, Buffer.from(screenshotB64, 'base64'));
        const msg = `📸 Saved screenshot to ${filePath}`;
        return new ActionResult({
          extracted_content: msg,
          long_term_memory: msg,
          attachments: [filePath],
        });
      }

      return new ActionResult({
        extracted_content:
          '📸 Screenshot captured. It will be visible in the next browser state if vision is enabled.',
        long_term_memory: 'Captured screenshot',
      });
    });

    type EvaluateAction = z.infer<typeof EvaluateActionSchema>;
    this.registry.action(
      'Execute browser JavaScript on the current page and return the result.',
      { param_model: EvaluateActionSchema }
    )(async function evaluate(
      params: EvaluateAction,
      { browser_session, signal }
    ) {
      if (!browser_session) throw new Error('Browser session missing');
      throwIfAborted(signal);
      const page: Page | null = await browser_session.get_current_page();
      if (!page?.evaluate) {
        throw new BrowserError('No active page available for evaluate.');
      }

      const payload = (await page.evaluate(
        async ({ code }: { code: string }) => {
          const serialize = (value: unknown): unknown => {
            if (value === undefined) {
              return null;
            }
            try {
              return JSON.parse(JSON.stringify(value));
            } catch {
              return String(value);
            }
          };

          try {
            const raw = await Promise.resolve((0, eval)(code));
            return { ok: true, result: serialize(raw) };
          } catch (error: unknown) {
            return {
              ok: false,
              error:
                error instanceof Error
                  ? error.message
                  : String(error ?? 'Unknown evaluate error'),
            };
          }
        },
        { code: params.code }
      )) as { ok: boolean; result?: unknown; error?: string } | null;

      if (!payload) {
        return new ActionResult({ error: 'evaluate returned no result' });
      }
      if (!payload.ok) {
        return new ActionResult({
          error: `JavaScript execution error: ${payload.error ?? 'Unknown error'}`,
        });
      }

      const rendered =
        typeof payload.result === 'string'
          ? payload.result
          : JSON.stringify(payload.result);
      const maxChars = 20000;
      const clipped =
        rendered.length > maxChars
          ? `${rendered.slice(0, maxChars)}\n... output truncated ...`
          : rendered;
      return new ActionResult({
        extracted_content: clipped,
        long_term_memory: `Executed JavaScript and returned ${Math.min(rendered.length, maxChars)} chars.`,
        include_extracted_content_only_once: true,
      });
    });
  }

  private registerKeyboardActions() {
    type SendKeysAction = z.infer<typeof SendKeysActionSchema>;
    this.registry.action('Send keys to the active page', {
      param_model: SendKeysActionSchema,
    })(async function send_keys(params: SendKeysAction, { browser_session }) {
      if (!browser_session) throw new Error('Browser session missing');
      const page: Page | null = await browser_session.get_current_page();
      const keyboard = page?.keyboard;
      if (!keyboard) {
        throw new BrowserError(
          'Keyboard input is not available on the current page.'
        );
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
    });
  }

  private registerDropdownActions() {
    const formatAvailableOptions = (
      options: Array<{ index: number; text: string; value: string }>
    ) =>
      options
        .map(
          (opt) =>
            `  - [${opt.index}] text=${JSON.stringify(opt.text)} value=${JSON.stringify(opt.value)}`
        )
        .join('\n');

    type DropdownAction = z.infer<typeof DropdownOptionsActionSchema>;
    this.registry.action(
      'Get all options from a native dropdown or ARIA menu',
      { param_model: DropdownOptionsActionSchema }
    )(async function get_dropdown_options(
      params: DropdownAction,
      { browser_session, signal }
    ) {
      if (!browser_session) throw new Error('Browser session missing');
      throwIfAborted(signal);
      const page: Page | null = await browser_session.get_current_page();
      const domElement = await browser_session.get_dom_element_by_index(
        params.index,
        { signal }
      );
      if (!domElement) {
        throw new BrowserError(`Element index ${params.index} does not exist.`);
      }
      if (!page?.evaluate) {
        throw new BrowserError(
          'Unable to evaluate dropdown options on current page.'
        );
      }
      if (!domElement.xpath) {
        throw new BrowserError(
          'DOM element does not include an XPath selector.'
        );
      }

      const payload = await page.evaluate(
        ({ xpath }: { xpath: string }) => {
          const element = document.evaluate(
            xpath,
            document,
            null,
            XPathResult.FIRST_ORDERED_NODE_TYPE,
            null
          ).singleNodeValue as HTMLElement | null;
          if (!element) return null;
          if (element.tagName?.toLowerCase() === 'select') {
            const options = Array.from(
              (element as HTMLSelectElement).options
            ).map((opt, index) => ({
              text: opt.textContent?.trim() ?? '',
              value: (opt.value ?? '').trim(),
              index,
            }));
            return { type: 'select', options };
          }
          const ariaRoles = new Set(['menu', 'listbox', 'combobox']);
          const role = element.getAttribute('role');
          if (role && ariaRoles.has(role)) {
            const nodes = element.querySelectorAll(
              '[role="menuitem"],[role="option"]'
            );
            const options = Array.from(nodes).map((node, index) => ({
              text: node.textContent?.trim() ?? '',
              value: node.textContent?.trim() ?? '',
              index,
            }));
            return { type: 'aria', options };
          }
          return null;
        },
        { xpath: domElement.xpath }
      );

      if (!payload || !payload.options?.length) {
        throw new BrowserError('No options found for the specified dropdown.');
      }

      const formatted = payload.options.map(
        (opt: any) =>
          `${opt.index}: text=${JSON.stringify(opt.text ?? '')}, value=${JSON.stringify(opt.value ?? '')}`
      );
      formatted.push(
        'Prefer exact text first; if needed select_dropdown_option also supports case-insensitive text/value matching.'
      );

      const message = formatted.join('\n');
      return new ActionResult({
        extracted_content: message,
        include_in_memory: true,
        include_extracted_content_only_once: true,
        long_term_memory: `Found dropdown options for index ${params.index}.`,
      });
    });

    type SelectAction = z.infer<typeof SelectDropdownActionSchema>;
    this.registry.action('Select dropdown option or ARIA menu item by text', {
      param_model: SelectDropdownActionSchema,
    })(async function select_dropdown_option(
      params: SelectAction,
      { browser_session, signal }
    ) {
      if (!browser_session) throw new Error('Browser session missing');
      throwIfAborted(signal);
      const page: Page | null = await browser_session.get_current_page();
      const domElement = await browser_session.get_dom_element_by_index(
        params.index,
        { signal }
      );
      if (!domElement?.xpath) {
        throw new BrowserError(
          'DOM element does not include an XPath selector.'
        );
      }
      if (!page) {
        throw new BrowserError('No active page for selection.');
      }

      for (const frame of page.frames ?? []) {
        try {
          const typeInfo = await frame.evaluate((xpath: string) => {
            const element = document.evaluate(
              xpath,
              document,
              null,
              XPathResult.FIRST_ORDERED_NODE_TYPE,
              null
            ).singleNodeValue as HTMLElement | null;
            if (!element) return { found: false };
            const tagName = element.tagName?.toLowerCase();
            const role = element.getAttribute?.('role');
            if (tagName === 'select') return { found: true, type: 'select' };
            if (role && ['menu', 'listbox', 'combobox'].includes(role))
              return { found: true, type: 'aria' };
            return { found: false };
          }, domElement.xpath);

          if (!typeInfo?.found) continue;

          if (typeInfo.type === 'select') {
            const selection = await frame.evaluate(
              ({ xpath, text }: { xpath: string; text: string }) => {
                const root = document.evaluate(
                  xpath,
                  document,
                  null,
                  XPathResult.FIRST_ORDERED_NODE_TYPE,
                  null
                ).singleNodeValue as HTMLSelectElement | null;
                if (!root || root.tagName?.toLowerCase() !== 'select') {
                  return { found: false };
                }

                const options = Array.from(root.options).map((opt, index) => ({
                  index,
                  text: opt.textContent?.trim() ?? '',
                  value: (opt.value ?? '').trim(),
                }));
                const normalize = (value: string) => value.trim().toLowerCase();
                const targetRaw = text.trim();
                const targetLower = normalize(text);

                let matchedIndex = options.findIndex(
                  (opt) => opt.text === targetRaw || opt.value === targetRaw
                );
                if (matchedIndex < 0) {
                  matchedIndex = options.findIndex(
                    (opt) =>
                      normalize(opt.text) === targetLower ||
                      normalize(opt.value) === targetLower
                  );
                }
                if (matchedIndex < 0) {
                  return { found: true, success: false, options };
                }

                const matched = options[matchedIndex];
                root.value = matched.value;
                root.dispatchEvent(new Event('input', { bubbles: true }));
                root.dispatchEvent(new Event('change', { bubbles: true }));
                const selectedOption =
                  root.selectedIndex >= 0 ? root.options[root.selectedIndex] : null;
                const selectedText = selectedOption?.textContent?.trim() ?? '';
                const selectedValue = (root.value ?? '').trim();
                const verified =
                  normalize(selectedValue) === normalize(matched.value) ||
                  normalize(selectedText) === normalize(matched.text);

                return {
                  found: true,
                  success: verified,
                  options,
                  selectedText,
                  selectedValue,
                  matched,
                };
              },
              { xpath: domElement.xpath, text: params.text }
            );

            if (selection?.found && selection.success) {
              const matchedText = selection.matched?.text ?? params.text;
              const matchedValue = selection.matched?.value ?? '';
              const msg = `Selected option ${matchedText} (${matchedValue})`;
              return new ActionResult({
                extracted_content: msg,
                include_in_memory: true,
                long_term_memory: msg,
              });
            }
            if (selection?.found) {
              const details = formatAvailableOptions(
                (selection.options as Array<{
                  index: number;
                  text: string;
                  value: string;
                }>) ?? []
              );
              throw new BrowserError(
                `Could not select option '${params.text}' for index ${params.index}.\nAvailable options:\n${details}`
              );
            }
            continue;
          }

          const clicked = await frame.evaluate(
            ({ xpath, text }: { xpath: string; text: string }) => {
              const root = document.evaluate(
                xpath,
                document,
                null,
                XPathResult.FIRST_ORDERED_NODE_TYPE,
                null
              ).singleNodeValue as HTMLElement | null;
              if (!root) return false;
              const nodes = root.querySelectorAll(
                '[role="menuitem"],[role="option"]'
              );
              const options = Array.from(nodes).map((node, index) => ({
                index,
                text: node.textContent?.trim() ?? '',
                value: node.textContent?.trim() ?? '',
              }));
              const normalize = (value: string) => value.trim().toLowerCase();
              const targetRaw = text.trim();
              const targetLower = normalize(text);

              let matchedIndex = options.findIndex(
                (opt) => opt.text === targetRaw || opt.value === targetRaw
              );
              if (matchedIndex < 0) {
                matchedIndex = options.findIndex(
                  (opt) =>
                    normalize(opt.text) === targetLower ||
                    normalize(opt.value) === targetLower
                );
              }
              if (matchedIndex < 0) {
                return { found: true, success: false, options };
              }
              (nodes[matchedIndex] as HTMLElement).click();
              return {
                found: true,
                success: true,
                options,
                matched: options[matchedIndex],
              };
            },
            { xpath: domElement.xpath, text: params.text }
          );

          if (clicked?.found && clicked.success) {
            const matchedText = clicked.matched?.text ?? params.text;
            const msg = `Selected menu item ${matchedText}`;
            return new ActionResult({
              extracted_content: msg,
              include_in_memory: true,
              long_term_memory: msg,
            });
          }
          if (clicked?.found) {
            const details = formatAvailableOptions(
              (clicked.options as Array<{
                index: number;
                text: string;
                value: string;
              }>) ?? []
            );
            throw new BrowserError(
              `Could not select option '${params.text}' for index ${params.index}.\nAvailable options:\n${details}`
            );
          }
        } catch (error) {
          if (error instanceof BrowserError) {
            throw error;
          }
          continue;
        }
      }

      throw new BrowserError(
        `Could not select option '${params.text}' for index ${params.index}`
      );
    });
  }

  private registerSheetsActions() {
    const gotoSheetsRange = this.gotoSheetsRange.bind(this);

    this.registry.action(
      'Google Sheets: Get the contents of the entire sheet',
      {
        domains: ['https://docs.google.com'],
      }
    )(async function sheets_get_contents(_params, { browser_session, signal }) {
      if (!browser_session) throw new Error('Browser session missing');
      throwIfAborted(signal);
      const page: Page | null = await browser_session.get_current_page();
      await page?.keyboard?.press('Enter');
      await page?.keyboard?.press('Escape');
      await page?.keyboard?.press('ControlOrMeta+A');
      await page?.keyboard?.press('ControlOrMeta+C');
      const content = await page?.evaluate?.(() =>
        navigator.clipboard.readText()
      );
      return new ActionResult({
        extracted_content: content ?? '',
        include_in_memory: true,
        long_term_memory: 'Retrieved sheet contents',
        include_extracted_content_only_once: true,
      });
    });

    type SheetsRange = z.infer<typeof SheetsRangeActionSchema>;
    this.registry.action(
      'Google Sheets: Get the contents of a cell or range of cells',
      {
        domains: ['https://docs.google.com'],
        param_model: SheetsRangeActionSchema,
      }
    )(async function sheets_get_range(
      params: SheetsRange,
      { browser_session, signal }
    ) {
      if (!browser_session) throw new Error('Browser session missing');
      throwIfAborted(signal);
      const page: Page | null = await browser_session.get_current_page();
      await gotoSheetsRange(page, params.cell_or_range, signal);
      await page?.keyboard?.press('ControlOrMeta+C');
      await waitWithSignal(100, signal);
      const content = await page?.evaluate?.(() =>
        navigator.clipboard.readText()
      );
      return new ActionResult({
        extracted_content: content ?? '',
        include_in_memory: true,
        long_term_memory: `Retrieved contents from ${params.cell_or_range}`,
        include_extracted_content_only_once: true,
      });
    });

    type SheetsUpdate = z.infer<typeof SheetsUpdateActionSchema>;
    this.registry.action(
      'Google Sheets: Update the content of a cell or range of cells',
      {
        domains: ['https://docs.google.com'],
        param_model: SheetsUpdateActionSchema,
      }
    )(async function sheets_update(
      params: SheetsUpdate,
      { browser_session, signal }
    ) {
      if (!browser_session) throw new Error('Browser session missing');
      throwIfAborted(signal);
      const page: Page | null = await browser_session.get_current_page();
      await gotoSheetsRange(page, params.cell_or_range, signal);
      await page?.evaluate?.((value: string) => {
        const clipboardData = new DataTransfer();
        clipboardData.setData('text/plain', value);
        document.activeElement?.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData })
        );
      }, params.value);
      return new ActionResult({
        extracted_content: `Updated cells: ${params.cell_or_range} = ${params.value}`,
        long_term_memory: `Updated cells ${params.cell_or_range} with ${params.value}`,
      });
    });

    this.registry.action(
      'Google Sheets: Clear whatever cells are currently selected',
      {
        domains: ['https://docs.google.com'],
        param_model: SheetsRangeActionSchema,
      }
    )(async function sheets_clear(
      params: SheetsRange,
      { browser_session, signal }
    ) {
      if (!browser_session) throw new Error('Browser session missing');
      throwIfAborted(signal);
      const page: Page | null = await browser_session.get_current_page();
      await gotoSheetsRange(page, params.cell_or_range, signal);
      await page?.keyboard?.press('Backspace');
      return new ActionResult({
        extracted_content: `Cleared cells: ${params.cell_or_range}`,
        long_term_memory: `Cleared cells ${params.cell_or_range}`,
      });
    });

    this.registry.action(
      'Google Sheets: Select a specific cell or range of cells',
      {
        domains: ['https://docs.google.com'],
        param_model: SheetsRangeActionSchema,
      }
    )(async function sheets_select(
      params: SheetsRange,
      { browser_session, signal }
    ) {
      if (!browser_session) throw new Error('Browser session missing');
      throwIfAborted(signal);
      const page: Page | null = await browser_session.get_current_page();
      await gotoSheetsRange(page, params.cell_or_range, signal);
      return new ActionResult({
        extracted_content: `Selected cells: ${params.cell_or_range}`,
        long_term_memory: `Selected cells ${params.cell_or_range}`,
      });
    });

    this.registry.action(
      'Google Sheets: Fallback method to type text into the currently selected cell',
      {
        domains: ['https://docs.google.com'],
        param_model: SheetsInputActionSchema,
      }
    )(async function sheets_input(
      params: z.infer<typeof SheetsInputActionSchema>,
      { browser_session, signal }
    ) {
      if (!browser_session) throw new Error('Browser session missing');
      throwIfAborted(signal);
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

  private async gotoSheetsRange(
    page: Page | null,
    cell_or_range: string,
    signal: AbortSignal | null = null
  ) {
    if (!page?.keyboard) {
      throw new BrowserError(
        'No keyboard available for Google Sheets actions.'
      );
    }
    throwIfAborted(signal);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    await waitWithSignal(100, signal);
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowUp');
    await waitWithSignal(100, signal);
    await page.keyboard.press('Control+G');
    await waitWithSignal(200, signal);
    await page.keyboard.type(cell_or_range, { delay: 50 });
    await page.keyboard.press('Enter');
    await waitWithSignal(200, signal);
    await page.keyboard.press('Escape');
  }

  private registerDoneAction(outputModel: z.ZodTypeAny | null) {
    const displayFilesInDoneText = this.displayFilesInDoneText;

    if (outputModel) {
      const structuredSchema = StructuredOutputActionSchema(outputModel);
      type StructuredParams = z.infer<typeof structuredSchema>;
      this.registry.action(
        'Complete task - with return text and success flag.',
        { param_model: structuredSchema }
      )(async function done(params: StructuredParams) {
        const data =
          params.data &&
          typeof params.data === 'object' &&
          !Array.isArray(params.data)
            ? (params.data as Record<string, unknown>)
            : {};
        const payload: Record<string, unknown> = { ...data };
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
    this.registry.action('Complete task - provide a summary to the user.', {
      param_model: DoneActionSchema,
    })(async function done(params: DoneAction, { file_system }) {
      const fsInstance = file_system ?? new FileSystem(process.cwd(), false);
      let userMessage = params.text;
      const lenMaxMemory = 100;
      let memory = `Task completed: ${params.success} - ${params.text.slice(0, lenMaxMemory)}`;
      if (params.text.length > lenMaxMemory) {
        memory += ` - ${params.text.length - lenMaxMemory} more characters`;
      }

      const attachments: string[] = [];
      if (params.files_to_display) {
        if (displayFilesInDoneText) {
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

      const attachmentPaths = attachments.map(
        (name) => `${fsInstance.get_dir()}/${name}`
      );
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
      signal = null,
    }: ActParams<Context>
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
            signal,
          }
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
        if (error instanceof BrowserError) {
          return new ActionResult({
            error: error.short_term_memory ?? error.message,
            include_in_memory: true,
            long_term_memory: error.long_term_memory ?? error.message,
          });
        }
        return new ActionResult({
          error: String(error?.message ?? error ?? ''),
        });
      }
    }

    return new ActionResult();
  }
}
