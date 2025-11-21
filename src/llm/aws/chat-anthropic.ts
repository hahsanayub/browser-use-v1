/**
 * AWS Bedrock Anthropic Claude chat model.
 *
 * This is a convenience class that provides Claude-specific defaults
 * for the AWS Bedrock service. It inherits all functionality from
 * ChatBedrockConverse but sets Anthropic Claude as the default model
 * and uses the Anthropic message serializer for better compatibility.
 *
 * Usage:
 * ```typescript
 * import { ChatAnthropicBedrock } from './llm/aws/chat-anthropic.js';
 *
 * const llm = new ChatAnthropicBedrock({
 *   model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
 *   region: 'us-east-1'
 * });
 *
 * const response = await llm.ainvoke(messages);
 * ```
 */

import { BedrockRuntimeClient, ConverseCommand, type Tool as BedrockTool } from '@aws-sdk/client-bedrock-runtime';
import type { BaseChatModel } from '../base.js';
import type { ChatInvokeCompletion } from '../views.js';
import { type Message, SystemMessage } from '../messages.js';
import { AnthropicMessageSerializer } from '../anthropic/serializer.js';

export interface ChatAnthropicBedrockConfig {
	/** Model ID, defaults to Claude 3.5 Sonnet */
	model?: string;
	/** AWS region, defaults to us-east-1 */
	region?: string;
	/** Maximum tokens to generate */
	max_tokens?: number;
	/** Temperature for sampling (0-1) */
	temperature?: number | null;
	/** Top-p sampling parameter */
	top_p?: number | null;
	/** Top-k sampling parameter */
	top_k?: number | null;
	/** Stop sequences */
	stop_sequences?: string[] | null;
}

export class ChatAnthropicBedrock implements BaseChatModel {
	public model: string;
	public provider = 'anthropic_bedrock';
	private client: BedrockRuntimeClient;
	private max_tokens: number;
	private temperature: number | null;
	private top_p: number | null;
	private top_k: number | null;
	private stop_sequences: string[] | null;

	constructor(config: ChatAnthropicBedrockConfig = {}) {
		// Anthropic Claude specific defaults
		this.model = config.model || 'anthropic.claude-3-5-sonnet-20241022-v2:0';
		this.max_tokens = config.max_tokens || 8192;
		this.temperature = config.temperature === undefined ? null : config.temperature;
		this.top_p = config.top_p === undefined ? null : config.top_p;
		this.top_k = config.top_k === undefined ? null : config.top_k;
		this.stop_sequences = config.stop_sequences === undefined ? null : config.stop_sequences;

		const region = config.region || process.env.AWS_REGION || 'us-east-1';
		this.client = new BedrockRuntimeClient({ region });
	}

	get name(): string {
		return this.model;
	}

	get model_name(): string {
		return this.model;
	}

	private _getInferenceParams(): Record<string, any> {
		const params: Record<string, any> = {
			maxTokens: this.max_tokens,
		};

		if (this.temperature !== null) {
			params.temperature = this.temperature;
		}
		if (this.top_p !== null) {
			params.topP = this.top_p;
		}
		if (this.stop_sequences !== null && this.stop_sequences.length > 0) {
			params.stopSequences = this.stop_sequences;
		}

		return params;
	}

	async ainvoke(messages: Message[], output_format?: undefined): Promise<ChatInvokeCompletion<string>>;
	async ainvoke<T>(messages: Message[], output_format: { parse: (input: string) => T }): Promise<ChatInvokeCompletion<T>>;
	async ainvoke<T>(
		messages: Message[],
		output_format?: { parse: (input: string) => T }
	): Promise<ChatInvokeCompletion<T | string>> {
		// Use Anthropic-specific message serializer
		const serializer = new AnthropicMessageSerializer();
		const [anthropicMessages, systemPrompt] = serializer.serializeMessages(messages);

		// Convert Anthropic messages to Bedrock format
		const bedrockMessages = anthropicMessages.map((msg: any) => {
			const content = Array.isArray(msg.content)
				? msg.content.map((block: any) => {
					if (block.type === 'text') {
						return { text: block.text };
					} else if (block.type === 'image') {
						// Handle image blocks if needed
						return { text: '[Image]' };
					}
					return { text: String(block) };
				})
				: [{ text: msg.content }];

			return {
				role: msg.role,
				content,
			};
		});

		// Handle system message
		const system = systemPrompt
			? [{ text: typeof systemPrompt === 'string' ? systemPrompt : JSON.stringify(systemPrompt) }]
			: undefined;

		let tools: BedrockTool[] | undefined = undefined;
		let toolConfig: any = undefined;

		if (output_format && 'schema' in output_format) {
			// Structured output using tools
			try {
				const schema = (output_format as any).schema?.shape
					? this._zodToJsonSchema((output_format as any).schema)
					: {};

				tools = [
					{
						toolSpec: {
							name: 'extract_structured_data',
							description: 'Extract structured data from the response',
							inputSchema: {
								json: schema,
							},
						},
					},
				];

				toolConfig = {
					tools: tools,
					toolChoice: { tool: { name: 'extract_structured_data' } },
				};
			} catch (e) {
				console.warn('Failed to convert output_format to JSON schema', e);
			}
		}

		const command = new ConverseCommand({
			modelId: this.model,
			messages: bedrockMessages,
			system: system,
			toolConfig: toolConfig,
			inferenceConfig: this._getInferenceParams(),
		});

		const response = await this.client.send(command);

		let completion: T | string = '';

		if (response.output?.message?.content) {
			// Check for tool use (structured output)
			const toolUseBlock = response.output.message.content.find((block) => block.toolUse);
			if (toolUseBlock && toolUseBlock.toolUse && output_format) {
				completion = output_format.parse(toolUseBlock.toolUse.input as any);
			} else {
				// Fallback to text
				const textBlock = response.output.message.content.find((block) => block.text);
				completion = textBlock?.text || '';
			}
		}

		const usage = response.usage || {};

		return {
			completion,
			usage: {
				promptTokens: usage.inputTokens || 0,
				completionTokens: usage.outputTokens || 0,
				totalTokens: usage.totalTokens || 0,
			},
		};
	}

	/**
	 * Simple Zod to JSON Schema conversion for structured output
	 */
	private _zodToJsonSchema(schema: any): any {
		// This is a simplified version - you might want to use zod-to-json-schema package
		try {
			const { zodToJsonSchema } = require('zod-to-json-schema');
			return zodToJsonSchema(schema, {
				name: 'Response',
				target: 'jsonSchema7',
			});
		} catch {
			// Fallback if zod-to-json-schema is not available
			return {
				type: 'object',
				properties: {},
				required: [],
			};
		}
	}
}
