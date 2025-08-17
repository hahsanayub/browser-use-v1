/**
 * Test example for multimodal/vision capabilities
 */

import { Controller } from '../src/controller/Controller';

async function testVisionCapabilities() {
  try {
    console.log('🚀 Testing multimodal/vision capabilities...');

    // Initialize controller with vision enabled
    const controller = new Controller({
      config: {
        browser: {
          browserType: 'chromium',
          headless: false, // Show browser for visual verification
          userDataDir: './test-data',
        },
        llm: {
          provider: 'google',
          model: 'gemini-2.0-flash',
          baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
          apiKey: process.env.GOOGLE_API_KEY,
        },
      },
    });

    await controller.initialize();

    console.log('🌍 Navigating to a visually rich website...');
    await controller.goto('https://www.wikipedia.org');

    console.log('🤖 Running agent with vision enabled...');
    const history = await controller.run(
      'Take a screenshot and describe what you can see on this Wikipedia homepage. Focus on the main visual elements, layout, and any prominent images or graphics.',
      {
        useVision: true, // Enable vision capabilities
        visionDetailLevel: 'high',
        maxSteps: 5,
      }
    );

    console.log('📊 Agent execution completed!');
    console.log(`Total steps: ${history.length}`);

    // Check if screenshots were captured
    const agent = (controller as any).agent;
    if (agent && agent.screenshotService) {
      const screenshots = await agent.screenshotService.listScreenshots();
      console.log(`📸 Screenshots captured: ${screenshots.length}`);

      for (const screenshot of screenshots) {
        console.log(
          `  - Step ${screenshot.stepNumber}: ${screenshot.filePath} (${Math.round(screenshot.fileSize / 1024)}KB)`
        );
      }
    }

    // Test placeholder screenshot functionality
    console.log('\n🧪 Testing placeholder screenshot for about:blank...');
    await controller.goto('about:blank');

    const placeholderTestHistory = await controller.run(
      'This is a test of placeholder screenshot functionality for about:blank pages.',
      {
        useVision: true,
        visionDetailLevel: 'high',
        maxSteps: 3,
      }
    );

    console.log(
      `📊 Placeholder test completed! Total steps: ${placeholderTestHistory.length}`
    );

    // Check if placeholder screenshots were handled correctly
    if (agent && agent.screenshotService) {
      const allScreenshots = await agent.screenshotService.listScreenshots();
      console.log(
        `📸 Total screenshots after placeholder test: ${allScreenshots.length}`
      );

      // Verify that placeholder screenshots are not stored to disk
      // (they should only be used in memory for LLM messages)
      const expectedScreenshotCount = 1; // Only the Wikipedia screenshot should be stored
      if (allScreenshots.length === expectedScreenshotCount) {
        console.log('✅ Placeholder screenshot correctly not stored to disk');
      } else {
        console.log(
          `⚠️ Unexpected screenshot count: ${allScreenshots.length} (expected ${expectedScreenshotCount})`
        );
      }
    }

    await controller.cleanup();
    console.log('✅ Vision test completed successfully!');
  } catch (error) {
    console.error('❌ Vision test failed:', error);
    process.exit(1);
  }
}

// Run the test if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  testVisionCapabilities().catch(console.error);
}

export { testVisionCapabilities };
