/* eslint-disable @typescript-eslint/no-unused-vars */
import 'dotenv/config';
import {
  ActionResult,
  Agent,
  BaseLLMClient,
  createController,
  Controller,
  type AgentConfig,
} from '../src/index';
import { withHealthCheck } from '../src/services/health-check';
import { z } from 'zod';
import { Page } from 'playwright';
import { BrowserSession } from '../src/browser';
import type { BrowserContext as AgentBrowserContext } from '../src/browser/BrowserContext';
import { action } from '../src/controller/decorators';
import { FileSystem } from '../src/services/file-system';
import type { BrowserUseEvent } from './browserUseService';
import TurndownService from 'turndown';
import * as path from 'path';
import { promises as fs, readFileSync } from 'fs';

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

// Global SSE event sender (single instance since no concurrency)
let globalSSEEventSender: ((event: BrowserUseEvent) => void) | null = null;

export function setGlobalSSEEventSender(
  sendEvent: (event: BrowserUseEvent) => void
): void {
  console.log('Trace Event setGlobalSSEEventSender');
  globalSSEEventSender = sendEvent;
}

export function clearGlobalSSEEventSender(): void {
  console.log('Trace Event clearGlobalSSEEventSender');
  globalSSEEventSender = null;
}

export class ExtractDataActions {
  @action(
    'extract_api_document_structured_data',
    "Extract a single API document structured, semantic data from the current webpage based on a textual query. This tool takes the entire markdown of the page and extracts the query from it. Set extract_links=true ONLY if your query requires extracting links/URLs from the page. Set endpoint_name to the name of the endpoint if you are extracting an endpoint, this will be used to record the extracted endpoint in the memory. Example: 'Get a transfer' endpoint, \"Return a transfer\" endpoint, etc. Only use this for specific single API document content extraction query from the page. Don't use this to get interactive elements - the tool does not see HTML elements, only the markdown.",
    z.object({
      query: z
        .string()
        .min(1)
        .describe('The query to extract information about'),
      extract_links: z
        .boolean()
        .default(false)
        .describe('Whether to include links and images in the extraction'),
      endpoint_name: z
        .string()
        .default('')
        .describe(
          'The name of the endpoint if extracting an endpoint, used for memory recording'
        ),
    }),
    { isAvailableForPage: (page) => page && !page.isClosed() }
  )
  static async extractApiDocumentStructuredData({
    params,
    page,
    context,
  }: {
    params: { query: string; extract_links: boolean; endpoint_name: string };
    page: Page;
    context: {
      browserContext?: AgentBrowserContext;
      browserSession?: BrowserSession;
      llmClient?: BaseLLMClient;
      fileSystem?: FileSystem;
      agent: Agent;
    };
  }): Promise<ActionResult> {
    const { query, extract_links, endpoint_name } = params;

    if (!context.llmClient) {
      return {
        success: false,
        message: 'LLM client not available',
        error: 'LLM_CLIENT_UNAVAILABLE',
      };
    }

    return withHealthCheck(page, async (p) => {
      try {
        // Send trace event for extraction start
        await ExtractDataActions.sendTraceEvent({
          type: 'extraction_start',
          url: p.url(),
          query,
          timestamp: new Date().toISOString(),
        });

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

        // 🔍 Check for duplicate endpoint extraction before processing
        if (context.fileSystem && endpoint_name) {
          try {
            const projectDir = context.fileSystem.getDir();
            const existingFiles = await fs.readdir(projectDir);
            const apiDocContentFiles = existingFiles.filter(
              (filename: string) =>
                filename.startsWith('api_doc_content_') &&
                filename.endsWith('.md')
            );

            // Check if endpoint has already been extracted
            for (const filename of apiDocContentFiles) {
              try {
                const filePath = path.join(projectDir, filename);
                const existingContent = await fs.readFile(filePath, 'utf-8');

                // Check for same endpoint name and URL
                const currentUrl = p.url();
                if (
                  existingContent.includes(`"endpoint": "${endpoint_name}"`) &&
                  existingContent.includes(`Page Link: ${currentUrl}`)
                ) {
                  console.log(
                    `⚠️ Duplicate endpoint detected: "${endpoint_name}" at ${currentUrl}`
                  );
                  console.log(`🔄 Already extracted in file: ${filename}`);

                  await ExtractDataActions.sendTraceEvent({
                    type: 'duplicate_endpoint_skipped',
                    endpoint_name,
                    url: currentUrl,
                    existing_file: filename,
                    timestamp: new Date().toISOString(),
                  });

                  return {
                    success: false,
                    message: `Endpoint "${endpoint_name}" has already been extracted. Found in ${filename}. Skipping duplicate extraction to avoid redundancy.`,
                    error: 'DUPLICATE_ENDPOINT',
                  };
                }
              } catch (readError) {
                console.warn(
                  `Failed to read ${filename} for duplicate check:`,
                  readError
                );
              }
            }
          } catch (error) {
            console.warn('Failed to perform duplicate endpoint check:', error);
          }
        }

        // Calculate page index based on api_doc_content_ files in the project directory
        let pageIndex = 1;
        if (context.fileSystem) {
          try {
            const projectDir = context.fileSystem.getDir();
            const existingFiles = await fs.readdir(projectDir);
            const apiDocContentFiles = existingFiles.filter(
              (filename: string) => filename.startsWith('api_doc_content_')
            );

            // Extract unique page indices from filenames
            const pageIndices = new Set<number>();
            apiDocContentFiles.forEach((filename) => {
              const match = filename.match(/^api_doc_content_(\d+)/);
              if (match) {
                pageIndices.add(parseInt(match[1]));
              }
            });

            const maxIndex =
              pageIndices.size > 0 ? Math.max(...pageIndices) : 0;
            pageIndex = maxIndex + 1;
          } catch (error) {
            console.warn(
              'Failed to read project directory for pageIndex calculation:',
              error
            );
            pageIndex = 1;
          }
        }

        console.log(`[You are here] this is from TypeScript controller`);
        console.log(`page_index of API document content files: ${pageIndex}`);

        const apiDocContentExtractFilePrefix = 'api_doc_content';
        const apiDocContentExtractContentFileName = `${apiDocContentExtractFilePrefix}_${pageIndex}.md`;

        if (context.fileSystem) {
          try {
            const contentRawFileName = `${apiDocContentExtractFilePrefix}_${pageIndex}.raw.html`;
            const contentRawFilePath = path.join(
              context.fileSystem.getDir(),
              contentRawFileName
            );
            await fs.writeFile(contentRawFilePath, pageHtml, 'utf-8');
            console.log(`Saving raw content to ${contentRawFilePath}`);
          } catch (error) {
            console.warn('Failed to save raw HTML:', error);
          }
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

        // Limit content length to 300000 characters - remove text in the middle (≈150000 tokens)
        const maxContentChars = 300000;
        if (content.length > maxContentChars) {
          const halfMax = Math.floor(maxContentChars / 2);
          content =
            content.substring(0, halfMax) +
            '\n... left out the middle because it was too long ...\n' +
            content.substring(content.length - halfMax);
        }

        // Use chunking for large content
        const maxChars = 47000; // Match Python version chunk size
        const maxChunks = 10;
        const overlapSize = 500; // Fixed overlap size like Python version (OVERLAP_SIZE = 500)

        if (content.length <= maxChars) {
          // Small content - process normally
          const extractionPrompt = ExtractDataActions.readExtractionPrompt();
          const prompt = `You convert websites into structured information. Extract information from this webpage based on the query.
            ${extractionPrompt}

Focus only on content relevant to the query. If
1. The query is vague
2. Does not make sense for the page
3. Some/all of the information is not available

Explain the content of the page and that the requested information is not available in the page. Respond in JSON format.\nQuery: ${query}\n Website:\n${content}`;

          // Save raw prompt content (like Python version)
          if (context.fileSystem) {
            try {
              const contentRawPromptName = `${apiDocContentExtractFilePrefix}_${pageIndex}.prompt.raw.md`;
              const contentRawPromptFilePath = path.join(
                context.fileSystem.getDir(),
                contentRawPromptName
              );
              await fs.writeFile(contentRawPromptFilePath, prompt, 'utf-8');
              console.log(`Saving raw prompt to ${contentRawPromptFilePath}`);
            } catch (error) {
              console.warn('Failed to save raw prompt:', error);
            }
          }

          // Send trace event for LLM call
          const contentRawPromptName = `${apiDocContentExtractFilePrefix}_${pageIndex}.prompt.raw.md`;
          await ExtractDataActions.sendTraceEvent({
            type: 'action_act',
            message: 'Calling llm to extract content...',
            action: 'bu_calling_llm_extract_content',
            data: {
              query,
              formatted_prompt: prompt.replace(
                content,
                `placeholder-in-log, see the content in the file: ${contentRawPromptName}, content-length: ${content.length}`
              ),
            },
          });

          // Call LLM with timeout
          const response = await withTimeout(
            context.llmClient!.generateResponse([
              { role: 'user', content: prompt },
            ]),
            120000,
            'LLM call timed out after 2 minutes'
          );

          const extractedContent = `Page Link: ${p.url()}\nQuery: ${query}\nExtracted Content:\n${response.content}`;

          // Save extracted content and manage memory
          return await ExtractDataActions.saveExtractedContent(
            extractedContent,
            p.url(),
            query,
            context,
            endpoint_name,
            pageIndex
          );
        } else {
          // Large content - use chunking
          console.log(
            `Content is large (${content.length} chars), splitting into chunks...`
          );
          await ExtractDataActions.sendTraceEvent({
            type: 'chunking_start',
            contentLength: content.length,
            maxChars,
            timestamp: Date.now(),
          });

          const chunks = ExtractDataActions.chunkContent(
            content,
            maxChars,
            maxChunks
          );
          const chunkResponses: string[] = [];

          // Process each chunk
          for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const chunkPrompt = ExtractDataActions.buildChunkPrompt(
              query,
              chunk,
              i + 1,
              chunks.length
            );

            console.log(
              `Processing chunk ${i + 1}/${chunks.length} (${chunk.length} chars)`
            );

            // Send trace event for chunk processing
            await ExtractDataActions.sendTraceEvent({
              type: 'action_act',
              message: `Processing chunk ${i + 1}/${chunks.length}`,
              action: 'bu_processing_chunk',
              data: {
                chunk_number: i + 1,
                total_content_length: content.length,
                total_chunks: chunks.length,
                chunk_size: chunk.length,
                query,
              },
            });

            // Save individual chunk prompt (like Python version)
            if (context.fileSystem) {
              try {
                const chunkPromptFileName = `${apiDocContentExtractFilePrefix}_${pageIndex}.chunk_${i + 1}.prompt.raw.md`;
                const chunkPromptFilePath = path.join(
                  context.fileSystem.getDir(),
                  chunkPromptFileName
                );
                await fs.writeFile(chunkPromptFilePath, chunkPrompt, 'utf-8');
                console.log(
                  `Saved chunk ${i + 1} prompt to ${chunkPromptFilePath}`
                );
              } catch (error) {
                console.warn(`Failed to save chunk ${i + 1} prompt:`, error);
              }
            }

            try {
              const chunkResponse = await withTimeout(
                context.llmClient!.generateResponse([
                  { role: 'user', content: chunkPrompt },
                ]),
                60000,
                `Chunk ${i + 1} LLM call timed out`
              );

              chunkResponses.push(chunkResponse.content);
              console.log(`Chunk ${i + 1} processed successfully`);
            } catch (error) {
              console.error(`Error processing chunk ${i + 1}:`, error);
              chunkResponses.push(
                `Error processing chunk ${i + 1}: ${(error as Error).message}`
              );
            }
          }

          console.log(
            `Chunk processing completed: ${chunkResponses.filter((r) => !r.startsWith('Error')).length} successful, ${chunkResponses.filter((r) => r.startsWith('Error')).length} failed`
          );

          // Save individual chunks content (like Python version)
          if (context.fileSystem) {
            try {
              let chunksContent = `Combined results from ${chunks.length} chunks:\n\n`;
              for (let i = 0; i < chunkResponses.length; i++) {
                chunksContent += `--- Chunk ${i + 1} ---\n${chunkResponses[i]}\n\n`;
              }

              const chunksFileName = `${apiDocContentExtractFilePrefix}_${pageIndex}.chunks.md`;
              const chunksFilePath = path.join(
                context.fileSystem.getDir(),
                chunksFileName
              );
              await fs.writeFile(chunksFilePath, chunksContent, 'utf-8');
              console.log(`Saved chunks result to ${chunksFilePath}`);
            } catch (error) {
              console.warn('Failed to save chunks result:', error);
            }
          }

          // Merge chunk responses
          console.log('Merging chunk responses...');
          await ExtractDataActions.sendTraceEvent({
            type: 'action_act',
            message: 'Merging chunk responses',
            action: 'bu_merging_chunks',
            data: {
              chunk_count: chunkResponses.length,
              query,
            },
          });

          const mergedResponse = await ExtractDataActions.mergeChunkResponses(
            chunkResponses,
            context.llmClient!
          );

          // Save final merged result (like Python version)
          if (context.fileSystem) {
            try {
              const mergedFileName = `${apiDocContentExtractFilePrefix}_${pageIndex}.md`;
              const mergedFilePath = path.join(
                context.fileSystem.getDir(),
                mergedFileName
              );
              await fs.writeFile(mergedFilePath, mergedResponse, 'utf-8');
              console.log(`Saved merged result to ${mergedFilePath}`);
            } catch (error) {
              console.warn('Failed to save merged result:', error);
            }
          }

          const extractedContent = `Page Link: ${p.url()}\nQuery: ${query}\nExtracted Content:\n${mergedResponse}`;
          console.log(`Extracted content length: ${extractedContent.length}`);

          // Save extracted content and manage memory (matching Python version)
          return await ExtractDataActions.saveExtractedContent(
            extractedContent,
            p.url(),
            query,
            context,
            endpoint_name,
            pageIndex
          );
        }
      } catch (error) {
        // Handle different types of errors (like Python version)
        let errorMessage = 'Unknown error';
        let errorType = 'general_error';

        if (error instanceof Error) {
          errorMessage = error.message;
          if (
            error.message.includes('timeout') ||
            error.message.includes('TimeoutError')
          ) {
            errorType = 'llm_timeout';
            console.error('LLM call timed out during extraction');
          }
        }

        await ExtractDataActions.sendTraceEvent({
          type: 'action_act',
          message: `Extraction failed: ${errorMessage}`,
          action: 'bu_extraction_error',
          data: {
            error_type: errorType,
            error_message: errorMessage,
            endpoint_name: endpoint_name || 'unknown',
            query,
          },
        });

        return {
          success: false,
          message: `Failed to extract structured data: ${errorMessage}`,
          error: errorMessage,
        };
      }
    });
  }

