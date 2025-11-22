import { ChatOpenAI } from './chat.js';

/**
 * A class to interact with any provider using the OpenAI API schema.
 *
 * This allows using any OpenAI-compatible API provider by specifying a custom model name.
 *
 * @example
 * ```typescript
 * const llm = new ChatOpenAILike('custom-model-name');
 * ```
 */
export class ChatOpenAILike extends ChatOpenAI {
    /**
     * @param model - The name of the model to use (any OpenAI-compatible model)
     */
    constructor(model: string) {
        super(model);
    }
}
