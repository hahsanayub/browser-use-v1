import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/index.mjs';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { z } from 'zod';
import type { BaseChatModel } from '../base.js';
import { ChatInvokeCompletion } from '../views.js';
import type { Message } from '../messages.js';
import { OpenAIMessageSerializer } from './serializer.js';

export class ChatOpenAI implements BaseChatModel {
  public model: string;
  public provider = 'openai';
  private client: OpenAI;

  constructor(model: string = 'gpt-4o') {
    this.model = model;
    this.client = new OpenAI();
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
    const serializer = new OpenAIMessageSerializer();
    const openaiMessages = serializer.serialize(messages);

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

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: openaiMessages,
      response_format: responseFormat,
    });

    const content = response.choices[0].message.content || '';

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
