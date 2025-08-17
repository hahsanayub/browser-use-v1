/**
 * Example demonstrating the enhanced browser configuration system
 */

import { Browser } from '../src/browser/Browser';
import {
  getPreset,
  createCustomConfig,
  OPTIMIZED_PRESET,
  STEALTH_PRESET,
  getSystemInfo,
} from '../src/browser/profiles';
import type { BrowserConfig } from '../src/types/browser';

async function basicUsageExample() {
  console.log('=== Basic Usage Example ===');

  // Simple configuration with optimization
  const basicConfig: BrowserConfig = {
    browserType: 'chromium',
    headless: true,
    useOptimizedArgs: true,
    enableDefaultExtensions: true,
  };

  const browser = new Browser(basicConfig);
  await browser.launch();

  console.log('Browser launched with optimized settings');
  console.log('Profile info:', browser.getProfile());

  await browser.close();
}

async function presetUsageExample() {
  console.log('\n=== Preset Usage Example ===');

  // Using presets for common configurations
  const optimizedConfig = getPreset('optimized');
  const stealthConfig = getPreset('stealth');

  console.log('Optimized preset:', optimizedConfig);

  // Custom configuration based on preset
  const customConfig = createCustomConfig('production', {
    headless: false,
    windowSize: { width: 1920, height: 1080 },
    keepAlive: true,
  });

  console.log('Custom production config:', customConfig);
}

async function extensionExample() {
  console.log('\n=== Extension Example ===');

  const configWithExtensions: BrowserConfig = {
    ...OPTIMIZED_PRESET,
    enableDefaultExtensions: true,
    customExtensions: [
      {
        id: 'some-extension-id',
        name: 'Custom Extension',
        enabled: true,
      },
      {
        path: '/path/to/local/extension',
        name: 'Local Extension',
        enabled: true,
      },
    ],
  };

  const browser = new Browser(configWithExtensions);
  await browser.launch();

  console.log('Browser launched with extensions');

  await browser.close();
}

async function environmentDetectionExample() {
  console.log('\n=== Environment Detection Example ===');

  const systemInfo = getSystemInfo();
  console.log('System info:', systemInfo);

  // Configuration that adapts to environment
  const adaptiveConfig: BrowserConfig = {
    browserType: 'chromium',
    useOptimizedArgs: true,
    enableStealth: systemInfo.isDocker, // Enable stealth in Docker
    enableDefaultExtensions: !systemInfo.isDocker, // Skip extensions in Docker
    // headless will be auto-detected based on display availability
  };

  const browser = new Browser(adaptiveConfig);
  await browser.launch();

  const profile = browser.getProfile();
  console.log('Auto-detected headless mode:', profile?.headless);
  console.log('Arguments count:', profile?.args.length);

  await browser.close();
}

async function stealthModeExample() {
  console.log('\n=== Stealth Mode Example ===');

  const stealthConfig: BrowserConfig = {
    ...STEALTH_PRESET,
    headless: false, // Show browser for demonstration
    windowSize: { width: 1280, height: 800 },
  };

  const browser = new Browser(stealthConfig);
  await browser.launch();

  const profile = browser.getProfile();
  console.log('Stealth mode enabled with', profile?.args.length, 'arguments');

  // The browser will now have:
  // - Anti-detection measures
  // - Ad blockers and cookie handlers
  // - Optimized automation arguments

  await browser.close();
}

async function testingConfigExample() {
  console.log('\n=== Testing Configuration Example ===');

  const testConfig = createCustomConfig('testing', {
    headless: true,
    enableDeterministicRendering: true,
    disableSecurity: true,
  });

  const browser = new Browser(testConfig);
  await browser.launch();

  console.log(
    'Testing browser launched with deterministic rendering and disabled security'
  );

  await browser.close();
}

// Run all examples
async function main() {
  try {
    await basicUsageExample();
    await presetUsageExample();
    await extensionExample();
    await environmentDetectionExample();
    await stealthModeExample();
    await testingConfigExample();

    console.log('\n=== All examples completed successfully! ===');
  } catch (error) {
    console.error('Example failed:', error);
  }
}

if (require.main === module) {
  main().catch(console.error);
}

export {
  basicUsageExample,
  presetUsageExample,
  extensionExample,
  environmentDetectionExample,
  stealthModeExample,
  testingConfigExample,
};
