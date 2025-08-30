/**
 * Azure OpenAI LLM client implementation using official OpenAI SDK
 */

import OpenAI, { AzureOpenAI } from 'openai';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { BaseLLMClient } from '../base-client';
import type {
  LLMMessage,
  LLMResponse,
  LLMRequestOptions,
  LLMClientConfig,
} from '../../types/llm';
import { SchemaOptimizer } from '../schema-optimizer';

interface AzureConfig extends LLMClientConfig {
  /** Azure OpenAI endpoint URL */
  azureEndpoint?: string;
  /** Azure OpenAI deployment name */
  azureDeployment?: string;
  /** Azure API version */
  apiVersion?: string;
  /** Azure AD token for authentication */
  azureAdToken?: string;
  /** Azure AD token provider function */
  azureAdTokenProvider?: () => Promise<string>;
}

type OpenAIMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

// Type guards for response format
function hasJsonSchema(
  format: any
): format is { type: 'json_schema'; schema: Record<string, any> } {
  return format && format.type === 'json_schema';
}

function hasZodSchema(
  format: any
): format is { type: 'zod_schema'; schema: z.ZodTypeAny } {
  return format && format.type === 'zod_schema';
}

/**
 * Azure OpenAI LLM client implementation using official OpenAI SDK
 */
export class AzureOpenAIClient extends BaseLLMClient {
  private azure: AzureOpenAI;
  private azureConfig: AzureConfig;

  constructor(config: AzureConfig) {
    super(config);
    this.azureConfig = config;

    // Get configuration from environment variables if not provided
    const azureEndpoint =
      config.azureEndpoint || process.env.AZURE_OPENAI_ENDPOINT;
    const azureDeployment =
      config.azureDeployment || process.env.AZURE_OPENAI_DEPLOYMENT;
    const apiKey = config.apiKey || process.env.AZURE_OPENAI_API_KEY;
    const apiVersion = config.apiVersion || '2024-12-01-preview';

    if (!azureEndpoint) {
      throw new Error(
        'Azure endpoint is required. Set azureEndpoint in config or AZURE_OPENAI_ENDPOINT environment variable.'
      );
    }

    if (!azureDeployment) {
      throw new Error(
        'Azure deployment is required. Set azureDeployment in config or AZURE_OPENAI_DEPLOYMENT environment variable.'
      );
    }

    if (!apiKey && !config.azureAdToken && !config.azureAdTokenProvider) {
      throw new Error(
        'Authentication is required. Provide apiKey, azureAdToken, or azureAdTokenProvider.'
      );
    }

    this.azure = new AzureOpenAI({
      apiKey: apiKey,
      endpoint: azureEndpoint,
      apiVersion: apiVersion,
      deployment: azureDeployment,
      timeout: config.timeout || 30000,
      maxRetries: config.maxRetries || 5,
      azureADTokenProvider: config.azureAdTokenProvider,
      defaultHeaders:
        config.organization || config.project
          ? {
              ...(config.organization && {
                'OpenAI-Organization': config.organization,
              }),
              ...(config.project && { 'OpenAI-Project': config.project }),
            }
          : undefined,
    });
  }