  /**
   * Read extraction prompt from file
   */
  private static readExtractionPrompt(): string {
    try {
      const promptPath = path.join(__dirname, 'prompt', 'extraction_prompt.md');
      return readFileSync(promptPath, 'utf-8');
    } catch (error) {
      // Fallback prompt if file not found
      return `You convert websites into structured information. Extract information from this webpage based on the query. Focus only on content relevant to the query. If
1. The query is vague
2. Does not make sense for the page
3. Some/all of the information is not available

Explain the content of the page and that the requested information is not available in the page. Respond in JSON format.`;
    }
  }

  /**
   * Chunk content into smaller pieces for processing (matching Python version logic)
   */
  private static chunkContent(
    content: string,
    maxChars: number,
    maxChunks: number
  ): string[] {
    if (content.length <= maxChars) {
      return [content];
    }

    const chunks: string[] = [];
    const overlapSize = 500; // Fixed overlap size like Python version (OVERLAP_SIZE = 500)
    let start = 0;
    let chunkCount = 0;

    while (start < content.length && chunkCount < maxChunks) {
      let end = start + maxChars;
      if (end > content.length) {
        end = content.length;
      }

      // Try to break at a line boundary to avoid cutting words/sentences
      if (end < content.length) {
        const lastNewline = content.lastIndexOf('\n', end);
        if (lastNewline > start) {
          end = lastNewline;
        }
      }

      const chunk = content.substring(start, end);
      chunks.push(chunk);
      chunkCount++;

      // Move start position with overlap (except for the last chunk)
      if (end < content.length) {
        start = end - overlapSize;
        // Ensure we don't go backwards
        if (start < 0) start = 0;
      } else {
        break;
      }
    }

    return chunks;
  }

  /**
   * Build prompt for chunk processing (matching Python version)
   */
  private static buildChunkPrompt(
    query: string,
    chunk: string,
    chunkIndex: number,
    totalChunks: number
  ): string {
    const extractionPrompt = ExtractDataActions.readExtractionPrompt();
    return `This is chunk ${chunkIndex} of ${totalChunks} from a webpage.
Extract information based on the query: ${query}

${extractionPrompt}

Focus only on content relevant to the query. Extract as much as possible information that match any part of the query from the chunk. Indicate the information that is not available in the chunk.
Respond in JSON format.

IMPORTANT: This chunk may contain overlapping content with adjacent chunks to maintain context.
Focus on extracting unique information while being aware that some content may be duplicated.

Website chunk content:
${chunk}`;
  }

  /**
   * Merge chunk responses into a single response (matching Python version)
   */
  private static async mergeChunkResponses(
    chunkResponses: string[],
    llmClient: BaseLLMClient
  ): Promise<string> {
    try {
      console.log('Merging chunk responses...');
      const mergePrompt = `Merge the following chunk responses into a single response, and respond in JSON format. Preserve the original content, do not fabricate any data.

# Rules
- Ignore fields in the chunk that do not have valid info, for example field with:
    1. The provided chunk does not contain any information related to xxxx
    2. Not available in the chunk.

<chunked_responses>
${chunkResponses.join('\n\n')}
</chunked_responses>`;

      const response = await withTimeout(
        llmClient.generateResponse([{ role: 'user', content: mergePrompt }]),
        120000,
        'Merge operation timed out after 2 minutes'
      );

      console.log('Merged chunk done');
      return response.content;
    } catch (error) {
      console.error('Error merging chunk responses:', error);
      // Fallback: return concatenated responses with clear separation (matching Python version)
      let fallbackResponse = `Combined results from ${chunkResponses.length} chunks:\n\n`;
      for (let i = 0; i < chunkResponses.length; i++) {
        fallbackResponse += `--- Chunk ${i + 1} ---\n${chunkResponses[i]}\n\n`;
      }
      return fallbackResponse;
    }
  }

  /**
   * Send trace event
   */
  private static async sendTraceEvent(
    eventData: Record<string, any>
  ): Promise<void> {
    try {
      // For now, just log the event. In the future, this could send to a trace service
      console.log('Trace Event:', JSON.stringify(eventData, null, 2));

      if (globalSSEEventSender) {
        const sseEvent: BrowserUseEvent = {
          type: 'trace_event',
          session_id: 'default',
          timestamp: new Date().toISOString(),
          data: eventData,
          message: `Trace: ${eventData.type || 'unknown'}`,
        };
        globalSSEEventSender(sseEvent);
      }
    } catch (error) {
      console.warn('Failed to send trace event:', error);
    }
  }

  /**
   * Save extracted content and manage memory
   */
  private static async saveExtractedContent(
    extractedContent: string,
    url: string,
    query: string,
    context: {
      fileSystem?: FileSystem;
      agent: Agent;
    },
    endpoint_name?: string,
    pageIndex?: number
  ): Promise<ActionResult> {
    // Determine if we need to save to file or include in memory (matching Python version)
    const MAX_MEMORY_SIZE = 600;
    let message: string;
    let attachments: string[] | undefined;
    let includeExtractedContentOnlyOnce = false;

    if (extractedContent.length < MAX_MEMORY_SIZE) {
      message = extractedContent;
      includeExtractedContentOnlyOnce = false;
    } else {
      // Save to file if content is too long (matching Python version logic)
      const lines = extractedContent.split('\n');
      let display = '';
      let displayLinesCount = 0;

      for (const line of lines) {
        if (display.length + line.length < MAX_MEMORY_SIZE) {
          display += line + '\n';
          displayLinesCount++;
        } else {
          break;
        }
      }

      const apiDocContentExtractContentFileName = `api_doc_content_${pageIndex}.md`;

      try {
        // Save using specific filename format (matching Python version logic)
        if (context.fileSystem) {
          await context.fileSystem.writeFile(
            apiDocContentExtractContentFileName,
            extractedContent
          );
        }

        const endpointNameInfo = endpoint_name
          ? `\n<endpoint_extracted>${endpoint_name}</endpoint_extracted>`
          : '';
        message = `Extracted content from ${url}\n<query>${query}\n</query>\n<extracted_content>\n${display}${lines.length - displayLinesCount} more lines...\n</extracted_content>\n<file_system>File saved at: ${apiDocContentExtractContentFileName}</file_system>${endpointNameInfo}`;

        // Append to todo.md (matching Python version)
        if (endpoint_name && context.fileSystem) {
          try {
            const todoFilePath = 'todo.md';
            let todoContent = '';

            try {
              todoContent = await context.fileSystem.readFile(todoFilePath);
            } catch (error) {
              console.warn('Error reading todo.md:', error);
              todoContent = '';
            }

            // Append the endpoint to the todo.md
            todoContent += `\n## Extraction Record\n\t- [x] Explored endpoint: ${endpoint_name}\n`;
            // Note: In Python version, this line is commented out, so we'll also skip writing
            // await context.fileSystem.writeFile(todoFilePath, todoContent);
          } catch (error) {
            console.warn('Error updating todo.md:', error);
          }
        }

        includeExtractedContentOnlyOnce = true;
      } catch (error) {
        console.error('Failed to save extracted content:', error);
        // Fallback to truncated content if file saving fails
        message =
          display +
          (lines.length - displayLinesCount > 0
            ? `${lines.length - displayLinesCount} more lines...`
            : '');
        includeExtractedContentOnlyOnce = false;
      }
    }

    console.log(`📄 ${message}`);

    await ExtractDataActions.sendTraceEvent({
      type: 'extraction_complete',
      contentLength: extractedContent.length,
      savedToFile: includeExtractedContentOnlyOnce,
      timestamp: Date.now(),
    });

    return {
      success: true,
      message,
      attachments,
      includeExtractedContentOnlyOnce,
    };
  }
}

