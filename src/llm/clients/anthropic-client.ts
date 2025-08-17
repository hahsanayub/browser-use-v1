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
  LLMContentPart,
} from '../../types/llm';

interface AnthropicTextContent {
  type: 'text';
  text: string;
}

interface AnthropicImageContent {
  type: 'image';
  source: {
    type: 'base64';
    media_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
    data: string;
  };
}

type AnthropicContent =
  | string
  | (AnthropicTextContent | AnthropicImageContent)[];

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicContent;
}

interface AnthropicResponse {
  content: Array<{
    type: 'text';
    text: string;
  }>;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
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
        (msg) => this.convertToAnthropicMessage(msg)
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
      if (requestOptions.responseFormat) {
        if (requestOptions.responseFormat.type === 'json_schema') {
          // Force structured output via tool choice by passing a tool schema-like instruction
          // Since we are using HTTP raw API here, emulate with a stronger system instruction
          const schema = requestOptions.responseFormat.schema;
          const sys =
            `${systemMessage?.content || ''}\nYou MUST produce ONLY a strict JSON object matching this JSON Schema: ${JSON.stringify(schema)}\nNo extra keys, no prose.`.trim();
          requestData.system = sys;
        } else if (requestOptions.responseFormat.type === 'json_object') {
          const sys =
            `${systemMessage?.content || ''}\nYou MUST produce ONLY a strict JSON object with no additional text.`.trim();
          requestData.system = sys;
        }
      }

      const maxRetries =
        typeof this.config.maxRetries === 'number' ? this.config.maxRetries : 0;
      let attempt = 0;
      let lastError: any;
      let response: { data: AnthropicResponse } | undefined;
      while (attempt <= maxRetries) {
        try {
          response = await this.httpClient.post<AnthropicResponse>(
            '/v1/messages',
            requestData,
            requestOptions.timeout
              ? { timeout: requestOptions.timeout }
              : undefined
          );
          break;
        } catch (err: any) {
          lastError = err;
          const status = err?.response?.status;
          if (
            attempt < maxRetries &&
            (status === 429 ||
              status === 408 ||
              (status >= 500 && status < 600))
          ) {
            const backoffMs = Math.min(1000 * Math.pow(2, attempt), 8000);
            await this.sleep(backoffMs);
            attempt += 1;
            continue;
          }
          throw err;
        }
      }
      if (!response)
        throw (
          lastError || new Error('Anthropic request failed without response')
        );

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
          promptTokens:
            anthropicResponse.usage.input_tokens +
            (anthropicResponse.usage.cache_read_input_tokens || 0),
          completionTokens: anthropicResponse.usage.output_tokens,
          totalTokens:
            anthropicResponse.usage.input_tokens +
            anthropicResponse.usage.output_tokens,
          promptCachedTokens:
            anthropicResponse.usage.cache_read_input_tokens ?? null,
          promptCacheCreationTokens:
            anthropicResponse.usage.cache_creation_input_tokens ?? null,
          promptImageTokens: null,
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
   * Convert our LLMMessage format to Anthropic's format
   */
  private convertToAnthropicMessage(msg: LLMMessage): AnthropicMessage {
    // If content is already a string, return as-is
    if (typeof msg.content === 'string') {
      return {
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      };
    }

    // Convert multimodal content
    const anthropicContent: (AnthropicTextContent | AnthropicImageContent)[] =
      [];

    for (const part of msg.content) {
      if (part.type === 'text') {
        anthropicContent.push({
          type: 'text',
          text: part.text,
        });
      } else if (part.type === 'image') {
        // Convert data URI to Anthropic's format
        const url = part.imageUrl.url;
        if (url.startsWith('data:image/')) {
          const [mimeTypePart, base64Data] = url.split(',');
          const mediaType = mimeTypePart.split(':')[1].split(';')[0] as
            | 'image/png'
            | 'image/jpeg'
            | 'image/webp'
            | 'image/gif';

          anthropicContent.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType,
              data: base64Data,
            },
          });
        } else {
          // For HTTP URLs, we'd need to fetch and convert the image
          this.logger.warn(
            'Anthropic requires base64 encoded images, HTTP URLs not directly supported',
            {
              url,
            }
          );
        }
      }
    }

    return {
      role: msg.role as 'user' | 'assistant',
      content: anthropicContent,
    };
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
