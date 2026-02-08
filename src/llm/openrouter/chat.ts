import OpenAI from 'openai';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { BaseChatModel, ChatInvokeOptions } from '../base.js';
import { ChatInvokeCompletion } from '../views.js';
import type { Message } from '../messages.js';
import { OpenRouterMessageSerializer } from './serializer.js';

export class ChatOpenRouter implements BaseChatModel {
  public model: string;
  public provider = 'openrouter';
  private client: OpenAI;

  constructor(model: string = 'openai/gpt-4o') {
    this.model = model;
    this.client = new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: 'https://openrouter.ai/api/v1',
    });
  }

  get name(): string {
    return this.model;
  }

  get model_name(): string {
    return this.model;
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
    const serializer = new OpenRouterMessageSerializer();
    const openRouterMessages = serializer.serialize(messages);

    let responseFormat: OpenAI.Chat.Completions.ChatCompletionCreateParams['response_format'] =
      undefined;
    if (output_format && 'schema' in output_format && output_format.schema) {
      // OpenRouter supports structured outputs for some models, but it depends on the underlying provider.
      // We'll try to use json_schema if possible, or json_object.
      try {
        const jsonSchema = zodToJsonSchema(output_format as any, {
          name: 'Response',
          target: 'jsonSchema7',
        });

        responseFormat = {
          type: 'json_schema',
          json_schema: {
            name: 'Response',
            schema: jsonSchema as any,
            strict: true,
          },
        };
      } catch (e) {
        console.warn(
          'Failed to convert output_format to JSON schema for OpenRouter',
          e
        );
      }
    }

    const response = await this.client.chat.completions.create(
      {
        model: this.model,
        messages: openRouterMessages,
        response_format: responseFormat,
      },
      options.signal ? { signal: options.signal } : undefined
    );

    const content = response.choices[0].message.content || '';

    let completion: T | string = content;
    if (output_format) {
      try {
        if (responseFormat?.type === 'json_schema') {
          completion = output_format.parse(JSON.parse(content));
        } else {
          completion = output_format.parse(content);
        }
      } catch (e) {
        console.error('Failed to parse completion', e);
        throw e;
      }
    }

    return new ChatInvokeCompletion(completion, {
      prompt_tokens: response.usage?.prompt_tokens ?? 0,
      completion_tokens: response.usage?.completion_tokens ?? 0,
      total_tokens: response.usage?.total_tokens ?? 0,
    });
  }
}
