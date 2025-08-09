/**
 * Configuration type definitions
 */

import { BrowserConfig } from './browser';

export interface LLMConfig {
  /** LLM provider (openai, anthropic, google, etc.) */
  provider: 'openai' | 'anthropic' | 'google' | 'custom';
  /** API key for the LLM provider */
  apiKey?: string;
  /** Model name to use */
  model?: string;
  /** Base URL for custom providers */
  baseUrl?: string;
  /** Request timeout in milliseconds */
  timeout?: number;
  /** Maximum tokens for responses */
  maxTokens?: number;
  /** Temperature for response generation */
  temperature?: number;
}

export interface LoggingConfig {
  /** Log level (debug, info, warn, error) */
  level: 'debug' | 'info' | 'warn' | 'error';
  /** Whether to log to console */
  console?: boolean;
  /** Log file path (optional) */
  file?: string;
  /** Whether to use structured JSON logging */
  json?: boolean;
}

export interface AppConfig {
  /** Browser configuration */
  browser: BrowserConfig;
  /** LLM configuration */
  llm: LLMConfig;
  /** Logging configuration */
  logging: LoggingConfig;
  /** Maximum number of steps for agent execution */
  maxSteps?: number;
  /** Custom configuration directory path */
  configDir?: string;
}
