/**
 * Configuration schema validation using Zod
 */

import { z } from 'zod';

// Viewport size schema
const ViewportSizeSchema = z.object({
  width: z.number().min(1).default(1280),
  height: z.number().min(1).default(720),
});

// Extension configuration schema
const ExtensionConfigSchema = z.object({
  id: z.string().optional(),
  path: z.string().optional(),
  name: z.string().optional(),
  enabled: z.boolean().default(true),
});

// Browser configuration schema
export const BrowserConfigSchema = z.object({
  browserType: z.enum(['chromium', 'firefox', 'webkit']).default('chromium'),
  headless: z.boolean().default(true),
  userDataDir: z.string().optional(),
  args: z.array(z.string()).default([]),
  executablePath: z.string().optional(),
  timeout: z.number().min(1000).default(30000),
  viewport: ViewportSizeSchema.default({ width: 1280, height: 720 }),

  // Enhanced configuration options
  useOptimizedArgs: z.boolean().default(false),
  enableStealth: z.boolean().default(false),
  disableSecurity: z.boolean().default(false),
  enableDeterministicRendering: z.boolean().default(false),
  enableDefaultExtensions: z.boolean().default(false),
  customExtensions: z.array(ExtensionConfigSchema).default([]),
  allowedDomains: z.array(z.string()).optional(),
  windowSize: ViewportSizeSchema.optional(),
  windowPosition: ViewportSizeSchema.optional(),
  keepAlive: z.boolean().default(false),
  profileDirectory: z.string().default('Default'),

  // DOM processing configuration (aligned with Python version)
  viewportExpansion: z.number().min(-1).max(2000).default(500),
  highlightElements: z.boolean().default(true),
  includeHiddenElements: z.boolean().default(false),
  maxTextLength: z.number().min(1).optional(),
  removeScripts: z.boolean().default(false),
  removeStyles: z.boolean().default(false),
  removeComments: z.boolean().default(false),
});

// LLM configuration schema
export const LLMConfigSchema = z.object({
  provider: z
    .enum(['openai', 'azure', 'anthropic', 'google', 'ollama', 'custom'])
    .default('openai'),
  apiKey: z.string().optional(),
  model: z.string().default('gpt-3.5-turbo'),
  baseUrl: z.string().url().optional(),
  timeout: z.number().min(1000).default(30000),
  maxTokens: z.number().min(1).default(4096),
  temperature: z.number().min(0).max(2).default(0.2),
  topP: z.number().min(0).max(1).optional(),
  frequencyPenalty: z.number().min(-2).max(2).default(0.3),
  presencePenalty: z.number().min(-2).max(2).optional(),
  seed: z.number().optional(),
  serviceTier: z
    .enum(['auto', 'default', 'flex', 'priority', 'scale'])
    .optional(),
  organization: z.string().optional(),
  project: z.string().optional(),
  maxRetries: z.number().min(0).optional(),
  // Azure-specific configuration
  azureEndpoint: z.string().url().optional(),
  azureDeployment: z.string().optional(),
  apiVersion: z.string().optional(),
  azureAdToken: z.string().optional(),
});

// Logging configuration schema
export const LoggingConfigSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  console: z.boolean().default(true),
  file: z.string().optional(),
  json: z.boolean().default(false),
});

// Main application configuration schema
export const AppConfigSchema = z.object({
  browser: BrowserConfigSchema,
  llm: LLMConfigSchema,
  logging: LoggingConfigSchema,
  maxSteps: z.number().min(1).default(100),
  configDir: z.string().optional(),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type BrowserConfig = z.infer<typeof BrowserConfigSchema>;
export type LLMConfig = z.infer<typeof LLMConfigSchema>;
export type LoggingConfig = z.infer<typeof LoggingConfigSchema>;

// Input configuration types (with defaults applied, fields optional for user input)
export type BrowserConfigInput = z.input<typeof BrowserConfigSchema>;
export type LLMConfigInput = z.input<typeof LLMConfigSchema>;
export type LoggingConfigInput = z.input<typeof LoggingConfigSchema>;
export type AppConfigInput = z.input<typeof AppConfigSchema>;

// Default configuration
export const DEFAULT_CONFIG: AppConfig = {
  browser: {
    browserType: 'chromium',
    headless: true,
    args: [],
    timeout: 30000,
    viewport: { width: 1280, height: 720 },
    useOptimizedArgs: false,
    enableStealth: false,
    disableSecurity: false,
    enableDeterministicRendering: false,
    enableDefaultExtensions: false,
    customExtensions: [],
    keepAlive: false,
    profileDirectory: 'Default',
    // DOM processing configuration (aligned with Python version)
    viewportExpansion: 500,
    highlightElements: true,
    includeHiddenElements: false,
    removeScripts: false,
    removeStyles: false,
    removeComments: false,
  },
  llm: {
    provider: 'openai',
    model: 'gpt-3.5-turbo',
    timeout: 30000,
    maxTokens: 4000,
    temperature: 0.2,
    frequencyPenalty: 0.3,
  },
  logging: {
    level: 'info',
    console: true,
    json: false,
  },
  maxSteps: 100,
};
