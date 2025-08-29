/**
 * Base LLM client interface and abstract implementation
 */

import type {
  LLMMessage,
  LLMResponse,
  LLMRequestOptions,
  LLMClientConfig,
  LLMContentPart,
} from '../types/llm';
import { z } from 'zod';
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
   * Validate messages format (supports both string and multimodal content)
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

      // Validate content - can be string or array of content parts
      if (typeof message.content === 'string') {
        if (message.content.trim().length === 0) {
          throw new Error('String message content must be non-empty');
        }
      } else if (Array.isArray(message.content)) {
        if (message.content.length === 0) {
          throw new Error('Content parts array must be non-empty');
        }

        for (const part of message.content) {
          this.validateContentPart(part);
        }
      } else {
        throw new Error(
          'Message content must be string or array of content parts'
        );
      }
    }
  }

  /**
   * Validate individual content part for multimodal messages
   */
  protected validateContentPart(part: LLMContentPart): void {
    if (!part.type) {
      throw new Error('Content part must have a type');
    }

    switch (part.type) {
      case 'text':
        if (typeof part.text !== 'string' || part.text.trim().length === 0) {
          throw new Error('Text content part must have non-empty text');
        }
        break;

      case 'image':
        if (!part.imageUrl?.url) {
          throw new Error('Image content part must have imageUrl.url');
        }

        // Basic validation for data URI or URL
        const url = part.imageUrl.url;
        if (!url.startsWith('data:image/') && !url.startsWith('http')) {
          throw new Error('Image URL must be a data URI or HTTP URL');
        }
        break;

      default:
        // Use a type assertion to access the type property
        throw new Error(`Unknown content part type: ${(part as any).type}`);
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
