import { AzureOpenAI } from 'openai';
import type { z } from 'zod';
import type { BaseChatModel, ChatInvokeOptions } from '../base.js';
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
    const serializer = new OpenAIMessageSerializer();
    const openaiMessages = serializer.serialize(messages);

    // Use simple json_object format for better compatibility with Azure
    // json_schema format may not be supported on all Azure API versions/deployments
    const responseFormat = output_format
      ? ({ type: 'json_object' } as const)
      : undefined;

    const response = await this.client.chat.completions.create(
      {
        model: this.model,
        messages: openaiMessages,
        response_format: responseFormat,
      },
      options.signal ? { signal: options.signal } : undefined
    );

    const content = response.choices[0].message.content || '';

    let completion: T | string = content;
    if (output_format) {
      try {
        // Extract JSON from the response
        let jsonText = content.trim();

        // Handle markdown fenced code blocks
        const fencedMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fencedMatch && fencedMatch[1]) {
          jsonText = fencedMatch[1].trim();
        }

        // Extract JSON object/array from the text
        const firstBrace = jsonText.indexOf('{');
        const firstBracket = jsonText.indexOf('[');
        const lastBrace = jsonText.lastIndexOf('}');
        const lastBracket = jsonText.lastIndexOf(']');

        // Determine if it's an object or array
        let startIdx = -1;
        let endIdx = -1;

        if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
          // It's an object
          startIdx = firstBrace;
          endIdx = lastBrace;
        } else if (firstBracket !== -1) {
          // It's an array
          startIdx = firstBracket;
          endIdx = lastBracket;
        }

        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonText = jsonText.slice(startIdx, endIdx + 1);
        }

        const parsedJson = JSON.parse(jsonText);
        completion = output_format.parse(parsedJson);
      } catch (e) {
        console.error('Failed to parse Azure completion:', e);
        console.error('Raw content:', content.substring(0, 500));
        throw new Error(`Failed to parse LLM completion as JSON: ${e}`);
      }
    }

    return new ChatInvokeCompletion(completion, {
      prompt_tokens: response.usage?.prompt_tokens ?? 0,
      completion_tokens: response.usage?.completion_tokens ?? 0,
      total_tokens: response.usage?.total_tokens ?? 0,
    });
  }
}
