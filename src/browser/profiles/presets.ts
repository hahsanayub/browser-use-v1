/**
 * Predefined browser configuration presets for common use cases
 */

import type { BrowserConfig } from '../../types/browser';

/**
 * Default configuration - lightweight and fast
 */
export const DEFAULT_PRESET: BrowserConfig = {
  browserType: 'chromium',
  headless: true,
  useOptimizedArgs: false,
  enableStealth: false,
  disableSecurity: false,
  enableDeterministicRendering: false,
  enableDefaultExtensions: false,
  keepAlive: false,
  timeout: 30000,
  viewport: { width: 1280, height: 720 },
};

/**
 * Optimized configuration - enhanced for automation
 */
export const OPTIMIZED_PRESET: BrowserConfig = {
  ...DEFAULT_PRESET,
  useOptimizedArgs: true,
  enableDefaultExtensions: true,
  enableStealth: true,
};

/**
 * Development configuration - visible browser with debugging features
 */
export const DEVELOPMENT_PRESET: BrowserConfig = {
  ...OPTIMIZED_PRESET,
  headless: false,
  windowSize: { width: 1280, height: 800 },
  keepAlive: true,
};

/**
 * Testing configuration - security disabled for testing environments
 */
export const TESTING_PRESET: BrowserConfig = {
  ...OPTIMIZED_PRESET,
  disableSecurity: true,
  enableDeterministicRendering: true,
};

/**
 * Production configuration - maximum stealth and optimization
 */
export const PRODUCTION_PRESET: BrowserConfig = {
  ...OPTIMIZED_PRESET,
  enableStealth: true,
  useOptimizedArgs: true,
  enableDefaultExtensions: true,
};

/**
 * Docker configuration - optimized for containerized environments
 */
export const DOCKER_PRESET: BrowserConfig = {
  ...PRODUCTION_PRESET,
  headless: true,
  // Docker-specific args will be auto-detected by environment detection
};

/**
 * Stealth configuration - maximum anti-detection measures
 */
export const STEALTH_PRESET: BrowserConfig = {
  ...PRODUCTION_PRESET,
  enableStealth: true,
  useOptimizedArgs: true,
  enableDefaultExtensions: true,
  disableSecurity: false, // Keep security enabled in stealth mode
};

/**
 * All available presets
 */
export const PRESETS = {
  default: DEFAULT_PRESET,
  optimized: OPTIMIZED_PRESET,
  development: DEVELOPMENT_PRESET,
  testing: TESTING_PRESET,
  production: PRODUCTION_PRESET,
  docker: DOCKER_PRESET,
  stealth: STEALTH_PRESET,
} as const;

export type PresetName = keyof typeof PRESETS;

/**
 * Get a preset configuration by name
 */
export function getPreset(name: PresetName): BrowserConfig {
  return { ...PRESETS[name] };
}

/**
 * Create a custom configuration based on a preset
 */
export function createCustomConfig(
  preset: PresetName,
  overrides: Partial<BrowserConfig> = {}
): BrowserConfig {
  return {
    ...getPreset(preset),
    ...overrides,
  };
}