export class TodoManagementActions {
  @action(
    'validate_current_todo_step',
    'Validate current step against TODO plan and get the current TODO item that should be worked on. MUST be called at the beginning of each step.',
    z.object({
      step_number: z.number().describe('Current step number'),
      proposed_actions: z
        .array(z.union([z.string(), z.record(z.any())]))
        .optional()
        .describe('Actions you plan to take this step'),
    }),
    { isAvailableForPage: (page) => page && !page.isClosed() }
  )
  static async validateCurrentTodoStep({
    params,
    context,
  }: {
    params: {
      step_number: number;
      proposed_actions?: (string | Record<string, any>)[];
    };
    page: Page;
    context: { fileSystem?: FileSystem };
  }): Promise<ActionResult> {
    const { step_number, proposed_actions = [] } = params;
    const fileSystem = context?.fileSystem;

    if (!fileSystem) {
      return {
        success: false,
        message: 'FileSystem not available for TODO validation',
        error: 'No file system available',
      };
    }

    try {
      const todoContent = fileSystem.getTodoContents();
      if (!todoContent.trim()) {
        return {
          success: false,
          message:
            'TODO.md is empty. You must create a detailed TODO plan first using write_file action.',
          error: 'NO_TODO_PLAN',
        };
      }

      // 解析 TODO 内容，找到当前应该执行的项目
      // 从文件系统路径推导 sessionId (简化实现)
      const sessionId =
        TodoManagementActions.extractSessionIdFromFileSystem(fileSystem);
      const currentTodoAnalysis =
        TodoManagementActions.analyzeTodoForCurrentStep(
          todoContent,
          step_number,
          sessionId
        );

      if (!currentTodoAnalysis.currentItem) {
        return {
          success: false,
          message:
            'No current TODO item found. All items may be completed or TODO structure is invalid.',
          error: 'NO_CURRENT_TODO_ITEM',
        };
      }

      // 验证计划的 actions 是否符合当前 TODO 项
      // Convert mixed array to strings for validation
      const actionStrings = proposed_actions.map((action) =>
        typeof action === 'string' ? action : JSON.stringify(action)
      );
      const actionValidation =
        TodoManagementActions.validateActionsAgainstTodoItem(
          actionStrings,
          currentTodoAnalysis.currentItem
        );

      let validationMessage = `📋 CURRENT TODO FOCUS:\n`;
      validationMessage += `Phase: ${currentTodoAnalysis.currentPhase}\n`;
      validationMessage += `Current Item: ${currentTodoAnalysis.currentItem.title}\n`;
      validationMessage += `Status: ${currentTodoAnalysis.currentItem.status}\n`;
      validationMessage += `Progress: ${currentTodoAnalysis.progress.completed}/${currentTodoAnalysis.progress.total} items completed\n\n`;

      if (actionValidation.isValid) {
        validationMessage += `✅ Your planned actions align with current TODO item.\n`;
        validationMessage += `💡 Step Guidance: ${currentTodoAnalysis.stepGuidance}\n`;
      } else {
        validationMessage += `❌ WARNING: Your planned actions don't align with current TODO item!\n`;
        validationMessage += `🎯 You should focus on: ${currentTodoAnalysis.stepGuidance}\n`;
        validationMessage += `⚠️ Reason: ${actionValidation.reason}\n`;
      }

      return {
        success: actionValidation.isValid,
        message: validationMessage,
        includeExtractedContentOnlyOnce: true,
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to validate TODO: ${(error as Error).message}`,
        error: (error as Error).message,
      };
    }
  }

  @action(
    'update_todo_progress',
    'Mark a TODO item as completed or update its status. MUST be called when you complete a TODO item.',
    z.object({
      item_identifier: z
        .string()
        .describe('The TODO item title or identifier to update'),
      new_status: z
        .enum(['completed', 'in_progress', 'blocked', 'skipped'])
        .describe('New status for the item'),
      completion_note: z
        .string()
        .optional()
        .describe('Note about what was accomplished'),
    }),
    { isAvailableForPage: (page) => page && !page.isClosed() }
  )
  static async updateTodoProgress({
    params,
    context,
  }: {
    params: {
      item_identifier: string;
      new_status: string;
      completion_note?: string;
    };
    page: Page;
    context: { fileSystem?: FileSystem };
  }): Promise<ActionResult> {
    const { item_identifier, new_status, completion_note } = params;
    const fileSystem = context?.fileSystem;

    if (!fileSystem) {
      return {
        success: false,
        message: 'FileSystem not available for TODO update',
        error: 'No file system available',
      };
    }

    try {
      const todoContent = fileSystem.getTodoContents();
      const updatedContent = TodoManagementActions.updateTodoItemStatus(
        todoContent,
        item_identifier,
        new_status,
        completion_note
      );

      await fileSystem.writeFile('todo.md', updatedContent);

      let message = `✅ Updated TODO item: "${item_identifier}" to status: ${new_status}`;
      if (completion_note) {
        message += `\nNote: ${completion_note}`;
      }

      // 检查是否需要移动到下一个项目
      const nextItem = TodoManagementActions.getNextTodoItem(updatedContent);
      if (nextItem) {
        message += `\n\n🎯 NEXT TODO ITEM: ${nextItem.title}`;
        message += `\nPhase: ${nextItem.phase}`;
        message += `\nGuidance: ${nextItem.guidance}`;
      } else {
        message += `\n\n🎉 All TODO items completed! Ready to finalize results.`;
      }

      return {
        success: true,
        message,
        includeExtractedContentOnlyOnce: true,
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to update TODO: ${(error as Error).message}`,
        error: (error as Error).message,
      };
    }
  }

  @action(
    'add_dynamic_todo_item',
    'Add a new TODO item when you discover additional work needed. Use this when you find new endpoints or content.',
    z.object({
      title: z.string().describe('Title of the new TODO item'),
      phase: z
        .enum(['discovery', 'enumeration', 'extraction', 'verification'])
        .describe('Which phase this item belongs to'),
      priority: z
        .enum(['high', 'medium', 'low'])
        .describe('Priority of this item'),
      insert_after: z
        .string()
        .optional()
        .describe('Insert after this existing item (item title)'),
      reason: z.string().describe('Why this item needs to be added'),
    }),
    { isAvailableForPage: (page) => page && !page.isClosed() }
  )
  static async addDynamicTodoItem({
    params,
    context,
  }: {
    params: {
      title: string;
      phase: string;
      priority: string;
      insert_after?: string;
      reason: string;
    };
    page: Page;
    context: { fileSystem?: FileSystem };
  }): Promise<ActionResult> {
    const { title, phase, priority, insert_after, reason } = params;
    const fileSystem = context?.fileSystem;

    if (!fileSystem) {
      return {
        success: false,
        message: 'FileSystem not available for TODO update',
        error: 'No file system available',
      };
    }

    try {
      const todoContent = fileSystem.getTodoContents();
      const updatedContent = TodoManagementActions.insertTodoItem(
        todoContent,
        { title, phase, priority, reason },
        insert_after
      );

      await fileSystem.writeFile('todo.md', updatedContent);

      const message =
        `➕ Added new TODO item: "${title}"\n` +
        `Phase: ${phase}\n` +
        `Priority: ${priority}\n` +
        `Reason: ${reason}\n\n` +
        `Continue with your current TODO item unless this new item has higher priority.`;

      return {
        success: true,
        message,
        includeExtractedContentOnlyOnce: true,
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to add dynamic TODO item: ${(error as Error).message}`,
        error: (error as Error).message,
      };
    }
  }

  @action(
    'analyze_todo_deviation',
    'Analyze if you have deviated from your TODO plan and get guidance to get back on track.',
    z.object({
      current_activity: z
        .string()
        .describe('What you are currently doing or planning to do'),
      step_number: z.number().describe('Current step number'),
    }),
    { isAvailableForPage: (page) => page && !page.isClosed() }
  )
  static async analyzeTodoDeviation({
    params,
    context,
  }: {
    params: { current_activity: string; step_number: number };
    page: Page;
    context: { fileSystem?: FileSystem };
  }): Promise<ActionResult> {
    const { current_activity, step_number } = params;
    const fileSystem = context?.fileSystem;

    if (!fileSystem) {
      return {
        success: false,
        message: 'FileSystem not available for TODO analysis',
        error: 'No file system available',
      };
    }

    try {
      const todoContent = fileSystem.getTodoContents();
      const sessionId =
        TodoManagementActions.extractSessionIdFromFileSystem(fileSystem);
      const currentTodoAnalysis =
        TodoManagementActions.analyzeTodoForCurrentStep(
          todoContent,
          step_number,
          sessionId
        );

      if (!currentTodoAnalysis.currentItem) {
        return {
          success: false,
          message:
            '❌ MAJOR DEVIATION: No current TODO item found, but you are still taking actions!',
          error: 'DEVIATION_NO_TODO_ITEM',
        };
      }

      const deviationAnalysis = TodoManagementActions.analyzeActivityDeviation(
        current_activity,
        currentTodoAnalysis.currentItem,
        currentTodoAnalysis.currentPhase
      );

      let message = `🔍 TODO DEVIATION ANALYSIS:\n\n`;
      message += `Current TODO Item: ${currentTodoAnalysis.currentItem.title}\n`;
      message += `Your Activity: ${current_activity}\n\n`;

      if (deviationAnalysis.isDeviated) {
        message += `❌ DEVIATION DETECTED!\n`;
        message += `Severity: ${deviationAnalysis.severity}\n`;
        message += `Reason: ${deviationAnalysis.reason}\n\n`;
        message += `🎯 CORRECTIVE ACTION:\n${deviationAnalysis.correction}\n\n`;
        message += `📋 You should be working on: ${currentTodoAnalysis.stepGuidance}`;
      } else {
        message += `✅ ON TRACK: Your activity aligns with current TODO item.\n`;
        message += `Continue with: ${currentTodoAnalysis.stepGuidance}`;
      }

      return {
        success: !deviationAnalysis.isDeviated,
        message,
        includeExtractedContentOnlyOnce: true,
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to analyze TODO deviation: ${(error as Error).message}`,
        error: (error as Error).message,
      };
    }
  }

  // Step-to-TODO mapping storage
  private static stepTodoMapping: Map<
    string,
    {
      sessionId: string;
      currentTodoItem: string;
      startStep: number;
      stepCount: number;
      lastUpdated: number;
    }
  > = new Map();

  private static getSessionKey(sessionId?: string): string {
    return sessionId || 'default';
  }

  static extractSessionIdFromFileSystem(fileSystem: any): string {
    try {
      // 尝试从文件系统的 baseDir 路径中提取 sessionId
      // 通常项目路径格式为: /path/to/projects/{timestamp}/
      const dataDir = fileSystem.dataDir || fileSystem.baseDir || '';
      const pathParts = dataDir.split('/');

      // 查找时间戳格式的目录名 (YYYY-MM-DDTHH:MM:SS.sssZ)
      for (let i = pathParts.length - 1; i >= 0; i--) {
        const part = pathParts[i];
        if (
          part &&
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(part)
        ) {
          return part;
        }
      }

      // 如果找不到时间戳格式，使用最后一个非空的路径部分
      for (let i = pathParts.length - 1; i >= 0; i--) {
        if (pathParts[i] && pathParts[i] !== '') {
          return pathParts[i];
        }
      }

      return 'default';
    } catch (error) {
      return 'default';
    }
  }

