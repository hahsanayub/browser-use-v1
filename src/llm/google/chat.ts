import { GoogleGenAI, type Tool } from '@google/genai';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { z } from 'zod';
import type { BaseChatModel, ChatInvokeOptions } from '../base.js';
import { ChatInvokeCompletion } from '../views.js';
import { type Message, SystemMessage } from '../messages.js';
import { GoogleMessageSerializer } from './serializer.js';

export class ChatGoogle implements BaseChatModel {
  public model: string;
  public provider = 'google';
  private client: GoogleGenAI;

  constructor(model: string = 'gemini-2.5-flash') {
    this.model = model;
    const apiVersion = process.env.GOOGLE_API_VERSION || 'v1';
    const baseUrl = process.env.GOOGLE_API_BASE_URL;

    this.client = new GoogleGenAI({
      apiKey: process.env.GOOGLE_API_KEY || '',
      ...(baseUrl ? { baseUrl } : {}),
      ...(apiVersion ? { apiVersion } : {}),
    });
  }

  get name(): string {
    return this.model;
  }

  get model_name(): string {
    return this.model;
  }

  /**
   * Clean up JSON schema for Google's format
   * Google API has specific requirements for responseSchema
   */
  private _cleanSchemaForGoogle(schema: any): any {
    if (!schema || typeof schema !== 'object') {
      return schema;
    }

    const cleaned: any = {};

    for (const [key, value] of Object.entries(schema)) {
      // Skip unsupported keys
      if (
        key === '$schema' ||
        key === 'additionalProperties' ||
        key === '$ref' ||
        key === 'definitions'
      ) {
        continue;
      }

      if (key === 'properties' && typeof value === 'object') {
        cleaned.properties = {};
        for (const [propKey, propValue] of Object.entries(value as object)) {
          cleaned.properties[propKey] = this._cleanSchemaForGoogle(propValue);
        }
      } else if (key === 'items' && typeof value === 'object') {
        cleaned.items = this._cleanSchemaForGoogle(value);
      } else if (typeof value === 'object' && !Array.isArray(value)) {
        cleaned[key] = this._cleanSchemaForGoogle(value);
      } else {
        cleaned[key] = value;
      }
    }

    return cleaned;
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
    const serializer = new GoogleMessageSerializer();
    const contents = serializer.serialize(messages);

    const systemMessage = messages.find(
      (msg) => msg instanceof SystemMessage
    ) as SystemMessage | undefined;
    const systemInstruction = systemMessage ? systemMessage.text : undefined;

    let tools: Tool[] | undefined = undefined;
    let toolConfig: any = undefined;

    // For Google, we need to be more explicit about JSON output
    // The generationConfig with responseSchema helps enforce JSON structure
    const generationConfig: any = {
      responseMimeType: 'application/json',
    };

    // Try to get schema from output_format
    const schemaForJson =
      output_format &&
      'schema' in output_format &&
      (output_format as any).schema
        ? (output_format as any).schema
        : null;

    if (schemaForJson) {
      try {
        const jsonSchema = zodToJsonSchema(
          schemaForJson as unknown as z.ZodType
        );
        // Clean up the schema for Google's format
        const cleanSchema = this._cleanSchemaForGoogle(jsonSchema);
        generationConfig.responseSchema = cleanSchema;
      } catch (e) {
        console.warn('Failed to set responseSchema', e);
      }
    }

    const request: any = {
      model: this.model,
      contents,
    };

    if (systemInstruction) {
      request.systemInstruction = {
        role: 'system',
        parts: [{ text: systemInstruction }],
      };
    }

    if (Object.keys(generationConfig).length > 0) {
      request.generationConfig = generationConfig;
    }

    const result = await (this.client.models as any).generateContent(
      request,
      options.signal ? { signal: options.signal } : undefined
    );

    // Extract text from first candidate
    const candidate = result.candidates?.[0];
    const textParts =
      candidate?.content?.parts?.filter((p: any) => p.text) || [];
    const text = textParts.map((p: any) => p.text).join('');

    let completion: T | string = text;

    if (output_format) {
      try {
        let parsed: any = text;

        if (generationConfig.responseMimeType === 'application/json') {
          let jsonText = text.trim();

          // Handle markdown code fences like ```json ... ```
          const fencedMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/i);
          if (fencedMatch && fencedMatch[1]) {
            jsonText = fencedMatch[1].trim();
          }

          // Try to extract JSON object from text
          const firstBrace = jsonText.indexOf('{');
          const lastBrace = jsonText.lastIndexOf('}');
          if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
            jsonText = jsonText.slice(firstBrace, lastBrace + 1);
          } else {
            // If no JSON object found, the model returned plain text
            // Try to wrap it in a minimal valid structure
            console.warn(
              'Google LLM returned plain text instead of JSON. Raw response:',
              text.slice(0, 200)
            );
            throw new Error(
              `Expected JSON response but got plain text: "${text.slice(0, 50)}..."`
            );
          }

          parsed = JSON.parse(jsonText);
        }

        completion = output_format.parse(parsed);
      } catch (e) {
        console.error('Failed to parse completion', e);
        throw e;
      }
    }

    return new ChatInvokeCompletion(completion, {
      prompt_tokens: result.usageMetadata?.promptTokenCount ?? 0,
      completion_tokens: result.usageMetadata?.candidatesTokenCount ?? 0,
      total_tokens: result.usageMetadata?.totalTokenCount ?? 0,
    });
  }
}
