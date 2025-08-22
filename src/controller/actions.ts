import { z } from 'zod';
import type { Page } from 'playwright';
import { action } from './decorators';
import type { ActionResult } from '../types/agent';
import { withHealthCheck } from '../services/health-check';
import { promises as fs } from 'fs';
import path from 'path';
import type { BrowserContext as AgentBrowserContext } from '../browser/BrowserContext';
import type { BrowserSession } from '../browser/BrowserSession';
import TurndownService from 'turndown';
import type { BaseLLMClient } from '../llm/base-client';
import { FileSystem } from '../services/file-system';
import { Agent } from '../agent';
import { DOMNode } from '../types/dom';

// Helper function for Promise.race with proper timeout cleanup
function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage: string = 'Operation timed out'
): Promise<T> {
  let timeoutId: NodeJS.Timeout;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

// Use BrowserSession's enhanced index-based interaction
async function executeWithBrowserSession<T>(
  context: { browserSession?: BrowserSession } | undefined,
  fn: (session: BrowserSession) => Promise<T>
): Promise<T> {
  const session = context?.browserSession;
  if (!session) {
    throw new Error('BrowserSession not available');
  }
  return await fn(session);
}

// scroll
class ScrollActions {
  @action(
    'scroll',
    'Scroll the page by specified number of pages (set down=true to scroll down, down=false to scroll up, num_pages=number of pages to scroll like 0.5 for half page, 1.0 for one page, etc.). Optional index parameter to scroll within a specific element or its scroll container (works well for dropdowns and custom UI components).',
    z.object({
      down: z.boolean().default(true),
      num_pages: z.number().positive().default(1),
      index: z.number().int().min(0).optional(),
    }),
    { isAvailableForPage: (page) => page && !page.isClosed() }
  )
  static async scrollPages({
    params,
    page,
    context,
  }: {
    params: { down: boolean; num_pages: number; index?: number };
    page: Page;
    context?: { browserSession?: BrowserSession };
  }): Promise<ActionResult> {
    return withHealthCheck(page, async (p) => {
      // Helper function to get window height with retry
      const getWindowHeight = async (): Promise<number> => {
        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            const height = await withTimeout(
              p.evaluate(() => window.innerHeight),
              5000,
              'Failed to get window height'
            );
            if (height && height > 0) return height;
          } catch (error) {
            if (attempt === 3) {
              throw new Error(`Scroll failed due to an error: ${error}`);
            }
            // Wait 1 second before retry
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
        return 800; // fallback
      };

      // Get window height with retries
      const windowHeight = await getWindowHeight();

      // Calculate scroll amount based on num_pages
      const scrollAmount = Math.floor(windowHeight * params.num_pages);
      const dy = params.down ? scrollAmount : -scrollAmount;

      // Initialize result message components
      const direction = params.down ? 'down' : 'up';
      let scrollTarget = 'the page';

      // Element-specific scrolling if index is provided
      if (typeof params.index === 'number') {
        try {
          const session = context?.browserSession;
          if (!session) {
            throw new Error('Browser session not available');
          }

          // Get element using the same pattern
          const summary = await session.getStateSummary(false);
          const elementNode = summary.selectorMap.get(params.index);

          if (!elementNode) {
            throw new Error(
              `Element index ${params.index} does not exist - retry or use alternative actions`
            );
          }

          // Try direct container scrolling (no events that might close dropdowns)
          const containerScrollResult = await p.evaluate(
            (scrollParams) => {
              const { dy, elementXPath } = scrollParams;

              // Get the target element by XPath
              const targetElement = document.evaluate(
                elementXPath,
                document,
                null,
                XPathResult.FIRST_ORDERED_NODE_TYPE,
                null
              ).singleNodeValue as HTMLElement | null;

              if (!targetElement) {
                return { success: false, reason: 'Element not found by XPath' };
              }

              console.log(
                '[SCROLL DEBUG] Starting direct container scroll for element:',
                targetElement.tagName
              );

              // Try to find scrollable containers in the hierarchy (starting from element itself)
              let currentElement: HTMLElement | null = targetElement;
              let scrollSuccess = false;
              let scrolledElement: HTMLElement | null = null;
              let scrollDelta = 0;
              let attempts = 0;

              // Check up to 10 elements in hierarchy (including the target element itself)
              while (currentElement && attempts < 10) {
                const computedStyle = window.getComputedStyle(currentElement);
                const hasScrollableY = /(auto|scroll|overlay)/.test(
                  computedStyle.overflowY
                );
                const canScrollVertically =
                  currentElement.scrollHeight > currentElement.clientHeight;

                console.log(
                  '[SCROLL DEBUG] Checking element:',
                  currentElement.tagName,
                  'hasScrollableY:',
                  hasScrollableY,
                  'canScrollVertically:',
                  canScrollVertically,
                  'scrollHeight:',
                  currentElement.scrollHeight,
                  'clientHeight:',
                  currentElement.clientHeight
                );

                if (hasScrollableY && canScrollVertically) {
                  const beforeScroll = currentElement.scrollTop;
                  const maxScroll =
                    currentElement.scrollHeight - currentElement.clientHeight;

                  // Calculate scroll amount (1/3 of provided dy for gentler scrolling)
                  let scrollAmount = dy / 3;

                  // Ensure we don't scroll beyond bounds
                  if (scrollAmount > 0) {
                    scrollAmount = Math.min(
                      scrollAmount,
                      maxScroll - beforeScroll
                    );
                  } else {
                    scrollAmount = Math.max(scrollAmount, -beforeScroll);
                  }

                  // Try direct scrollTop manipulation (most reliable)
                  currentElement.scrollTop = beforeScroll + scrollAmount;

                  const afterScroll = currentElement.scrollTop;
                  const actualScrollDelta = afterScroll - beforeScroll;

                  console.log(
                    '[SCROLL DEBUG] Scroll attempt:',
                    currentElement.tagName,
                    'before:',
                    beforeScroll,
                    'after:',
                    afterScroll,
                    'delta:',
                    actualScrollDelta
                  );

                  if (Math.abs(actualScrollDelta) > 0.5) {
                    scrollSuccess = true;
                    scrolledElement = currentElement;
                    scrollDelta = actualScrollDelta;
                    console.log(
                      '[SCROLL DEBUG] Successfully scrolled container:',
                      currentElement.tagName,
                      'delta:',
                      actualScrollDelta
                    );
                    break;
                  }
                }

                // Move to parent (but don't go beyond body for dropdown case)
                if (
                  currentElement === document.body ||
                  currentElement === document.documentElement
                ) {
                  break;
                }
                currentElement = currentElement.parentElement;
                attempts++;
              }

              if (scrollSuccess && scrolledElement) {
                // Successfully scrolled a container
                return {
                  success: true,
                  method: 'direct_container_scroll',
                  containerType: 'element',
                  containerTag: scrolledElement.tagName.toLowerCase(),
                  containerClass: scrolledElement.className || '',
                  containerId: scrolledElement.id || '',
                  scrollDelta: scrollDelta,
                };
              } else {
                // No container found or could scroll
                console.log(
                  '[SCROLL DEBUG] No scrollable container found for element'
                );
                return {
                  success: false,
                  reason: 'No scrollable container found',
                  needsPageScroll: true,
                };
              }
            },
            { dy, elementXPath: elementNode.xpath || '' }
          );

          if (containerScrollResult.success) {
            if (containerScrollResult.containerType === 'element') {
              let containerInfo = containerScrollResult.containerTag;
              if (containerScrollResult.containerId) {
                containerInfo += `#${containerScrollResult.containerId}`;
              } else if (containerScrollResult.containerClass) {
                containerInfo += `.${containerScrollResult.containerClass.split(' ')[0]}`;
              }
              scrollTarget = `element ${params.index}'s scroll container (${containerInfo})`;
            } else {
              scrollTarget = `the page (fallback from element ${params.index})`;
            }
          } else {
            // Container scroll failed, need page-level scrolling
            console.log(
              `Container scroll failed for element ${params.index}: ${containerScrollResult.reason || 'Unknown'}`
            );
            scrollTarget = `the page (no container found for element ${params.index})`;
          }
        } catch (error) {
          console.log(
            `Element-specific scrolling failed for index ${params.index}: ${error}`
          );
          scrollTarget = `the page (fallback from element ${params.index})`;
        }
      }

      // Page-level scrolling (default or fallback)
      const needsPageScroll =
        scrollTarget === 'the page' ||
        scrollTarget.includes('fallback') ||
        scrollTarget.includes('no container found') ||
        scrollTarget.includes('mouse wheel failed');

      if (needsPageScroll) {
        console.log(
          `🔄 Performing page-level scrolling. Reason: ${scrollTarget}`
        );

        try {
          // Try CDP scroll gesture first (works universally including PDFs)
          const cdpScrollSuccess = await ScrollActions.scrollWithCDPGesture(
            p,
            dy
          );

          if (!cdpScrollSuccess) {
            // Fallback to smart JavaScript scrolling
            console.log('Falling back to JavaScript scrolling');
            await ScrollActions.smartScrollContainer(p, dy);
          }
        } catch (error) {
          // Hard fallback: always works on root scroller
          await p.evaluate((y) => window.scrollBy(0, y), dy);
          console.log(
            'Smart scroll failed; used window.scrollBy fallback',
            error
          );
        }
      }

      // Create descriptive message
      const pagesScrolled = params.num_pages;
      let longTermMemory: string;
      if (pagesScrolled === 1.0) {
        longTermMemory = `Scrolled ${direction} ${scrollTarget} by one page`;
      } else {
        longTermMemory = `Scrolled ${direction} ${scrollTarget} by ${pagesScrolled} pages`;
      }

      const message = `🔍 ${longTermMemory}`;
      console.log(message);

      return {
        success: true,
        message,
      };
    });
  }

  /**
   * Scroll using CDP Input.synthesizeScrollGesture for universal compatibility.
   * Works in all contexts including PDFs.
   */
  private static async scrollWithCDPGesture(
    page: Page,
    pixels: number
  ): Promise<boolean> {
    try {
      // Create CDP session
      const cdpSession = await (page.context() as any).newCDPSession(page);

      // Get viewport center for scroll origin
      const viewport = await page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      }));

      const centerX = Math.floor(viewport.width / 2);
      const centerY = Math.floor(viewport.height / 2);

      await cdpSession.send('Input.synthesizeScrollGesture', {
        x: centerX,
        y: centerY,
        xDistance: 0,
        yDistance: -pixels, // Negative = scroll down, Positive = scroll up
        gestureSourceType: 'mouse', // Use mouse gestures for better compatibility
        speed: 3000, // Pixels per second
      });

      // Detach CDP session with timeout
      try {
        await Promise.race([
          cdpSession.detach(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('CDP detach timeout')), 1000)
          ),
        ]);
      } catch {
        // Ignore timeout and other detach errors
      }

      console.log(
        `📄 Scrolled via CDP Input.synthesizeScrollGesture: ${pixels}px`
      );
      return true;
    } catch (error) {
      console.log(
        `❌ Scrolling via CDP Input.synthesizeScrollGesture failed: ${error}`
      );
      return false;
    }
  }

  /**
   * Smart container scrolling with JavaScript fallback.
   * Finds the best scrollable container and scrolls it.
   */
  private static async smartScrollContainer(
    page: Page,
    pixels: number
  ): Promise<void> {
    const SMART_SCROLL_JS = `(dy) => {
      const bigEnough = el => el.clientHeight >= window.innerHeight * 0.5;
      const canScroll = el =>
        el &&
        /(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY) &&
        el.scrollHeight > el.clientHeight &&
        bigEnough(el);

      let el = document.activeElement;
      while (el && !canScroll(el) && el !== document.body) el = el.parentElement;

      el = canScroll(el)
          ? el
          : [...document.querySelectorAll('*')].find(canScroll)
          || document.scrollingElement
          || document.documentElement;

      if (el === document.scrollingElement ||
        el === document.documentElement ||
        el === document.body) {
        window.scrollBy(0, dy);
      } else {
        el.scrollBy({ top: dy, behavior: 'auto' });
      }
    }`;

    await page.evaluate(SMART_SCROLL_JS, pixels);
  }
}

