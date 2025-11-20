import Groq from 'groq-sdk';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { z } from 'zod';
import type { BaseChatModel } from '../base.js';
import type { ChatInvokeCompletion } from '../views.js';
import type { Message } from '../messages.js';
import { GroqMessageSerializer } from './serializer.js';

export class ChatGroq implements BaseChatModel {
    public model: string;
    public provider = 'groq';
    private client: Groq;

    constructor(model: string = 'llama-3.1-70b-versatile') {
        this.model = model;
        this.client = new Groq({
            apiKey: process.env.GROQ_API_KEY,
        });
    }

    get name(): string {
        return this.model;
    }

    get model_name(): string {
        return this.model;
    }

    async ainvoke(messages: Message[], output_format?: undefined): Promise<ChatInvokeCompletion<string>>;
    async ainvoke<T>(messages: Message[], output_format: { parse: (input: string) => T } | undefined): Promise<ChatInvokeCompletion<T>>;
    async ainvoke<T>(
        messages: Message[],
        output_format?: { parse: (input: string) => T } | undefined
    ): Promise<ChatInvokeCompletion<T | string>> {
        const serializer = new GroqMessageSerializer();
        const groqMessages = serializer.serialize(messages);

        let responseFormat: Groq.Chat.Completions.CompletionCreateParams.ResponseFormat | undefined = undefined;
        if (output_format && 'schema' in output_format && output_format.schema) {
            // Groq supports JSON mode, but not full JSON schema validation in the same way as OpenAI yet (or maybe it does now).
            // For now, we'll enforce JSON mode and prompt engineering or use tools if needed.
            // But let's try to use json_object which is supported.
            responseFormat = { type: 'json_object' };
        }

        const response = await this.client.chat.completions.create({
            model: this.model,
            messages: groqMessages,
            response_format: responseFormat,
        });

        const content = response.choices[0].message.content || '';

        let completion: T | string = content;
        if (output_format) {
            try {
                completion = output_format.parse(JSON.parse(content));
            } catch (e) {
                console.error('Failed to parse completion', e);
                throw e;
            }
        }

        return {
            completion,
            usage: {
                promptTokens: response.usage?.prompt_tokens ?? 0,
                completionTokens: response.usage?.completion_tokens ?? 0,
                totalTokens: response.usage?.total_tokens ?? 0,
            },
        };
    }
}
