import { describe, expect, it } from 'vitest';
import { CerebrasMessageSerializer } from '../src/llm/cerebras/serializer.js';
import {
  AssistantMessage,
  ContentPartImageParam,
  ContentPartRefusalParam,
  ContentPartTextParam,
  FunctionCall,
  ImageURL,
  ToolCall,
  UserMessage,
} from '../src/llm/messages.js';

describe('Cerebras serializer alignment', () => {
  it('serializes user text and image content parts', () => {
    const serializer = new CerebrasMessageSerializer();
    const serialized = serializer.serialize([
      new UserMessage([
        new ContentPartTextParam('hello'),
        new ContentPartImageParam(
          new ImageURL('data:image/png;base64,abc123', 'high')
        ),
      ]),
    ]);

    expect(serialized).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hello' },
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,abc123' },
          },
        ],
      },
    ]);
  });

  it('serializes refusal content and safely parses invalid tool arguments', () => {
    const serializer = new CerebrasMessageSerializer();
    const serialized = serializer.serialize([
      new AssistantMessage({
        content: [new ContentPartRefusalParam('cannot comply')],
        tool_calls: [
          new ToolCall('tool_1', new FunctionCall('do_it', 'not-json')),
        ],
      }),
    ]);

    expect(serialized[0]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: '[Refusal] cannot comply' }],
      tool_calls: [
        {
          id: 'tool_1',
          type: 'function',
          function: {
            name: 'do_it',
            arguments: { arguments: 'not-json' },
          },
        },
      ],
    });
  });

  it('throws for unknown message types', () => {
    const serializer = new CerebrasMessageSerializer();
    expect(() => serializer.serialize([{} as any])).toThrow(
      'Unknown message type'
    );
  });
});