// wait
class WaitActions {
  @action(
    'wait',
    'Wait for time/selector/navigation',
    z.object({
      type: z.enum(['time', 'element', 'navigation']).default('time'),
      value: z.union([z.number(), z.string()]),
      timeout: z.number().min(100).max(60000).default(5000),
    }),
    {
      isAvailableForPage: (page) => page && !page.isClosed(),
    }
  )
  static async wait({
    params,
    page,
  }: {
    params: {
      type: 'time' | 'element' | 'navigation';
      value: number | string;
      timeout?: number;
    };
    page: Page;
  }): Promise<ActionResult> {
    return withHealthCheck(page, async (p) => {
      if (params.type === 'time') {
        await p.waitForTimeout(params.value as number);
      } else if (params.type === 'element') {
        await p.waitForSelector(params.value as string, {
          timeout: params.timeout,
        });
      } else {
        await p.waitForURL(params.value as string, { timeout: params.timeout });
      }
      return { success: true, message: `Waited for ${params.type}` };
    });
  }
}

// done
class DoneActions {
  @action(
    'done',
    'Mark the task as completed - provide a summary of results for the user. Set success=true if task completed successfully, false otherwise. Text should be your response to the user summarizing results. Include files you would like to display to the user in files_to_display.',
    z.object({
      success: z
        .boolean()
        .describe('Whether the task was completed successfully'),
      text: z.string().describe('Summary of results for the user'),
      files_to_display: z
        .array(z.string())
        .optional()
        .default([])
        .describe('Files to display to the user'),
    })
  )
  static async done({
    params,
  }: {
    params: { success: boolean; text: string; files_to_display?: string[] };
  }): Promise<ActionResult> {
    return {
      success: params.success,
      message: params.text,
      attachments: params.files_to_display,
    };
  }
}

