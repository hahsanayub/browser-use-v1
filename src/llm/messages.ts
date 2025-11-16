export type SupportedImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

const truncate = (text: string, maxLength = 50) => {
	if (text.length <= maxLength) {
		return text;
	}
	return `${text.slice(0, maxLength - 3)}...`;
};

const formatImageUrl = (url: string, maxLength = 50) => {
	if (url.startsWith('data:')) {
		const mediaType = url.split(';')[0]?.split(':')[1] ?? 'image';
		return `<base64 ${mediaType}>`;
	}
	return truncate(url, maxLength);
};

export class ContentPartTextParam {
	type: 'text' = 'text';
	constructor(public text: string) {}

	toString() {
		return `Text: ${truncate(this.text)}`;
	}
}

export class ContentPartRefusalParam {
	type: 'refusal' = 'refusal';
	constructor(public refusal: string) {}

	toString() {
		return `Refusal: ${truncate(this.refusal)}`;
	}
}

export class ImageURL {
	detail: 'auto' | 'low' | 'high';
	media_type: SupportedImageMediaType;
	constructor(public url: string, detail: 'auto' | 'low' | 'high' = 'auto', media: SupportedImageMediaType = 'image/png') {
		this.detail = detail;
		this.media_type = media;
	}

	toString() {
		return `🖼️  Image[${this.media_type}, detail=${this.detail}]: ${formatImageUrl(this.url)}`;
	}
}

export class ContentPartImageParam {
	type: 'image_url' = 'image_url';
	constructor(public image_url: ImageURL) {}

	toString() {
		return this.image_url.toString();
	}
}

export class FunctionCall {
	constructor(public name: string, public arguments: string) {}

	toString() {
		return `${this.name}(${truncate(this.arguments, 80)})`;
	}
}

export class ToolCall {
	type: 'function' = 'function';
	constructor(public id: string, public functionCall: FunctionCall) {}

	toString() {
		return `ToolCall[${this.id}]: ${this.functionCall.toString()}`;
	}
}

type ContentPart = ContentPartTextParam | ContentPartImageParam | ContentPartRefusalParam;

export type MessageRole = 'user' | 'system' | 'assistant';

export abstract class MessageBase {
	cache = false;
	abstract role: MessageRole;
	constructor(init?: Partial<MessageBase>) {
		if (init?.cache !== undefined) {
			this.cache = init.cache;
		}
	}
}

export class UserMessage extends MessageBase {
	role: MessageRole = 'user';
	content: string | ContentPart[];
	name: string | null;

	constructor(content: string | ContentPart[], name: string | null = null) {
		super();
		this.content = content;
		this.name = name;
	}

	get text() {
		if (typeof this.content === 'string') {
			return this.content;
		}
		return this.content
			.filter((part): part is ContentPartTextParam => part instanceof ContentPartTextParam)
			.map((part) => part.text)
			.join('\n');
	}

	toString() {
		return `UserMessage(content=${this.text})`;
	}
}

export class SystemMessage extends MessageBase {
	role: MessageRole = 'system';
	content: string | ContentPartTextParam[];
	name: string | null;

	constructor(content: string | ContentPartTextParam[], name: string | null = null) {
		super();
		this.content = content;
		this.name = name;
	}

	get text() {
		if (typeof this.content === 'string') {
			return this.content;
		}
		return this.content.map((part) => part.text).join('\n');
	}

	toString() {
		return `SystemMessage(content=${this.text})`;
	}
}

export class AssistantMessage extends MessageBase {
	role: MessageRole = 'assistant';
	content: string | ContentPart[] | null;
	tool_calls: ToolCall[] | null;
	refusal: string | null;

	constructor(init: {
		content?: string | ContentPart[] | null;
		tool_calls?: ToolCall[] | null;
		refusal?: string | null;
	}) {
		super();
		this.content = init.content ?? null;
		this.tool_calls = init.tool_calls ?? null;
		this.refusal = init.refusal ?? null;
	}

	get text() {
		if (typeof this.content === 'string') {
			return this.content;
		}
		if (Array.isArray(this.content)) {
			return this.content
				.filter((part): part is ContentPartTextParam => part instanceof ContentPartTextParam)
				.map((part) => part.text)
				.join('\n');
		}
		return '';
	}

	toString() {
		return `AssistantMessage(content=${this.text})`;
	}
}

export type Message = UserMessage | SystemMessage | AssistantMessage;
