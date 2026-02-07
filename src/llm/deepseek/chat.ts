import OpenAI from 'openai';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { z } from 'zod';
import type { BaseChatModel, ChatInvokeOptions } from '../base.js';
import { ChatInvokeCompletion } from '../views.js';
import type { Message } from '../messages.js';
import { DeepSeekMessageSerializer } from './serializer.js';

export class ChatDeepSeek implements BaseChatModel {
  public model: string;
  public provider = 'deepseek';
  private client: OpenAI;

  constructor(model: string = 'deepseek-chat') {
    this.model = model;
    this.client = new OpenAI({
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseURL: 'https://api.deepseek.com',
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
    const serializer = new DeepSeekMessageSerializer();
    const deepseekMessages = serializer.serialize(messages);

    let responseFormat: OpenAI.Chat.Completions.ChatCompletionCreateParams['response_format'] =
      undefined;
    if (output_format && 'schema' in output_format && output_format.schema) {
      // DeepSeek supports json_object
      responseFormat = { type: 'json_object' };
    }

    const response = await this.client.chat.completions.create(
      {
        model: this.model,
        messages: deepseekMessages,
        response_format: responseFormat,
      },
      options.signal ? { signal: options.signal } : undefined
    );

    const content = response.choices[0].message.content || '';

    let completion: T | string = content;
    if (output_format) {
      try {
        completion = output_format.parse(JSON.parse(content));
      } catch (e) {
        console.error('Failed to parse completion', e);
        throw e;
      }
    }

    return new ChatInvokeCompletion(
      completion,
      {
        prompt_tokens: response.usage?.prompt_tokens ?? 0,
        completion_tokens: response.usage?.completion_tokens ?? 0,
        total_tokens: response.usage?.total_tokens ?? 0,
      }
    );
  }
}