class IndexActions {
  @action(
    'click_element_by_index',
    'Click an interactive element by index shown on the page overlay',
    z.object({ index: z.number().int().min(0) }),
    { isAvailableForPage: (page) => page && !page.isClosed() }
  )
  static async clickByIndex({
    params,
    page: _page, // eslint-disable-line @typescript-eslint/no-unused-vars
    context,
  }: {
    params: { index: number };
    page: Page;
    context?: { browserSession?: BrowserSession };
  }): Promise<ActionResult> {
    const domState = context?.browserSession?.domState;
    let node: DOMNode | undefined;
    let text: string | null | undefined;
    if (domState) {
      node = Object.values(domState.map).find(
        (i) => i.xpath === domState.selectorMap[params.index].slice(7)
      );
      if (node) {
        text = context.browserSession?.getAllChildrenText(node, 2);
      }
    }
    return executeWithBrowserSession(context, async (session) => {
      await session.clickByIndex(params.index);
      return {
        success: true,
        message: `Clicked element with index ${params.index}${text ? `: ${text}` : ''}`,
      };
    });
  }

  @action(
    'input_text',
    'Focus an interactive element by index and type the provided text',
    z.object({ index: z.number().int().min(0), text: z.string() }),
    { isAvailableForPage: (page) => page && !page.isClosed() }
  )
  static async inputText({
    params,
    page: _page, // eslint-disable-line @typescript-eslint/no-unused-vars
    context,
  }: {
    params: { index: number; text: string };
    page: Page;
    context?: { browserSession?: BrowserSession };
  }): Promise<ActionResult> {
    return executeWithBrowserSession(context, async (session) => {
      await session.typeByIndex(params.index, params.text);
      return {
        success: true,
        message: `Input text into element #${params.index}`,
      };
    });
  }
}

