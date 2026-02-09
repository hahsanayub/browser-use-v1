import { GoogleGenAI } from '@google/genai';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { BaseChatModel, ChatInvokeOptions } from '../base.js';
import { ModelProviderError } from '../exceptions.js';
import { ChatInvokeCompletion, type ChatInvokeUsage } from '../views.js';
import type { Message } from '../messages.js';
import { GoogleMessageSerializer } from './serializer.js';

export interface ChatGoogleOptions {
  model?: string;
  apiKey?: string;
  apiVersion?: string;
  baseUrl?: string;
  temperature?: number | null;
  topP?: number | null;
  seed?: number | null;
  maxOutputTokens?: number | null;
  includeSystemInUser?: boolean;
  supportsStructuredOutput?: boolean;
}

export class ChatGoogle implements BaseChatModel {
  public model: string;
  public provider = 'google';
  private client: GoogleGenAI;
  private temperature: number | null;
  private topP: number | null;
  private seed: number | null;
  private maxOutputTokens: number | null;
  private includeSystemInUser: boolean;
  private supportsStructuredOutput: boolean;

  constructor(options: string | ChatGoogleOptions = {}) {
    const normalizedOptions =
      typeof options === 'string' ? { model: options } : options;
    const {
      model = 'gemini-2.5-flash',
      apiKey = process.env.GOOGLE_API_KEY || '',
      apiVersion = process.env.GOOGLE_API_VERSION || 'v1',
      baseUrl = process.env.GOOGLE_API_BASE_URL,
      temperature = 0.5,
      topP = null,
      seed = null,
      maxOutputTokens = 8096,
      includeSystemInUser = false,
      supportsStructuredOutput = true,
    } = normalizedOptions;

    this.model = model;
    this.temperature = temperature;
    this.topP = topP;
    this.seed = seed;
    this.maxOutputTokens = maxOutputTokens;
    this.includeSystemInUser = includeSystemInUser;
    this.supportsStructuredOutput = supportsStructuredOutput;

    this.client = new GoogleGenAI({
      apiKey,
      ...(baseUrl ? { baseUrl } : {}),
      ...(apiVersion ? { apiVersion } : {}),
    });
  }

  get name(): string {
    return this.model;
  }

  get model_name(): string {
    return this.model;
  }

  private getUsage(result: any): ChatInvokeUsage | null {
    const usage = result?.usageMetadata;
    if (!usage) {
      return null;
    }

    let imageTokens = 0;
    const promptTokenDetails = Array.isArray(usage.promptTokensDetails)
      ? usage.promptTokensDetails
      : [];
    for (const detail of promptTokenDetails) {
      if (String(detail?.modality ?? '').toUpperCase() === 'IMAGE') {
        imageTokens += Number(detail?.tokenCount ?? 0) || 0;
      }
    }

    const completionTokens =
      (Number(usage.candidatesTokenCount ?? 0) || 0) +
      (Number(usage.thoughtsTokenCount ?? 0) || 0);

    return {
      prompt_tokens: Number(usage.promptTokenCount ?? 0) || 0,
      prompt_cached_tokens:
        usage.cachedContentTokenCount == null
          ? null
          : Number(usage.cachedContentTokenCount),
      prompt_cache_creation_tokens: null,
      prompt_image_tokens: imageTokens,
      completion_tokens: completionTokens,
      total_tokens: Number(usage.totalTokenCount ?? 0) || 0,
    };
  }

  /**
   * Clean up JSON schema for Google's format
   * Google API has specific requirements for responseSchema
   */
  private _cleanSchemaForGoogle(schema: any): any {
    if (!schema || typeof schema !== 'object') {
      return schema;
    }

    const cleaned: any = {};

    for (const [key, value] of Object.entries(schema)) {
      // Skip unsupported keys
      if (
        key === '$schema' ||
        key === 'additionalProperties' ||
        key === '$ref' ||
        key === 'definitions'
      ) {
        continue;
      }

      if (key === 'properties' && typeof value === 'object') {
        cleaned.properties = {};
        for (const [propKey, propValue] of Object.entries(value as object)) {
          cleaned.properties[propKey] = this._cleanSchemaForGoogle(propValue);
        }
      } else if (key === 'items' && typeof value === 'object') {
        cleaned.items = this._cleanSchemaForGoogle(value);
      } else if (typeof value === 'object' && !Array.isArray(value)) {
        cleaned[key] = this._cleanSchemaForGoogle(value);
      } else {
        cleaned[key] = value;
      }
    }

    return cleaned;
  }