  // Enhanced TODO analysis with explicit step-to-todo mapping
  static analyzeTodoForCurrentStep(
    todoContent: string,
    stepNumber: number,
    sessionId?: string
  ) {
    const sessionKey = this.getSessionKey(sessionId);

    // 解析所有 TODO 项目
    const todoAnalysis = TodoManagementActions.parseTodoContent(todoContent);

    // 检查是否有现有的 step-to-todo 映射
    const existingMapping = this.stepTodoMapping.get(sessionKey);

    if (existingMapping && existingMapping.currentTodoItem) {
      // 检查当前映射的 TODO item 是否仍然有效
      const mappedItem = todoAnalysis.allItems.find(
        (item) => item.title === existingMapping.currentTodoItem
      );

      if (mappedItem && mappedItem.status !== 'completed') {
        // 更新 step 计数
        existingMapping.stepCount = stepNumber - existingMapping.startStep + 1;
        existingMapping.lastUpdated = Date.now();

        return {
          currentPhase: mappedItem.phase,
          currentItem: mappedItem,
          progress: todoAnalysis.progress,
          stepGuidance: TodoManagementActions.generateStepGuidance(
            mappedItem,
            stepNumber,
            existingMapping.stepCount
          ),
          allItems: todoAnalysis.allItems,
          mappingInfo: {
            isExistingMapping: true,
            startStep: existingMapping.startStep,
            stepCount: existingMapping.stepCount,
            totalStepsOnThisItem: existingMapping.stepCount,
          },
        };
      } else {
        // 当前映射的 item 已完成，需要创建新映射
        this.stepTodoMapping.delete(sessionKey);
      }
    }

    // 创建新的映射：找到第一个未完成的 TODO item
    const nextItem = todoAnalysis.allItems.find(
      (item) => item.status !== 'completed' && item.status !== 'skipped'
    );

    if (nextItem) {
      // 创建新的 step-to-todo 映射
      this.stepTodoMapping.set(sessionKey, {
        sessionId: sessionKey,
        currentTodoItem: nextItem.title,
        startStep: stepNumber,
        stepCount: 1,
        lastUpdated: Date.now(),
      });

      return {
        currentPhase: nextItem.phase,
        currentItem: nextItem,
        progress: todoAnalysis.progress,
        stepGuidance: TodoManagementActions.generateStepGuidance(
          nextItem,
          stepNumber,
          1
        ),
        allItems: todoAnalysis.allItems,
        mappingInfo: {
          isExistingMapping: false,
          startStep: stepNumber,
          stepCount: 1,
          totalStepsOnThisItem: 1,
        },
      };
    }

    // 没有找到待执行的 TODO item
    return {
      currentPhase: '',
      currentItem: null,
      progress: todoAnalysis.progress,
      stepGuidance: 'All TODO items completed!',
      allItems: todoAnalysis.allItems,
      mappingInfo: {
        isExistingMapping: false,
        startStep: stepNumber,
        stepCount: 0,
        totalStepsOnThisItem: 0,
      },
    };
  }

  static parseTodoContent(todoContent: string) {
    const lines = todoContent.split('\n');
    const phases = ['discovery', 'enumeration', 'extraction', 'verification'];
    let currentPhase = '';
    let items: any[] = [];
    let progress = { completed: 0, total: 0 };

    for (const line of lines) {
      const trimmed = line.trim();

      // 识别阶段
      if (
        trimmed.startsWith('###') &&
        phases.some((p) => trimmed.toLowerCase().includes(p))
      ) {
        currentPhase =
          phases.find((p) => trimmed.toLowerCase().includes(p)) || '';
        continue;
      }

      // 识别 TODO 项目
      const todoMatch = trimmed.match(/^\d+\.\s*\[([x\-!\s])\]\s*(.+)$/);
      if (todoMatch) {
        const status = todoMatch[1];
        const title = todoMatch[2];
        const item = {
          title,
          status:
            status === 'x'
              ? 'completed'
              : status === '-'
                ? 'in_progress'
                : status === '!'
                  ? 'blocked'
                  : 'pending',
          phase: currentPhase,
        };

        items.push(item);
        progress.total++;

        if (status === 'x') {
          progress.completed++;
        }
      }
    }

    return {
      allItems: items,
      progress,
    };
  }

  static generateStepGuidance(
    item: any,
    stepNumber: number,
    stepCount: number = 1
  ): string {
    const phase = item.phase;
    const title = item.title;

    const stepInfo =
      stepCount > 1
        ? ` (Step ${stepCount} on this TODO item)`
        : ` (Starting this TODO item)`;

    switch (phase) {
      case 'discovery':
        return `Navigate and explore to ${title}${stepInfo}. Focus on finding and revealing content.`;
      case 'enumeration':
        return `List and catalog items for ${title}${stepInfo}. Make comprehensive inventories.`;
      case 'extraction':
        return `Extract detailed information for ${title}${stepInfo}. Ensure all schema and response details are captured.`;
      case 'verification':
        return `Verify and confirm ${title}${stepInfo}. Check completeness and accuracy.`;
      default:
        return `Work on ${title}${stepInfo}`;
    }
  }

  static validateActionsAgainstTodoItem(
    actions: string[],
    todoItem: any
  ): { isValid: boolean; reason: string } {
    if (!todoItem) {
      return {
        isValid: false,
        reason: 'No current TODO item to validate against',
      };
    }

    const phase = todoItem.phase;
    const title = todoItem.title.toLowerCase();

    // 基于阶段和标题的启发式验证
    const actionStr = actions.join(' ').toLowerCase();

    switch (phase) {
      case 'discovery':
        if (
          actionStr.includes('extract') &&
          !actionStr.includes('navigate') &&
          !actionStr.includes('click')
        ) {
          return {
            isValid: false,
            reason:
              'Discovery phase should focus on navigation and exploration, not extraction',
          };
        }
        break;
      case 'extraction':
        if (!actionStr.includes('extract') && !title.includes('extract')) {
          return {
            isValid: false,
            reason: 'Extraction phase should include extraction actions',
          };
        }
        break;
    }

    return {
      isValid: true,
      reason: 'Actions appear to align with current TODO item',
    };
  }

  private static updateTodoItemStatus(
    content: string,
    identifier: string,
    status: string,
    note?: string
  ): string {
    const lines = content.split('\n');
    const statusMap = {
      completed: 'x',
      in_progress: '-',
      pending: ' ',
      blocked: '!',
      skipped: 'x',
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes(identifier) && /^\d+\.\s*\[/.test(line.trim())) {
        const newStatus = statusMap[status as keyof typeof statusMap] || ' ';
        lines[i] = line.replace(/\[([x\-!\s])\]/, `[${newStatus}]`);

        if (note && status === 'completed') {
          lines.splice(i + 1, 0, `   ✓ ${note}`);
        }
        break;
      }
    }

    return lines.join('\n');
  }

  private static getNextTodoItem(content: string) {
    const lines = content.split('\n');
    let currentPhase = '';
    const phases = ['discovery', 'enumeration', 'extraction', 'verification'];

    for (const line of lines) {
      const trimmed = line.trim();

      if (
        trimmed.startsWith('###') &&
        phases.some((p) => trimmed.toLowerCase().includes(p))
      ) {
        currentPhase =
          phases.find((p) => trimmed.toLowerCase().includes(p)) || '';
        continue;
      }

      const todoMatch = trimmed.match(/^\d+\.\s*\[([ -!])\]\s*(.+)$/);
      if (todoMatch) {
        const status = todoMatch[1];
        const title = todoMatch[2];

        if (status !== 'x') {
          return {
            title,
            phase: currentPhase,
            guidance: TodoManagementActions.generateStepGuidance(
              { title, phase: currentPhase },
              1
            ),
          };
        }
      }
    }

    return null;
  }

  private static insertTodoItem(
    content: string,
    newItem: any,
    insertAfter?: string
  ): string {
    const lines = content.split('\n');
    let insertIndex = -1;
    let currentPhaseIndex = -1;

    // 找到对应阶段
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(`### ${newItem.phase}`)) {
        currentPhaseIndex = i;
        break;
      }
    }

    // 如果指定了插入位置
    if (insertAfter) {
      for (let i = currentPhaseIndex; i < lines.length; i++) {
        if (lines[i].includes(insertAfter)) {
          insertIndex = i + 1;
          break;
        }
      }
    }

    // 否则插入到阶段末尾
    if (insertIndex === -1) {
      for (let i = currentPhaseIndex + 1; i < lines.length; i++) {
        if (lines[i].startsWith('###') || i === lines.length - 1) {
          insertIndex = i;
          break;
        }
      }
    }

    // 获取下一个序号
    let nextNumber = 1;
    for (const line of lines) {
      const match = line.match(/^(\d+)\.\s*\[/);
      if (match) {
        nextNumber = Math.max(nextNumber, parseInt(match[1]) + 1);
      }
    }

    const priorityPrefix = newItem.priority === 'high' ? '⚡ ' : '';
    const newLine = `${nextNumber}. [ ] ${priorityPrefix}${newItem.title}`;

    if (insertIndex === -1) {
      lines.push(newLine);
    } else {
      lines.splice(insertIndex, 0, newLine);
    }

    return lines.join('\n');
  }

  private static analyzeActivityDeviation(
    activity: string,
    todoItem: any,
    phase: string
  ) {
    const activityLower = activity.toLowerCase();
    const titleLower = todoItem.title.toLowerCase();

    // 简单的偏离检测逻辑
    if (
      phase === 'discovery' &&
      activityLower.includes('extract') &&
      !titleLower.includes('extract')
    ) {
      return {
        isDeviated: true,
        severity: 'high',
        reason: 'Attempting to extract data during discovery phase',
        correction:
          'Focus on navigation and exploration first. Save extraction for the extraction phase.',
      };
    }

    if (
      phase === 'extraction' &&
      !activityLower.includes('extract') &&
      titleLower.includes('extract')
    ) {
      return {
        isDeviated: true,
        severity: 'medium',
        reason: 'Not extracting data during extraction phase',
        correction:
          'You should be extracting detailed information for this endpoint.',
      };
    }

    return {
      isDeviated: false,
      severity: 'none',
      reason: 'Activity appears to align with current TODO item',
      correction: '',
    };
  }
}

export class TodoContextProvider {
  static getCurrentTodoContext(
    fileSystem: FileSystem,
    stepNumber: number,
    sessionId?: string,
    currentUrl?: string
  ): string {
    try {
      const todoContent = fileSystem.getTodoContents();
      if (!todoContent.trim()) {
        return `
⚠️ **NO TODO PLAN**: You must create a detailed todo.md file first!

📋 **IMMEDIATE ACTION REQUIRED**:
1. Create todo.md with proper structure (Discovery → Enumeration & Extraction → Verification phases)
2. Then call validate_current_todo_step to begin execution`;
      }

      // 分析当前应该执行的TODO item
      const extractedSessionId =
        sessionId ||
        TodoManagementActions.extractSessionIdFromFileSystem(fileSystem);
      const analysis = TodoManagementActions.analyzeTodoForCurrentStep(
        todoContent,
        stepNumber,
        extractedSessionId
      );

      if (!analysis.currentItem) {
        return `
🎉 **ALL TODO ITEMS COMPLETED!**
- Progress: ${analysis.progress.completed}/${analysis.progress.total} items completed (100%)
- Ready to finalize results and call done action`;
      }

      // 🔥 智能检测TODO进度更新
      const progressUpdateReminder = this.detectMissingProgressUpdate(
        fileSystem,
        analysis,
        stepNumber,
        extractedSessionId,
        currentUrl
      );

      return `
📋 **CURRENT TODO FOCUS** (Step ${stepNumber}):

🎯 **Current Item**: ${analysis.currentItem.title}
📍 **Phase**: ${analysis.currentPhase}
📊 **Status**: ${analysis.currentItem.status}
⏱️ **Progress**: ${analysis.progress.completed}/${analysis.progress.total} items completed (${Math.round((analysis.progress.completed / analysis.progress.total) * 100)}%)

💡 **Step Guidance**: ${analysis.stepGuidance}

🔍 **Next Actions**: ${this.getNextActionGuidance(analysis.currentItem, analysis.currentPhase)}

${progressUpdateReminder}

⚠️ **CRITICAL**: You MUST work on the current item above. Do not skip ahead!`;
    } catch (error) {
      return `
❌ **TODO ANALYSIS ERROR**: ${error}
📋 **FALLBACK ACTION**: Call validate_current_todo_step to get proper TODO guidance`;
    }
  }

