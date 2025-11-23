import { AzureOpenAI } from 'openai';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { z } from 'zod';
import type { BaseChatModel } from '../base.js';
import type { ChatInvokeCompletion } from '../views.js';
import type { Message } from '../messages.js';
import { OpenAIMessageSerializer } from '../openai/serializer.js';

export class ChatAzure implements BaseChatModel {
  public model: string;
  public provider = 'azure';
  private client: AzureOpenAI;

  constructor(model: string = 'gpt-4o') {
    this.model = model;
    this.client = new AzureOpenAI({
      apiKey: process.env.AZURE_OPENAI_API_KEY,
      endpoint: process.env.AZURE_OPENAI_ENDPOINT,
      apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-05-01-preview',
      deployment: model,
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

    let responseFormat: any = undefined;
    if (output_format && 'schema' in output_format && output_format.schema) {
      try {
        const jsonSchema = zodToJsonSchema(
          output_format as unknown as z.ZodType,
          {
            name: 'Response',
            target: 'jsonSchema7',
          }
        );

        responseFormat = {
          type: 'json_schema',
          json_schema: {
            name: 'Response',
            schema: jsonSchema,
            strict: true,
          },
        };
      } catch (e) {
        console.warn(
          'Failed to convert output_format to JSON schema for Azure',
          e
        );
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

    return {
      completion,
      usage: {
        promptTokens: response.usage?.prompt_tokens ?? 0,
        completionTokens: response.usage?.completion_tokens ?? 0,
        totalTokens: response.usage?.total_tokens ?? 0,
      },
    };
  }
}
