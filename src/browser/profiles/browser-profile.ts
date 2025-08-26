/**
 * Browser profile manager that combines arguments, extensions, and environment detection
 */

import type { BrowserConfig } from '../../config/schema';
import type { ViewportSize, ExtensionConfig } from '../../types/browser';
import { getSystemInfo, getWindowAdjustments } from './environment';
import { ExtensionManager, DEFAULT_EXTENSIONS } from './extensions';
import {
  CHROME_OPTIMIZED_ARGS,
  CHROME_DOCKER_ARGS,
  CHROME_HEADLESS_ARGS,
  CHROME_DISABLE_SECURITY_ARGS,
  CHROME_DETERMINISTIC_RENDERING_ARGS,
  CHROME_STEALTH_ARGS,
} from './chrome-args';
import { getLogger } from '../../services/logging';

export interface ProfileBuildResult {
  args: string[];
  userDataDir?: string;
  viewport?: ViewportSize;
  headless: boolean;
}

/**
 * Browser profile builder that creates optimized launch configurations
 */
export class BrowserProfile {
  private config: BrowserConfig;
  private systemInfo = getSystemInfo();
  private extensionManager: ExtensionManager;

  constructor(config: BrowserConfig) {
    this.config = { ...config };
    this.extensionManager = new ExtensionManager();
    this.detectDisplayConfiguration();
  }

  /**
   * Detect display configuration and adjust settings
   */
  private detectDisplayConfiguration(): void {
    const { isDocker, hasDisplay } = this.systemInfo;

    // Auto-detect headless mode if not specified
    if (this.config.headless === undefined) {
      this.config.headless = isDocker || !hasDisplay;
      getLogger().info(
        `Auto-detected headless mode: ${this.config.headless} (Docker: ${isDocker}, Display: ${hasDisplay})`
      );
    }

    // Set default viewport only for headless mode; in headful mode prefer real window sizing
    if (this.config.headless) {
      if (!this.config.viewport && !this.config.windowSize) {
        this.config.viewport = { width: 1280, height: 720 };
      }
    } else {
      // Headful: if window size not set, we'll start maximized via args; use default viewport
      if (!this.config.windowSize) {
        this.config.viewport = { width: 1280, height: 720 };
      }
    }

    // Adjust window position for non-headless mode
    if (!this.config.headless && !this.config.windowPosition) {
      const adjustments = getWindowAdjustments();
      this.config.windowPosition = {
        width: adjustments.x,
        height: adjustments.y,
      };
    }
  }

  /**
   * Build Chrome launch arguments based on configuration
   */
  private async buildArgs(): Promise<string[]> {
    const args: string[] = [];

    // Add user-provided args first
    if (this.config.args) {
      args.push(...this.config.args);
    }

    // Add optimized args if enabled
    if (this.config.useOptimizedArgs) {
      args.push(...CHROME_OPTIMIZED_ARGS);
    }

    // Add Docker-specific args if needed
    if (this.systemInfo.isDocker) {
      args.push(...CHROME_DOCKER_ARGS);
      getLogger().info('Added Docker-specific Chrome arguments');
    }

    // Add headless args
    if (this.config.headless) {
      args.push(...CHROME_HEADLESS_ARGS);
    }

    // Add security-disabled args for testing
    if (this.config.disableSecurity) {
      args.push(...CHROME_DISABLE_SECURITY_ARGS);
      getLogger().warn('Security features disabled - only use for testing!');
    }

    // Add deterministic rendering args
    if (this.config.enableDeterministicRendering) {
      args.push(...CHROME_DETERMINISTIC_RENDERING_ARGS);
      getLogger().warn(
        'Deterministic rendering enabled - may break some websites'
      );
    }

    // Add stealth mode args
    if (this.config.enableStealth) {
      args.push(...CHROME_STEALTH_ARGS);
      getLogger().info('Stealth mode enabled');
    }

    // Add profile directory
    if (this.config.profileDirectory) {
      args.push(`--profile-directory=${this.config.profileDirectory}`);
    }

    // Add window size for non-headless mode
    if (!this.config.headless) {
      if (this.config.windowSize) {
        args.push(
          `--window-size=${this.config.windowSize.width},${this.config.windowSize.height}`
        );
      } else {
        args.push('--start-maximized');
      }

      // Add window position
      if (this.config.windowPosition) {
        args.push(
          `--window-position=${this.config.windowPosition.width},${this.config.windowPosition.height}`
        );
      }
    }

    // Handle extensions
    const extensionsToLoad: ExtensionConfig[] = [];

    // Add default extensions if enabled
    if (this.config.enableDefaultExtensions) {
      extensionsToLoad.push(...DEFAULT_EXTENSIONS);
    }

    // Add custom extensions
    if (this.config.customExtensions) {
      extensionsToLoad.push(...this.config.customExtensions);
    }

    // Get extension arguments
    if (extensionsToLoad.length > 0) {
      const extensionArgs =
        await this.extensionManager.getExtensionArgs(extensionsToLoad);
      args.push(...extensionArgs);
    }

    // Remove duplicates and merge conflicting args
    return this.deduplicateArgs(args);
  }

  /**
   * Remove duplicate arguments and merge conflicting ones
   */
  private deduplicateArgs(args: string[]): string[] {
    const argsMap = new Map<string, string>();

    for (const arg of args) {
      const [key, value] = arg.split('=', 2);

      if (value !== undefined) {
        // For args with values, keep the last one
        argsMap.set(key, value);
      } else {
        // For boolean flags, just keep the key
        argsMap.set(key, '');
      }
    }

    // Convert back to array
    const result: string[] = [];
    for (const [key, value] of argsMap.entries()) {
      if (value) {
        result.push(`${key}=${value}`);
      } else {
        result.push(key);
      }
    }

    return result;
  }

  /**
   * Build complete profile configuration for browser launch
   */
  async build(): Promise<ProfileBuildResult> {
    getLogger().info(
      `Building browser profile for ${this.systemInfo.platform} (Docker: ${this.systemInfo.isDocker})`
    );

    const args = await this.buildArgs();

    const result: ProfileBuildResult = {
      args,
      headless: this.config.headless!,
      userDataDir: this.config.userDataDir,
    };

    // Set viewport for headless mode or if explicitly configured; in headful mode default is no viewport
    if (this.config.headless || this.config.viewport) {
      result.viewport = this.config.viewport || this.config.windowSize;
    }

    getLogger().info(`Browser profile built with ${args.length} arguments`);
    getLogger().debug(`Browser arguments: ${args.join(' ')}`);

    return result;
  }

  /**
   * Create a browser profile from configuration
   */
  static async fromConfig(config: BrowserConfig): Promise<ProfileBuildResult> {
    const profile = new BrowserProfile(config);
    return await profile.build();
  }
}
