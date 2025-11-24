import {
  BedrockRuntimeClient,
  ConverseCommand,
  type Tool as BedrockTool,
  type ToolChoice,
} from '@aws-sdk/client-bedrock-runtime';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { z } from 'zod';
import type { BaseChatModel } from '../base.js';
import { ChatInvokeCompletion } from '../views.js';
import { type Message, SystemMessage } from '../messages.js';
import { AWSBedrockMessageSerializer } from './serializer.js';

export class ChatBedrockConverse implements BaseChatModel {
  public model: string;
  public provider = 'aws';
  private client: BedrockRuntimeClient;

  constructor(
    model: string = 'anthropic.claude-3-5-sonnet-20240620-v1:0',
    region: string = process.env.AWS_REGION || 'us-east-1'
  ) {
    this.model = model;
    this.client = new BedrockRuntimeClient({ region });
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
    const serializer = new AWSBedrockMessageSerializer();
    const bedrockMessages = serializer.serialize(messages);

    const systemMessage = messages.find(
      (msg) => msg instanceof SystemMessage
    ) as SystemMessage | undefined;
    const system = systemMessage ? [{ text: systemMessage.text }] : undefined;

    let tools: BedrockTool[] | undefined = undefined;
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

        tools = [
          {
            toolSpec: {
              name: 'response',
              description: 'The response to the user request',
              inputSchema: {
                json: jsonSchema as any,
              },
            },
          },
        ];
        toolConfig = {
          tools: tools,
          toolChoice: { tool: { name: 'response' } },
        };
      } catch (e) {
        console.warn(
          'Failed to convert output_format to JSON schema for AWS Bedrock',
          e
        );
      }
    }

    const command = new ConverseCommand({
      modelId: this.model,
      messages: bedrockMessages,
      system: system,
      toolConfig: toolConfig,
    });

    const response = await this.client.send(command);

    let completion: T | string = '';

    if (response.output?.message?.content) {
      // Check for tool use
      const toolUseBlock = response.output.message.content.find(
        (block) => block.toolUse
      );
      if (toolUseBlock && toolUseBlock.toolUse && output_format) {
        completion = output_format.parse(toolUseBlock.toolUse.input as any);
      } else {
        // Fallback to text
        const textBlock = response.output.message.content.find(
          (block) => block.text
        );
        completion = textBlock?.text || '';
      }
    }

    const usage = response.usage || {};

    return new ChatInvokeCompletion(
      completion,
      {
        prompt_tokens: (usage as any).inputTokens || 0,
        completion_tokens: (usage as any).outputTokens || 0,
        total_tokens: (usage as any).totalTokens || 0,
      }
    );
  }
}