  private static analyzeTodoForCurrentStep(
    todoContent: string,
    stepNumber: number
  ) {
    const lines = todoContent.split('\n');
    const phases = ['discovery', 'enumeration', 'extraction', 'verification'];
    let currentPhase = '';
    let items: any[] = [];
    let currentItem = null;
    let progress = { completed: 0, total: 0 };

    for (const line of lines) {
      const trimmed = line.trim();

      // 识别阶段
      if (
        trimmed.startsWith('###') &&
        phases.some((p) => trimmed.toLowerCase().includes(p))
      ) {
        currentPhase =
          phases.find((p) => trimmed.toLowerCase().includes(p)) || '';
        continue;
      }

      // 识别 TODO 项目
      const todoMatch = trimmed.match(/^\d+\.\s*\[([x\-!\s])\]\s*(.+)$/);
      if (todoMatch) {
        const status = todoMatch[1];
        const title = todoMatch[2];
        const item = {
          title,
          status:
            status === 'x'
              ? 'completed'
              : status === '-'
                ? 'in_progress'
                : status === '!'
                  ? 'blocked'
                  : 'pending',
          phase: currentPhase,
        };

        items.push(item);
        progress.total++;

        if (status === 'x') {
          progress.completed++;
        } else if (!currentItem && status !== 'x') {
          currentItem = item;
        }
      }
    }

    const stepGuidance = currentItem
      ? TodoManagementActions.generateStepGuidance(currentItem, stepNumber)
      : 'No current TODO item found';

    return {
      currentPhase,
      currentItem,
      progress,
      stepGuidance,
      allItems: items,
    };
  }

  private static getNextActionGuidance(item: any, phase: string): string {
    switch (phase) {
      case 'discovery':
        return 'Use go_to_url, click_element_by_index, scroll actions to navigate and explore';
      case 'enumeration':
        return 'Document findings using write_file or replace_file_str to update TODO';
      case 'extraction':
        return 'Use extract_api_document_structured_data to capture detailed information';
      case 'verification':
        return 'Use read_file to verify completeness and accuracy';
      default:
        return 'Follow the TODO item requirements';
    }
  }

  /**
   * 🎯 方案2: 基于URL的导航成功检测
   * 检测当前URL是否匹配TODO目标，判断导航是否成功
   */
  static detectNavigationSuccess(
    currentUrl: string,
    todoItem: any
  ): {
    isSuccess: boolean;
    confidence: number;
    reason: string;
  } {
    try {
      if (!currentUrl || !todoItem?.title) {
        return {
          isSuccess: false,
          confidence: 0,
          reason: 'Missing URL or TODO item',
        };
      }

      const title = todoItem.title.toLowerCase();
      const url = currentUrl.toLowerCase();

      // HubSpot 导航检测
      if (title.includes('hubspot') && title.includes('navigate')) {
        if (
          url.includes('hubspot.com/docs/reference/api/crm/objects/contacts')
        ) {
          return {
            isSuccess: true,
            confidence: 0.95,
            reason:
              'Successfully navigated to HubSpot Contacts API documentation page',
          };
        }
        if (url.includes('hubspot.com')) {
          return {
            isSuccess: true,
            confidence: 0.7,
            reason: 'Navigated to HubSpot domain, may need further navigation',
          };
        }
      }

      // Adyen 导航检测
      if (title.includes('adyen') && title.includes('navigate')) {
        if (url.includes('docs.adyen.com/api-explorer/transfers')) {
          return {
            isSuccess: true,
            confidence: 0.95,
            reason: 'Successfully navigated to Adyen Transfers API page',
          };
        }
        if (url.includes('adyen.com')) {
          return {
            isSuccess: true,
            confidence: 0.7,
            reason: 'Navigated to Adyen domain, may need further navigation',
          };
        }
      }

      // Jumpseller 导航检测
      if (title.includes('jumpseller') && title.includes('navigate')) {
        if (
          url.includes('jumpseller.com/support/api') &&
          url.includes('products')
        ) {
          return {
            isSuccess: true,
            confidence: 0.95,
            reason: 'Successfully navigated to Jumpseller Products API page',
          };
        }
        if (url.includes('jumpseller.com')) {
          return {
            isSuccess: true,
            confidence: 0.7,
            reason:
              'Navigated to Jumpseller domain, may need further navigation',
          };
        }
      }

      // Zoho 导航检测
      if (title.includes('zoho') && title.includes('navigate')) {
        if (url.includes('zoho.com/crm/developer/docs/api')) {
          return {
            isSuccess: true,
            confidence: 0.95,
            reason: 'Successfully navigated to Zoho CRM API documentation page',
          };
        }
        if (url.includes('zoho.com')) {
          return {
            isSuccess: true,
            confidence: 0.7,
            reason: 'Navigated to Zoho domain, may need further navigation',
          };
        }
      }

      // 通用导航检测模式
      if (title.includes('navigate') && title.includes('api')) {
        // 检查是否包含API文档相关关键词
        const apiKeywords = [
          'api',
          'docs',
          'documentation',
          'reference',
          'developer',
        ];
        const hasApiKeywords = apiKeywords.some((keyword) =>
          url.includes(keyword)
        );

        if (hasApiKeywords) {
          return {
            isSuccess: true,
            confidence: 0.8,
            reason: 'Navigated to a page with API documentation indicators',
          };
        }
      }

      return {
        isSuccess: false,
        confidence: 0,
        reason: 'No navigation success patterns matched',
      };
    } catch (error) {
      console.warn('Navigation success detection failed:', error);
      return {
        isSuccess: false,
        confidence: 0,
        reason: `Detection error: ${error}`,
      };
    }
  }

  /**
   * 🔍 方案1: 增强的工作证据分析（导航阶段 + API提取检测）
   * 检测文件系统中的工作进展证据，结合URL检测
   */
  static analyzeWorkEvidence(
    fileSystem: FileSystem,
    currentItem: any,
    currentUrl?: string
  ): {
    hasEvidence: boolean;
    evidenceType: string;
    confidence: number;
    details: string[];
    actionSuggestion?: string;
  } {
    const evidence = {
      hasEvidence: false,
      evidenceType: '',
      confidence: 0,
      details: [] as string[],
      actionSuggestion: undefined as string | undefined,
    };

    try {
      console.log('🔍 Analyzing work evidence...');

      // 获取文件系统描述
      let description = '';
      try {
        description = fileSystem.describe() || '';
        console.log(
          '📂 FileSystem description:',
          description.substring(0, 200) + '...'
        );
      } catch (error) {
        console.warn('⚠️ Failed to get file system description:', error);
        return evidence;
      }

      // 🎯 **优先级1: API文档提取证据** (最高置信度)
      if (description.includes('api_doc_content_')) {
        evidence.hasEvidence = true;
        evidence.evidenceType = 'API Documentation Extracted';
        evidence.confidence = 0.95;

        // 计算API文档文件数量
        const apiDocMatches = description.match(/api_doc_content_\w+\.md/g);
        const fileCount = apiDocMatches ? apiDocMatches.length : 1;
        evidence.details.push(
          `Found ${fileCount} API document files in filesystem`
        );
        evidence.actionSuggestion = 'update_todo_progress';

        console.log('✅ API Documentation detected!', {
          fileCount,
          confidence: evidence.confidence,
        });
        return evidence;
      }

      // 🎯 **优先级2: 导航成功证据** (结合URL检测)
      if (currentUrl && currentItem) {
        const navigationResult = this.detectNavigationSuccess(
          currentUrl,
          currentItem
        );

        if (navigationResult.isSuccess && navigationResult.confidence >= 0.7) {
          evidence.hasEvidence = true;
          evidence.evidenceType = 'Navigation Success';
          evidence.confidence = navigationResult.confidence;
          evidence.details.push(navigationResult.reason);
          evidence.details.push(`Current URL: ${currentUrl}`);

          // 根据置信度决定是否建议更新
          if (navigationResult.confidence >= 0.9) {
            evidence.actionSuggestion = 'update_todo_progress';
          }

          console.log('🎯 Navigation success detected!', navigationResult);
          return evidence;
        }
      }

      // 🎯 **优先级3: 多截图证据** (表明深度工作)
      const screenshotMatches = description.match(/step_\d+\.png/g);
      if (screenshotMatches && screenshotMatches.length >= 5) {
        evidence.hasEvidence = true;
        evidence.evidenceType = 'Extensive Navigation Activity';
        evidence.confidence = 0.6;
        evidence.details.push(
          `Found ${screenshotMatches.length} screenshots indicating thorough exploration`
        );

        console.log('📸 Extensive screenshot activity detected');
      }

      // 🎯 **优先级4: 对话文件证据** (表明活跃工作)
      const conversationMatches = description.match(/conversation_\d+\.txt/g);
      if (conversationMatches && conversationMatches.length >= 3) {
        evidence.hasEvidence = true;
        evidence.evidenceType =
          evidence.evidenceType || 'Active Conversation Work';
        evidence.confidence = Math.max(evidence.confidence, 0.5);
        evidence.details.push(
          `Found ${conversationMatches.length} conversation files indicating sustained work`
        );

        console.log('💬 Active conversation work detected');
      }

      // 🎯 **优先级5: 单一截图证据** (基础活动)
      if (
        !evidence.hasEvidence &&
        (description.includes('screenshot') || description.includes('.png'))
      ) {
        evidence.hasEvidence = true;
        evidence.evidenceType = 'Basic Navigation Activity';
        evidence.confidence = 0.3;
        evidence.details.push(
          'Found screenshot files indicating basic navigation activity'
        );
        console.log('📷 Basic screenshot evidence detected');
      }

      console.log('🔍 Work evidence analysis result:', evidence);
    } catch (error) {
      console.warn('⚠️ Work evidence analysis failed:', error);
    }

    return evidence;
  }

