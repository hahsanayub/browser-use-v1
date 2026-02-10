import {
  AssistantMessage,
  ContentPartImageParam,
  ContentPartRefusalParam,
  ContentPartTextParam,
  SystemMessage,
  UserMessage,
  type Message,
} from '../messages.js';

export type CerebrasMessage = Record<string, unknown>;

export class CerebrasMessageSerializer {
  private serializeContent(content: unknown): string | Record<string, unknown>[] {
    if (content == null) {
      return '';
    }
    if (typeof content === 'string') {
      return content;
    }
    if (!Array.isArray(content)) {
      return String(content);
    }

    const parts: Record<string, unknown>[] = [];
    for (const part of content) {
      if (part instanceof ContentPartTextParam) {
        parts.push({ type: 'text', text: part.text });
      } else if (part instanceof ContentPartImageParam) {
        parts.push({
          type: 'image_url',
          image_url: {
            url: part.image_url.url,
          },
        });
      } else if (part instanceof ContentPartRefusalParam) {
        parts.push({ type: 'text', text: `[Refusal] ${part.refusal}` });
      }
    }
    return parts;
  }

  private serializeToolCalls(toolCalls: AssistantMessage['tool_calls']) {
    if (!toolCalls || !toolCalls.length) {
      return undefined;
    }

    return toolCalls.map((toolCall) => {
      let argumentsPayload: unknown;
      try {
        argumentsPayload = JSON.parse(toolCall.functionCall.arguments);
      } catch {
        argumentsPayload = { arguments: toolCall.functionCall.arguments };
      }
      return {
        id: toolCall.id,
        type: 'function',
        function: {
          name: toolCall.functionCall.name,
          arguments: argumentsPayload,
        },
      };
    });
  }

  serialize(messages: Message[]): CerebrasMessage[] {
    return messages.map((message) => {
      if (message instanceof UserMessage) {
        return {
          role: 'user',
          content: this.serializeContent(message.content),
        };
      }

      if (message instanceof SystemMessage) {
        return {
          role: 'system',
          content: this.serializeContent(message.content),
        };
      }

      if (message instanceof AssistantMessage) {
        const payload: CerebrasMessage = {
          role: 'assistant',
          content: this.serializeContent(message.content),
        };
        const toolCalls = this.serializeToolCalls(message.tool_calls);
        if (toolCalls) {
          payload.tool_calls = toolCalls;
        }
        return payload;
      }

      throw new Error(
        `Unknown message type: ${(message as any)?.constructor?.name ?? typeof message}`
      );
    });
  }
}
