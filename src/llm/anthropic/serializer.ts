import type { MessageParam, ImageBlockParam, TextBlockParam, ToolResultBlockParam, ToolUseBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs';
import {
    AssistantMessage,
    ContentPartImageParam,
    ContentPartTextParam,
    UserMessage,
    type Message,
} from '../messages.js';

export class AnthropicMessageSerializer {
    serialize(messages: Message[]): MessageParam[] {
        return messages
            .filter((msg) => !(msg.role === 'system')) // System messages are handled separately
            .map((message) => this.serializeMessage(message));
    }

    private serializeMessage(message: Message): MessageParam {
        if (message instanceof UserMessage) {
            return {
                role: 'user',
                content: Array.isArray(message.content)
                    ? message.content.map((part) => {
                        if (part instanceof ContentPartTextParam) {
                            return { type: 'text', text: part.text } as TextBlockParam;
                        }
                        if (part instanceof ContentPartImageParam) {
                            const mediaType = part.image_url.media_type;
                            const data = part.image_url.url.split(',')[1]; // Assuming base64 url
                            return {
                                type: 'image',
                                source: {
                                    type: 'base64',
                                    media_type: mediaType,
                                    data: data,
                                },
                            } as ImageBlockParam;
                        }
                        return { type: 'text', text: '' } as TextBlockParam;
                    })
                    : message.content,
            };
        }

        if (message instanceof AssistantMessage) {
            const content: (TextBlockParam | ToolUseBlockParam)[] = [];

            if (message.content) {
                if (typeof message.content === 'string') {
                    content.push({ type: 'text', text: message.content });
                } else if (Array.isArray(message.content)) {
                    message.content.forEach(part => {
                        if (part instanceof ContentPartTextParam) {
                            content.push({ type: 'text', text: part.text });
                        }
                    });
                }
            }

            if (message.tool_calls) {
                message.tool_calls.forEach((toolCall) => {
                    content.push({
                        type: 'tool_use',
                        id: toolCall.id,
                        name: toolCall.functionCall.name,
                        input: JSON.parse(toolCall.functionCall.arguments),
                    });
                });
            }

            return {
                role: 'assistant',
                content: content,
            };
        }

        throw new Error(`Unknown message type or unhandled role: ${message.role}`);
    }
}
