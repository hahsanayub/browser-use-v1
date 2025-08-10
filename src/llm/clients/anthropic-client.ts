/**
 * Anthropic Claude LLM client implementation
 */

import axios, { AxiosInstance } from 'axios';
import { BaseLLMClient } from '../base-client';
import type {
  LLMMessage,
  LLMResponse,
  LLMRequestOptions,
  LLMClientConfig,
} from '../../types/llm';

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface AnthropicResponse {
  content: Array<{
    type: 'text';
    text: string;
  }>;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
  model: string;
  stop_reason: string;
}

/**
 * Anthropic Claude LLM client implementation
 */
export class AnthropicClient extends BaseLLMClient {
  private httpClient: AxiosInstance;
  private async sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  constructor(config: LLMClientConfig) {
    super(config);

    this.httpClient = axios.create({
      baseURL: config.baseUrl || 'https://api.anthropic.com',
      timeout: config.timeout || 30000,
      headers: {
        'x-api-key': config.apiKey,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
    });
  }

  /**
   * Generate response using Anthropic API
   */
  async generateResponse(
    messages: LLMMessage[],
    options?: LLMRequestOptions
  ): Promise<LLMResponse> {
    this.validateMessages(messages);

    const requestOptions = this.mergeOptions(options);
    const startTime = Date.now();

    try {
      this.logger.debug('Sending request to Anthropic', {
        model: this.config.model,
        messageCount: messages.length,
        options: requestOptions,
      });

      // Anthropic requires system message to be separate from conversation
      const systemMessage = messages.find((msg) => msg.role === 'system');
      const conversationMessages = messages.filter(
        (msg) => msg.role !== 'system'
      );

      const anthropicMessages: AnthropicMessage[] = conversationMessages.map(
        (msg) => ({
          role: msg.role as 'user' | 'assistant',
          content: msg.content,
        })
      );

      const requestData: Record<string, any> = {
        model: this.config.model,
        max_tokens: requestOptions.maxTokens || 4000,
        temperature: requestOptions.temperature,
        top_p: requestOptions.topP,
        stream: requestOptions.stream,
        messages: anthropicMessages,
        ...(systemMessage && { system: systemMessage.content }),
        ...(requestOptions.stop && { stop_sequences: requestOptions.stop }),
      };

      // Anthropic "structured output" equivalent is tool use; for now we only support text output.
      // If responseFormat is requested as json, we guide via system message for stricter adherence.
      if (
        requestOptions.responseFormat &&
        (requestOptions.responseFormat.type === 'json_object' ||
          requestOptions.responseFormat.type === 'json_schema')
      ) {
        requestData.system = `${systemMessage?.content || ''}\nReturn ONLY strict JSON${
          requestOptions.responseFormat.type === 'json_schema' ?
            ' matching the provided schema.' :
            '.'
        }`.trim();
      }

      const maxRetries = typeof this.config.maxRetries === 'number' ? this.config.maxRetries : 0;
      let attempt = 0;
      let lastError: any;
      let response: { data: AnthropicResponse } | undefined;
      while (attempt <= maxRetries) {
        try {
          response = await this.httpClient.post<AnthropicResponse>(
            '/v1/messages',
            requestData,
            requestOptions.timeout ? { timeout: requestOptions.timeout } : undefined
          );
          break;
        } catch (err: any) {
          lastError = err;
          const status = err?.response?.status;
          if (attempt < maxRetries && (status === 429 || status === 408 || (status >= 500 && status < 600))) {
            const backoffMs = Math.min(1000 * Math.pow(2, attempt), 8000);
            await this.sleep(backoffMs);
            attempt += 1;
            continue;
          }
          throw err;
        }
      }
      if (!response) throw lastError || new Error('Anthropic request failed without response');

      const anthropicResponse = response.data;
      const requestTime = Date.now() - startTime;

      if (
        !anthropicResponse.content ||
        anthropicResponse.content.length === 0
      ) {
        throw new Error('No content returned from Anthropic');
      }

      const textContent = anthropicResponse.content
        .filter((item) => item.type === 'text')
        .map((item) => item.text)
        .join('');

      const llmResponse: LLMResponse = {
        content: textContent,
        usage: {
          promptTokens: anthropicResponse.usage.input_tokens,
          completionTokens: anthropicResponse.usage.output_tokens,
          totalTokens:
            anthropicResponse.usage.input_tokens +
            anthropicResponse.usage.output_tokens,
        },
        model: anthropicResponse.model,
        metadata: {
          stopReason: anthropicResponse.stop_reason,
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
   * Validate Anthropic client configuration
   */
  async validateConfig(): Promise<boolean> {
    try {
      this.logger.debug('Validating Anthropic configuration');

      // Test with a simple request
      const testMessages: LLMMessage[] = [{ role: 'user', content: 'Hello' }];

      await this.generateResponse(testMessages, {
        maxTokens: 1,
        temperature: 0,
      });

      this.logger.info('Anthropic client configuration validated successfully');
      return true;
    } catch (error) {
      this.logger.error(
        'Anthropic client configuration validation failed',
        error as Error
      );
      return false;
    }
  }

  /**
   * Get supported models
   */
  getSupportedModels(): string[] {
    return [
      'claude-3-opus-20240229',
      'claude-3-sonnet-20240229',
      'claude-3-haiku-20240307',
      'claude-2.1',
      'claude-2.0',
      'claude-instant-1.2',
    ];
  }
}
