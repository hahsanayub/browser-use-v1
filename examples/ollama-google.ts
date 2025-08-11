/**
 * Example: Use Ollama (qwen3-coder) to open Google, search "openai",
 * click the first result, and open the linked page.
 */

import { createController, type AgentConfig } from '../src/index.js';

async function main() {
  const controller = await createController({
    config: {
      llm: {
        provider: 'ollama',
        model: 'qwen3-coder',
        baseUrl: 'http://localhost:11434',
        timeout: 60000,
        maxTokens: 1024 * 1024,
        temperature: 0.7,
      },
      browser: {
        headless: false,
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
    await controller.goto('https://www.google.com');

    const agentConfig: AgentConfig = {
      maxSteps: 40,
      actionTimeout: 15000,
      continueOnFailure: true,
      customInstructions:
        'Use the search input to search for "openai". Click the first real search result (not an ad). Wait for the new page to fully load, then take a screenshot and finish.',
    };

    const history = await controller.run(
      'On Google, search for "openai" and open the first non-ad result. After navigation, wait for content to load, take a screenshot, and finish.',
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
    console.error('Ollama Google example failed:', error);
  } finally {
    await controller.cleanup();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
