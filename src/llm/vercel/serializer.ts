import type { ChatCompletionMessageParam } from 'openai/resources/index.mjs';
import type { Message } from '../messages.js';
import { OpenAIMessageSerializer } from '../openai/serializer.js';

export class VercelMessageSerializer {
  serialize(messages: Message[]): ChatCompletionMessageParam[] {
    const serializer = new OpenAIMessageSerializer();
    return serializer.serialize(messages);
  }
}
