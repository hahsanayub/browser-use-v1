import OpenAI from 'openai';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { BaseChatModel, ChatInvokeOptions } from '../base.js';
import { ModelProviderError, ModelRateLimitError } from '../exceptions.js';
import type { Message } from '../messages.js';
import { SchemaOptimizer } from '../schema.js';
import { ChatInvokeCompletion, type ChatInvokeUsage } from '../views.js';
import { VercelMessageSerializer } from './serializer.js';

export interface ChatVercelOptions {
  model?: string;
  apiKey?: string;
  baseURL?: string;
  temperature?: number | null;
  topP?: number | null;
  seed?: number | null;
  maxRetries?: number;
  providerOptions?: Record<string, unknown> | null;
  extraBody?: Record<string, unknown> | null;
  removeMinItemsFromSchema?: boolean;
  removeDefaultsFromSchema?: boolean;
}

export class ChatVercel implements BaseChatModel {
  public model: string;
  public provider = 'vercel';
  private client: OpenAI;
  private temperature: number | null;
  private topP: number | null;
  private seed: number | null;
  private providerOptions: Record<string, unknown> | null;
  private extraBody: Record<string, unknown> | null;
  private removeMinItemsFromSchema: boolean;
  private removeDefaultsFromSchema: boolean;

  constructor(options: string | ChatVercelOptions = {}) {
    const normalizedOptions =
      typeof options === 'string' ? { model: options } : options;
    const {
      model = 'openai/gpt-4o',
      apiKey = process.env.VERCEL_API_KEY,
      baseURL = process.env.VERCEL_BASE_URL || 'https://ai-gateway.vercel.sh/v1',
      temperature = null,
      topP = null,
      seed = null,
      maxRetries = 5,
      providerOptions = null,
      extraBody = null,
      removeMinItemsFromSchema = false,
      removeDefaultsFromSchema = false,
    } = normalizedOptions;

    this.model = model;
    this.temperature = temperature;
    this.topP = topP;
    this.seed = seed;
    this.providerOptions = providerOptions;
    this.extraBody = extraBody;
    this.removeMinItemsFromSchema = removeMinItemsFromSchema;
    this.removeDefaultsFromSchema = removeDefaultsFromSchema;

    this.client = new OpenAI({
      apiKey,
      baseURL,
      maxRetries,
    });
  }

  get name(): string {
    return this.model;
  }

  get model_name(): string {
    return this.model;
  }

  private getUsage(
    response: OpenAI.Chat.Completions.ChatCompletion
  ): ChatInvokeUsage | null {
    if (!response.usage) {
      return null;
    }

    return {
      prompt_tokens: response.usage.prompt_tokens,
      prompt_cached_tokens:
        (response.usage as any).prompt_tokens_details?.cached_tokens ?? null,
      prompt_cache_creation_tokens: null,
      prompt_image_tokens: null,
      completion_tokens: response.usage.completion_tokens,
      total_tokens: response.usage.total_tokens,
    };
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
    const serializer = new VercelMessageSerializer();
    const vercelMessages = serializer.serialize(messages);

    const modelParams: Record<string, unknown> = {};
    if (this.temperature !== null) {
      modelParams.temperature = this.temperature;
    }
    if (this.topP !== null) {
      modelParams.top_p = this.topP;
    }
    if (this.seed !== null) {
      modelParams.seed = this.seed;
    }

    const zodSchemaCandidate = (() => {
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

    let responseFormat: OpenAI.Chat.Completions.ChatCompletionCreateParams['response_format'] =
      undefined;
    if (zodSchemaCandidate) {
      try {
        const rawJsonSchema = zodToJsonSchema(zodSchemaCandidate, {
          name: 'agent_output',
          target: 'jsonSchema7',
        });
        const optimizedJsonSchema = SchemaOptimizer.createOptimizedJsonSchema(
          rawJsonSchema as Record<string, unknown>,
          {
            removeMinItems: this.removeMinItemsFromSchema,
            removeDefaults: this.removeDefaultsFromSchema,
          }
        );

        responseFormat = {
          type: 'json_schema',
          json_schema: {
            name: 'agent_output',
            schema: optimizedJsonSchema as any,
            strict: true,
          },
        };
      } catch {
        responseFormat = undefined;
      }
    }

    const request: Record<string, unknown> = {
      model: this.model,
      messages: vercelMessages,
      response_format: responseFormat,
      ...modelParams,
      ...(this.extraBody ?? {}),
    };
    if (this.providerOptions) {
      request.providerOptions = this.providerOptions;
    }

    try {
      const response = await this.client.chat.completions.create(
        request as any,
        options.signal ? { signal: options.signal } : undefined
      );

      const content = response.choices[0].message.content || '';
      const usage = this.getUsage(response);
      const stopReason = response.choices[0].finish_reason ?? null;

      let completion: T | string = content;
      if (output_format) {
        if (zodSchemaCandidate) {
          const parsedJson = JSON.parse(content);
          const output = output_format as any;
          if (
            output &&
            typeof output === 'object' &&
            output.schema &&
            typeof output.schema.parse === 'function'
          ) {
            completion = output.schema.parse(parsedJson);
          } else {
            completion = (output_format as any).parse(parsedJson);
          }
        } else {
          completion = (output_format as any).parse(content);
        }
      }

      return new ChatInvokeCompletion(completion, usage, null, null, stopReason);
    } catch (error: any) {
      if (error?.status === 429) {
        throw new ModelRateLimitError(
          error?.message ?? 'Rate limit exceeded',
          429,
          this.model
        );
      }
      if (error?.status >= 500) {
        throw new ModelProviderError(
          error?.message ?? 'Server error',
          error.status,
          this.model
        );
      }
      throw new ModelProviderError(
        error?.message ?? String(error),
        error?.status ?? 500,
        this.model
      );
    }
  }
}
