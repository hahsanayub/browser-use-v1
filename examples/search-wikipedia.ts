import 'dotenv/config';
import { createController, type AgentConfig } from '../src/index.js';

const timestamp = new Date().toISOString();

async function main() {
  const controller = await createController({
    config: {
      llm: {
        provider: 'google',
        model: 'gemini-2.0-flash',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: process.env.GOOGLE_API_KEY,
        timeout: 60000,
        maxTokens: 1024 * 1024,
        temperature: 0.7,
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
      maxSteps: 7,
      actionTimeout: 15000,
      continueOnFailure: true,
      customInstructions:
        'Use the search input to search with keywords. Click the first real search result (not an ad). Wait for the new page to fully load, then get the content of the page.',
      saveConversationPath: `logs/${timestamp}/conversations`,
      fileSystemPath: `logs/${timestamp}`,
    };

    const history = await controller.run(
      "On Wikipedia, search for 'TDD' and open the first non-ad result. After navigation, wait for content to load, scroll to the bottom of the page, summarize the content, and finish.",
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