  /**
   * 🚨 智能TODO进度更新检测 (方案1+方案2组合)
   * 整合导航检测和文件证据分析，生成智能提醒
   */
  static detectMissingProgressUpdate(
    fileSystem: FileSystem,
    analysis: any,
    stepNumber: number,
    sessionId: string,
    currentUrl?: string
  ): string {
    try {
      console.log(
        `🔍 TODO Detection: Step ${stepNumber}, Session ${sessionId}`
      );

      // 检测工作证据 (组合方案1+方案2)
      const workEvidence = this.analyzeWorkEvidence(
        fileSystem,
        analysis.currentItem,
        currentUrl
      );

      console.log('📊 Work Evidence:', workEvidence);

      // 🚨 **强制更新场景**: API文档提取完成
      if (
        workEvidence.hasEvidence &&
        workEvidence.evidenceType.includes('API Documentation') &&
        workEvidence.confidence >= 0.9
      ) {
        return `

🚨 **MANDATORY PROGRESS UPDATE DETECTED** 🚨

✅ **Strong Evidence of API Documentation Work**:
- Type: ${workEvidence.evidenceType}
- Confidence: ${Math.round(workEvidence.confidence * 100)}%
- Details: ${workEvidence.details.join(', ')}

⚡ **IMMEDIATE ACTION REQUIRED**:
You MUST call update_todo_progress in this step with:
- item_identifier: "${analysis.currentItem.title}"
- new_status: "completed"
- completion_note: "API documentation extraction completed"

🔥 **ZERO TOLERANCE**: Failure to update progress is a critical system violation!`;
      }

      // 🎯 **高优先级提醒**: 导航成功，建议更新
      if (
        workEvidence.hasEvidence &&
        workEvidence.evidenceType.includes('Navigation Success') &&
        workEvidence.confidence >= 0.9
      ) {
        return `

🎯 **NAVIGATION SUCCESS DETECTED** 🎯

✅ **Successful Navigation Evidence**:
- Type: ${workEvidence.evidenceType}
- Confidence: ${Math.round(workEvidence.confidence * 100)}%
- Details: ${workEvidence.details.join(', ')}

💡 **RECOMMENDED ACTION**:
Consider calling update_todo_progress with:
- item_identifier: "${analysis.currentItem.title}"
- new_status: "completed"
- completion_note: "Successfully navigated to target page"

🔄 **Next**: Proceed to the next TODO item or continue current objectives`;
      }

      // 📋 **中等优先级提醒**: 有工作证据，考虑更新
      if (workEvidence.hasEvidence && workEvidence.confidence >= 0.6) {
        return `

💡 **PROGRESS CONSIDERATION**:
- Detected: ${workEvidence.evidenceType}
- Confidence: ${Math.round(workEvidence.confidence * 100)}%
- Details: ${workEvidence.details.join(', ')}

🤔 **Consider**: updating progress if meaningful work completed on "${analysis.currentItem.title}"
📝 **Optional**: call update_todo_progress if current item has advanced significantly`;
      }

      // 📊 **基础状态显示**: 显示检测活跃状态
      const statusMessage = workEvidence.hasEvidence
        ? `Evidence found but low confidence (${Math.round(workEvidence.confidence * 100)}%)`
        : 'No significant work evidence detected yet';

      return `

🔍 **TODO DETECTION ACTIVE** (Step ${stepNumber}):
- Monitoring: File system + URL navigation patterns
- Current Status: ${statusMessage}
- Ready to detect: API documentation extraction, navigation success
- Target Item: "${analysis.currentItem.title}"`;
    } catch (error) {
      console.warn('⚠️ Progress update detection failed:', error);
      return `

❌ **TODO DETECTION ERROR**: ${error}
📋 **Note**: Smart detection is active but encountered an issue
🔄 **Fallback**: Continue with current TODO item "${analysis.currentItem?.title || 'unknown'}"`;
    }
  }
}

const customInstructions = `

<critical_todo_enforcement>
🚨 MANDATORY TODO WORKFLOW - YOU MUST FOLLOW THIS EXACTLY:

📋 **AUTOMATIC TODO AWARENESS**: At the start of EVERY step, you will automatically receive a "**CURRENT TODO FOCUS**" section that tells you EXACTLY which TODO item you should be working on. This appears at the top of each step.

1. **STEP START PROTOCOL** (Required for EVERY step):
   - READ the automatically provided "**CURRENT TODO FOCUS**" section first
   - WORK ONLY on the TODO item specified in that section
   - NEVER ignore or deviate from the current TODO focus
   - Optional: Call validate_current_todo_step for additional validation

2. **TODO ADHERENCE RULES**:
   - The "**CURRENT TODO FOCUS**" section shows your exact current task
   - FOLLOW the "Step Guidance" and "Next Actions" provided
   - NEVER take actions that don't align with your current TODO item
   - NEVER skip ahead to future TODO items
   - NEVER abandon your TODO plan for "interesting discoveries"

3. **COMPLETION PROTOCOL**:
   - When you complete a TODO item, IMMEDIATELY call update_todo_progress
   - Mark the status as 'completed' with a completion note
   - The next TODO item will be automatically highlighted in the next step

4. **DEVIATION RECOVERY**:
   - If you realize you might be off-track, call analyze_todo_deviation
   - Follow the corrective actions provided
   - Return to your assigned TODO item

5. **TODO STATUS INDICATORS**:
   - 📋 "**NO TODO PLAN**" → Create todo.md file immediately
   - 🎯 "**Current Item**" → This is what you MUST work on
   - 🎉 "**ALL TODO ITEMS COMPLETED**" → Ready to call done action

6. **DYNAMIC TODO UPDATES**:
   - New endpoints found → add_dynamic_todo_item (medium priority)
   - Missing navigation needed → add_dynamic_todo_item (high priority)
   - Additional verification needed → add_dynamic_todo_item (low priority)

⚡ **KEY**: Look for the "**CURRENT TODO FOCUS**" section at the start of each step - it tells you exactly what to do!
</critical_todo_enforcement>

<todo_file_management>
This section defines the rules for how the TODO.md file should be generated, updated, and maintained by the agent.

**Rules**
- Always begin with a **title** (e.g., "Plan for extracting X API documentation").
- Must include a **## Goal** section that restates the user's request in natural language.
- Must include a **## Steps** (or **## Tasks**) section with a numbered checklist of actions.
  - Each task is a Markdown checkbox:
    - \`[ ]\` = incomplete
    - \`[x]\` = complete
    - \`[-]\` = start processing, or in the progress
  - Subtasks are allowed:
    - Indented by 3 spaces
    - Numbered (1., 2., 3., etc.)
- When a parent step has in-process sub-task, update its checkbox from \`[ ]\` → \`[-]\`.
- When a step is starting, update its checkbox from \`[ ]\` → \`[-]\`.
- When a step is completed, update its checkbox from e.g. \`[ ]\`, \`[-]\` → \`[x]\`.
- When the workflow is finished (success, partial, or failure), append or update a **## Result** (or **## Summary**) section at the end.
  - This section must include a **brief summary of the final output** or the outcome of the workflow. E.g. what has been extracted for the user request, what files generated for what extracted.
- Do not delete or overwrite existing tasks; only update their status or append new ones.
- Always preserve the overall structure of the file when updating.

**Example**
This is just an example of the file strucure, never copy this as your todo.md content directly.
\`\`\`md
# Plan for extracting Tasks-related API documentation

## Goal
Extract all Tasks-related API endpoint documentation content from the HubSpot CRM API documentation.

## Steps

### Discovery
1. [x] Navigate to HubSpot CRM API documentation home page
2. [x] Locate "Tasks" section
3. [x] Expand to reveal all endpoints

### Enumeration & Extraction
1. [x] Archive a batch of tasks by ID
2. [-] Create a batch of tasks
3. [ ] Create a task
4. [ ] Update a task by ID

### Verification
1. [ ] Confirm all listed endpoints are extracted
\`\`\`

</todo_file_management>




<api_document_content_page_explore_guidelines>
You are controlling a browser to extract complete information from an API documentation page.

## Workflow Guideline You Must Apply to Browse the page to Extract API document content
0. Firtly, you must identify what pages(endpoints) you need to browse to complete the user_request in your plan, follow this when you process your steps. Skip the pages (endpoints) that doesn't match the user_request.
1. Do not start browsing and extracting page content in a group section menu scope, always click the endpoint mene item. If the navigation section has many endpoints, open them by clicking one by one.
2. If the page doesn't look like an "API-endpoint" document page, for example the page just tells the end-point usage, api versions, rate-limit info, general authorzation-info of the API service, you should just extract the page content's summary content with a query like: \`Extract summary info, and what this page describes.\`.
3. You must memorize clearly what elements have been expanded, do not repeat to click them again.
4. Your goal is to explore the every single endpoint page, you should be able to distinglish if the page is a category section, or an endpoint detailed page. Click its sub nav items to enter the endpoint page, instead of doing extraction for the entire section.
5. Handle navigation menu:
  1. If the entry page open but the selected navigation menu item is not fully visible, you must observe the navigation panel and do necessary interaction scrollin(0.5 page to 1 page) individually on the panel as needed to make sure the selected navigation item of the entry page is visible before doing API document content extraction. For example, you can locate the first "nav" or "NavMenu" element on the page, or a div with class "SideNav" (or similar), this element is scrollable vertically.
  2. Make sure to get the selected endpoint page, or the endpoint you're currently exploring is visible in the navigation menu (if has) by using the scrolling tool, or do necessary interaction on the nav menu, nav panel decidedly.
  3. If the Nav item is already expanded, do not click to collapse them.
6. **IMPORTANT** Process indivisual endpoint at once, when the page contains multiple endpoints, please keep navivating to the sub endpoint.
7. Ignore **deprecated** endpoints, endpoint pages with "strikethrough" line. Skip those pages, indicate this in the todo.md file in your plan.
8. Folllow the **Detailed Info Discovery Instructions** below to browse the page to identify and discover API Spec content.
9. Use "extract_api_document_structured_data" tool to do API content extraction, and deliver the results.

## IMPORTANT INTERACTION RULES:
- NEVER click on elements with "+", "-", "▼", "▲" symbols in "Response samples"/"Requeset samples" sections
- NEVER interact with any UI controls in sample/example sections
- Focus only on the main API documentation content
- Ignore all "Copy", "Expand", "Collapse" buttons in sample areas


## Detailed Info Discovery Instructions

#### 0️⃣ Close Overlay: Highest Priority Action

CRITICAL: Before proceeding with any other actions on a new page (including those planned in todo.md), you MUST first scan the entire page for any overlays.

- **What to look for:** Overlays are elements that may block access to the main content. They include, but are not limited to:
  - Cookie consent banners & Cookie Policy prompts
  - Pop-up modals
  - Subscription prompts or sign-in dialogs
  - Floating ads or tooltips

- **What to do:** If an overlay is detected, your **immediate and only action for the current step must be to click the button or icon to dismiss it.**
  - Look for common dismissal elements like: "Accept", "Close", "X", "No thanks", "Got it", or "Dismiss".
  - Icons that look like X, × (close) or checkmarks are also valid targets.

- **Important Constraints:**
  - Defer your originally planned task to the next step after the overlay has been successfully closed.
  - Do not combine closing an overlay with any other action in the same step.
  - If an overlay cannot be closed, attempt to scroll or interact to bypass it.
  - Always wait 1–2 seconds after the interaction to allow the interface to update.

---

#### 1️⃣ Handle Page Navigating and Scrolling
- Do not mess up contents when page scrolling, you must extractly know what page you're exploring, and strictly recognize and remember the boundary when page is scrolling, here is same guides:
  - Anchor the current page by the location url, if the location url changed after scrolling, meaning the page is changed, you should scrolling back.
  - When scrolling, if more content is displaying, you must learn the context, if the content is not relative to the API content under the current page url, you should not extract or do interactive actions with that.
- You must always keep the focus on the content extraction on the current page you're working on, you should memory the page link you're working on.
- You can only change the navigation menu focused item, until the page content is extracted to meet the goal of the step.
- If the navigation menu bar(panel) is too long, you can scroll that container to get more content visible.
- Observe and learn the page to explore and expand the nav menu appropriatly.
- Wait 1-2s for content to load before proceeding.

---

#### 2️⃣ Discover Each Endpoint
For each visible API endpoint (e.g., GET \`/products\`, POST \`/users\`):
- Click its title or section to ensure details are visible.
- Wait 1-2s for content to load before proceeding.

---

#### 3️⃣ Discover **Request** Definitions
Within each endpoint section:
- Do not consider/explore "example" as the request body type
- You must firstly locate and click the elements under section where its field has description info to extract content, then check other example/samples area.
- Look for headings or tabs labeled:
  - "Request", "Request Body", "Request Payload", "Request Schema" or similar!
- Identify all clickable elements, for example item with arrow indicator symbols like: ▼, +, or arrow indicators!
- **Important** If the elements are already expanded/visible, DO NOT click the element to collapse it.
- Avoid duplicate clicks on already active tabs.

**CRITICAL RULE: You MUST FIRST CLICK on tabs labeled 'Schema', 'Request Schema', or 'Response Schema' to reveal their content.**
**NEVER call \`extract_api_document_structured_data\` on an API endpoint section IF a 'Schema' tab is visible but not active.**Your immediate next action must be to \`click\` the schema tab. Only after the schema content is visible can you proceed with extraction in a subsequent step. This is a mandatory prerequisite, not an optional step.

---

#### 4️⃣ Discover **Response** Definitions
- Do not consider/explore "example" as the response body type
- Always put to your thinking that: "Under labels like \`Responses\`, there would have Request Schema definition, you must firstly interact those elements under there"!
- You must always locate and interact the expandable elements under section where the fields have description info.
- If there are elements with label like below pattern examples, you must firstly click them just once to show the Response Schema Definition entries. For example:
   - Http Status Buttons under Responses section like: 200, 404, 500,
- Look for headings or tabs labeled:
  - "Response", "Response Body", "Response Schema" or similar.
- Scroll to the "Responses" section of the endpoint.
- If the elements are already expanded/visible, DO NOT click the element to collapse it.
- Be careful to avoid duplicate clicks on the same element with multiple Indexes.


**CRITICAL RULE: You MUST FIRST CLICK on tabs labeled 'Schema', 'Request Schema', or 'Response Schema' to reveal their content.**
**NEVER call \`extract_api_document_structured_data\` on an API endpoint section IF a 'Schema' tab is visible but not active.**Your immediate next action must be to \`click\` the schema tab. Only after the schema content is visible can you proceed with extraction in a subsequent step. This is a mandatory prerequisite, not an optional step.
---

#### 5️⃣ Sections You Should Ignore To Expand
- Programming Language Sections, for example JavaScript, PHP...

---


#### 6️⃣ Ignore Those Items
- "API docs by Redocly" This is not an API endpoint.

---

#### 7️⃣ CRITICAL: Iterative Expansion Protocol for Schemas

**This is a mandatory protocol before any data extraction.**

- **Principle:** You are not finished exploring a request or response until ALL nested elements are fully visible. The presence of any expandable element means your view is incomplete.

- **Action Loop:**
  1. After revealing a primary section (e.g., by clicking a "200" status code or a "Request Body" tab), you MUST immediately scan its content for any further expandable elements.
  2. These elements are often buttons indicated by symbols like \`+\`, \`▼\`, \`▶\`, text labels like "expand", "show children", or HTML attributes like \`aria-expanded="false"\`. The case you encountered, \`[41]<button aria-label="expand product" />\`, is a perfect example.
  3. **If one or more such elements exist, your IMMEDIATE and ONLY \`next_goal\` is to \`click\` one of them.** Do not proceed to extraction.
  4. After the click, the page state will update. You must **repeat this scanning process (Step 1-3)** because expanding one object may reveal new, deeper nested expandable objects.
  5. Continue this click-and-scan loop until a scan of the current endpoint's section reveals **NO MORE** expandable elements.

- **Extraction Condition:** The action \`extract_api_document_structured_data\` may ONLY be called on an endpoint's section after you have confirmed that this Iterative Expansion Protocol is complete and the schema is in a fully expanded state.

---

</api_document_content_page_explore_guidelines>


## CRITICAL: API Document information Extraction Rules
<api_document_page_extraction_rules>
CRITICAL: API Document Information Extraction Rules

**extract_api_document_structured_data Query Guidelines for API Documentation:**

### For API Endpoint Page Content Extraction
1. When calling \`extract_api_document_structured_data\` for indivisual API documentation pages, you should bring below intent and combine it to the \`query\` with what endpoint (page) you think it needs to extract the current browser page(endpoint) you'r focusing on:
\`\`\`md
Extract raw api document content for "Get users" endpoint, including:
  1. HTTP method, path, baseApiUrl, endpoint description
  2. Request content type, query/path parameters, request headers, request body schema, including field descriptions, types, and required/optional properties.
  3. Detailed response schemas for each HTTP status code, including field descriptions, types, and required/optional properties.
\`\`\`
</api_document_page_extraction_rules>

`;

