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
        agent: {
          useVision: true, // Enable vision capabilities
          visionDetailLevel: 'high',
          maxSteps: 5,
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
      'Take a screenshot and describe what you can see on this Wikipedia homepage. Focus on the main visual elements, layout, and any prominent images or graphics.'
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