class NavActions {
  @action(
    'go_to_url',
    'Navigate to URL (optionally in new tab with new_tab=true)',
    z.object({ url: z.string().url(), new_tab: z.boolean().optional() }),
    { isAvailableForPage: (page) => page && !page.isClosed() }
  )
  static async goToUrl({
    params,
    page: _page, // eslint-disable-line @typescript-eslint/no-unused-vars
    context,
  }: {
    params: { url: string; new_tab?: boolean };
    page: Page;
    context: {
      browserContext?: AgentBrowserContext;
      browserSession?: BrowserSession;
    };
  }): Promise<ActionResult> {
    return executeWithBrowserSession(context, async (session) => {
      await session.navigate(params.url, params.new_tab || false);
      const message = params.new_tab
        ? `Opened new tab with ${params.url}`
        : `Navigated to ${params.url}`;
      return { success: true, message };
    });
  }
}

class KeysActions {
  @action(
    'send_keys',
    'Send special keys via page.keyboard.press (e.g., Enter, Escape, Control+V)',
    z.object({ keys: z.union([z.string(), z.array(z.string())]) }),
    { isAvailableForPage: (page) => page && !page.isClosed() }
  )
  static async sendKeys({
    params,
    page,
  }: {
    params: { keys: string | string[] };
    page: Page;
  }): Promise<ActionResult> {
    return withHealthCheck(page, async (p) => {
      const pressOne = async (key: string) => p.keyboard.press(key);
      if (Array.isArray(params.keys)) {
        for (const k of params.keys) await pressOne(k);
      } else {
        await pressOne(params.keys);
      }
      return {
        success: true,
        message: `Sent keys: ${JSON.stringify(params.keys)}`,
      };
    });
  }
}

