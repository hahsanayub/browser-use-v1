import { AzureOpenAI } from 'openai';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { z } from 'zod';
import type { BaseChatModel } from '../base.js';
import { ChatInvokeCompletion } from '../views.js';
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
    const schemaForJson =
      output_format && 'schema' in output_format && (output_format as any).schema
        ? (output_format as any).schema
        : output_format;

    if (schemaForJson) {
      try {
        const jsonSchema = zodToJsonSchema(
          schemaForJson as unknown as z.ZodType,
          {
            name: 'Response',
            target: 'jsonSchema7',
          }
        );

        if ((jsonSchema as any)?.type === 'object') {
          responseFormat = {
            type: 'json_schema',
            json_schema: {
              name: 'Response',
              schema: jsonSchema,
              strict: true,
            },
          };
        } else {
          // Fallback: skip structured response if schema is not an object
          responseFormat = undefined;
        }
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
          let parsed: any = content;
          let jsonText = content.trim();
          const fencedMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/i);
          if (fencedMatch && fencedMatch[1]) {
            jsonText = fencedMatch[1].trim();
          }
          const firstBrace = jsonText.indexOf('{');
          const lastBrace = jsonText.lastIndexOf('}');
          if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
            jsonText = jsonText.slice(firstBrace, lastBrace + 1);
          }
          parsed = JSON.parse(jsonText);
          completion = output_format.parse(parsed);
        } else {
          // If we didn't configure a structured response, return raw content
          completion = content as any;
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
