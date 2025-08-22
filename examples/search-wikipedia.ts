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
    console.log('extractStructuredData', params);
    // const { query, extract_links } = params;

    if (!context.llmClient) {
      return {
        success: false,
        message: 'LLM client not available',
        error: 'LLM_CLIENT_UNAVAILABLE',
      };
    }

    return withHealthCheck(page, async (p) => {
      return {
        success: true,
        message: 'Extracted structured data',
        attachments: [],
      };
    });
  }
}

const timestamp = new Date().toISOString();

async function main() {
  const controller = await createController({
    config: {
      llm: {
        provider: 'google',
        model: 'gemini-2.0-flash',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: process.env.GOOGLE_API_KEY,

        // provider: 'azure',
        // model: 'gpt-5',
        // azureEndpoint: 'https://oai-ai4m-rnd-eastus-001.openai.azure.com',
        // azureDeployment: 'oai-ai4m-rnd-eastus-001-gpt-4-0125-Preview-001',
        // apiVersion: '2025-03-01-preview',
        // apiKey: process.env.AZURE_OPENAI_API_KEY,

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
      maxSteps: 60,
    },
  });

  try {
    await controller.goto('https://www.wikipedia.org/');

    const agentConfig: AgentConfig = {
      useVision: true,
      maxSteps: 10,
      actionTimeout: 15000,
      continueOnFailure: true,
      customInstructions:
        'Use the search input to search with keywords. Click the first real search result (not an ad). Wait for the new page to fully load, then get the content of the page.',
      saveConversationPath: `logs/${timestamp}/conversations`,
      fileSystemPath: `logs/${timestamp}`,
    };

    const history = await controller.run(
      "On Wikipedia, search for 'TDD' and open the first non-ad result. After navigation, wait for content to load, summarize the content, and finish.",
      agentConfig
    );

    const browserContext = controller.getBrowserContext();
    const page = browserContext?.getActivePage();
    if (page) {
      const title = await page.title();
      const url = page.url();
      console.log(`Final page: ${title} (${url})`);
    }

    console.log(`Steps executed: ${history.length}`);
  } catch (error) {
    console.error('Wikipedia example failed:', error);
  } finally {
    await controller.cleanup();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
