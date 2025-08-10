/**
 * Configuration schema validation using Zod
 */

import { z } from 'zod';

// Browser configuration schema
export const BrowserConfigSchema = z.object({
  browserType: z.enum(['chromium', 'firefox', 'webkit']).default('chromium'),
  headless: z.boolean().default(true),
  userDataDir: z.string().optional(),
  args: z.array(z.string()).default([]),
  executablePath: z.string().optional(),
  timeout: z.number().min(1000).default(30000),
  viewport: z
    .object({
      width: z.number().min(1).default(1280),
      height: z.number().min(1).default(720),
    })
    .default({ width: 1280, height: 720 }),
});

// LLM configuration schema
export const LLMConfigSchema = z.object({
  provider: z
    .enum(['openai', 'anthropic', 'google', 'custom'])
    .default('openai'),
  apiKey: z.string().optional(),
  model: z.string().default('gpt-3.5-turbo'),
  baseUrl: z.string().url().optional(),
  timeout: z.number().min(1000).default(30000),
  maxTokens: z.number().min(1).default(4000),
  temperature: z.number().min(0).max(2).default(0.7),
  topP: z.number().min(0).max(1).optional(),
  frequencyPenalty: z.number().min(-2).max(2).optional(),
  presencePenalty: z.number().min(-2).max(2).optional(),
  seed: z.number().optional(),
  serviceTier: z.enum(['auto', 'default', 'standard', 'premium']).optional(),
  organization: z.string().optional(),
  project: z.string().optional(),
  maxRetries: z.number().min(0).optional(),
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

// Default configuration
export const DEFAULT_CONFIG: AppConfig = {
  browser: {
    browserType: 'chromium',
    headless: true,
    args: [],
    timeout: 30000,
    viewport: { width: 1280, height: 720 },
  },
  llm: {
    provider: 'openai',
    model: 'gpt-3.5-turbo',
    timeout: 30000,
    maxTokens: 4000,
    temperature: 0.7,
  },
  logging: {
    level: 'info',
    console: true,
    json: false,
  },
  maxSteps: 100,
};
