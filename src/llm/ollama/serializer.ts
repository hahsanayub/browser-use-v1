import type { Message as OllamaMessage } from 'ollama';
import {
  AssistantMessage,
  ContentPartImageParam,
  ContentPartTextParam,
  SystemMessage,
  UserMessage,
  type Message,
} from '../messages.js';

export class OllamaMessageSerializer {
  serialize(messages: Message[]): OllamaMessage[] {
    return messages.map((message) => this.serializeMessage(message));
  }

  private serializeMessage(message: Message): OllamaMessage {
    if (message instanceof UserMessage) {
      const images: string[] = [];
      let content = '';

      if (Array.isArray(message.content)) {
        message.content.forEach((part) => {
          if (part instanceof ContentPartTextParam) {
            content += part.text;
          } else if (part instanceof ContentPartImageParam) {
            // Ollama expects base64 string without header
            const data = part.image_url.url.split(',')[1];
            if (data) images.push(data);
          }
        });
      } else {
        content = message.content;
      }

      return {
        role: 'user',
        content: content,
        images: images.length > 0 ? images : undefined,
      };
    }

    if (message instanceof SystemMessage) {
      return {
        role: 'system',
        content: message.text,
      };
    }

    if (message instanceof AssistantMessage) {
      const toolCalls = message.tool_calls?.map((toolCall) => ({
        function: {
          name: toolCall.functionCall.name,
          arguments: JSON.parse(toolCall.functionCall.arguments),
        },
      }));

      return {
        role: 'assistant',
        content: message.text,
        tool_calls: toolCalls,
      };
    }

    throw new Error(`Unknown message type: ${(message as any).constructor.name}`);
  }
}
