/**
 * Anthropic Message Serializer with Prompt Caching Support
 *
 * This serializer converts custom message types to Anthropic's MessageParam format
 * and implements Anthropic's Prompt Caching feature to reduce costs by up to 90%.
 *
 * Caching Strategy:
 * - Only the last message with cache=true will have cache_control enabled
 * - Caching is most effective for system prompts and large conversation histories
 * - Cache writes cost 25% more, but cache reads cost 90% less
 *
 * Example cost savings:
 * - Without caching: 10,000 tokens @ $3/M = $0.030 per request
 * - With caching (90% hit rate):
 *   - First request: 10,000 tokens @ $3.75/M (write) = $0.0375
 *   - Subsequent: 1,000 tokens @ $3/M + 9,000 tokens @ $0.30/M = $0.0057
 *   - Savings: 81% cost reduction
 */

import type { MessageParam, ImageBlockParam, TextBlockParam, ToolUseBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs';
import {
    AssistantMessage,
    ContentPartImageParam,
    ContentPartTextParam,
    UserMessage,
    SystemMessage,
    type Message,
    type SupportedImageMediaType,
} from '../messages.js';

type CacheControlEphemeralParam = {
    type: 'ephemeral';
};

type NonSystemMessage = UserMessage | AssistantMessage;

export class AnthropicMessageSerializer {
    /**
     * Serialize a list of messages, extracting any system message
     *
     * @param messages - List of messages to serialize
     * @returns Tuple of [messages, system_message]
     */
    public serializeMessages(
        messages: Message[]
    ): [MessageParam[], (string | TextBlockParam[])?] {
        // Make deep copies to avoid modifying originals
        const messagesCopy = messages.map(m => ({ ...m }));

        // Separate system messages from normal messages
        const normalMessages: NonSystemMessage[] = [];
        let systemMessage: SystemMessage | null = null;

        for (const message of messagesCopy) {
            if (message instanceof SystemMessage) {
                systemMessage = message;
            } else {
                normalMessages.push(message as NonSystemMessage);
            }
        }

        // Clean cache messages so only the last cache=true message remains cached
        const cleanedMessages = this._cleanCacheMessages(normalMessages);

        // Serialize normal messages
        const serializedMessages = cleanedMessages.map(msg => this.serializeMessage(msg));

        // Serialize system message
        let serializedSystemMessage: string | TextBlockParam[] | undefined = undefined;
        if (systemMessage) {
            serializedSystemMessage = this._serializeContentToStr(
                systemMessage.content,
                systemMessage.cache
            );
        }

        return [serializedMessages, serializedSystemMessage];
    }

    /**
     * Serialize a single message
     */
    public serializeMessage(message: Message): MessageParam {
        if (message instanceof UserMessage) {
            return {
                role: 'user',
                content: Array.isArray(message.content)
                    ? message.content.map((part, idx, arr) => {
                        const isLastPart = idx === arr.length - 1;
                        const useCache = message.cache && isLastPart;

                        if (part instanceof ContentPartTextParam) {
                            return this._serializeContentPartText(part, useCache);
                        }
                        if (part instanceof ContentPartImageParam) {
                            return this._serializeContentPartImage(part);
                        }
                        return { type: 'text', text: '' } as TextBlockParam;
                    })
                    : this._serializeContent(message.content, message.cache),
            };
        }

        if (message instanceof AssistantMessage) {
            const content: (TextBlockParam | ToolUseBlockParam)[] = [];

            // Add content blocks if present
            if (message.content) {
                if (typeof message.content === 'string') {
                    content.push({
                        type: 'text',
                        text: message.content,
                        ...(message.cache ? { cache_control: this._serializeCacheControl(true) } : {})
                    });
                } else if (Array.isArray(message.content)) {
                    message.content.forEach((part, idx, arr) => {
                        const isLastPart = idx === arr.length - 1;
                        const useCache = message.cache && isLastPart && !message.tool_calls?.length;

                        if (part instanceof ContentPartTextParam) {
                            content.push(this._serializeContentPartText(part, useCache));
                        }
                    });
                }
            }

            // Add tool use blocks if present
            if (message.tool_calls) {
                message.tool_calls.forEach((toolCall, idx, arr) => {
                    const isLastToolCall = idx === arr.length - 1;
                    const useCache = message.cache && isLastToolCall;

                    content.push({
                        type: 'tool_use',
                        id: toolCall.id,
                        name: toolCall.functionCall.name,
                        input: JSON.parse(toolCall.functionCall.arguments),
                        ...(useCache ? { cache_control: this._serializeCacheControl(true) } : {})
                    });
                });
            }

            // If no content or tool calls, add empty text block
            if (!content.length) {
                content.push({
                    type: 'text',
                    text: '',
                    ...(message.cache ? { cache_control: this._serializeCacheControl(true) } : {})
                });
            }

            return {
                role: 'assistant',
                content: content,
            };
        }

        throw new Error(`Unknown message type or unhandled role: ${message.role}`);
    }

    /**
     * Serialize cache control parameter
     */
    private _serializeCacheControl(useCache: boolean): CacheControlEphemeralParam | undefined {
        return useCache ? { type: 'ephemeral' } : undefined;
    }

    /**
     * Serialize text content part with optional caching
     */
    private _serializeContentPartText(
        part: ContentPartTextParam,
        useCache: boolean
    ): TextBlockParam {
        return {
            type: 'text',
            text: part.text,
            ...(useCache ? { cache_control: this._serializeCacheControl(true) } : {})
        };
    }

    /**
     * Serialize image content part
     */
    private _serializeContentPartImage(part: ContentPartImageParam): ImageBlockParam {
        const url = part.image_url.url;

        if (this._isBase64Image(url)) {
            // Handle base64 encoded images
            const [mediaType, data] = this._parseBase64Url(url);
            return {
                type: 'image',
                source: {
                    type: 'base64',
                    media_type: mediaType,
                    data: data,
                },
            };
        } else {
            // Handle URL images
            return {
                type: 'image',
                source: {
                    type: 'url',
                    url: url,
                },
            };
        }
    }

    /**
     * Serialize content (string or array) with optional caching
     */
    private _serializeContent(
        content: string | (ContentPartTextParam | ContentPartImageParam)[],
        useCache: boolean
    ): string | (TextBlockParam | ImageBlockParam)[] {
        if (typeof content === 'string') {
            if (useCache) {
                return [{
                    type: 'text',
                    text: content,
                    cache_control: this._serializeCacheControl(true),
                }];
            }
            return content;
        }

        return content.map((part, idx, arr) => {
            const isLastPart = idx === arr.length - 1;
            const partUseCache = useCache && isLastPart;

            if (part instanceof ContentPartTextParam) {
                return this._serializeContentPartText(part, partUseCache);
            } else if (part instanceof ContentPartImageParam) {
                return this._serializeContentPartImage(part);
            }
            return { type: 'text', text: '' } as TextBlockParam;
        });
    }

    /**
     * Serialize content to string format (for system messages)
     */
    private _serializeContentToStr(
        content: string | ContentPartTextParam[],
        useCache: boolean
    ): string | TextBlockParam[] {
        if (typeof content === 'string') {
            if (useCache) {
                return [{
                    type: 'text',
                    text: content,
                    cache_control: this._serializeCacheControl(true),
                }];
            }
            return content;
        }

        return content.map((part, idx, arr) => {
            const isLastPart = idx === arr.length - 1;
            const partUseCache = useCache && isLastPart;
            return this._serializeContentPartText(part, partUseCache);
        });
    }

    /**
     * Check if URL is a base64 encoded image
     */
    private _isBase64Image(url: string): boolean {
        return url.startsWith('data:image/');
    }

    /**
     * Parse base64 data URL to extract media type and data
     */
    private _parseBase64Url(url: string): [SupportedImageMediaType, string] {
        if (!url.startsWith('data:')) {
            throw new Error(`Invalid base64 URL: ${url}`);
        }

        const [header, data] = url.split(',', 2);
        if (!header || !data) {
            throw new Error(`Invalid base64 URL format: ${url}`);
        }

        let mediaType = header.split(';')[0]?.replace('data:', '') || 'image/png';

        // Ensure it's a supported media type
        const supportedTypes: SupportedImageMediaType[] = [
            'image/jpeg',
            'image/png',
            'image/gif',
            'image/webp'
        ];

        if (!supportedTypes.includes(mediaType as SupportedImageMediaType)) {
            // Default to png if not recognized
            mediaType = 'image/png';
        }

        return [mediaType as SupportedImageMediaType, data];
    }

    /**
     * Clean cache settings so only the last cache=true message remains cached
     *
     * Because of how Claude caching works, only the last cache message matters.
     * This method automatically removes cache=True from all messages except the last one.
     */
    private _cleanCacheMessages(messages: NonSystemMessage[]): NonSystemMessage[] {
        if (!messages.length) {
            return messages;
        }

        // Create deep copies to avoid modifying originals
        const cleanedMessages = messages.map(msg => ({ ...msg }));

        // Find the last message with cache=true
        let lastCacheIndex = -1;
        for (let i = cleanedMessages.length - 1; i >= 0; i--) {
            if (cleanedMessages[i].cache) {
                lastCacheIndex = i;
                break;
            }
        }

        // If we found a cached message, disable cache for all others
        if (lastCacheIndex !== -1) {
            for (let i = 0; i < cleanedMessages.length; i++) {
                if (i !== lastCacheIndex && cleanedMessages[i].cache) {
                    cleanedMessages[i].cache = false;
                }
            }
        }

        return cleanedMessages;
    }
}