export class BrowserUseSSEAgent {
  private cancelled = false;
  private controller?: Controller;
  private sessionId?: string;

  constructor(sessionId?: string) {
    this.sessionId = sessionId;
  }

  async cancel(): Promise<void> {
    try {
      // Cancel any ongoing execution
      this.cancelled = true;

      // Cleanup controller if exists
      if (this.controller) {
        await this.controller.cleanup();
        this.controller = undefined;
      }
      // Session cleanup is now handled by BrowserUseService
    } catch (error) {
      console.warn('Error during cleanup:', error);
    }
  }

  /**
   * Execute agent with SSE event streaming (simplified)
   */
  async executeWithSSE(
    userRequest: string,
    maxSteps: number = 100,
    sessionId?: string,
    sendEvent?: (event: BrowserUseEvent) => void
  ): Promise<void> {
    try {
      // Initialize controller
      this.controller = await createController({
        config: {
          llm: {
            provider: 'azure',
            model: 'gpt-5',
            azureEndpoint: 'https://oai-ai4m-rnd-eastus-001.openai.azure.com',
            azureDeployment: 'oai-ai4m-rnd-eastus-001-gpt-4-0125-Preview-001',
            apiVersion: '2025-03-01-preview',
            apiKey: process.env.AZURE_OPENAI_API_KEY,

            // provider: 'google',
            // model: 'gemini-2.5-flash',
            // baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
            // apiKey: process.env.GOOGLE_API_KEY,
            temperature: 0.1,
            frequencyPenalty: 0.2,
            timeout: 60000,
            maxTokens: 16384,
          },
          browser: {
            headless: process.env.HEADLESS === 'true' || false,
            browserType: 'chromium',
            viewport: { width: 1440, height: 1080 },
            timeout: 45000,
            args: [],
            viewportExpansion: 2000,
          },
          logging: {
            level: 'debug',
            console: true,
            json: false,
          },
          maxSteps: maxSteps,
        },
      });

      // Start execution event
      const startEvent: BrowserUseEvent = {
        type: 'execution_start',
        timestamp: new Date().toISOString(),
        session_id: sessionId || 'default',
        message: 'Agent execution started',
      };
      if (sendEvent) sendEvent(startEvent);

      // Enhanced agent config with SSE event handling
      const enhancedConfig: AgentConfig = {
        useVision: true,
        maxSteps: maxSteps,
        actionTimeout: 15000,
        continueOnFailure: true,
        customInstructions: customInstructions,
        saveConversationPath: `projects/${sessionId}/conversations`,
        fileSystemPath: `projects/${sessionId}`,
        onStepStart: this._createOnStepStartHandler(sessionId, sendEvent),
        onStepEnd: this._createOnStepEndHandler(sessionId, sendEvent),
      };

      const request = `
${userRequest}

# 🚨 CRITICAL TODO EXECUTION PROTOCOL:

📋 **AUTOMATIC TODO GUIDANCE**: You will receive a "**CURRENT TODO FOCUS**" section at the start of EVERY step that shows:
- 🎯 **Current Item**: Exactly which TODO item you should work on
- 📍 **Phase**: Which phase you're in (Discovery, Enumeration&Extraction,Verification)
- 💡 **Step Guidance**: What you should accomplish in this step
- 🔍 **Next Actions**: Specific actions you should take

⚠️ **MANDATORY FIRST STEP**: Before any other actions, you MUST:
1. Create a detailed todo.md file following the <todo_file_management> format
2. The system will automatically guide you to the first TODO item

⚠️ **EVERY SUBSEQUENT STEP** you MUST:
1. READ the "**CURRENT TODO FOCUS**" section provided automatically
2. Work ONLY on the current TODO item specified
3. Follow the "Step Guidance" and "Next Actions" exactly
4. Call update_todo_progress when you complete an item

⚠️ **AUTOMATIC FAILURE CONDITIONS**:
- Ignoring the "**CURRENT TODO FOCUS**" section → IMMEDIATE STOP
- Working on wrong TODO items → IMMEDIATE STOP
- Not updating TODO progress when items are completed → IMMEDIATE STOP

🎯 **YOUR SUCCESS CRITERIA**:
- 100% adherence to "**CURRENT TODO FOCUS**" guidance
- Sequential completion of all TODO items as directed
- Dynamic updates when new content discovered
- Clear completion notes for each item

# Important Rules:
- This is "multi-step" task, you need to create a detailed plan with "todo.md" file before you start the task. Reference the <todo_file_management> section for the format of the "todo.md" file.
- Dynamically update the "todo.md" file with the new steps you need to take.
- Ignore **deprecated** endpoints, or endpoint pages with "strikethrough" line. Skip those pages, endpoint pages with "deprecated" text. Indicate this in the todo.md file in your plan as "skipped" with \`[x]\` flag as default.
- Reference the <additional_todo_definition_rules> for the additional rules to organize tasks into logical phases for API document content extraction task.
- Follow the <additional_todo_management_rules> to explore/navigate the page content and extract the API document content.
- **Prioritize Interaction over Visibility**: Before checking for visible content, you MUST first inspect elements for clear interactive roles or attributes. If an element has a WAI-ARIA role like role='option', role='tab', role='radio', role='presentation', or a state attribute like aria-expanded='false', you must prioritize **clicking** it. This action is necessary to ensure the corresponding view is fully loaded and active. This rule **overrides** the general rule of extracting data just because some content appears to be visible.
- When you think content can be extracted and before calling extract_api_document_structured_data, if there are buttons like 200, 201, 400, 500 and so on, please click them first(Regardless of whether the information for 200, 201, 400, 500, etc., is already displayed, please use the history to determine this and make sure to click it once.). Then, consider if there is any "default" related information (if so, be sure to click the "default" element), and then call extract_api_document_structured_data.

<additional_todo_management_rules>
CRITICAL Rules to organize tasks into logical phases:
- Organize tasks into the following logical phases. The todo.md should be structured with headings that reflect these phases.
  - **Discovery**: The first phase for navigation, locating the relevant API documentation sections, and revealing all the endpoints.
  - **Enumeration & Extraction**: The phase for listing and processing all relevant items. Create a single, comprehensive checklist, listing every individual endpoint you need to process as a **numbered** checkbox item (e.g., \`1. [ ] Endpoint Name\`). Then, work through this checklist, and as soon as you have extracted data for an endpoint, mark its corresponding checkbox from \`[ ]\` to \`[x]\`.
  - **Verification**: The final phase. After all items in the checklist are marked as complete, confirm that all work has been done correctly.

**Example**
This is just an example of the file strucure, never copy this this as your todo.md content directly.
\`\`\`md
# Plan for extracting Tasks-related API documentation

## Goal
Extract all Tasks-related API endpoint documentation content from the HubSpot CRM API documentation.

## Steps

### Discovery
1. [x] Navigate to HubSpot CRM API documentation home page
2. [x] Locate "Tasks" section
3. [x] Expand to reveal all endpoints

### Enumeration & Extraction
1. [x] Archive a batch of tasks by ID
2. [-] Create a batch of tasks
3. [ ] Create a task
4. [ ] Update a task by ID

### Verification
1. [ ] Confirm all listed endpoints are extracted
\`\`\`

</additional_todo_management_rules>
`;

      // Execute agent
      const history = await this.controller.run(request, enhancedConfig);

      // Get final page info
      const browserContext = this.controller.getBrowserContext();
      const page = browserContext?.getActivePage();
      let finalPageInfo = null;

      if (page) {
        try {
          const title = await page.title();
          const url = page.url();
          finalPageInfo = { title, url };
        } catch (error) {
          console.warn('Failed to get final page info:', error);
        }
      }

      // Send completion event
      const completeEvent: BrowserUseEvent = {
        type: this.cancelled ? 'cancelled' : 'agent_complete',
        timestamp: new Date().toISOString(),
        session_id: sessionId || 'default',
        data: {
          stepsExecuted: history.length,
          finalPage: finalPageInfo,
        },
        message: this.cancelled
          ? 'Agent execution cancelled'
          : 'Agent execution completed successfully',
      };
      if (sendEvent) sendEvent(completeEvent);
    } catch (error) {
      const errorEvent: BrowserUseEvent = {
        type: 'error',
        timestamp: new Date().toISOString(),
        session_id: sessionId || 'default',
        message: (error as Error).message,
        error: (error as Error).message,
      };
      if (sendEvent) sendEvent(errorEvent);
    } finally {
      await this.cancel();
    }
  }

