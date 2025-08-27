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
import { promises as fs } from 'fs';

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

export function setGlobalSSEEventSender(sendEvent: (event: BrowserUseEvent) => void): void {
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
        .describe('The name of the endpoint if extracting an endpoint, used for memory recording'),
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

        // Calculate page index based on api_doc_content_ files in the project directory
        let pageIndex = 1;
        if (context.fileSystem) {
          try {
            const projectDir = context.fileSystem.getDir();
            const existingFiles = await fs.readdir(projectDir);
            const apiDocContentFiles = existingFiles.filter((filename: string) => filename.startsWith('api_doc_content_'));

            // Extract unique page indices from filenames
            const pageIndices = new Set<number>();
            apiDocContentFiles.forEach(filename => {
              const match = filename.match(/^api_doc_content_(\d+)/);
              if (match) {
                pageIndices.add(parseInt(match[1]));
              }
            });

            const maxIndex = pageIndices.size > 0 ? Math.max(...pageIndices) : 0;
            pageIndex = maxIndex + 1;
          } catch (error) {
            console.warn('Failed to read project directory for pageIndex calculation:', error);
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
            const contentRawFilePath = path.join(context.fileSystem.getDir(), contentRawFileName);
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
              const contentRawPromptFilePath = path.join(context.fileSystem.getDir(), contentRawPromptName);
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
              formatted_prompt: prompt.replace(content, `placeholder-in-log, see the content in the file: ${contentRawPromptName}, content-length: ${content.length}`),
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
            endpoint_name
          );
        } else {
          // Large content - use chunking
          console.log(`Content is large (${content.length} chars), splitting into chunks...`);
          await ExtractDataActions.sendTraceEvent({
            type: 'chunking_start',
            contentLength: content.length,
            maxChars,
            timestamp: Date.now(),
          });

          const chunks = ExtractDataActions.chunkContent(content, maxChars, maxChunks);
          const chunkResponses: string[] = [];

          // Process each chunk
          for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const chunkPrompt = ExtractDataActions.buildChunkPrompt(query, chunk, i + 1, chunks.length);

            console.log(`Processing chunk ${i + 1}/${chunks.length} (${chunk.length} chars)`);

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
                const chunkPromptFilePath = path.join(context.fileSystem.getDir(), chunkPromptFileName);
                await fs.writeFile(chunkPromptFilePath, chunkPrompt, 'utf-8');
                console.log(`Saved chunk ${i + 1} prompt to ${chunkPromptFilePath}`);
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
              chunkResponses.push(`Error processing chunk ${i + 1}: ${(error as Error).message}`);
            }
          }

          console.log(`Chunk processing completed: ${chunkResponses.filter(r => !r.startsWith('Error')).length} successful, ${chunkResponses.filter(r => r.startsWith('Error')).length} failed`);

          // Save individual chunks content (like Python version)
          if (context.fileSystem) {
            try {
              let chunksContent = `Combined results from ${chunks.length} chunks:\n\n`;
              for (let i = 0; i < chunkResponses.length; i++) {
                chunksContent += `--- Chunk ${i + 1} ---\n${chunkResponses[i]}\n\n`;
              }

              const chunksFileName = `${apiDocContentExtractFilePrefix}_${pageIndex}.chunks.md`;
              const chunksFilePath = path.join(context.fileSystem.getDir(), chunksFileName);
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
              const mergedFilePath = path.join(context.fileSystem.getDir(), mergedFileName);
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
            endpoint_name
          );
        }
      } catch (error) {
        // Handle different types of errors (like Python version)
        let errorMessage = 'Unknown error';
        let errorType = 'general_error';

        if (error instanceof Error) {
          errorMessage = error.message;
          if (error.message.includes('timeout') || error.message.includes('TimeoutError')) {
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
      return require('fs').readFileSync(promptPath, 'utf-8');
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
  private static chunkContent(content: string, maxChars: number, maxChunks: number): string[] {
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
  private static buildChunkPrompt(query: string, chunk: string, chunkIndex: number, totalChunks: number): string {
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
  private static async mergeChunkResponses(chunkResponses: string[], llmClient: BaseLLMClient): Promise<string> {
    try {
      const mergePrompt = `Merge the following chunk responses into a single response, and respond in JSON format. Preserve the original content, do not fabricate any data.

# Rules
- Ignore fields in the chunk that do not have valid info, for example field with:
    1. The provided chunk does not contain any information related to xxxx
    2. Not available in the chunk.
- Combine and deduplicate information from all chunks
- Maintain the structure and format of the original responses
- If there are conflicts between chunks, prioritize the most complete information

<chunked_responses>
${chunkResponses.join('\n\n---\n\n')}
</chunked_responses>`;

      const response = await withTimeout(
        llmClient.generateResponse([
          { role: 'user', content: mergePrompt },
        ]),
        120000,
        'Merge operation timed out after 2 minutes'
      );

      return response.content;
    } catch (error) {
      console.error('Error merging chunk responses:', error);
      // Fallback: return concatenated responses with clear separation
      return `# Combined Chunk Responses\n\n${chunkResponses.map((response, index) => `## Chunk ${index + 1}\n\n${response}`).join('\n\n---\n\n')}`;
    }
  }

  /**
   * Send trace event
   */
  private static async sendTraceEvent(eventData: Record<string, any>): Promise<void> {
    try {
      // For now, just log the event. In the future, this could send to a trace service
      console.log('Trace Event:', JSON.stringify(eventData, null, 2));

      if (globalSSEEventSender) {
        const sseEvent: BrowserUseEvent = {
          type: 'trace_event',
          session_id: 'default',
          timestamp: new Date().toISOString(),
          data: eventData,
          message: `Trace: ${eventData.type || 'unknown'}`
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
    endpoint_name?: string
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

      const pageIndex = context.fileSystem?.getExtractedContentCount() || 0;

      try {
        // Save using file system if available (matching Python version logic)
        if (context.fileSystem) {
          await context.fileSystem.saveExtractedContent(extractedContent);
        }

        const endpointNameInfo = endpoint_name ? `\n<endpoint_extracted>${endpoint_name}</endpoint_extracted>` : '';
        message = `Extracted content from ${url}\n<query>${query}\n</query>\n<extracted_content>\n${display}${lines.length - displayLinesCount} more lines...\n</extracted_content>\n<file_system>File saved at: extracted_content_${pageIndex}.md</file_system>${endpointNameInfo}`;

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
        message = display + (lines.length - displayLinesCount > 0 ? `${lines.length - displayLinesCount} more lines...` : '');
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

const customInstructions = `

<todo_file_management>
This section defines the rules for how the TODO.md file should be generated, updated, and maintained by the agent.

**Rules**
- Always begin with a **title** (e.g., "Plan for extracting X API documentation").
- Must include a **## Goal** section that restates the user’s request in natural language.
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
2. [ ] Locate "Tasks" section
3. [ ] Expand to reveal all endpoints

### Enumeration
1. [ ] List all Tasks-related endpoints

### Extraction
1. [ ] Archive a batch of tasks by ID
2. [ ] Create a batch of tasks
3. [ ] Create a task
4. [ ] Update a task by ID

### Verification
1. [ ] Confirm all listed endpoints are extracted

## Result
- Navigation complete.
- Enumeration in progress.
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
9. Use "extract_structured_data" tool to do API content extraction, and deliver the results.

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
  - Look for common dismissal elements like: "Accept”, "Close”, "X”, "No thanks”, "Got it”, or "Dismiss”.
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
  - "Request”, "Request Body", "Request Payload", "Request Schema" or similar!
- Identify all clickable elements, for example item with arrow indicator symbols like: ▼, +, or arrow indicators!
- **Important** If the elements are already expanded/visible, DO NOT click the element to collapse it.
- Avoid duplicate clicks on already active tabs.

**CRITICAL RULE: You MUST FIRST CLICK on tabs labeled 'Schema', 'Request Schema', or 'Response Schema' to reveal their content.**
**NEVER call \`extract_structured_data\` on an API endpoint section IF a 'Schema' tab is visible but not active.**Your immediate next action must be to \`click\` the schema tab. Only after the schema content is visible can you proceed with extraction in a subsequent step. This is a mandatory prerequisite, not an optional step.

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
**NEVER call \`extract_structured_data\` on an API endpoint section IF a 'Schema' tab is visible but not active.**Your immediate next action must be to \`click\` the schema tab. Only after the schema content is visible can you proceed with extraction in a subsequent step. This is a mandatory prerequisite, not an optional step.
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

**extract_structured_data Query Guidelines for API Documentation:**

### For API Endpoint Page Content Extraction
1. When calling \`extract_structured_data\` for indivisual API documentation pages, you should bring below intent and combine it to the \`query\` with what endpoint (page) you think it needs to extract the current browser page(endpoint) you'r focusing on:
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
  async *executeWithSSE(userRequest: string, maxSteps: number = 100, sessionId?: string, sendEvent?: (event: BrowserUseEvent) => void): AsyncGenerator<BrowserUseEvent, void, unknown> {
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
          message: 'Agent execution started'
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
        onStepEnd: this._createOnStepEndHandler(sessionId, sendEvent)
      };

      const request = `
${userRequest}

# Important Rules:
- This is "multi-step" task, you need to create a detailed plan with "todo.md" file before you start the task. Reference the <todo_file_management> section for the format of the "todo.md" file.
- Dynamically update the "todo.md" file with the new steps you need to take.
- Ignore **deprecated** endpoints, or endpoint pages with "strikethrough" line. Skip those pages, endpoint pages with "deprecated" text. Indicate this in the todo.md file in your plan as "skipped" with \`[x]\` flag as default.
- Reference the <additional_todo_definition_rules> for the additional rules to organize tasks into logical phases for API document content extraction task.
- Follow the <additional_todo_management_rules> to explore/navigate the page content and extract the API document content.
- **Prioritize Interaction over Visibility**: Before checking for visible content, you MUST first inspect elements for clear interactive roles or attributes. If an element has a WAI-ARIA role like role='option', role='tab', role='radio', role='presentation', or a state attribute like aria-expanded='false', you must prioritize **clicking** it. This action is necessary to ensure the corresponding view is fully loaded and active. This rule **overrides** the general rule of extracting data just because some content appears to be visible.
- When you think content can be extracted and before calling extract_structured_data, if there are buttons like 200, 201, 400, 500 and so on, please click them first(Regardless of whether the information for 200, 201, 400, 500, etc., is already displayed, please use the history to determine this and make sure to click it once.). Then, consider if there is any "default" related information (if so, be sure to click the "default" element), and then call extract_structured_data.

<additional_todo_management_rules>
CRITICAL Rules to organize tasks into logical phases:
- Organize tasks into the following logical phases. The todo.md should be structured with headings that reflect these phases.
  - **Discovery**: The first phase for navigation, locating the relevant API documentation sections, and revealing all the endpoints.
  - **Enumeration**: The phase for listing all relevant items. Create a single, comprehensive checklist. List every individual endpoint you need to process as a **numbered** checkbox item (e.g., \`1. [ ] Endpoint Name\`).
  - **Extraction**: The execution phase. Work through the checklist created during the Enumeration phase. As soon as you have extracted data for an endpoint, mark its corresponding checkbox from \`[ ]\` to \`[x]\` in that same list.
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
2. [ ] Locate "Tasks" section
3. [ ] Expand to reveal all endpoints

### Enumeration
1. [x] Archive a batch of tasks by ID
2. [-] Create a batch of tasks
3. [ ] Create a task
4. [ ] Update a task by ID

### Extraction
1. [x] Archive a batch of tasks by ID
2. [-] Create a batch of tasks
3. [ ] Create a task
4. [ ] Update a task by ID

### Verification
1. [ ] Confirm all listed endpoints are extracted

## Result
- Navigation complete.
- Enumeration in progress.
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
          finalPage: finalPageInfo
        },
        message: this.cancelled ? 'Agent execution cancelled' : 'Agent execution completed successfully'
      };
      if (sendEvent) sendEvent(completeEvent);
    } catch (error) {
      const errorEvent: BrowserUseEvent = {
        type: 'error',
        timestamp: new Date().toISOString(),
        session_id: sessionId || 'default',
        message: (error as Error).message,
        error: (error as Error).message
      };
      if (sendEvent) sendEvent(errorEvent);
    } finally {
      await this.cancel();
    }
  }

  /**
   * Create onStepStart handler
   */
  private _createOnStepStartHandler(sessionId?: string, sendEvent?: (event: BrowserUseEvent) => void) {
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

        // Create step event data matching Python format
        const stepData = {
          step: stepNumber,
          url: currentUrl,
          ...historyData,
          timestamp: new Date().toISOString(),
        };

        const event: BrowserUseEvent = {
          type: 'step_start',
          message: `Starting step ${stepNumber}`,
          timestamp: new Date().toISOString(),
          session_id: sessionId || 'default',
          data: stepData
        };
        if (sendEvent) sendEvent(event);
      } catch (error) {
        console.error('Error in step start hook:', error);
        const errorEvent: BrowserUseEvent = {
          type: 'error',
          message: `Error in step start hook: ${error}`,
          timestamp: new Date().toISOString(),
          session_id: sessionId || 'default',
          error: String(error)
        };
        if (sendEvent) sendEvent(errorEvent);
      }
    };
  }

  /**
   * Create onStepEnd handler
   */
  private _createOnStepEndHandler(sessionId?: string, sendEvent?: (event: BrowserUseEvent) => void) {
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
          data: stepData
        };
        if (sendEvent) sendEvent(event);
      } catch (error) {
        console.error('Error in step end hook:', error);
        const errorEvent: BrowserUseEvent = {
          type: 'error',
          message: `Error in step end hook: ${error}`,
          timestamp: new Date().toISOString(),
          session_id: sessionId || 'default',
          error: String(error)
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
        const thoughts = step.result?.metadata?.thoughts ||
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
        model_thoughts: model_thoughts.length > 0 ? model_thoughts[model_thoughts.length - 1] : null,
        model_outputs: model_outputs.length > 0 ? model_outputs[model_outputs.length - 1] : null,
        model_actions: model_actions.length > 0 ? model_actions[model_actions.length - 1] : null,
        extracted_content: extracted_contents.length > 0 ? extracted_contents[extracted_contents.length - 1] : null,
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
      timestamp: Date.now()
    };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const browserUseAgent = new BrowserUseSSEAgent();

  const timestamp = new Date().toISOString();
  const request = {
  hubspot: {
    url: 'https://developers.hubspot.com/docs/reference/api/crm/objects/tickets',
    text: `Extract the entire original API documentation content for the List Tickets API from this page: https://developers.hubspot.com/docs/reference/api/crm/objects/tickets. You must extract all available details required for OpenAPI Spec, including endpoints, HTTP methods, versioning, baseApiUrl, auth requirements, request parameters, request body schema, response codes, bodies, and error responses. Preserve exact wording from the source.`,
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

  const generator = browserUseAgent.executeWithSSE(request.text, 100, timestamp);
  // Consume the async generator
  (async () => {
    try {
      for await (const event of generator) {
        console.log('Event:', event);
      }
    } catch (error) {
      console.error('Error:', error);
    }
  })();
}
