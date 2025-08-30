/**
 * Google Gemini client implementation using @google/genai SDK.
 * Supports structured JSON output with proper Gemini schema handling.
 */

import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { BaseLLMClient } from '../base-client';
import type {
  LLMMessage,
  LLMResponse,
  LLMRequestOptions,
  LLMClientConfig,
  LLMContentPart,
} from '../../types/llm';
import { SchemaOptimizer } from '../schema-optimizer';

/**
 * Check if an error should be retried based on error message patterns.
 */
function isRetryableError(exception: any): boolean {
  const errorMsg = String(exception).toLowerCase();

  // Rate limit patterns
  const rateLimitPatterns = [
    'rate limit',
    'resource exhausted',
    'quota exceeded',
    'too many requests',
    '429',
  ];

  // Server error patterns
  const serverErrorPatterns = [
    'service unavailable',
    'internal server error',
    'bad gateway',
    '503',
    '502',
    '500',
  ];

  // Connection error patterns
  const connectionPatterns = [
    'connection',
    'timeout',
    'network',
    'unreachable',
  ];

  const allPatterns = [
    ...rateLimitPatterns,
    ...serverErrorPatterns,
    ...connectionPatterns,
  ];
  return allPatterns.some((pattern) => errorMsg.includes(pattern));
}

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

export class GoogleClient extends BaseLLMClient {
  private genai: GoogleGenAI;

  constructor(config: LLMClientConfig) {
    super(config);
    if (!config.apiKey) {
      throw new Error('Google API key is required');
    }
    this.genai = new GoogleGenAI({
      apiKey: config.apiKey,
    });
  }

  /**
   * Convert our content format to Google genai format
   */
  private convertContentToParts(content: string | LLMContentPart[]) {
    if (typeof content === 'string') {
      return [{ text: content }];
    }

    const parts = [];
    for (const part of content) {
      if (part.type === 'text') {
        parts.push({ text: part.text });
      } else if (part.type === 'image') {
        // Convert data URI to inline data format for Google
        const url = part.imageUrl.url;
        if (url.startsWith('data:image/')) {
          const [mimeTypePart, base64Data] = url.split(',');
          const mimeType = mimeTypePart.split(':')[1].split(';')[0];
          parts.push({
            inlineData: {
              mimeType,
              data: base64Data,
            },
          });
        } else {
          this.logger.warn(
            'Google Gemini requires inline data for images, HTTP URLs not directly supported',
            {
              url,
            }
          );
        }
      }
    }

    return parts;
  }

  private serializeMessages(messages: LLMMessage[]) {
    const contents = [];
    let systemInstruction = undefined;
    for (const m of messages) {
      if (m.role === 'system') {
        const systemParts = this.convertContentToParts(m.content);
        systemInstruction = { parts: systemParts };
        continue;
      }
      const parts = this.convertContentToParts(m.content);
      const role = m.role === 'assistant' ? 'model' : 'user';
      contents.push({ role, parts });
    }
    return { contents, systemInstruction };
  }