class ExtractDataActions {
  @action(
    'extract_structured_data',
    "Extract structured, semantic data (e.g. product description, price, all information about XYZ) from the current webpage based on a textual query. This tool takes the entire markdown of the page and extracts the query from it. Set extract_links=true ONLY if your query requires extracting links/URLs from the page. Only use this for specific queries for information retrieval from the page. Don't use this to get interactive elements - the tool does not see HTML elements, only the markdown.",
    z.object({
      query: z
        .string()
        .min(1)
        .describe('The query to extract information about'),
      extract_links: z
        .boolean()
        .default(false)
        .describe('Whether to include links and images in the extraction'),
    }),
    { isAvailableForPage: (page) => page && !page.isClosed() }
  )
  static async extractStructuredData({
    params,
    page,
    context,
  }: {
    params: { query: string; extract_links: boolean };
    page: Page;
    context: {
      browserContext?: AgentBrowserContext;
      browserSession?: BrowserSession;
      llmClient?: BaseLLMClient;
      fileSystem?: FileSystem;
      agent: Agent;
    };
  }): Promise<ActionResult> {
    const { query, extract_links } = params;

    if (!context.llmClient) {
      return {
        success: false,
        message: 'LLM client not available',
        error: 'LLM_CLIENT_UNAVAILABLE',
      };
    }

    return withHealthCheck(page, async (p) => {
      try {
        // Get page HTML content with timeout
        let pageHtml: string;
        try {
          pageHtml = await withTimeout(
            p.content(),
            10000,
            'Page content extraction timed out after 10 seconds'
          );
        } catch (error) {
          throw new Error(`Couldn't extract page content: ${error}`);
        }

        // Initialize Turndown service for HTML to Markdown conversion
        const turndownService = new TurndownService({
          headingStyle: 'atx',
          codeBlockStyle: 'fenced',
        });

        // Configure what to strip based on extract_links parameter
        if (!extract_links) {
          // Remove links and images if not needed
          turndownService.remove(['a', 'img']);
        }

        // Convert HTML to markdown
        let content: string;
        try {
          content = await withTimeout(
            Promise.resolve(turndownService.turndown(pageHtml)),
            5000,
            'HTML to markdown conversion timed out'
          );
        } catch (error) {
          throw new Error(`Could not convert HTML to markdown: ${error}`);
        }

        // Process iframe content (simplified version - Playwright has limitations with cross-origin iframes)
        for (const frame of p.frames()) {
          if (
            frame.url() !== p.url() &&
            !frame.url().startsWith('data:') &&
            !frame.url().startsWith('about:')
          ) {
            try {
              // Wait for iframe to load with aggressive timeout
              await withTimeout(
                frame.waitForLoadState('domcontentloaded'),
                1000,
                'Iframe load timeout'
              );

              const iframeHtml = await withTimeout(
                frame.content(),
                2000,
                'Iframe content extraction timeout'
              );

              const iframeMarkdown = await withTimeout(
                Promise.resolve(turndownService.turndown(iframeHtml)),
                2000,
                'Iframe markdown conversion timeout'
              );

              content += `\n\nIFRAME ${frame.url()}:\n${iframeMarkdown}`;
            } catch {
              // Skip failed iframes silently
            }
          }
        }

        // Remove multiple sequential newlines
        content = content.replace(/\n+/g, '\n');

        // Limit content length to 1024 * 1024 characters
        // TODO: set 30000  characters
        const maxChars = 1024 * 1024;
        if (content.length > maxChars) {
          const halfMax = Math.floor(maxChars / 2);
          content =
            content.substring(0, halfMax) +
            '\n... left out the middle because it was too long ...\n' +
            content.substring(content.length - halfMax);
        }

        // Prepare prompt for LLM
        const prompt = `You convert websites into structured information. Extract information from this webpage based on the query. Focus only on content relevant to the query. If
1. The query is vague
2. Does not make sense for the page
3. Some/all of the information is not available

Explain the content of the page and that the requested information is not available in the page. Respond in JSON format.

Query: ${query}

Website:
${content}`;

        // Call LLM with timeout
        const response = await withTimeout(
          context.llmClient!.generateResponse([
            { role: 'user', content: prompt },
          ]),
          120000,
          'LLM call timed out after 2 minutes'
        );

        const extractedContent = `Page Link: ${p.url()}\nQuery: ${query}\nExtracted Content:\n${response.content}`;

        // Determine if we need to save to file or include in memory
        const maxMemorySize = 600;
        let message: string;
        let attachments: string[] | undefined;

        if (extractedContent.length < maxMemorySize) {
          message = extractedContent;
        } else {
          // Save to file if content is too long
          const lines = extractedContent.split('\n');
          let display = '';
          let displayLines = 0;

          for (const line of lines) {
            if (display.length + line.length < maxMemorySize) {
              display += line + '\n';
              displayLines++;
            } else {
              break;
            }
          }

          const remainingLines = lines.length - displayLines;
          const fileName = `extracted_content_${context.agent.getState().n_steps}_${Date.now()}.md`;
          const filePath = path.resolve(
            context.fileSystem?.getDir() ?? process.cwd(),
            fileName
          );

          try {
            await fs.writeFile(filePath, extractedContent, 'utf-8');
            message = `Extracted content from ${p.url()}\n<query>${query}</query>\n<extracted_content>\n${display}${remainingLines > 0 ? `${remainingLines} more lines...\n` : ''}</extracted_content>\n<file_saved>Content saved to ${fileName}</file_saved>`;
            attachments = [fileName];
          } catch {
            // Fallback to truncated content if file saving fails
            message =
              display +
              (remainingLines > 0 ? `${remainingLines} more lines...` : '');
          }
        }

        return {
          success: true,
          message,
          attachments,
        };
      } catch (error) {
        return {
          success: false,
          message: `Failed to extract structured data: ${(error as Error).message}`,
          error: (error as Error).message,
        };
      }
    });
  }
}

