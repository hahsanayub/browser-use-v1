import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/index.mjs';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { z } from 'zod';
import type { BaseChatModel, ChatInvokeOptions } from '../base.js';
import { ChatInvokeCompletion, ChatInvokeUsage } from '../views.js';
import type { Message } from '../messages.js';
import { OpenAIMessageSerializer } from './serializer.js';
import { ModelProviderError } from '../exceptions.js';

// Reasoning models that support reasoning_effort parameter
const ReasoningModels = [
  'o4-mini',
  'o3',
  'o3-mini',
  'o1',
  'o1-pro',
  'o3-pro',
  'gpt-5',
  'gpt-5-mini',
  'gpt-5-nano',
];

export interface ChatOpenAIOptions {
  model?: string;
  apiKey?: string;
  organization?: string;
  baseURL?: string;
  temperature?: number | null;
  frequencyPenalty?: number | null;
  reasoningEffort?: 'low' | 'medium' | 'high';
  maxCompletionTokens?: number | null;
  maxRetries?: number;
  seed?: number | null;
  topP?: number | null;
  addSchemaToSystemPrompt?: boolean;
}

export class ChatOpenAI implements BaseChatModel {
  public model: string;
  public provider = 'openai';
  private client: OpenAI;
  private temperature: number | null;
  private frequencyPenalty: number | null;
  private reasoningEffort: 'low' | 'medium' | 'high';
  private maxCompletionTokens: number | null;
  private seed: number | null;
  private topP: number | null;
  private addSchemaToSystemPrompt: boolean;

  constructor(options: ChatOpenAIOptions = {}) {
    const {
      model = 'gpt-4o',
      apiKey,
      organization,
      baseURL,
      temperature = 0.2,
      frequencyPenalty = 0.1,
      reasoningEffort = 'low',
      maxCompletionTokens = 8000,
      maxRetries = 10,
      seed = null,
      topP = null,
      addSchemaToSystemPrompt = false,
    } = options;

    this.model = model;
    this.temperature = temperature;
    this.frequencyPenalty = frequencyPenalty;
    this.reasoningEffort = reasoningEffort;
    this.maxCompletionTokens = maxCompletionTokens;
    this.seed = seed;
    this.topP = topP;
    this.addSchemaToSystemPrompt = addSchemaToSystemPrompt;

    this.client = new OpenAI({
      apiKey,
      organization,
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

  private isReasoningModel(): boolean {
    return ReasoningModels.some(
      (m) => this.model.toLowerCase().includes(m.toLowerCase())
    );
  }

  private getUsage(response: OpenAI.Chat.Completions.ChatCompletion): ChatInvokeUsage | null {
    if (!response.usage) return null;

    let completionTokens = response.usage.completion_tokens;
    const details = (response.usage as any).completion_tokens_details;
    if (details?.reasoning_tokens) {
      completionTokens += details.reasoning_tokens;
    }

    return {
      prompt_tokens: response.usage.prompt_tokens,
      prompt_cached_tokens: (response.usage as any).prompt_tokens_details?.cached_tokens ?? null,
      prompt_cache_creation_tokens: null,
      prompt_image_tokens: null,
      completion_tokens: completionTokens,
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
    const serializer = new OpenAIMessageSerializer();
    const openaiMessages = serializer.serialize(messages);

    // Build model parameters
    const modelParams: Record<string, unknown> = {};

    if (!this.isReasoningModel()) {
      // Regular models support temperature and frequency_penalty
      if (this.temperature !== null) {
        modelParams.temperature = this.temperature;
      }
      if (this.frequencyPenalty !== null) {
        modelParams.frequency_penalty = this.frequencyPenalty;
      }
    } else {
      // Reasoning models use reasoning_effort instead
      modelParams.reasoning_effort = this.reasoningEffort;
    }

    if (this.maxCompletionTokens !== null) {
      modelParams.max_completion_tokens = this.maxCompletionTokens;
    }
    if (this.seed !== null) {
      modelParams.seed = this.seed;
    }
    if (this.topP !== null) {
      modelParams.top_p = this.topP;
    }

    let responseFormat: OpenAI.Chat.Completions.ChatCompletionCreateParams['response_format'] =
      undefined;
    if (output_format && 'schema' in output_format && output_format.schema) {
      // Assuming output_format is a Zod schema wrapper or similar that has a schema property
      // But the interface says { parse: ... }
      // In the plan, it was passed as a Zod schema directly.
      // However, the BaseChatModel interface I saw earlier has:
      // ainvoke<T>(messages: Message[], output_format: { parse: (input: string) => T } | undefined): Promise<ChatInvokeCompletion<T>>;
      // So I need to handle how to extract the schema if I want to use structured outputs.
      // If output_format is just a Zod schema, it has a parse method.
      // Let's assume it's a Zod schema for now, as that's what the plan implies.

      // We need to cast it to any or check if it's a Zod schema to get the schema for JSON schema generation.
      // For now, I'll try to use zodToJsonSchema on it if possible.
      try {
        const jsonSchema = zodToJsonSchema(
          output_format as unknown as z.ZodType,
          {
            name: 'Response',
            target: 'jsonSchema7',
          }
        );

        // OpenAI expects a specific format for json_schema
        responseFormat = {
          type: 'json_schema',
          json_schema: {
            name: 'Response',
            schema: jsonSchema as any,
            strict: true,
          },
        };
      } catch (e) {
        // If it's not a Zod schema or fails, we might fallback or just not use response_format
        console.warn('Failed to convert output_format to JSON schema', e);
      }
    }

    try {
      const response = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: openaiMessages,
          response_format: responseFormat,
          ...modelParams,
        },
        options.signal ? { signal: options.signal } : undefined
      );

      const content = response.choices[0].message.content || '';
      const usage = this.getUsage(response);

      let completion: T | string = content;
      if (output_format) {
        try {
          // If it's structured output, we need to parse the JSON first
          if (responseFormat?.type === 'json_schema') {
            const parsedJson = JSON.parse(content);
            completion = output_format.parse(parsedJson);
          } else {
            // If it's not structured output but we have a parser (e.g. for simple types or manual parsing)
            // But usually for OpenAI we want structured output if a schema is provided.
            // If we didn't use json_schema, we might still try to parse if it looks like JSON?
            // For now, let's trust the output_format.parse
            completion = output_format.parse(content);
          }
        } catch (e) {
          console.error('Failed to parse completion', e);
          throw e;
        }
      }

      return new ChatInvokeCompletion(completion, usage);
    } catch (error: any) {
      // Handle OpenAI-specific errors
      if (error?.status === 429) {
        throw new ModelProviderError(
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
