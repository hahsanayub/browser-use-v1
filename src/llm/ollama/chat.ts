import { Ollama } from 'ollama';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { z } from 'zod';
import type { BaseChatModel } from '../base.js';
import type { ChatInvokeCompletion } from '../views.js';
import type { Message } from '../messages.js';
import { OllamaMessageSerializer } from './serializer.js';

export class ChatOllama implements BaseChatModel {
  public model: string;
  public provider = 'ollama';
  private client: Ollama;

  constructor(
    model: string = 'qwen2.5:latest',
    host: string = 'http://localhost:11434'
  ) {
    this.model = model;
    this.client = new Ollama({ host });
  }

  get name(): string {
    return this.model;
  }

  get model_name(): string {
    return this.model;
  }

  async ainvoke(
    messages: Message[],
    output_format?: undefined
  ): Promise<ChatInvokeCompletion<string>>;
  async ainvoke<T>(
    messages: Message[],
    output_format: { parse: (input: string) => T } | undefined
  ): Promise<ChatInvokeCompletion<T>>;
  async ainvoke<T>(
    messages: Message[],
    output_format?: { parse: (input: string) => T } | undefined
  ): Promise<ChatInvokeCompletion<T | string>> {
    const serializer = new OllamaMessageSerializer();
    const ollamaMessages = serializer.serialize(messages);

    let format: string | undefined = undefined;
    if (output_format && 'schema' in output_format && output_format.schema) {
      // Ollama supports 'json' format
      format = 'json';
    }

    const response = await this.client.chat({
      model: this.model,
      messages: ollamaMessages,
      format: format,
      stream: false,
    });

    const content = response.message.content;

    let completion: T | string = content;
    if (output_format) {
      try {
        completion = output_format.parse(JSON.parse(content));
      } catch (e) {
        console.error('Failed to parse completion', e);
        throw e;
      }
    }

    return {
      completion,
      usage: {
        promptTokens: response.prompt_eval_count ?? 0,
        completionTokens: response.eval_count ?? 0,
        totalTokens:
          (response.prompt_eval_count ?? 0) + (response.eval_count ?? 0),
      },
    };
  }
}
