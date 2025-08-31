import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLogger } from '../src/services/logging';
import { SimplifiedVisualizationService } from '../src/services/visualization-service-simple';
import type { AgentHistory } from '../src/types/agent';
import fs from 'fs/promises';

// Initialize logger for testing
initializeLogger({ level: 'error', console: false, json: false });

describe('SimplifiedVisualizationService', () => {
  let visualizationService: SimplifiedVisualizationService;

  beforeAll(async () => {
    visualizationService = new SimplifiedVisualizationService();
  });

  describe('Unicode Text Rendering', () => {
    it('should decode simple unicode escapes', () => {
      const result = visualizationService.decodeUnicodeEscapes(
        'Hello \\u4e2d\\u6587 World'
      );
      expect(result).toBe('Hello 中文 World');
    });

    it('should decode unicode escapes in mixed text', () => {
      const result = visualizationService.decodeUnicodeEscapes(
        'Test \\u0041\\u0042\\u0043 123'
      );
      expect(result).toBe('Test ABC 123');
    });

    it('should handle text without unicode escapes', () => {
      const result = visualizationService.decodeUnicodeEscapes(
        'Regular text without escapes'
      );
      expect(result).toBe('Regular text without escapes');
    });

    it('should handle arabic text', () => {
      const result = visualizationService.decodeUnicodeEscapes(
        '\\u0645\\u0631\\u062d\\u0628\\u0627'
      );
      expect(result).toBe('مرحبا');
    });

    it('should handle chinese text', () => {
      const result = visualizationService.decodeUnicodeEscapes(
        '\\u4f60\\u597d\\u4e16\\u754c'
      );
      expect(result).toBe('你好世界');
    });

    it('should handle emoji unicode escapes', () => {
      const result = visualizationService.decodeUnicodeEscapes(
        'Hello \\ud83d\\ude00 World'
      );
      expect(result).toBe('Hello 😀 World');
    });

    it('should handle invalid unicode escapes gracefully', () => {
      const result = visualizationService.decodeUnicodeEscapes(
        'Invalid \\uXYZ escape'
      );
      expect(result).toBe('Invalid \\uXYZ escape');
    });
  });

  describe('Visualization Generation', () => {
    it('should handle empty history gracefully', async () => {
      const result = await visualizationService.createHistoryVisualization(
        'Test task',
        []
      );
      expect(result).toBe('agent_history.html');
    });

    it('should create visualization for single screenshot', async () => {
      // Create a minimal base64 image (1x1 white pixel)
      const whitePixel =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChAI9jU77mgAAAABJRU5ErkJggg==';

      const mockHistory: AgentHistory[] = [
        {
          step: 1,
          action: { action: 'click', index: 1 },
          result: { success: true, message: 'Clicked element' },
          timestamp: Date.now(),
          state: {
            screenshot: whitePixel,
          },
          model_output: {
            current_state: {
              next_goal: 'Test goal with Unicode: 测试中文目标 \\u4e2d\\u6587',
            },
          },
        },
      ];

      const outputPath = './test_output/single_screenshot.html';
      const result = await visualizationService.createHistoryVisualization(
        'Test task: 创建可视化测试 \\u521b\\u5efa\\u53ef\\u89c6\\u5316\\u6d4b\\u8bd5',
        mockHistory,
        { outputPath }
      );

      expect(result).toBe(outputPath);

      // Check if HTML file was created
      try {
        const stats = await fs.stat(outputPath);
        expect(stats.isFile()).toBe(true);

        const htmlContent = await fs.readFile(outputPath, 'utf-8');
        expect(htmlContent).toContain('Agent History Visualization');
        expect(htmlContent).toContain('Test task');
        expect(htmlContent).toContain('创建可视化测试');
        expect(htmlContent).toContain('测试中文目标');
        expect(htmlContent).toContain('data:image/png;base64,' + whitePixel);

        // Clean up
        await fs.unlink(outputPath);
      } catch (error) {
        console.log('HTML file creation test failed:', error);
      }
    });

    it('should create visualization for multiple screenshots with Unicode goals', async () => {
      // Create multiple test screenshots
      const whitePixel =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChAI9jU77mgAAAABJRU5ErkJggg==';
      const blackPixel =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

      const mockHistory: AgentHistory[] = [
        {
          step: 1,
          action: { action: 'click', index: 1 },
          result: { success: true, message: 'Clicked element' },
          timestamp: Date.now(),
          state: { screenshot: whitePixel },
          model_output: {
            current_state: {
              next_goal:
                'First goal 第一个目标 \\u7b2c\\u4e00\\u4e2a\\u76ee\\u6807',
            },
          },
        },
        {
          step: 2,
          action: { action: 'input_text', text: 'Hello' },
          result: { success: true, message: 'Input text' },
          timestamp: Date.now(),
          state: { screenshot: blackPixel },
          model_output: {
            current_state: {
              next_goal:
                'Second goal 第二个目标 with Arabic: \\u0645\\u0631\\u062d\\u0628\\u0627',
            },
          },
        },
        {
          step: 3,
          action: { action: 'navigate', url: 'https://example.com' },
          result: { success: true, message: 'Navigated' },
          timestamp: Date.now(),
          state: { screenshot: whitePixel },
          model_output: {
            current_state: {
              next_goal: 'Final goal 最终目标 \\u6700\\u7ec8\\u76ee\\u6807',
            },
          },
        },
      ];

      const outputPath = './test_output/multi_screenshot.html';

      // Create output directory
      await fs.mkdir('./test_output', { recursive: true });

      try {
        const result = await visualizationService.createHistoryVisualization(
          'Multi-step task: 多步骤任务 \\u591a\\u6b65\\u9aa4\\u4efb\\u52a1',
          mockHistory,
          {
            outputPath,
            showGoals: true,
            showTask: true,
            duration: 1500,
          }
        );

        expect(result).toBe(outputPath);

        // Check if HTML file was created and contains expected content
        const htmlStats = await fs.stat(outputPath);
        expect(htmlStats.isFile()).toBe(true);

        const htmlContent = await fs.readFile(outputPath, 'utf-8');

        // Check basic structure
        expect(htmlContent).toContain('Agent History Visualization');
        expect(htmlContent).toContain('Multi-step task');
        expect(htmlContent).toContain('多步骤任务');

        // Check that Unicode was decoded properly
        expect(htmlContent).toContain('第一个目标');
        expect(htmlContent).toContain('مرحبا');
        expect(htmlContent).toContain('最终目标');

        // Check that all screenshots are included
        expect(htmlContent).toContain('data:image/png;base64,' + whitePixel);
        expect(htmlContent).toContain('data:image/png;base64,' + blackPixel);

        // Check timeline structure
        expect(htmlContent).toContain('Execution Timeline');
        expect(htmlContent).toContain('Step 1:');
        expect(htmlContent).toContain('Step 2:');
        expect(htmlContent).toContain('Step 3:');

        // Check controls
        expect(htmlContent).toContain('▶ Play');
        expect(htmlContent).toContain('⏮ Previous');
        expect(htmlContent).toContain('⏭ Next');

        console.log(
          `✅ Multi-screenshot visualization created successfully at ${outputPath}`
        );
      } finally {
        // Clean up test files
        try {
          await fs.rm('./test_output', { recursive: true, force: true });
        } catch (error) {
          console.log('Failed to clean up test directory:', error);
        }
      }
    });

    it('should skip placeholder screenshots', async () => {
      const mockHistory: AgentHistory[] = [
        {
          step: 1,
          action: { action: 'navigate', url: 'about:blank' },
          result: { success: true, message: 'Navigated to about:blank' },
          timestamp: Date.now(),
          state: {
            // This is the known placeholder for about:blank pages
            screenshot:
              'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAFElEQVR4nGP8//8/AwwwMSAB3BwAlm4DBfIlvvkAAAAASUVORK5CYII=',
          },
        },
      ];

      const outputPath = './test_output/placeholder_test.html';
      const result = await visualizationService.createHistoryVisualization(
        'Placeholder test',
        mockHistory,
        { outputPath }
      );

      expect(result).toBe(outputPath);

      // Should not create HTML file since all screenshots are placeholders
      try {
        await fs.stat(outputPath);
        throw new Error(
          'HTML file should not have been created for placeholder screenshots'
        );
      } catch (error: any) {
        // This is expected - the file should not exist
        expect(error.code).toBe('ENOENT');
      }
    });

    it('should handle mixed valid and placeholder screenshots', async () => {
      const validScreenshot =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChAI9jU77mgAAAABJRU5ErkJggg==';
      const placeholder =
        'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAFElEQVR4nGP8//8/AwwwMSAB3BwAlm4DBfIlvvkAAAAASUVORK5CYII=';

      const mockHistory: AgentHistory[] = [
        {
          step: 1,
          action: { action: 'navigate', url: 'about:blank' },
          result: { success: true, message: 'Navigated to about:blank' },
          timestamp: Date.now(),
          state: { screenshot: placeholder }, // Should be skipped
        },
        {
          step: 2,
          action: { action: 'click', index: 1 },
          result: { success: true, message: 'Clicked element' },
          timestamp: Date.now(),
          state: { screenshot: validScreenshot },
          model_output: {
            current_state: {
              next_goal:
                'Valid screenshot goal \\u6709\\u6548\\u622a\\u56fe\\u76ee\\u6807',
            },
          },
        },
        {
          step: 3,
          action: { action: 'navigate', url: 'about:blank' },
          result: { success: true, message: 'Another placeholder' },
          timestamp: Date.now(),
          state: { screenshot: placeholder }, // Should be skipped
        },
      ];

      const outputPath = './test_output/mixed_screenshots.html';

      await fs.mkdir('./test_output', { recursive: true });

      try {
        const result = await visualizationService.createHistoryVisualization(
          'Mixed screenshots test',
          mockHistory,
          { outputPath }
        );

        expect(result).toBe(outputPath);

        const htmlContent = await fs.readFile(outputPath, 'utf-8');

        // Should only contain the valid screenshot
        expect(htmlContent).toContain(
          'data:image/png;base64,' + validScreenshot
        );
        expect(htmlContent).not.toContain(
          'data:image/png;base64,' + placeholder
        );
        expect(htmlContent).toContain('Step 1 of 1'); // Only one valid screenshot
        expect(htmlContent).toContain('有效截图目标');
      } finally {
        try {
          await fs.rm('./test_output', { recursive: true, force: true });
        } catch (error) {
          console.log('Failed to clean up test directory:', error);
        }
      }
    });
  });
});
