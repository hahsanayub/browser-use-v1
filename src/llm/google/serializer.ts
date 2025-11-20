import type { Content, Part } from '@google/genai';
import {
    AssistantMessage,
    ContentPartImageParam,
    ContentPartTextParam,
    SystemMessage,
    UserMessage,
    type Message,
} from '../messages.js';

export class GoogleMessageSerializer {
    serialize(messages: Message[]): Content[] {
        return messages
            .filter((msg) => !(msg instanceof SystemMessage)) // System instructions are passed separately
            .map((message) => this.serializeMessage(message));
    }

    private serializeMessage(message: Message): Content {
        if (message instanceof UserMessage) {
            return {
                role: 'user',
                parts: Array.isArray(message.content)
                    ? message.content.map((part) => {
                        if (part instanceof ContentPartTextParam) {
                            return { text: part.text } as Part;
                        }
                        if (part instanceof ContentPartImageParam) {
                            // Google GenAI expects inlineData for images usually
                            const data = part.image_url.url.split(',')[1];
                            const mimeType = part.image_url.media_type;
                            return {
                                inlineData: {
                                    mimeType: mimeType,
                                    data: data,
                                },
                            } as Part;
                        }
                        return { text: '' } as Part;
                    })
                    : [{ text: message.content }],
            };
        }

        if (message instanceof AssistantMessage) {
            const parts: Part[] = [];
            if (message.content) {
                if (typeof message.content === 'string') {
                    parts.push({ text: message.content });
                } else if (Array.isArray(message.content)) {
                    message.content.forEach((part) => {
                        if (part instanceof ContentPartTextParam) {
                            parts.push({ text: part.text });
                        }
                    });
                }
            }

            if (message.tool_calls) {
                message.tool_calls.forEach((toolCall) => {
                    parts.push({
                        functionCall: {
                            name: toolCall.functionCall.name,
                            args: JSON.parse(toolCall.functionCall.arguments),
                        },
                    });
                });
            }

            return {
                role: 'model',
                parts: parts,
            };
        }

        throw new Error(`Unknown message type: ${message.constructor.name}`);
    }
}
