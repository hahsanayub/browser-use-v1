import { Ollama, type ChatResponse } from 'ollama';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { z } from 'zod';
import type { BaseChatModel, ChatInvokeOptions } from '../base.js';
import { ChatInvokeCompletion } from '../views.js';
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
    const serializer = new OllamaMessageSerializer();
    const ollamaMessages = serializer.serialize(messages);

    let format: string | undefined = undefined;
    if (output_format && 'schema' in output_format && output_format.schema) {
      // Ollama supports 'json' format
      format = 'json';
    }

    const requestPromise: Promise<ChatResponse> = this.client.chat({
      model: this.model,
      messages: ollamaMessages,
      format: format,
      stream: false,
    });

    const abortSignal = options.signal;
    const response = abortSignal
      ? await new Promise<ChatResponse>((resolve, reject) => {
          const onAbort = () => {
            cleanup();
            const error = new Error('Operation aborted');
            error.name = 'AbortError';
            reject(error);
          };

          const cleanup = () => {
            abortSignal.removeEventListener('abort', onAbort);
          };

          if (abortSignal.aborted) {
            onAbort();
            return;
          }

          abortSignal.addEventListener('abort', onAbort, { once: true });
          requestPromise
            .then((result) => {
              cleanup();
              resolve(result);
            })
            .catch((error) => {
              cleanup();
              reject(error);
            });
        })
      : await requestPromise;

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

    return new ChatInvokeCompletion(completion, {
      prompt_tokens: response.prompt_eval_count ?? 0,
      completion_tokens: response.eval_count ?? 0,
      total_tokens:
        (response.prompt_eval_count ?? 0) + (response.eval_count ?? 0),
    });
  }
}
