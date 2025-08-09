/**
 * Configuration loader that handles multiple sources with priority order:
 * 1. Environment variables (highest priority)
 * 2. config.json file
 * 3. Default values (lowest priority)
 */

import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { config as loadEnv } from 'dotenv';
import { AppConfigSchema, DEFAULT_CONFIG, type AppConfig } from './schema';

// Load environment variables
loadEnv();

/**
 * Get the configuration directory path following XDG specification
 */
function getConfigDir(): string {
  const envConfigDir = process.env.BROWSER_USE_CONFIG_DIR;
  if (envConfigDir) {
    return envConfigDir;
  }

  // Follow XDG Base Directory specification
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  if (xdgConfigHome) {
    return join(xdgConfigHome, 'browser-use');
  }

  // Fallback to ~/.config/browser-use
  return join(homedir(), '.config', 'browser-use');
}

/**
 * Create default configuration file
 */
async function createDefaultConfig(configPath: string): Promise<AppConfig> {
  try {
    // Ensure directory exists
    await fs.mkdir(dirname(configPath), { recursive: true });

    // Write default configuration
    await fs.writeFile(
      configPath,
      JSON.stringify(DEFAULT_CONFIG, null, 2),
      'utf-8'
    );

    console.log(`Created default configuration file at: ${configPath}`);
    return DEFAULT_CONFIG;
  } catch (error) {
    console.warn(`Failed to create config file: ${error}`);
    return DEFAULT_CONFIG;
  }
}

/**
 * Load configuration from file with validation and migration support
 */
async function loadConfigFromFile(configPath: string): Promise<AppConfig> {
  try {
    const configContent = await fs.readFile(configPath, 'utf-8');
    const rawConfig = JSON.parse(configContent);

    // Validate configuration using Zod schema
    const validatedConfig = AppConfigSchema.parse(rawConfig);
    return validatedConfig;
  } catch (error) {
    console.warn(`Failed to load or validate config file: ${error}`);

    // If file exists but is invalid, backup and create new one
    try {
      const stats = await fs.stat(configPath);
      if (stats.isFile()) {
        const backupPath = `${configPath}.backup.${Date.now()}`;
        await fs.copyFile(configPath, backupPath);
        console.log(`Backed up invalid config to: ${backupPath}`);
      }
    } catch (backupError) {
      // Ignore backup errors
    }

    // Create new default configuration
    return createDefaultConfig(configPath);
  }
}

/**
 * Apply environment variable overrides to configuration
 */
function applyEnvironmentOverrides(config: AppConfig): AppConfig {
  const overrides: Partial<AppConfig> = {};

  // Browser configuration overrides
  if (process.env.BROWSER_USE_HEADLESS !== undefined) {
    overrides.browser = {
      ...config.browser,
      headless: process.env.BROWSER_USE_HEADLESS === 'true',
    };
  }

  if (process.env.BROWSER_USE_TYPE) {
    overrides.browser = {
      ...overrides.browser,
      ...config.browser,
      browserType: process.env.BROWSER_USE_TYPE as any,
    };
  }

  if (process.env.BROWSER_USE_TIMEOUT) {
    const timeout = parseInt(process.env.BROWSER_USE_TIMEOUT, 10);
    if (!isNaN(timeout)) {
      overrides.browser = {
        ...overrides.browser,
        ...config.browser,
        timeout,
      };
    }
  }

  // LLM configuration overrides
  if (process.env.LLM_API_KEY) {
    overrides.llm = {
      ...config.llm,
      apiKey: process.env.LLM_API_KEY,
    };
  }

  if (process.env.LLM_PROVIDER) {
    overrides.llm = {
      ...overrides.llm,
      ...config.llm,
      provider: process.env.LLM_PROVIDER as any,
    };
  }

  if (process.env.LLM_MODEL) {
    overrides.llm = {
      ...overrides.llm,
      ...config.llm,
      model: process.env.LLM_MODEL,
    };
  }

  if (process.env.LLM_BASE_URL) {
    overrides.llm = {
      ...overrides.llm,
      ...config.llm,
      baseUrl: process.env.LLM_BASE_URL,
    };
  }

  // Logging configuration overrides
  if (process.env.LOG_LEVEL) {
    overrides.logging = {
      ...config.logging,
      level: process.env.LOG_LEVEL as any,
    };
  }

  if (process.env.LOG_FILE) {
    overrides.logging = {
      ...overrides.logging,
      ...config.logging,
      file: process.env.LOG_FILE,
    };
  }

  // Max steps override
  if (process.env.BROWSER_USE_MAX_STEPS) {
    const maxSteps = parseInt(process.env.BROWSER_USE_MAX_STEPS, 10);
    if (!isNaN(maxSteps)) {
      overrides.maxSteps = maxSteps;
    }
  }

  return { ...config, ...overrides };
}

/**
 * Main configuration loader function
 */
export async function loadConfig(): Promise<AppConfig> {
  const configDir = getConfigDir();
  const configPath = join(configDir, 'config.json');

  let config: AppConfig;

  try {
    // Check if config file exists
    await fs.access(configPath);
    config = await loadConfigFromFile(configPath);
  } catch (error) {
    // Config file doesn't exist, create default
    config = await createDefaultConfig(configPath);
  }

  // Apply environment variable overrides
  config = applyEnvironmentOverrides(config);

  // Final validation
  const finalConfig = AppConfigSchema.parse(config);

  return finalConfig;
}

/**
 * Singleton configuration instance
 */
let configInstance: AppConfig | null = null;

/**
 * Get the global configuration instance
 */
export async function getConfig(): Promise<AppConfig> {
  if (!configInstance) {
    configInstance = await loadConfig();
  }
  return configInstance;
}

/**
 * Reset configuration (useful for testing)
 */
export function resetConfig(): void {
  configInstance = null;
}
