/**
 * OpenAI LLM client implementation
 */

import axios, { AxiosInstance } from 'axios';
import { BaseLLMClient } from '../base-client';
import type {
  LLMMessage,
  LLMResponse,
  LLMRequestOptions,
  LLMClientConfig,
} from '../../types/llm';

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OpenAIResponse {
  choices: Array<{
    message: {
      content: string;
      role: string;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  model: string;
}

/**
 * OpenAI LLM client implementation
 */
export class OpenAIClient extends BaseLLMClient {
  private httpClient: AxiosInstance;

  constructor(config: LLMClientConfig) {
    super(config);

    this.httpClient = axios.create({
      baseURL: config.baseUrl || 'https://api.openai.com/v1',
      timeout: config.timeout || 30000,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Generate response using OpenAI API
   */
  async generateResponse(
    messages: LLMMessage[],
    options?: LLMRequestOptions
  ): Promise<LLMResponse> {
    this.validateMessages(messages);

    const requestOptions = this.mergeOptions(options);
    const startTime = Date.now();

    try {
      this.logger.debug('Sending request to OpenAI', {
        model: this.config.model,
        messageCount: messages.length,
        options: requestOptions,
      });

      const openAIMessages: OpenAIMessage[] = messages.map((msg) => ({
        role: msg.role,
        content: msg.content,
      }));

      const requestData = {
        model: this.config.model,
        messages: openAIMessages,
        max_tokens: requestOptions.maxTokens,
        temperature: requestOptions.temperature,
        stop: requestOptions.stop,
      };

      const response = await this.httpClient.post<OpenAIResponse>(
        '/chat/completions',
        requestData
      );

      const openAIResponse = response.data;
      const requestTime = Date.now() - startTime;

      if (!openAIResponse.choices || openAIResponse.choices.length === 0) {
        throw new Error('No response choices returned from OpenAI');
      }

      const choice = openAIResponse.choices[0];
      const llmResponse: LLMResponse = {
        content: choice.message.content,
        usage: {
          promptTokens: openAIResponse.usage.prompt_tokens,
          completionTokens: openAIResponse.usage.completion_tokens,
          totalTokens: openAIResponse.usage.total_tokens,
        },
        model: openAIResponse.model,
        metadata: {
          finishReason: choice.finish_reason,
          requestTime,
        },
      };

      this.logMetrics(llmResponse, requestTime, messages.length);
      return llmResponse;
    } catch (error: any) {
      const requestTime = Date.now() - startTime;

      if (error.response?.status === 401) {
        throw this.handleError(error, 'Invalid API key');
      } else if (error.response?.status === 429) {
        throw this.handleError(error, 'Rate limit exceeded');
      } else if (error.response?.status === 400) {
        throw this.handleError(error, 'Invalid request format');
      } else {
        throw this.handleError(error, 'API request failed');
      }
    }
  }

  /**
   * Validate OpenAI client configuration
   */
  async validateConfig(): Promise<boolean> {
    try {
      this.logger.debug('Validating OpenAI configuration');

      // Test with a simple request
      const testMessages: LLMMessage[] = [{ role: 'user', content: 'Hello' }];

      await this.generateResponse(testMessages, {
        maxTokens: 1,
        temperature: 0,
      });

      this.logger.info('OpenAI client configuration validated successfully');
      return true;
    } catch (error) {
      this.logger.error(
        'OpenAI client configuration validation failed',
        error as Error
      );
      return false;
    }
  }

  /**
   * Get supported models (this would typically make an API call)
   */
  async getSupportedModels(): Promise<string[]> {
    try {
      const response = await this.httpClient.get('/models');
      return response.data.data
        .filter((model: any) => model.id.includes('gpt'))
        .map((model: any) => model.id);
    } catch (error) {
      this.logger.warn('Failed to fetch supported models', {
        error: (error as Error).message,
      });
      return ['gpt-3.5-turbo', 'gpt-4', 'gpt-4-turbo'];
    }
  }
}
