import {
  AssistantMessage,
  ContentPartImageParam,
  ContentPartRefusalParam,
  ContentPartTextParam,
  SystemMessage,
  UserMessage,
  type Message,
} from '../messages.js';

type ResponsesInputPart =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string; detail?: 'auto' | 'low' | 'high' };

export type ResponsesInputMessage = {
  role: 'user' | 'system' | 'assistant';
  content: string | ResponsesInputPart[];
};

export class ResponsesAPIMessageSerializer {
  serialize(messages: Message[]): ResponsesInputMessage[] {
    return messages.map((message) => this.serializeMessage(message));
  }

  private serializeMessage(message: Message): ResponsesInputMessage {
    if (message instanceof UserMessage) {
      if (typeof message.content === 'string') {
        return { role: 'user', content: message.content };
      }

      const content = message.content
        .map((part): ResponsesInputPart | null => {
          if (part instanceof ContentPartTextParam) {
            return { type: 'input_text', text: part.text };
          }
          if (part instanceof ContentPartImageParam) {
            return {
              type: 'input_image',
              image_url: part.image_url.url,
              detail: part.image_url.detail,
            };
          }
          return null;
        })
        .filter((part): part is ResponsesInputPart => part !== null);

      return { role: 'user', content };
    }

    if (message instanceof SystemMessage) {
      if (typeof message.content === 'string') {
        return { role: 'system', content: message.content };
      }
      return {
        role: 'system',
        content: message.content.map((part) => ({
          type: 'input_text',
          text: part.text,
        })),
      };
    }

    if (message instanceof AssistantMessage) {
      if (message.content == null) {
        if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
          const toolCallText = message.tool_calls
            .map(
              (toolCall) =>
                `[Tool call: ${toolCall.functionCall.name}(${toolCall.functionCall.arguments})]`
            )
            .join('\n');
          return { role: 'assistant', content: toolCallText };
        }
        return { role: 'assistant', content: '' };
      }

      if (typeof message.content === 'string') {
        return { role: 'assistant', content: message.content };
      }

      const content = message.content
        .map((part): ResponsesInputPart | null => {
          if (part instanceof ContentPartTextParam) {
            return { type: 'input_text', text: part.text };
          }
          if (part instanceof ContentPartRefusalParam) {
            return {
              type: 'input_text',
              text: `[Refusal: ${part.refusal}]`,
            };
          }
          return null;
        })
        .filter((part): part is ResponsesInputPart => part !== null);

      return { role: 'assistant', content };
    }

    throw new Error(
      `Unknown message type: ${(message as any)?.constructor?.name ?? typeof message}`
    );
  }
}
