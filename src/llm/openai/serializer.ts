import type { ChatCompletionMessageParam } from 'openai/resources/index.mjs';
import {
  AssistantMessage,
  ContentPartImageParam,
  ContentPartTextParam,
  SystemMessage,
  UserMessage,
  type Message,
} from '../messages.js';

export class OpenAIMessageSerializer {
  serialize(messages: Message[]): ChatCompletionMessageParam[] {
    return messages.map((message) => this.serializeMessage(message));
  }

  private serializeMessage(message: Message): ChatCompletionMessageParam {
    if (message instanceof UserMessage) {
      return {
        role: 'user',
        content: Array.isArray(message.content)
          ? message.content.map((part) => {
              if (part instanceof ContentPartTextParam) {
                return { type: 'text', text: part.text };
              }
              if (part instanceof ContentPartImageParam) {
                return {
                  type: 'image_url',
                  image_url: {
                    url: part.image_url.url,
                    detail: part.image_url.detail,
                  },
                };
              }
              return { type: 'text', text: '' }; // Fallback
            })
          : message.content,
        name: message.name || undefined,
      };
    }

    if (message instanceof SystemMessage) {
      return {
        role: 'system',
        content: Array.isArray(message.content)
          ? message.content.map((part) => part.text).join('\n')
          : message.content,
        name: message.name || undefined,
      };
    }

    if (message instanceof AssistantMessage) {
      const toolCalls = message.tool_calls?.map((toolCall) => ({
        id: toolCall.id,
        type: 'function' as const,
        function: {
          name: toolCall.functionCall.name,
          arguments: toolCall.functionCall.arguments,
        },
      }));

      return {
        role: 'assistant',
        content: typeof message.content === 'string' ? message.content : null, // OpenAI expects string or null for content in assistant message if tool_calls are present
        tool_calls: toolCalls,
        refusal: message.refusal || undefined,
      };
    }

    throw new Error(`Unknown message type: ${(message as any).constructor.name}`);
  }
}
