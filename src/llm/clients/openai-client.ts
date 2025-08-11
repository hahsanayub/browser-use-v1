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
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens: number;
    total_tokens: number;
    reasoning_tokens?: number;
    cached_tokens?: number;
  };
  model: string;
}

/**
 * OpenAI LLM client implementation
 */
export class OpenAIClient extends BaseLLMClient {
  private httpClient: AxiosInstance;
  private async sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  constructor(config: LLMClientConfig) {
    super(config);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    };
    if (config.organization)
      headers['OpenAI-Organization'] = config.organization;
    if (config.project) headers['OpenAI-Project'] = config.project;

    this.httpClient = axios.create({
      baseURL: config.baseUrl || 'https://api.openai.com/v1',
      timeout: config.timeout || 30000,
      headers,
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

      const requestData: Record<string, any> = {
        model: this.config.model,
        messages: openAIMessages,
        max_tokens: requestOptions.maxTokens,
        temperature: requestOptions.temperature,
        stop: requestOptions.stop,
        top_p: requestOptions.topP,
        frequency_penalty: requestOptions.frequencyPenalty,
        presence_penalty: requestOptions.presencePenalty,
        seed: requestOptions.seed,
        stream: requestOptions.stream,
      };

      // Service tier and reasoning effort (for compatible models)
      const serviceTier = requestOptions.serviceTier || this.config.serviceTier;
      if (serviceTier) requestData.service_tier = serviceTier;
      if (requestOptions.reasoningEffort) {
        requestData.reasoning = { effort: requestOptions.reasoningEffort };
      }

      // Structured output mapping
      if (requestOptions.responseFormat) {
        if (requestOptions.responseFormat.type === 'json_object') {
          requestData.response_format = { type: 'json_object' };
        } else if (requestOptions.responseFormat.type === 'json_schema') {
          const { schema, name, strict } = requestOptions.responseFormat;
          requestData.response_format = {
            type: 'json_schema',
            json_schema: {
              name: name || 'ResponseSchema',
              schema,
              strict: strict !== false,
            },
          };
        } else {
          // text: no special format
        }
      }

      // Optionally add schema to system prompt for certain models to improve adherence
      if (
        requestOptions.responseFormat?.type === 'json_schema' &&
        requestOptions.addSchemaToSystemPrompt &&
        openAIMessages.length > 0 &&
        openAIMessages[0].role === 'system'
      ) {
        const schemaText = `\n<json_schema>\n${JSON.stringify(requestOptions.responseFormat.schema)}\n</json_schema>`;
        openAIMessages[0].content = `${openAIMessages[0].content}${schemaText}`;
        requestData.messages = openAIMessages;
      }

      const maxRetries =
        typeof this.config.maxRetries === 'number' ? this.config.maxRetries : 0;
      let attempt = 0;
      let lastError: any;
      let response: { data: OpenAIResponse } | undefined;
      while (attempt <= maxRetries) {
        try {
          response = await this.httpClient.post<OpenAIResponse>(
            '/chat/completions',
            requestData,
            requestOptions.timeout
              ? { timeout: requestOptions.timeout }
              : undefined
          );
          break;
        } catch (err: any) {
          lastError = err;
          // Retry on 429, 408, 5xx
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
        throw lastError || new Error('OpenAI request failed without response');

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
          promptCachedTokens:
            openAIResponse.usage.prompt_tokens_details?.cached_tokens ?? null,
          completionTokens:
            (openAIResponse.usage.completion_tokens || 0) +
            (openAIResponse.usage.reasoning_tokens || 0),
          totalTokens: openAIResponse.usage.total_tokens,
          reasoningTokens: openAIResponse.usage.reasoning_tokens,
          cachedTokens: openAIResponse.usage.cached_tokens,
          promptCacheCreationTokens: null,
          promptImageTokens: null,
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
