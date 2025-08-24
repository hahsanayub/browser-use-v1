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
import { PromptConfig } from './prompt_config';

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

export class ExtractDataActions {
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
        // Send trace event for extraction start
        await ExtractDataActions.sendTraceEvent({
          type: 'extraction_start',
          url: p.url(),
          query,
          timestamp: Date.now(),
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

        // Save raw HTML content (like Python version)
        const pageIndex = context.fileSystem?.getExtractedContentCount() || 0;
        if (context.fileSystem) {
          try {
            const rawHtmlFileName = `extracted_content_${pageIndex}.raw.html`;
            const rawHtmlFilePath = path.join(context.fileSystem.getDir(), rawHtmlFileName);
            await fs.writeFile(rawHtmlFilePath, pageHtml, 'utf-8');
            console.log(`Saved raw HTML to ${rawHtmlFilePath}`);
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
              const rawPromptFileName = `extracted_content_${pageIndex}.prompt.raw.md`;
              const rawPromptFilePath = path.join(context.fileSystem.getDir(), rawPromptFileName);
              await fs.writeFile(rawPromptFilePath, prompt, 'utf-8');
              console.log(`Saved raw prompt to ${rawPromptFilePath}`);
            } catch (error) {
              console.warn('Failed to save raw prompt:', error);
            }
          }

          // Send trace event for LLM call
          await ExtractDataActions.sendTraceEvent({
            type: 'llm_call_start',
            contentLength: content.length,
            timestamp: Date.now(),
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
            context
          );
        } else {
          // Large content - use chunking
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

            await ExtractDataActions.sendTraceEvent({
              type: 'chunk_processing',
              chunkIndex: i + 1,
              totalChunks: chunks.length,
              chunkLength: chunk.length,
              timestamp: Date.now(),
            });

            // Save individual chunk prompt (like Python version)
            if (context.fileSystem) {
              try {
                const chunkPromptFileName = `extracted_content_${pageIndex}.chunk_${i + 1}.prompt.raw.md`;
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

          // Save individual chunks content (like Python version)
          if (context.fileSystem) {
            try {
              let chunksContent = `Combined results from ${chunks.length} chunks:\n\n`;
              for (let i = 0; i < chunkResponses.length; i++) {
                chunksContent += `--- Chunk ${i + 1} ---\n${chunkResponses[i]}\n\n`;
              }

              const chunksFileName = `extracted_content_${pageIndex}.chunks.md`;
              const chunksFilePath = path.join(context.fileSystem.getDir(), chunksFileName);
              await fs.writeFile(chunksFilePath, chunksContent, 'utf-8');
              console.log(`Saved chunks result to ${chunksFilePath}`);
            } catch (error) {
              console.warn('Failed to save chunks result:', error);
            }
          }

          // Merge chunk responses
          await ExtractDataActions.sendTraceEvent({
            type: 'merging_start',
            chunkCount: chunkResponses.length,
            timestamp: Date.now(),
          });

          const mergedResponse = await ExtractDataActions.mergeChunkResponses(
            chunkResponses,
            context.llmClient!
          );

          // Save final merged result (like Python version)
          if (context.fileSystem) {
            try {
              const mergedFileName = `extracted_content_${pageIndex}.md`;
              const mergedFilePath = path.join(context.fileSystem.getDir(), mergedFileName);
              const mergedContent = `# Merged Chunk Processing Results\n\nTotal chunks: ${chunkResponses.length}\nQuery: ${query}\n\n## Merged Response:\n${mergedResponse}`;
              await fs.writeFile(mergedFilePath, mergedContent, 'utf-8');
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
            context
          );
        }
      } catch (error) {
        await ExtractDataActions.sendTraceEvent({
          type: 'extraction_error',
          error: (error as Error).message,
          timestamp: Date.now(),
        });

        return {
          success: false,
          message: `Failed to extract structured data: ${(error as Error).message}`,
          error: (error as Error).message,
        };
      }
    });
  }

  /**
   * Read extraction prompt from file
   */
  private static readExtractionPrompt(): string {
    try {
      const promptPath = path.join(__dirname, '..', '..', 'extraction_prompt.md');
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
    endpointName?: string
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

        const endpointNameInfo = endpointName ? `\n<endpoint_extracted>${endpointName}</endpoint_extracted>` : '';
        message = `Extracted content from ${url}\n<query>${query}\n</query>\n<extracted_content>\n${display}${lines.length - displayLinesCount} more lines...\n</extracted_content>\n<file_system>File saved at: extracted_content_${pageIndex}.md</file_system>${endpointNameInfo}`;

        // Append to todo.md (matching Python version)
        if (endpointName && context.fileSystem) {
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
            todoContent += `\n## Extraction Record\n\t- [x] Explored endpoint: ${endpointName}\n`;
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

// Initialize PromptConfig instance
const promptConfig = new PromptConfig();

export async function execute(userRequest: string, sessionId: string) {
  const request = `
${userRequest}

# Important Rules:
- This is "multi-step" task, you need to create a plan with "todo.md" and execute it step by step. Dynamically update the "todo.md" file with the new steps you need to take. Reference the <todo_definition> section for the format of the "todo.md" file.
- You must write down the endpoints you identified and what pages you need to browse and extract the API document content in the "todo.md" file.
- NEVER click on elements with "+", "-", "▼", "▲" symbols in "Response samples"/"Requeset samples" sections
- NEVER interact with any UI controls in sample/example sections
- Ignore all "Copy", "Expand", "Collapse" buttons in sample areas
`;
  const controller = await createController({
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
      maxSteps: 100,
    },
  });

  try {
    // await controller.goto(targetUrl);

    const agentConfig: AgentConfig = {
      useVision: true,
      maxSteps: 100,
      actionTimeout: 15000,
      continueOnFailure: true,
      useThinking: true,
      customInstructions: promptConfig.extendPromptMessage,
      saveConversationPath: `projects/${sessionId}/conversations`,
      fileSystemPath: `projects/${sessionId}`,
    };

    const history = await controller.run(request, agentConfig);

    const browserContext = controller.getBrowserContext();
    const page = browserContext?.getActivePage();
    if (page) {
      const title = await page.title();
      const url = page.url();
      console.log(`Final page: ${title} (${url})`);
    }

    console.log(`Steps executed: ${history.length}`);
  } catch (error) {
    console.error('example failed:', error);
  } finally {
    await controller.cleanup();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  execute('Extract all API endpoints from the documentation', 'default');
}
