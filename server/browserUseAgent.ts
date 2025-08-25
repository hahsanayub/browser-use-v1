/* eslint-disable @typescript-eslint/no-unused-vars */
import 'dotenv/config';
import {
  ActionResult,
  Agent,
  BaseLLMClient,
  createController,
  type AgentConfig,
} from '../src/index';
import { withHealthCheck } from '../src/services/health-check';
import { z } from 'zod';
import { Page } from 'playwright';
import { BrowserSession } from '../src/browser';
import type { BrowserContext as AgentBrowserContext } from '../src/browser/BrowserContext';
import { action } from '../src/controller/decorators';
import TurndownService from 'turndown';
import * as path from 'path';
import { promises as fs } from 'fs';
import { FileSystem } from '../src/services/file-system';
import { PromptConfig } from './promptConfig';

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

// SSE-specific types and interfaces
export interface AgentConfigSSE extends AgentConfig {
  sessionId?: string;
}

// Global session registry for managing active sessions
const sessionRegistry = new Map<string, BrowserUseSSEAgent>();

// Simplified SSE Agent class focused on core functionality
export class BrowserUseSSEAgent {
  private cancelled = false;
  private controller?: any;
  private sessionId?: string;

  constructor(sessionId?: string) {
    this.sessionId = sessionId;

    // Register session if sessionId is provided
    if (sessionId) {
      sessionRegistry.set(sessionId, this);
    }
  }

  /**
   * Cancel the current agent execution
   */
  cancel(): void {
    this.cancelled = true;
  }

  /**
   * Cleanup agent resources
   */
  async cleanup(): Promise<void> {
    try {
      // Cancel any ongoing execution
      this.cancel();

      // Cleanup controller if exists
      if (this.controller) {
        await this.controller.cleanup();
        this.controller = null;
      }

      // Remove from session registry
      if (this.sessionId) {
        sessionRegistry.delete(this.sessionId);
      }
    } catch (error) {
      console.warn('Error during cleanup:', error);
    }
  }