  async ainvoke(
    messages: Message[],
    output_format?: undefined,
    options?: ChatInvokeOptions
  ): Promise<ChatInvokeCompletion<string>>;
  async ainvoke<T>(
    messages: Message[],
    output_format: { parse: (input: string) => T } | undefined,
    options?: ChatInvokeOptions
  ): Promise<ChatInvokeCompletion<T>>;
  async ainvoke<T>(
    messages: Message[],
    output_format?: { parse: (input: string) => T } | undefined,
    options: ChatInvokeOptions = {}
  ): Promise<ChatInvokeCompletion<T | string>> {
    const serializer = new GoogleMessageSerializer();
    const { contents, systemInstruction } = serializer.serializeWithSystem(
      messages,
      this.includeSystemInUser
    );

    const generationConfig: any = {};
    if (this.temperature !== null) {
      generationConfig.temperature = this.temperature;
    }
    if (this.topP !== null) {
      generationConfig.topP = this.topP;
    }
    if (this.seed !== null) {
      generationConfig.seed = this.seed;
    }
    if (this.maxOutputTokens !== null) {
      generationConfig.maxOutputTokens = this.maxOutputTokens;
    }

    // Try to get schema from output_format
    const schemaForJson = (() => {
      const output = output_format as any;
      if (
        output &&
        typeof output === 'object' &&
        typeof output.safeParse === 'function' &&
        typeof output.parse === 'function'
      ) {
        return output;
      }
      if (
        output &&
        typeof output === 'object' &&
        output.schema &&
        typeof output.schema.safeParse === 'function' &&
        typeof output.schema.parse === 'function'
      ) {
        return output.schema;
      }
      return null;
    })();

    if (schemaForJson && this.supportsStructuredOutput) {
      try {
        const jsonSchema = zodToJsonSchema(schemaForJson as any);
        // Clean up the schema for Google's format
        const cleanSchema = this._cleanSchemaForGoogle(jsonSchema);
        generationConfig.responseMimeType = 'application/json';
        generationConfig.responseSchema = cleanSchema;
      } catch {
        // Continue without responseSchema fallback.
      }
    }

    const request: any = {
      model: this.model,
      contents,
    };

    if (systemInstruction && !this.includeSystemInUser) {
      request.systemInstruction = {
        role: 'system',
        parts: [{ text: systemInstruction }],
      };
    }

    if (Object.keys(generationConfig).length > 0) {
      request.generationConfig = generationConfig;
    }

    try {
      const result = await (this.client.models as any).generateContent(
        request,
        options.signal ? { signal: options.signal } : undefined
      );

      // Extract text from first candidate
      const candidate = result.candidates?.[0];
      const textParts = candidate?.content?.parts?.filter((p: any) => p.text) || [];
      const text = textParts.map((p: any) => p.text).join('');

      let completion: T | string = text;

      try {
        let parsed: any = text;

        if (output_format && schemaForJson && this.supportsStructuredOutput) {
          let jsonText = String(text ?? '').trim();

          // Handle markdown code fences like ```json ... ```
          const fencedMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/i);
          if (fencedMatch && fencedMatch[1]) {
            jsonText = fencedMatch[1].trim();
          }

          // Try to extract JSON object from text
          const firstBrace = jsonText.indexOf('{');
          const lastBrace = jsonText.lastIndexOf('}');
          if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
            jsonText = jsonText.slice(firstBrace, lastBrace + 1);
          } else {
            // If no JSON object found, the model returned plain text
            // Try to wrap it in a minimal valid structure
            console.warn(
              'Google LLM returned plain text instead of JSON. Raw response:',
              text.slice(0, 200)
            );
            throw new Error(
              `Expected JSON response but got plain text: "${text.slice(0, 50)}..."`
            );
          }

          parsed = JSON.parse(jsonText);
        }

        if (output_format) {
          const output = output_format as any;
          if (
            schemaForJson &&
            output &&
            typeof output === 'object' &&
            output.schema &&
            typeof output.schema.parse === 'function'
          ) {
            completion = output.schema.parse(parsed);
          } else {
            completion = output.parse(parsed);
          }
        }
      } catch (error) {
        throw error;
      }

      return new ChatInvokeCompletion(completion, this.getUsage(result));
    } catch (error: any) {
      throw new ModelProviderError(
        error?.message ?? String(error),
        error?.status ?? 500,
        this.model
      );
    }
  }
}