  /**
   * Generate response using Azure OpenAI API
   */
  async generateResponse(
    messages: LLMMessage[],
    options?: LLMRequestOptions
  ): Promise<LLMResponse> {
    this.validateMessages(messages);

    const requestOptions = this.mergeOptions(options);
    const startTime = Date.now();

    try {
      this.logger.debug('Sending request to Azure OpenAI', {
        model: this.config.model,
        messageCount: messages.length,
        options: requestOptions,
      });

      const openAIMessages: OpenAIMessage[] = messages.map((msg) =>
        this.convertToOpenAIMessage(msg)
      );

      const requestParams: OpenAI.Chat.Completions.ChatCompletionCreateParams =
        {
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

      // Service tier (Azure may support this in the future)
      const serviceTier = requestOptions.serviceTier || this.config.serviceTier;
      if (serviceTier) {
        (requestParams as any).service_tier = serviceTier;
      }

      // Reasoning effort (for O-series models)
      if (requestOptions.reasoningEffort) {
        (requestParams as any).reasoning = {
          effort: requestOptions.reasoningEffort,
        };
      }

      // Structured output mapping and schema processing
      let processedSchema: Record<string, any> | null = null;
      let schemaName: string | null = null;
      let hasStructuredOutput = false;

      if (requestOptions.responseFormat) {
        if (requestOptions.responseFormat.type === 'json_object') {
          requestParams.response_format = { type: 'json_object' };
        } else if (hasJsonSchema(requestOptions.responseFormat)) {
          // Handle JSON schema (existing functionality)
          const { schema, name, strict } = requestOptions.responseFormat;
          processedSchema = SchemaOptimizer.createOptimizedJsonSchema(schema);
          schemaName = name || 'ResponseSchema';
          hasStructuredOutput = true;

          requestParams.response_format = {
            type: 'json_schema',
            json_schema: {
              name: schemaName,
              schema: processedSchema,
              strict: strict !== false,
            },
          };
        } else if (hasZodSchema(requestOptions.responseFormat)) {
          // Handle Zod schema - convert once and reuse
          const jsonSchema = zodToJsonSchema(
            requestOptions.responseFormat.schema
          );
          processedSchema =
            SchemaOptimizer.createOptimizedJsonSchema(jsonSchema);
          schemaName = requestOptions.responseFormat.name || 'ZodSchema';
          hasStructuredOutput = true;

          requestParams.response_format = {
            type: 'json_schema',
            json_schema: {
              name: schemaName,
              schema: processedSchema,
              strict: true, // Always strict for Zod schemas
            },
          };
        }
      }

      // Optionally add schema to system prompt for certain models to improve adherence
      if (
        hasStructuredOutput &&
        processedSchema &&
        requestOptions.addSchemaToSystemPrompt &&
        openAIMessages.length > 0 &&
        openAIMessages[0].role === 'system'
      ) {
        const schemaText = `\n<json_schema>\n${JSON.stringify(processedSchema)}\n</json_schema>`;
        if (typeof openAIMessages[0].content === 'string') {
          openAIMessages[0].content = `${openAIMessages[0].content}${schemaText}`;
        }
      }

      const openAIResponse =
        await this.azure.chat.completions.create(requestParams);
      const requestTime = Date.now() - startTime;

      // Ensure we have a non-stream response
      if (!('choices' in openAIResponse)) {
        throw new Error('Streaming responses not supported in this method');
      }

      if (!openAIResponse.choices || openAIResponse.choices.length === 0) {
        throw new Error('No response choices returned from Azure OpenAI');
      }

      const choice = openAIResponse.choices[0];
      const usage = openAIResponse.usage;

      let content = choice.message.content || '';
      let parsedContent = null;

      // Handle structured output parsing and validation (reuse hasStructuredOutput from above)
      if (hasStructuredOutput) {
        // For structured output, try to parse JSON
        try {
          if (content) {
            parsedContent = JSON.parse(content);

            // If using Zod schema, validate the parsed content
            if (
              requestOptions.responseFormat &&
              hasZodSchema(requestOptions.responseFormat)
            ) {
              try {
                // Validate and transform using Zod schema (like Python's Pydantic validation)
                const validatedContent =
                  requestOptions.responseFormat.schema.parse(parsedContent);
                parsedContent = validatedContent;
                content = JSON.stringify(validatedContent);
              } catch (zodError) {
                this.logger.warn(
                  'Zod validation failed, using raw parsed content',
                  {
                    error: zodError,
                    parsedContent,
                  }
                );
                content = JSON.stringify(parsedContent);
              }
            } else {
              content = JSON.stringify(parsedContent);
            }
          }
        } catch (error) {
          this.logger.warn('Failed to parse structured JSON response', {
            error,
          });
          content = choice.message.content || '';
        }
      }

      const llmResponse: LLMResponse = {
        content,
        usage: usage
          ? {
              promptTokens: usage.prompt_tokens,
              promptCachedTokens:
                usage.prompt_tokens_details?.cached_tokens ?? null,
              completionTokens:
                (usage.completion_tokens || 0) +
                ((usage as any).reasoning_tokens || 0),
              totalTokens: usage.total_tokens,
              reasoningTokens: (usage as any).reasoning_tokens,
              cachedTokens: (usage as any).cached_tokens,
              promptCacheCreationTokens: null,
              promptImageTokens: null,
            }
          : undefined,
        model: openAIResponse.model,
        metadata: {
          finishReason: choice.finish_reason,
          requestTime,
          ...(parsedContent && { parsedContent }),
        },
      };

      this.logMetrics(llmResponse, requestTime, messages.length);
      return llmResponse;
    } catch (error: any) {
      if (error.status === 401) {
        throw this.handleError(error, 'Invalid API key or authentication');
      } else if (error.status === 429) {
        throw this.handleError(error, 'Rate limit exceeded');
      } else if (error.status === 400) {
        throw this.handleError(error, 'Invalid request format');
      } else {
        throw this.handleError(error, 'Azure OpenAI API request failed');
      }
    }
  }

  /**
   * Convert our LLMMessage format to OpenAI's format
   */
  private convertToOpenAIMessage(msg: LLMMessage): OpenAIMessage {
    // If content is already a string, return as-is
    if (typeof msg.content === 'string') {
      return {
        role: msg.role,
        content: msg.content,
      } as OpenAIMessage;
    }

    // Convert multimodal content
    const openAIContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] =
      [];

    for (const part of msg.content) {
      if (part.type === 'text') {
        openAIContent.push({
          type: 'text',
          text: part.text,
        });
      } else if (part.type === 'image') {
        openAIContent.push({
          type: 'image_url',
          image_url: {
            url: part.imageUrl.url,
            detail: part.imageUrl.detail,
          },
        });
      }
    }

    return {
      role: msg.role,
      content: openAIContent,
    } as OpenAIMessage;
  }

  /**
   * Validate Azure OpenAI client configuration
   */
  async validateConfig(): Promise<boolean> {
    try {
      this.logger.debug('Validating Azure OpenAI configuration');

      // Test with a simple request
      const testMessages: LLMMessage[] = [{ role: 'user', content: 'Hello' }];

      await this.generateResponse(testMessages, {
        maxTokens: 1,
        temperature: 0,
      });

      this.logger.info(
        'Azure OpenAI client configuration validated successfully'
      );
      return true;
    } catch (error) {
      this.logger.error(
        'Azure OpenAI client configuration validation failed',
        error as Error
      );
      return false;
    }
  }

  /**
   * Get supported models from Azure deployment
   */
  async getSupportedModels(): Promise<string[]> {
    try {
      // Azure typically uses deployment names, so we return the configured model
      // In a real scenario, you might want to query the Azure Management API
      return [this.config.model];
    } catch (error) {
      this.logger.warn('Failed to fetch supported models', {
        error: (error as Error).message,
      });
      return [this.config.model];
    }
  }

  /**
   * Get the provider name
   */
  get provider(): string {
    return 'azure';
  }
}
