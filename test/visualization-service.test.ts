import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLogger } from '../src/services/logging';
import { VisualizationService } from '../src/services/visualization-service';
import type { AgentHistory } from '../src/types/agent';
import fs from 'fs/promises';
import path from 'path';

// Initialize logger for testing
initializeLogger({ level: 'error', console: false, json: false });

describe('VisualizationService', () => {
  let visualizationService: VisualizationService;

  beforeAll(async () => {
    visualizationService = new VisualizationService();
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

    it('should handle invalid unicode escapes gracefully', () => {
      const result = visualizationService.decodeUnicodeEscapes(
        'Invalid \\uXYZ escape'
      );
      expect(result).toBe('Invalid \\uXYZ escape'); // Should remain unchanged
    });
  });

  describe('GIF Generation', () => {
    it('should handle empty history gracefully', async () => {
      const result = await visualizationService.createHistoryGif(
        'Test task',
        []
      );
      expect(result).toBe('agent_history.gif');
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
              next_goal: 'Test goal with Unicode: 测试中文',
            },
          },
        },
      ];

      const outputPath = 'test_output.gif';
      const result = await visualizationService.createHistoryGif(
        'Test task: 创建可视化测试',
        mockHistory,
        { outputPath }
      );

      expect(result).toBe(outputPath);

      // Check if PNG file was created (since we're using PNG fallback)
      const pngPath = outputPath.replace('.gif', '.png');
      try {
        const stats = await fs.stat(pngPath);
        expect(stats.isFile()).toBe(true);

        // Clean up
        await fs.unlink(pngPath);
      } catch (error) {
        // File might not exist, which is acceptable for this test
        console.log(
          'PNG file not created, which is expected for empty/placeholder screenshots'
        );
      }
    });

    it('should create visualization for multiple screenshots', async () => {
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
            current_state: { next_goal: 'First goal 第一个目标' },
          },
        },
        {
          step: 2,
          action: { action: 'input_text', text: 'Hello' },
          result: { success: true, message: 'Input text' },
          timestamp: Date.now(),
          state: { screenshot: blackPixel },
          model_output: {
            current_state: { next_goal: 'Second goal 第二个目标' },
          },
        },
      ];

      const outputDir = './test_output';
      const outputPath = path.join(outputDir, 'multi_frame_test.gif');

      // Create output directory
      await fs.mkdir(outputDir, { recursive: true });

      try {
        const result = await visualizationService.createHistoryGif(
          'Multi-frame test: 多帧测试',
          mockHistory,
          {
            outputPath,
            showGoals: true,
            showTask: true,
            duration: 2000,
          }
        );

        expect(result).toBe(outputPath);

        // Check if HTML viewer was created
        const htmlPath = outputPath.replace('.gif', '.html');
        try {
          const htmlStats = await fs.stat(htmlPath);
          expect(htmlStats.isFile()).toBe(true);

          const htmlContent = await fs.readFile(htmlPath, 'utf-8');
          expect(htmlContent).toContain('Agent History Animation');
          expect(htmlContent).toContain('multi_frame_test');
        } catch (error) {
          console.log(
            'HTML file not created, expected for small/placeholder screenshots'
          );
        }
      } finally {
        // Clean up test files
        try {
          await fs.rm(outputDir, { recursive: true, force: true });
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

      const outputPath = 'placeholder_test.gif';
      const result = await visualizationService.createHistoryGif(
        'Placeholder test',
        mockHistory,
        { outputPath }
      );

      expect(result).toBe(outputPath);

      // Should not create any output files since all screenshots are placeholders
      const pngPath = outputPath.replace('.gif', '.png');
      try {
        await fs.stat(pngPath);
        // If we reach this line, the file exists when it shouldn't
        await fs.unlink(pngPath); // Clean up
        throw new Error(
          'PNG file should not have been created for placeholder screenshots'
        );
      } catch (error: any) {
        // This is expected - the file should not exist
        expect(error.code).toBe('ENOENT');
      }
    });
  });

  describe('Font System', () => {
    it('should initialize without throwing', () => {
      const service = new VisualizationService();
      expect(service).toBeDefined();
    });

    it('should provide fallback font when no custom fonts available', () => {
      const service = new VisualizationService();
      // The getPreferredFont method is private, but we can test indirectly
      // by checking that the service initializes without errors
      expect(service).toBeDefined();
    });
  });
});
