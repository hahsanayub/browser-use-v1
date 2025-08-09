/**
 * Advanced example showing more control over the browser-use components
 */

import {
  createController,
  Controller,
  type AgentConfig
} from '../src/index.js';

async function advancedExample() {
  // Create controller with custom configuration
  const controller = await createController({
    config: {
      llm: {
        provider: 'openai',
        apiKey: process.env.OPENAI_API_KEY!,
        model: 'gpt-4',
        temperature: 0.1,
      },
      browser: {
        headless: false,
        browserType: 'chromium',
        viewport: { width: 1920, height: 1080 },
      },
      logging: {
        level: 'debug',
        console: true,
      },
    },
  });

  try {
    // Navigate to a starting page
    await controller.goto('https://example.com');

    // Configure agent behavior
    const agentConfig: AgentConfig = {
      maxSteps: 50,
      actionTimeout: 10000,
      continueOnFailure: true,
      customInstructions: `
        Be extra careful when interacting with forms.
        Always verify that actions were successful before proceeding.
        Take screenshots when something unexpected happens.
      `,
    };

    // Run multiple tasks
    const tasks = [
      'Take a screenshot of the current page',
      'Find and click on any links on the page',
      'Navigate back to the original page',
    ];

    for (const task of tasks) {
      console.log(`\nExecuting task: ${task}`);

      const history = await controller.run(task, agentConfig);

      console.log(`Task completed in ${history.length} steps`);

      // Add delay between tasks
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    // Get final page information
    const browserContext = controller.getBrowserContext();
    const activePage = browserContext?.getActivePage();

    if (activePage) {
      const url = activePage.url();
      const title = await activePage.title();
      console.log(`\nFinal page: ${title} (${url})`);
    }

  } catch (error) {
    console.error('Advanced example failed:', error);
  } finally {
    // Always cleanup
    await controller.cleanup();
  }
}

// Run if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  advancedExample();
}
