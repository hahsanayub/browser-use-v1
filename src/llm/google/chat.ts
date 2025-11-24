import {
  GoogleGenAI,
  type Tool,
} from '@google/genai';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { z } from 'zod';
import type { BaseChatModel } from '../base.js';
import { ChatInvokeCompletion } from '../views.js';
import { type Message, SystemMessage } from '../messages.js';
import { GoogleMessageSerializer } from './serializer.js';

export class ChatGoogle implements BaseChatModel {
  public model: string;
  public provider = 'google';
  private client: GoogleGenAI;

  constructor(model: string = 'gemini-1.5-pro') {
    this.model = model;
    this.client = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY || '' });
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
    const serializer = new GoogleMessageSerializer();
    const contents = serializer.serialize(messages);

    const systemMessage = messages.find(
      (msg) => msg instanceof SystemMessage
    ) as SystemMessage | undefined;
    const systemInstruction = systemMessage ? systemMessage.text : undefined;

    let tools: Tool[] | undefined = undefined;
    let toolConfig: any = undefined;

    if (output_format && 'schema' in output_format && output_format.schema) {
      try {
        const jsonSchema = zodToJsonSchema(
          output_format as unknown as z.ZodType,
          {
            name: 'Response',
            target: 'jsonSchema7',
          }
        );

        // Google GenAI uses a specific format for function calling or structured output
        // For now, we'll use function calling to enforce structure if possible, or just prompt engineering.
        // But Gemini 1.5 Pro supports responseSchema in generationConfig.
      } catch (e) {
        console.warn(
          'Failed to convert output_format to JSON schema for Google',
          e
        );
      }
    }

    const config: any = {
      systemInstruction: systemInstruction,
    };

    if (output_format && 'schema' in output_format && output_format.schema) {
      try {
        const jsonSchema = zodToJsonSchema(
          output_format as unknown as z.ZodType
        );
        config.responseMimeType = 'application/json';
        config.responseSchema = jsonSchema;
      } catch (e) {
        console.warn('Failed to set responseSchema', e);
      }
    }

    const result = await this.client.models.generateContent({
      model: this.model,
      contents,
      config,
    });

    // Extract text from first candidate
    const candidate = result.candidates?.[0];
    const textParts = candidate?.content?.parts?.filter((p: any) => p.text) || [];
    const text = textParts.map((p: any) => p.text).join('');

    let completion: T | string = text;

    if (output_format) {
      try {
        if (config.responseMimeType === 'application/json') {
          completion = output_format.parse(JSON.parse(text));
        } else {
          completion = output_format.parse(text);
        }
      } catch (e) {
        console.error('Failed to parse completion', e);
        throw e;
      }
    }

    return new ChatInvokeCompletion(
      completion,
      {
        prompt_tokens: result.usageMetadata?.promptTokenCount ?? 0,
        completion_tokens: result.usageMetadata?.candidatesTokenCount ?? 0,
        total_tokens: result.usageMetadata?.totalTokenCount ?? 0,
      }
    );
  }
}
