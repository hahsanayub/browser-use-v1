import Anthropic from '@anthropic-ai/sdk';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { z } from 'zod';
import type { BaseChatModel } from '../base.js';
import { ChatInvokeCompletion } from '../views.js';
import { type Message, SystemMessage } from '../messages.js';
import { AnthropicMessageSerializer } from './serializer.js';

export class ChatAnthropic implements BaseChatModel {
  public model: string;
  public provider = 'anthropic';
  private client: Anthropic;

  constructor(model: string = 'claude-3-5-sonnet-20240620') {
    this.model = model;
    this.client = new Anthropic();
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
    const serializer = new AnthropicMessageSerializer();
    const [anthropicMessages] = serializer.serializeMessages(messages);

    const systemMessage = messages.find(
      (msg) => msg instanceof SystemMessage
    ) as SystemMessage | undefined;
    const system = systemMessage ? systemMessage.text : undefined;

    let tools: Anthropic.Tool[] | undefined = undefined;
    let toolChoice: Anthropic.ToolChoice | undefined = undefined;

    if (output_format && 'schema' in output_format && output_format.schema) {
      // Assuming output_format is a Zod schema wrapper
      try {
        const jsonSchema = zodToJsonSchema(
          output_format as unknown as z.ZodType,
          {
            name: 'Response',
            target: 'jsonSchema7',
          }
        );

        tools = [
          {
            name: 'response',
            description: 'The response to the user request',
            input_schema: jsonSchema as any,
          },
        ];
        toolChoice = { type: 'tool', name: 'response' };
      } catch (e) {
        console.warn(
          'Failed to convert output_format to JSON schema for Anthropic',
          e
        );
      }
    }

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system: system,
      messages: anthropicMessages,
      tools: tools,
      tool_choice: toolChoice,
    });

    let completion: T | string = '';

    // Handle tool use response
    const toolUseBlock = response.content.find(
      (block) => block.type === 'tool_use'
    );
    if (toolUseBlock && output_format) {
      completion = output_format.parse(toolUseBlock.input as any);
    } else {
      // Fallback to text content
      const textBlock = response.content.find((block) => block.type === 'text');
      completion = textBlock ? textBlock.text : '';
    }

    return new ChatInvokeCompletion(
      completion,
      {
        prompt_tokens: response.usage.input_tokens,
        completion_tokens: response.usage.output_tokens,
        total_tokens: response.usage.input_tokens + response.usage.output_tokens,
      }
    );
  }
}
