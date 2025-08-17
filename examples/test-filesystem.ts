/**
 * Test script to verify FileSystem functionality
 */

import { Controller } from '../src/controller/Controller';
import { chromium } from 'playwright';

async function testFileSystem() {
  console.log('🚀 Testing FileSystem functionality...');

  const controller = new Controller({
    config: {
      browser: {
        headless: true,
      },
      llm: {
        provider: 'anthropic',
        apiKey: process.env.ANTHROPIC_API_KEY || 'test',
      },
    },
    // Disable signal handlers to allow process to exit naturally
    setupSignalHandlers: false,
  });

  try {
    await controller.initialize();
    await controller.initializeBrowser();

    // Get agent with file system configuration
    const agent = await controller.getAgent({
      fileSystemPath: './test-fs',
      maxSteps: 5,
    });

    console.log('✅ Agent created with FileSystem');

    // Test file system operations through actions
    console.log('📝 Testing file operations...');

    // Test write_file
    const writeResult = await controller.act('write_file', {
      filename: 'test.md',
      content: '# Test File\n\nThis is a test file created by the Agent FileSystem.',
    });
    console.log('Write result:', writeResult);

    // Test read_file
    const readResult = await controller.act('read_file', {
      filename: 'test.md',
    });
    console.log('Read result:', readResult);

    // Test list_files
    const listResult = await controller.act('list_files', {});
    console.log('List result:', listResult);

    // Test append_file
    const appendResult = await controller.act('append_file', {
      filename: 'test.md',
      content: '\n\n## Appended Content\n\nThis content was appended.',
    });
    console.log('Append result:', appendResult);

    // Test replace_file_str
    const replaceResult = await controller.act('replace_file_str', {
      filename: 'test.md',
      old_str: 'Test File',
      new_str: 'Updated Test File',
    });
    console.log('Replace result:', replaceResult);

    // Test the FileSystem directly
    const fileSystem = agent.getFileSystem();
    if (fileSystem) {
      console.log('📋 FileSystem description:');
      console.log(fileSystem.describe());

      console.log('📝 Todo contents:');
      console.log(fileSystem.getTodoContents());
    }

    console.log('✅ All FileSystem tests completed successfully!');

  } catch (error) {
    console.error('❌ Error during testing:', error);
    process.exit(1);
  } finally {
    await controller.cleanup();
    console.log('🧹 Cleanup completed, exiting...');
    process.exit(0);
  }
}

// Run the test
if (import.meta.url === `file://${process.argv[1]}`) {
  testFileSystem().catch((error) => {
    console.error('❌ Unhandled error in testFileSystem:', error);
    process.exit(1);
  });
}

export { testFileSystem };
