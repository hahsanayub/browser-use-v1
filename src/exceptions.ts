export class LLMException extends Error {
	constructor(public readonly statusCode: number, public readonly detail: string) {
		super(`Error ${statusCode}: ${detail}`);
		this.name = 'LLMException';
	}
}