  /**
   * Create onStepStart handler
   */
  private _createOnStepStartHandler(
    sessionId?: string,
    sendEvent?: (event: BrowserUseEvent) => void
  ) {
    return async (agent: Agent) => {
      try {
        // Get current page state from browser session
        const browserSession = (agent as any).browserSession;
        const context = browserSession?.getContext();
        const page = context?.pages().slice(-1)[0];
        const currentUrl = page ? page.url() : 'N/A';

        // Get agent state information
        const history = agent.getHistory();
        const stepNumber = agent.getCurrentStep();

        // 🎯 Inject current TODO context into agent's memory
        let todoContextMessage = '';
        try {
          const fileSystem = (agent as any).fileSystem;
          if (fileSystem) {
            const todoContext = TodoContextProvider.getCurrentTodoContext(
              fileSystem,
              stepNumber + 1,
              sessionId,
              currentUrl
            );
            todoContextMessage = todoContext;

            // ❌ 只发送了事件，但没有注入到LLM消息中！
            const todoEvent: BrowserUseEvent = {
              type: 'todo_context',
              message: 'Current TODO context provided to LLM', // 误导性的消息！
              timestamp: new Date().toISOString(),
              session_id: sessionId || 'default',
              data: {
                step: stepNumber + 1,
                todoContextPreview:
                  todoContext.length > 200
                    ? todoContext.substring(0, 200) + '...'
                    : todoContext,
              },
            };
            if (sendEvent) sendEvent(todoEvent);

            console.log(`📋 TODO Context injected for step ${stepNumber + 1}`);
          }
        } catch (todoError) {
          console.warn('Failed to inject TODO context:', todoError);
          todoContextMessage = `❌ **TODO CONTEXT ERROR**: ${todoError}\n📋 **FALLBACK**: Call validate_current_todo_step to get proper guidance`;
        }

        // Extract history data using safe method
        const historyData = this._extractSafeHistoryData(history);

        // Create step event data matching Python format with TODO context
        const stepData = {
          step: stepNumber,
          url: currentUrl,
          todoContext: todoContextMessage,
          ...historyData,
          timestamp: new Date().toISOString(),
        };

        const event: BrowserUseEvent = {
          type: 'step_start',
          message: `Starting step ${stepNumber} with TODO context`,
          timestamp: new Date().toISOString(),
          session_id: sessionId || 'default',
          data: stepData,
        };
        if (sendEvent) sendEvent(event);
      } catch (error) {
        console.error('Error in step start hook:', error);
        const errorEvent: BrowserUseEvent = {
          type: 'error',
          message: `Error in step start hook: ${error}`,
          timestamp: new Date().toISOString(),
          session_id: sessionId || 'default',
          error: String(error),
        };
        if (sendEvent) sendEvent(errorEvent);
      }
    };
  }

  /**
   * Create onStepEnd handler
   */
  private _createOnStepEndHandler(
    sessionId?: string,
    sendEvent?: (event: BrowserUseEvent) => void
  ) {
    return async (agent: Agent) => {
      try {
        // Get current page state from browser session
        const browserSession = (agent as any).browserSession;
        const context = browserSession?.getContext();
        const page = context?.pages().slice(-1)[0];
        const currentUrl = page ? page.url() : 'N/A';

        // Get agent state information
        const history = agent.getHistory();
        const stepNumber = agent.getCurrentStep();

        // Extract history data using safe method
        const historyData = this._extractSafeHistoryData(history);

        // Create step completion event data matching Python format
        const stepData = {
          step: stepNumber,
          url: currentUrl,
          ...historyData,
          timestamp: new Date().toISOString(),
        };

        const event: BrowserUseEvent = {
          type: 'step_complete',
          message: `Completed step ${stepNumber}`,
          timestamp: new Date().toISOString(),
          session_id: sessionId || 'default',
          data: stepData,
        };
        if (sendEvent) sendEvent(event);
      } catch (error) {
        console.error('Error in step end hook:', error);
        const errorEvent: BrowserUseEvent = {
          type: 'error',
          message: `Error in step end hook: ${error}`,
          timestamp: new Date().toISOString(),
          session_id: sessionId || 'default',
          error: String(error),
        };
        if (sendEvent) sendEvent(errorEvent);
      }
    };
  }

  /**
   * Safely extract data from browser_use history object.
   * Matches Python version's _extract_safe_history_data functionality.
   */
  private _extractSafeHistoryData(history: any[]): any {
    try {
      // Validate history object
      if (!history || !Array.isArray(history)) {
        console.warn('Invalid history object provided');
        return {
          model_thoughts: null,
          model_outputs: null,
          model_actions: null,
          extracted_content: null,
          urls: [],
        };
      }

      if (history.length === 0) {
        console.warn('Empty history object provided');
        return {
          model_thoughts: null,
          model_outputs: null,
          model_actions: null,
          extracted_content: null,
          urls: [],
        };
      }

      // Extract data from all history steps, similar to Python version
      const model_thoughts: string[] = [];
      const model_outputs: string[] = [];
      const model_actions: any[] = [];
      const extracted_contents: string[] = [];
      const urls: string[] = [];

      // Process each history step
      for (const step of history) {
        if (!step) continue;

        // Extract thoughts from various possible locations
        // Check result.metadata.thoughts, result.longTermMemory, or action reasoning
        const thoughts =
          step.result?.metadata?.thoughts ||
          step.result?.longTermMemory ||
          (typeof step.action === 'object' && step.action?.reasoning) ||
          null;
        if (thoughts && typeof thoughts === 'string') {
          model_thoughts.push(thoughts);
        }

        // Extract model outputs (result messages)
        const output = step.result?.message;
        if (output && typeof output === 'string') {
          model_outputs.push(output);
        }

        // Extract actions
        if (step.action) {
          model_actions.push(step.action);
        }

        // Extract content
        const content = step.result?.extractedContent;
        if (content && typeof content === 'string') {
          extracted_contents.push(content);
        }

        // Extract URLs from page state
        const url = step.pageState?.url;
        if (url && typeof url === 'string') {
          urls.push(url);
        }
      }

      // Return the last item for most fields (matching Python behavior)
      // and all URLs
      return {
        model_thoughts:
          model_thoughts.length > 0
            ? model_thoughts[model_thoughts.length - 1]
            : null,
        model_outputs:
          model_outputs.length > 0
            ? model_outputs[model_outputs.length - 1]
            : null,
        model_actions:
          model_actions.length > 0
            ? model_actions[model_actions.length - 1]
            : null,
        extracted_content:
          extracted_contents.length > 0
            ? extracted_contents[extracted_contents.length - 1]
            : null,
        urls: Array.from(new Set(urls)), // Remove duplicates
      };
    } catch (error) {
      console.warn(`Failed to extract history data: ${error}`);
      return {
        model_thoughts: null,
        model_outputs: null,
        model_actions: null,
        extracted_content: null,
        urls: [],
      };
    }
  }

  /**
   * Get session status
   */
  getStatus(): any {
    return {
      sessionId: this.sessionId,
      cancelled: this.cancelled,
      isRunning: !!this.controller,
      timestamp: Date.now(),
    };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const browserUseAgent = new BrowserUseSSEAgent();

  const timestamp = new Date().toISOString();
  const request = {
    hubspot: {
      url: 'https://developers.hubspot.com/docs/reference/api/crm/objects/contacts',
      text: `Extract the API documentation content for the endpoints: read contact, create contact, and update contact from the page https://developers.hubspot.com/docs/reference/api/crm/objects/contacts. You must extract all available details required for OpenAPI Spec generation, including endpoints, HTTP methods, baseApiUrl, auth requirements, request params, request body schema, response codes, and error responses.`,
    },
    adyen: {
      url: 'https://docs.adyen.com/api-explorer/transfers/4/overview',
      text: `I would like to generate the spec for "Transfers" related API from Adyen https://docs.adyen.com/api-explorer/transfers/4/overview`,
    },
    jumpseller: {
      url: 'https://jumpseller.com/support/api/#tag/Products',
      text: `I would like to generate the spec for "Products" related API from Jumpseller website https://jumpseller.com/support/api/#tag/Products`,
    },
    zuho: {
      url: 'https://www.zoho.com/crm/developer/docs/api/v8/delete-tag.html',
      text: `Extract the entire original API documentation content for the 'Delete Tag' API from the page https://www.zoho.com/crm/developer/docs/api/v8/delete-tag.html. Extract all available details required for OpenAPI Spec generation, including endpoints, HTTP methods, versioning, baseApiUrl, auth requirements, request parameters, request body schema, response codes, bodies, and error responses. Preserve exact wording from the source.`,
    },
  }[(process.env.API_NAME as string) ?? 'hubspot']!;

  // Execute the agent task
  (async () => {
    try {
      await browserUseAgent.executeWithSSE(
        request.text,
        100,
        timestamp,
        (event) => {
          // console.log('Event:', event);
        }
      );
      console.log('Agent execution completed successfully');
    } catch (error) {
      console.error('Error:', error);
    }
  })();
}
