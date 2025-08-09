/**
 * Simple example demonstrating browser automation with browser-use
 */

import { run } from '../src/index.js';

async function main() {
  try {
    console.log('Starting browser automation example...');

    // Run a simple search task
    const { controller, history } = await run(
      'Go to google.com and search for "TypeScript browser automation"',
      {
        llmApiKey: process.env.OPENAI_API_KEY,
        llmProvider: 'openai',
        headless: false, // Set to true for headless mode
        startUrl: 'https://google.com'
      }
    );

    console.log('Task completed!');
    console.log(`Executed ${history.length} steps:`);

    history.forEach((step, index) => {
      console.log(`${index + 1}. ${step.action.action}: ${step.result.message}`);
    });

    // Cleanup
    await controller.cleanup();

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

// Run if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
