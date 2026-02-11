import { describe, expect, it } from 'vitest';
import { ResponsesAPIMessageSerializer } from '../src/llm/openai/responses-serializer.js';
import {
  AssistantMessage,
  ContentPartImageParam,
  ContentPartRefusalParam,
  ContentPartTextParam,
  FunctionCall,
  ImageURL,
  SystemMessage,
  ToolCall,
  UserMessage,
} from '../src/llm/messages.js';

describe('OpenAI responses serializer alignment', () => {
  it('serializes user text and image parts to input_text/input_image', () => {
    const serializer = new ResponsesAPIMessageSerializer();
    const messages = serializer.serialize([
      new UserMessage([
        new ContentPartTextParam('hello'),
        new ContentPartImageParam(
          new ImageURL('https://example.com/image.png', 'high')
        ),
      ]),
    ]);

    expect(messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'hello' },
          {
            type: 'input_image',
            image_url: 'https://example.com/image.png',
            detail: 'high',
          },
        ],
      },
    ]);
  });

  it('serializes system content parts as input_text entries', () => {
    const serializer = new ResponsesAPIMessageSerializer();
    const messages = serializer.serialize([
      new SystemMessage([new ContentPartTextParam('system-rule')]),
    ]);

    expect(messages).toEqual([
      {
        role: 'system',
        content: [{ type: 'input_text', text: 'system-rule' }],
      },
    ]);
  });

  it('serializes assistant refusal parts as text markers', () => {
    const serializer = new ResponsesAPIMessageSerializer();
    const messages = serializer.serialize([
      new AssistantMessage({
        content: [new ContentPartRefusalParam('cannot comply')],
      }),
    ]);

    expect(messages).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'input_text', text: '[Refusal: cannot comply]' }],
      },
    ]);
  });

  it('serializes assistant tool calls into text fallback when content is null', () => {
    const serializer = new ResponsesAPIMessageSerializer();
    const messages = serializer.serialize([
      new AssistantMessage({
        content: null,
        tool_calls: [
          new ToolCall(
            'tool-call-1',
            new FunctionCall('open_url', '{"url":"https://example.com"}')
          ),
        ],
      }),
    ]);

    expect(messages).toEqual([
      {
        role: 'assistant',
        content: '[Tool call: open_url({"url":"https://example.com"})]',
      },
    ]);
  });

  it('throws for unknown message types', () => {
    const serializer = new ResponsesAPIMessageSerializer();

    expect(() => serializer.serialize([{} as any])).toThrow(
      'Unknown message type'
    );
  });
});
