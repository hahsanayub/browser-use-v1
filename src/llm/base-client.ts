/**
 * Base LLM client interface and abstract implementation
 */

import type {
  LLMMessage,
  LLMResponse,
  LLMRequestOptions,
  LLMClientConfig,
} from '../types/llm';
import { getLogger } from '../services/logging';

/**
 * Abstract base class for LLM clients
 */
export abstract class BaseLLMClient {
  protected config: LLMClientConfig;
  protected logger = getLogger();

  constructor(config: LLMClientConfig) {
    this.config = config;
  }

  /**
   * Generate a response from the LLM
   */
  abstract generateResponse(
    messages: LLMMessage[],
    options?: LLMRequestOptions
  ): Promise<LLMResponse>;

  /**
   * Validate that the client is properly configured
   */
  abstract validateConfig(): Promise<boolean>;

  /**
   * Get the model name being used
   */
  getModel(): string {
    return this.config.model;
  }

  /**
   * Update client configuration
   */
  updateConfig(config: Partial<LLMClientConfig>): void {
    this.config = { ...this.config, ...config };
    this.logger.debug('LLM client configuration updated');
  }

  /**
   * Merge request options with defaults
   */
  protected mergeOptions(options?: LLMRequestOptions): LLMRequestOptions {
    return {
      ...this.config.defaultOptions,
      ...options,
    };
  }

  /**
   * Validate messages format
   */
  protected validateMessages(messages: LLMMessage[]): void {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error('Messages must be a non-empty array');
    }

    for (const message of messages) {
      if (
        !message.role ||
        !['system', 'user', 'assistant'].includes(message.role)
      ) {
        throw new Error(`Invalid message role: ${message.role}`);
      }

      if (
        typeof message.content !== 'string' ||
        message.content.trim().length === 0
      ) {
        throw new Error('Message content must be a non-empty string');
      }
    }
  }

  /**
   * Handle API errors and transform them into standardized format
   */
  protected handleError(error: any, context?: string): Error {
    let message = 'LLM API request failed';

    if (context) {
      message += ` (${context})`;
    }

    if (error?.response?.data?.error?.message) {
      message += `: ${error.response.data.error.message}`;
    } else if (error?.message) {
      message += `: ${error.message}`;
    }

    this.logger.error(message, error);
    return new Error(message);
  }

  /**
   * Log request metrics
   */
  protected logMetrics(
    response: LLMResponse,
    requestTime: number,
    messageCount: number
  ): void {
    this.logger.debug('LLM request completed', {
      model: this.config.model,
      requestTime,
      messageCount,
      usage: response.usage,
    });
  }
}
