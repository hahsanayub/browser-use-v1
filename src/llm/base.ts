import type { ChatInvokeCompletion } from './views.js';
import type { Message } from './messages.js';

export interface BaseChatModel {
	model: string;
	_verified_api_keys?: boolean;

	get provider(): string;
	get name(): string;

	get model_name(): string;

	ainvoke(messages: Message[], output_format?: undefined): Promise<ChatInvokeCompletion<string>>;
	ainvoke<T>(messages: Message[], output_format: { parse: (input: string) => T } | undefined): Promise<ChatInvokeCompletion<T>>;
}
