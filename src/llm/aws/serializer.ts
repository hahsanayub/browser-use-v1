import {
    AssistantMessage,
    ContentPartImageParam,
    ContentPartTextParam,
    SystemMessage,
    UserMessage,
    type Message,
} from '../messages.js';

// AWS Bedrock types are a bit complex and vary by model.
// We will define a generic structure that fits most Bedrock models (like Claude on Bedrock).

export class AWSBedrockMessageSerializer {
    serialize(messages: Message[]): any[] {
        return messages
            .filter((msg) => !(msg instanceof SystemMessage)) // System messages are handled separately usually
            .map((message) => this.serializeMessage(message));
    }

    private serializeMessage(message: Message): any {
        if (message instanceof UserMessage) {
            return {
                role: 'user',
                content: Array.isArray(message.content)
                    ? message.content.map((part) => {
                        if (part instanceof ContentPartTextParam) {
                            return { text: part.text };
                        }
                        if (part instanceof ContentPartImageParam) {
                            const mediaType = part.image_url.media_type;
                            const data = part.image_url.url.split(',')[1];
                            return {
                                image: {
                                    format: mediaType.split('/')[1], // e.g. 'png' from 'image/png'
                                    source: {
                                        bytes: Buffer.from(data, 'base64'),
                                    },
                                },
                            };
                        }
                        return { text: '' };
                    })
                    : [{ text: message.content }],
            };
        }

        if (message instanceof AssistantMessage) {
            const content: any[] = [];
            if (message.content) {
                if (typeof message.content === 'string') {
                    content.push({ text: message.content });
                } else if (Array.isArray(message.content)) {
                    message.content.forEach((part) => {
                        if (part instanceof ContentPartTextParam) {
                            content.push({ text: part.text });
                        }
                    });
                }
            }

            if (message.tool_calls) {
                message.tool_calls.forEach((toolCall) => {
                    content.push({
                        toolUse: {
                            toolUseId: toolCall.id,
                            name: toolCall.functionCall.name,
                            input: JSON.parse(toolCall.functionCall.arguments),
                        },
                    });
                });
            }

            return {
                role: 'assistant',
                content: content,
            };
        }

        throw new Error(`Unknown message type: ${message.constructor.name}`);
    }
}
