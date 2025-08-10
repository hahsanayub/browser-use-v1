/**
 * LLM client factory for creating appropriate client instances
 */

import { BaseLLMClient } from './base-client';
import { OpenAIClient } from './clients/openai-client';
import { AnthropicClient } from './clients/anthropic-client';
import { OllamaClient } from './clients/ollama-client';
import { GoogleClient } from './clients/google-client';
import type { LLMConfig } from '../config/schema';
import type { LLMClientConfig } from '../types/llm';
import { getLogger } from '../services/logging';

/**
 * Factory function to create LLM client instances
 */
export function createLLMClient(config: LLMConfig): BaseLLMClient {
  const logger = getLogger();

  // Only some providers require API keys. Ollama runs locally and does not.
  const providerRequiresApiKey = config.provider !== 'ollama';
  if (providerRequiresApiKey && !config.apiKey) {
    throw new Error(`API key is required for ${config.provider} provider`);
  }

  const clientConfig: LLMClientConfig = {
    apiKey: config.apiKey || '',
    model: config.model || 'gpt-3.5-turbo',
    baseUrl: config.baseUrl,
    timeout: config.timeout,
    maxRetries: config.maxRetries,
    organization: config.organization,
    project: config.project,
    serviceTier: config.serviceTier,
    defaultOptions: {
      maxTokens: config.maxTokens,
      temperature: config.temperature,
      topP: config.topP,
      frequencyPenalty: config.frequencyPenalty,
      presencePenalty: config.presencePenalty,
      seed: config.seed,
    },
  };

  logger.debug('Creating LLM client', {
    provider: config.provider,
    model: clientConfig.model,
  });

  switch (config.provider) {
    case 'openai':
      return new OpenAIClient(clientConfig);

    case 'anthropic':
      return new AnthropicClient(clientConfig);

    case 'google':
      return new GoogleClient(clientConfig);

    case 'ollama':
      return new OllamaClient(clientConfig);

    case 'custom':
      // For custom providers, default to OpenAI-compatible format
      return new OpenAIClient(clientConfig);

    default:
      throw new Error(`Unsupported LLM provider: ${config.provider}`);
  }
}

/**
 * Validate LLM configuration
 */
export async function validateLLMConfig(config: LLMConfig): Promise<boolean> {
  try {
    const client = createLLMClient(config);
    return await client.validateConfig();
  } catch (error) {
    const logger = getLogger();
    logger.error('LLM configuration validation failed', error as Error);
    return false;
  }
}

/**
 * Get supported providers
 */
export function getSupportedProviders(): string[] {
  // Keep 'google' to match schema; although not implemented, it is a recognized option
  return ['openai', 'anthropic', 'google', 'ollama', 'custom'];
}

/**
 * Get default models for each provider
 */
export function getDefaultModels(): Record<string, string> {
  return {
    openai: 'gpt-3.5-turbo',
    anthropic: 'claude-3-sonnet-20240229',
    google: 'gemini-2.0-flash',
    ollama: 'llama3.1:8b',
    custom: 'gpt-3.5-turbo',
  };
}