  async generateResponse(
    messages: LLMMessage[],
    options?: LLMRequestOptions
  ): Promise<LLMResponse> {
    this.validateMessages(messages);
    const requestOptions = this.mergeOptions(options);
    const start = Date.now();

    const { contents, systemInstruction } = this.serializeMessages(messages);

    // Build generation config
    const config: any = {};
    if (requestOptions.temperature != null)
      config.temperature = requestOptions.temperature;
    if (requestOptions.topP != null) config.topP = requestOptions.topP;
    if (requestOptions.seed != null) config.seed = requestOptions.seed;
    if (requestOptions.maxTokens != null)
      config.maxOutputTokens = requestOptions.maxTokens;

    // Add system instruction if present
    if (systemInstruction) {
      config.systemInstruction = systemInstruction;
    }

    // Handle structured output using responseFormat
    if (options?.responseFormat) {
      config.responseMimeType = 'application/json';

      if (hasJsonSchema(options.responseFormat)) {
        // Handle JSON schema (existing functionality)
        let processedSchema = options.responseFormat.schema;

        // Apply optimization
        const optimizedSchema =
          SchemaOptimizer.createOptimizedJsonSchema(processedSchema);

        // Apply Gemini-specific fixes
        const geminiSchema = this.fixGeminiSchema(optimizedSchema);
        config.responseSchema = geminiSchema;
      } else if (hasZodSchema(options.responseFormat)) {
        // Handle Zod schema
        // Convert Zod schema to JSON schema
        const jsonSchema = zodToJsonSchema(options.responseFormat.schema);

        // Apply optimization
        const optimizedSchema =
          SchemaOptimizer.createOptimizedJsonSchema(jsonSchema);

        // Apply Gemini-specific fixes
        const geminiSchema = this.fixGeminiSchema(optimizedSchema);
        config.responseSchema = geminiSchema;
      }
    }

    // Internal function to make the actual API call
    const makeApiCall = async (): Promise<LLMResponse> => {
      const response = await this.genai.models.generateContent({
        model: this.config.model,
        contents,
        config,
      });

      const time = Date.now() - start;

      // Extract usage metadata
      const imageTokens =
        response.usageMetadata?.promptTokensDetails
          ?.filter((d: any) => d.modality?.toUpperCase() === 'IMAGE')
          .reduce((sum: number, d: any) => sum + (d.tokenCount || 0), 0) || 0;

      let content = '';
      let parsedContent = null;

      const hasStructuredOutput =
        options?.responseFormat &&
        (hasJsonSchema(options.responseFormat) ||
          hasZodSchema(options.responseFormat));

      if (hasStructuredOutput) {
        // For structured output, try to parse JSON
        try {
          if (response.text) {
            parsedContent = JSON.parse(response.text);

            // If using Zod schema, validate the parsed content
            if (
              options?.responseFormat &&
              hasZodSchema(options.responseFormat)
            ) {
              try {
                // Validate and transform using Zod schema
                const validatedContent =
                  options.responseFormat.schema.parse(parsedContent);
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
          content = response.text || '';
        }
      } else {
        content = response.text || '';
      }

      const llmResponse: LLMResponse = {
        content,
        usage: {
          promptTokens: response.usageMetadata?.promptTokenCount || 0,
          completionTokens: response.usageMetadata?.candidatesTokenCount || 0,
          totalTokens: response.usageMetadata?.totalTokenCount || 0,
          promptCachedTokens:
            response.usageMetadata?.cachedContentTokenCount ?? null,
          promptCacheCreationTokens: null,
          promptImageTokens: imageTokens || null,
        },
        model: this.config.model,
        metadata: {
          requestTime: time,
          ...(parsedContent && { parsedContent }),
        },
      };
      this.logMetrics(llmResponse, time, messages.length);
      return llmResponse;
    };

    // Retry mechanism with exponential backoff
    let lastException: any = null;
    const maxRetries = 10;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await makeApiCall();
      } catch (error: any) {
        lastException = error;

        // Don't retry on non-retryable errors or last attempt
        if (!isRetryableError(error) || attempt === maxRetries - 1) {
          break;
        }

        // Exponential backoff with cap at 60 seconds
        const delay = Math.min(60.0, 1.0 * Math.pow(2.0, attempt));
        this.logger.warn(
          `Google API request failed (attempt ${attempt + 1}/${maxRetries}), retrying in ${delay}s`,
          {
            error: error.message,
            attempt: attempt + 1,
            maxRetries,
          }
        );

        await new Promise((resolve) => setTimeout(resolve, delay * 1000));
      }
    }

    // Handle the final error with enhanced error detection
    if (lastException) {
      const errorMessage = String(lastException);
      let statusCode: number | null = null;

      // Check for rate limit errors
      if (
        [
          'rate limit',
          'resource exhausted',
          'quota exceeded',
          'too many requests',
          '429',
        ].some((indicator) => errorMessage.toLowerCase().includes(indicator))
      ) {
        statusCode = 429;
      }
      // Check for server errors
      else if (
        [
          'service unavailable',
          'internal server error',
          'bad gateway',
          '503',
          '502',
          '500',
        ].some((indicator) => errorMessage.toLowerCase().includes(indicator))
      ) {
        statusCode = 503;
      }

      // Try to extract status code from response if available
      if (lastException?.response?.status) {
        statusCode = lastException.response.status;
      }

      const enhancedMessage =
        lastException?.response?.data?.error?.message ||
        lastException.message ||
        'Google request failed after all retries';

      this.logger.error(
        `Google API request failed after all retries: ${enhancedMessage} (status: ${statusCode}, retries: ${maxRetries})`
      );

      throw this.handleError(lastException, enhancedMessage);
    }

    // This should never happen, but ensure we don't return undefined
    throw new Error('All retry attempts failed without exception');
  }

  /**
   * Fix Gemini schema to be compatible with Google's requirements.
   */
  private fixGeminiSchema(schema: Record<string, any>): Record<string, any> {
    // Handle $defs and $ref resolution
    if (schema.$defs) {
      const defs = schema.$defs;
      delete schema.$defs;

      const resolveRefs = (obj: any): any => {
        if (typeof obj === 'object' && obj !== null) {
          if (Array.isArray(obj)) {
            return obj.map(resolveRefs);
          }

          const result: any = {};
          for (const [key, value] of Object.entries(obj)) {
            if (key === '$ref' && typeof value === 'string') {
              const refName = value.split('/').pop();
              if (refName && defs[refName]) {
                // Replace the reference with the actual definition
                const resolved = { ...defs[refName] };
                // Merge any additional properties from the reference
                for (const [objKey, objValue] of Object.entries(obj)) {
                  if (objKey !== '$ref') {
                    resolved[objKey] = objValue;
                  }
                }
                return resolveRefs(resolved);
              }
              result[key] = value;
            } else {
              result[key] = resolveRefs(value);
            }
          }
          return result;
        }
        return obj;
      };

      schema = resolveRefs(schema);
    }

    // Remove unsupported properties
    const cleanSchema = (obj: any): any => {
      if (typeof obj === 'object' && obj !== null) {
        if (Array.isArray(obj)) {
          return obj.map(cleanSchema);
        }

        const cleaned: any = {};
        for (const [key, value] of Object.entries(obj)) {
          // Remove unsupported properties for Google Gemini API
          const unsupportedFields = [
            'additionalProperties',
            'title',
            'default',
            'exclusiveMinimum',
            'exclusiveMaximum',
            '$schema',
          ];

          if (!unsupportedFields.includes(key)) {
            const cleanedValue = cleanSchema(value);

            // Handle empty object properties - Gemini doesn't allow empty OBJECT types
            if (
              key === 'properties' &&
              typeof cleanedValue === 'object' &&
              cleanedValue !== null &&
              Object.keys(cleanedValue).length === 0 &&
              typeof obj.type === 'string' &&
              obj.type.toUpperCase() === 'OBJECT'
            ) {
              // Convert empty object to have at least one property
              cleaned[key] = { _placeholder: { type: 'string' } };
            } else {
              cleaned[key] = cleanedValue;
            }
          }
        }

        // If this is an object type with empty properties, add a placeholder
        if (
          typeof cleaned.type === 'string' &&
          cleaned.type.toUpperCase() === 'OBJECT' &&
          cleaned.properties &&
          typeof cleaned.properties === 'object' &&
          Object.keys(cleaned.properties).length === 0
        ) {
          cleaned.properties = { _placeholder: { type: 'string' } };
        }

        return cleaned;
      }
      return obj;
    };

    return cleanSchema(schema);
  }

  async validateConfig(): Promise<boolean> {
    return true;
  }
}
