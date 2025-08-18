/**
 * Screenshot storage service for browser-use agents
 */

import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { getLogger } from './logging';

export interface ScreenshotMetadata {
  /** Step number when screenshot was taken */
  stepNumber: number;
  /** Timestamp when screenshot was taken */
  timestamp: number;
  /** Full path to the stored screenshot file */
  filePath: string;
  /** Size of the screenshot file in bytes */
  fileSize: number;
  /** Image format */
  format: 'png' | 'jpeg';
}

/**
 * Simple screenshot storage service that saves screenshots to disk
 */
export class ScreenshotService {
  private logger = getLogger();
  private agentDirectory: string;
  private screenshotsDir: string;

  constructor(agentDirectory: string) {
    this.agentDirectory = agentDirectory;
    this.screenshotsDir = join(agentDirectory, 'screenshots');
  }

  /**
   * Initialize the screenshot service by creating necessary directories
   */
  async initialize(): Promise<void> {
    try {
      await fs.mkdir(this.screenshotsDir, { recursive: true });
      this.logger.debug('Screenshot service initialized', {
        directory: this.screenshotsDir,
      });
    } catch (error) {
      this.logger.error(
        'Failed to initialize screenshot service',
        error as Error
      );
      throw error;
    }
  }

  /**
   * Store screenshot to disk and return metadata
   */
  async storeScreenshot(
    screenshotB64: string,
    stepNumber: number,
    format: 'png' | 'jpeg' = 'png'
  ): Promise<ScreenshotMetadata> {
    const screenshotFilename = `step_${stepNumber}.${format}`;
    const screenshotPath = join(this.screenshotsDir, screenshotFilename);

    try {
      // Decode base64 and save to disk
      const screenshotData = Buffer.from(screenshotB64, 'base64');
      await fs.writeFile(screenshotPath, screenshotData);

      const metadata: ScreenshotMetadata = {
        stepNumber,
        timestamp: Date.now(),
        filePath: screenshotPath,
        fileSize: screenshotData.length,
        format,
      };

      this.logger.debug('Screenshot stored', {
        stepNumber,
        filePath: screenshotPath,
        fileSize: metadata.fileSize,
        format,
      });

      return metadata;
    } catch (error) {
      this.logger.error('Failed to store screenshot', error as Error, {
        stepNumber,
        message: (error as Error).message,
        format,
      });
      throw error;
    }
  }

  /**
   * Load screenshot from disk path and return as base64
   */
  async getScreenshot(screenshotPath: string): Promise<string | null> {
    if (!screenshotPath) {
      return null;
    }

    try {
      const screenshotData = await fs.readFile(screenshotPath);
      return screenshotData.toString('base64');
    } catch (error) {
      this.logger.warn('Failed to load screenshot', {
        screenshotPath,
        error: (error as Error).message,
      });
      return null;
    }
  }

  /**
   * Get all screenshot files for the current agent session
   */
  async listScreenshots(): Promise<ScreenshotMetadata[]> {
    try {
      const files = await fs.readdir(this.screenshotsDir);
      const screenshots: ScreenshotMetadata[] = [];

      for (const file of files) {
        if (file.endsWith('.png') && file.startsWith('step_')) {
          const filePath = join(this.screenshotsDir, file);
          const stats = await fs.stat(filePath);
          const stepMatch = file.match(/step_(\d+)\.png/);

          if (stepMatch) {
            screenshots.push({
              stepNumber: parseInt(stepMatch[1], 10),
              timestamp: stats.mtime.getTime(),
              filePath,
              fileSize: stats.size,
              format: 'png', // Default format for existing screenshots
            });
          }
        }
      }

      // Sort by step number
      screenshots.sort((a, b) => a.stepNumber - b.stepNumber);
      return screenshots;
    } catch (error) {
      this.logger.error('Failed to list screenshots', error as Error);
      return [];
    }
  }

  /**
   * Clean up old screenshots to manage disk space
   */
  async cleanupOldScreenshots(keepCount: number = 10): Promise<void> {
    try {
      const screenshots = await this.listScreenshots();

      if (screenshots.length <= keepCount) {
        return; // Nothing to clean up
      }

      // Remove oldest screenshots beyond keepCount
      const toDelete = screenshots.slice(0, screenshots.length - keepCount);

      for (const screenshot of toDelete) {
        try {
          await fs.unlink(screenshot.filePath);
          this.logger.debug('Cleaned up old screenshot', {
            filePath: screenshot.filePath,
            stepNumber: screenshot.stepNumber,
          });
        } catch (error) {
          this.logger.warn('Failed to delete screenshot file', {
            filePath: screenshot.filePath,
            error: (error as Error).message,
          });
        }
      }

      this.logger.info('Screenshot cleanup completed', {
        deleted: toDelete.length,
        remaining: keepCount,
      });
    } catch (error) {
      this.logger.error('Failed to cleanup old screenshots', error as Error);
    }
  }

  /**
   * Get the screenshots directory path
   */
  getScreenshotsDirectory(): string {
    return this.screenshotsDir;
  }
}
