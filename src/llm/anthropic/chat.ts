import Anthropic from '@anthropic-ai/sdk';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { BaseChatModel, ChatInvokeOptions } from '../base.js';
import { ChatInvokeCompletion, ChatInvokeUsage } from '../views.js';
import { type Message, SystemMessage } from '../messages.js';
import { AnthropicMessageSerializer } from './serializer.js';
import { ModelProviderError, ModelRateLimitError } from '../exceptions.js';

export interface ChatAnthropicOptions {
  model?: string;
  apiKey?: string;
  baseURL?: string;
  maxTokens?: number;
  temperature?: number | null;
  topP?: number | null;
  maxRetries?: number;
}

export class ChatAnthropic implements BaseChatModel {
  public model: string;
  public provider = 'anthropic';
  private client: Anthropic;
  private maxTokens: number;
  private temperature: number | null;
  private topP: number | null;

  constructor(options: ChatAnthropicOptions = {}) {
    const {
      model = 'claude-sonnet-4-20250514',
      apiKey,
      baseURL,
      maxTokens = 8192,
      temperature = null,
      topP = null,
      maxRetries = 10,
    } = options;

    this.model = model;
    this.maxTokens = maxTokens;
    this.temperature = temperature;
    this.topP = topP;

    this.client = new Anthropic({
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

  private getUsage(response: Anthropic.Message): ChatInvokeUsage {
    const cacheReadTokens =
      (response.usage as any).cache_read_input_tokens ?? 0;
    const cacheCreationTokens =
      (response.usage as any).cache_creation_input_tokens ?? 0;

    return {
      prompt_tokens: response.usage.input_tokens + cacheReadTokens,
      completion_tokens: response.usage.output_tokens,
      total_tokens: response.usage.input_tokens + response.usage.output_tokens,
      prompt_cached_tokens: cacheReadTokens || null,
      prompt_cache_creation_tokens: cacheCreationTokens || null,
      prompt_image_tokens: null,
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
    const serializer = new AnthropicMessageSerializer();
    const [anthropicMessages] = serializer.serializeMessages(messages);

    const systemMessage = messages.find(
      (msg) => msg instanceof SystemMessage
    ) as SystemMessage | undefined;
    const system = systemMessage ? systemMessage.text : undefined;

    let tools: Anthropic.Tool[] | undefined = undefined;
    let toolChoice: Anthropic.ToolChoice | undefined = undefined;

    if (output_format && 'schema' in output_format && output_format.schema) {
      // Assuming output_format is a Zod schema wrapper
      try {
        const jsonSchema = zodToJsonSchema(output_format as any, {
          name: 'Response',
          target: 'jsonSchema7',
        });

        tools = [
          {
            name: 'response',
            description: 'The response to the user request',
            input_schema: jsonSchema as any,
          },
        ];
        toolChoice = { type: 'tool', name: 'response' };
      } catch (e) {
        console.warn(
          'Failed to convert output_format to JSON schema for Anthropic',
          e
        );
      }
    }

    // Build model parameters
    const modelParams: Record<string, unknown> = {};
    if (this.temperature !== null) {
      modelParams.temperature = this.temperature;
    }
    if (this.topP !== null) {
      modelParams.top_p = this.topP;
    }

    // Add cache_control to tools if present
    if (tools && tools.length > 0) {
      tools = tools.map((tool, index) => {
        if (index === tools!.length - 1) {
          return {
            ...tool,
            cache_control: { type: 'ephemeral' },
          } as Anthropic.Tool;
        }
        return tool;
      });
    }

    try {
      const response = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: this.maxTokens,
          system: system,
          messages: anthropicMessages,
          tools: tools,
          tool_choice: toolChoice,
          ...modelParams,
        },
        options.signal ? { signal: options.signal } : undefined
      );

      let completion: T | string = '';

      // Handle tool use response
      const toolUseBlock = response.content.find(
        (block) => block.type === 'tool_use'
      );
      if (toolUseBlock && output_format) {
        completion = output_format.parse(toolUseBlock.input as any);
      } else {
        // Fallback to text content
        const textBlock = response.content.find(
          (block) => block.type === 'text'
        );
        completion = textBlock ? textBlock.text : '';
      }

      const usage = this.getUsage(response);

      return new ChatInvokeCompletion(completion, usage);
    } catch (error: any) {
      // Handle Anthropic-specific errors
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