  /**
   * Execute agent with SSE event streaming (simplified)
   */
  async *executeWithSSE(userRequest: string, maxSteps: number = 100, sessionId?: string, sendEvent?: (event: BrowserUseEvent) => void): AsyncGenerator<BrowserUseEvent, void, unknown> {
    const currentSessionId = sessionId || this.sessionId || 'default';

    try {
      // Register SSE event sender if provided
      if (sendEvent) {
        setGlobalSSEEventSender(sendEvent);
      }

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
            timeout: 60000,
            maxTokens: 16384,
          },
          browser: {
            headless: true,
            browserType: 'chromium',
            viewport: { width: 1440, height: 900 },
            timeout: 45000,
            args: [],
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
          session_id: sessionId || this.sessionId || 'default',
          message: 'Agent execution started'
        };
      if (sendEvent) sendEvent(startEvent);

      // Enhanced agent config with SSE event handling
      const enhancedConfig: AgentConfig = {
        useVision: true,
        maxSteps: maxSteps,
        actionTimeout: 15000,
        continueOnFailure: true,
        useThinking: true,
        customInstructions: promptConfig.extendPromptMessage,
        saveConversationPath: `projects/${sessionId || this.sessionId || 'default'}/conversations`,
        fileSystemPath: `projects/${sessionId || this.sessionId || 'default'}`,
        onStepStart: async (agent: Agent) => {
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
              session_id: sessionId || this.sessionId || 'default',
              data: stepData
            };
            if (sendEvent) sendEvent(event);
          } catch (error) {
            console.error('Error in step start hook:', error);
            const errorEvent: BrowserUseEvent = {
              type: 'error',
              message: `Error in step start hook: ${error}`,
              timestamp: new Date().toISOString(),
              session_id: sessionId || this.sessionId || 'default',
              error: String(error)
            };
            if (sendEvent) sendEvent(errorEvent);
          }
        },
        onStepEnd: async (agent: Agent) => {
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
              session_id: sessionId || this.sessionId || 'default',
              data: stepData
            };
            if (sendEvent) sendEvent(event);
          } catch (error) {
            console.error('Error in step end hook:', error);
            const errorEvent: BrowserUseEvent = {
              type: 'error',
              message: `Error in step end hook: ${error}`,
              timestamp: new Date().toISOString(),
              session_id: sessionId || this.sessionId || 'default',
              error: String(error)
            };
            if (sendEvent) sendEvent(errorEvent);
          }
        }
      };

      const request = `
${userRequest}

# Important Rules:
- This is "multi-step" task, you need to create a detailed plan with "todo.md" file before you start the task. Reference the <todo_file_management> section for the format of the "todo.md" file.
- Dynamically update the "todo.md" file with the new steps you need to take.
- Reference the <additional_todo_definition_rules> for the additional rules to organize tasks into logical phases for API document content extraction task.
- Follow the <additional_todo_management_rules> to explore/navigate the page content and extract the API document content.
- **Prioritize Interaction over Visibility**: Before checking for visible content, you MUST first inspect elements for clear interactive roles or attributes. If an element has a WAI-ARIA role like role='option', role='tab', role='radio', role='presentation', or a state attribute like aria-expanded='false', you must prioritize **clicking** it. This action is necessary to ensure the corresponding view is fully loaded and active. This rule **overrides** the general rule of extracting data just because some content appears to be visible.
- When you think content can be extracted and before calling extract_api_document_structured_data, if there are buttons like 200, 400, 500 and so on, please click them first(Regardless of whether the information for 200, 400, 500, etc., is already displayed, please use the history to determine this and make sure to click it once.). Then, consider if there is any "default" related information (if so, be sure to click the "default" element), and then call extract_structured_data.

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
        session_id: sessionId || this.sessionId || 'default',
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
        session_id: sessionId || this.sessionId || 'default',
        message: (error as Error).message,
        error: (error as Error).message
      };
      if (sendEvent) sendEvent(errorEvent);
    } finally {
      // Disconnect SSE connection
      if (globalSSEEventSender) {
        clearGlobalSSEEventSender();
      }

      // Cleanup
      if (this.controller) {
        try {
          await this.controller.cleanup();
        } catch (error) {
          console.warn('Error during cleanup:', error);
        }
      }

      // Remove from session registry
      if (this.sessionId) {
        sessionRegistry.delete(this.sessionId);
      }
    }
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
        urls: [...new Set(urls)], // Remove duplicates
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
   * Static method to get active sessions
   */
  static getActiveSessions(): Array<{ sessionId: string; status: any }> {
    const sessions: Array<{ sessionId: string; status: any }> = [];
    for (const [sessionId, agent] of sessionRegistry.entries()) {
      sessions.push({
        sessionId,
        status: agent.getStatus()
      });
    }
    return sessions;
  }

  /**
   * Static method to cancel a session
   */
  static cancelSession(sessionId: string): boolean {
    const agent = sessionRegistry.get(sessionId);
    if (agent) {
      agent.cancel();
      return true;
    }
    return false;
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

// Session management functions
export function getSession(sessionId: string): BrowserUseSSEAgent | undefined {
  return sessionRegistry.get(sessionId);
}

export function getAllSessions(): Array<{ sessionId: string; status: any }> {
  return BrowserUseSSEAgent.getActiveSessions();
}

export function cancelSession(sessionId: string): boolean {
  return BrowserUseSSEAgent.cancelSession(sessionId);
}

// Export event type for better type safety
export interface BrowserUseEvent {
  type: string;
  session_id: string;
  timestamp?: string;
  step?: number;
  data?: any;
  message?: string;
  error?: string;
  url?: string;
  history?: any[];
  screenshot?: string;
}

// Initialize PromptConfig instance
const promptConfig = new PromptConfig();

if (import.meta.url === `file://${process.argv[1]}`) {
  // For testing purposes, you can create an SSE agent and test executeWithSSE
  const agent = new BrowserUseSSEAgent('test-session');
  // agent.executeWithSSE('Extract all API endpoints from the documentation', 100, 'test-session');
}