// file system
class FileSystemActions {
  @action(
    'read_file',
    'Read content from a file in the agent filesystem',
    z.object({
      filename: z
        .string()
        .min(1)
        .describe('Full filename with extension (e.g., todo.md, results.txt)'),
      external: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Whether this is an external file path (not in agent filesystem)'
        ),
    })
  )
  static async readFile({
    params,
    context,
  }: {
    params: { filename: string; external?: boolean };
    page: Page;
    context: { fileSystem?: FileSystem };
  }): Promise<ActionResult> {
    const fileSystem = context?.fileSystem;
    if (!fileSystem) {
      return {
        success: false,
        message: 'FileSystem not available',
        error: 'FileSystem service not initialized',
      };
    }

    try {
      const result = await fileSystem.readFile(
        params.filename,
        params.external || false
      );
      return {
        success: true,
        message: result,
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to read file: ${(error as Error).message}`,
        error: (error as Error).message,
      };
    }
  }

  @action(
    'write_file',
    'Write content to a file in the agent filesystem',
    z.object({
      filename: z
        .string()
        .min(1)
        .describe('Full filename with extension (e.g., todo.md, results.txt)'),
      content: z.string().describe('Content to write to the file'),
    })
  )
  static async writeFile({
    params,
    context,
  }: {
    params: { filename: string; content: string };
    page: Page;
    context: { fileSystem?: FileSystem };
  }): Promise<ActionResult> {
    const fileSystem = context?.fileSystem;
    if (!fileSystem) {
      return {
        success: false,
        message: 'FileSystem not available',
        error: 'FileSystem service not initialized',
      };
    }

    try {
      const result = await fileSystem.writeFile(
        params.filename,
        params.content
      );
      return {
        success: true,
        message: result,
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to write file: ${(error as Error).message}`,
        error: (error as Error).message,
      };
    }
  }

  @action(
    'replace_file_str',
    'Replace all occurrences of a string in a file with another string',
    z.object({
      filename: z
        .string()
        .min(1)
        .describe('Full filename with extension (e.g., todo.md, results.txt)'),
      old_str: z.string().min(1).describe('String to replace'),
      new_str: z.string().describe('Replacement string'),
    })
  )
  static async replaceFileStr({
    params,
    context,
  }: {
    params: { filename: string; old_str: string; new_str: string };
    page: Page;
    context: { fileSystem?: FileSystem };
  }): Promise<ActionResult> {
    const fileSystem = context?.fileSystem;
    if (!fileSystem) {
      return {
        success: false,
        message: 'FileSystem not available',
        error: 'FileSystem service not initialized',
      };
    }

    try {
      const result = await fileSystem.replaceFileStr(
        params.filename,
        params.old_str,
        params.new_str
      );
      return {
        success: true,
        message: result,
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to replace string in file: ${(error as Error).message}`,
        error: (error as Error).message,
      };
    }
  }
}

// Ensure classes are referenced to avoid tree-shaking and "unused" warnings
export default [
  ScrollActions,
  WaitActions,
  DoneActions,
  IndexActions,
  NavActions,
  KeysActions,
  ExtractDataActions,
  FileSystemActions,
];
