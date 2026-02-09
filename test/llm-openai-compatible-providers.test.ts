import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const openaiCreateMock = vi.fn();
const openaiCtorMock = vi.fn();

vi.mock('openai', () => {
  class OpenAI {
    chat = {
      completions: {
        create: openaiCreateMock,
      },
    };

    constructor(options?: unknown) {
      openaiCtorMock(options);
    }
  }
  return { default: OpenAI };
});

import { UserMessage } from '../src/llm/messages.js';
import { ChatDeepSeek } from '../src/llm/deepseek/chat.js';
import { ChatOpenAI } from '../src/llm/openai/chat.js';
import { ChatOpenAILike } from '../src/llm/openai/like.js';
import { ChatOpenRouter } from '../src/llm/openrouter/chat.js';
import { ChatMistral } from '../src/llm/mistral/chat.js';
import { ChatCerebras } from '../src/llm/cerebras/chat.js';

const buildResponse = (content: string) => ({
  choices: [{ message: { content } }],
  usage: {
    prompt_tokens: 12,
    completion_tokens: 4,
    total_tokens: 16,
    prompt_tokens_details: { cached_tokens: 3 },
  },
});

const buildToolResponse = (argumentsJson: string) => ({
  choices: [
    {
      finish_reason: 'tool_calls',
      message: {
        content: null,
        tool_calls: [{ function: { arguments: argumentsJson } }],
      },
    },
  ],
  usage: {
    prompt_tokens: 12,
    completion_tokens: 4,
    total_tokens: 16,
    prompt_tokens_details: { cached_tokens: 3 },
  },
});

describe('OpenAI-compatible providers alignment', () => {
  beforeEach(() => {
    openaiCreateMock.mockReset();
    openaiCtorMock.mockReset();
    openaiCreateMock.mockResolvedValue(buildResponse('ok'));
  });

  it('allows ChatOpenAILike to pass through ChatOpenAI options', async () => {
    const llm = new ChatOpenAILike({
      model: 'gpt-4o-mini',
      serviceTier: 'priority',
      maxRetries: 7,
    });

    expect(llm).toBeInstanceOf(ChatOpenAI);
    await llm.ainvoke([new UserMessage('hello')]);

    const request = openaiCreateMock.mock.calls[0]?.[0] ?? {};
    expect(request.model).toBe('gpt-4o-mini');
    expect(request.service_tier).toBe('priority');
    expect(openaiCtorMock.mock.calls[0]?.[0]).toMatchObject({
      maxRetries: 7,
    });
  });

  it('supports OpenRouter options including HTTP-Referer and extra body', async () => {
    const llm = new ChatOpenRouter({
      model: 'openai/gpt-4o',
      temperature: 0.4,
      topP: 0.8,
      seed: 42,
      httpReferer: 'https://example.com/app',
      extraBody: {
        provider: { order: ['openai'] },
      },
    });

    await llm.ainvoke([new UserMessage('hello')]);

    const request = openaiCreateMock.mock.calls[0]?.[0] ?? {};
    expect(request.model).toBe('openai/gpt-4o');
    expect(request.temperature).toBe(0.4);
    expect(request.top_p).toBe(0.8);
    expect(request.seed).toBe(42);
    expect(request.extra_headers).toEqual({
      'HTTP-Referer': 'https://example.com/app',
    });
    expect(request.provider).toEqual({ order: ['openai'] });
  });

  it('optimizes OpenRouter structured schemas for provider compatibility', async () => {
    openaiCreateMock.mockResolvedValue(
      buildResponse(JSON.stringify({ items: ['alpha'] }))
    );
    const schema = z.object({
      items: z.array(z.string()).min(1).default(['seed']),
    });
    const llm = new ChatOpenRouter({
      model: 'openai/gpt-4o',
      removeMinItemsFromSchema: true,
      removeDefaultsFromSchema: true,
    });

    const response = await llm.ainvoke([new UserMessage('extract')], schema as any);
    const request = openaiCreateMock.mock.calls[0]?.[0] ?? {};
    const schemaPayload = request.response_format?.json_schema?.schema;

    expect(request.response_format?.type).toBe('json_schema');
    expect(JSON.stringify(schemaPayload)).not.toContain('minItems');
    expect(JSON.stringify(schemaPayload)).not.toContain('min_items');
    expect(JSON.stringify(schemaPayload)).not.toContain('"default"');
    expect((response.completion as any).items).toEqual(['alpha']);
  });

  it('uses DeepSeek function-calling structured output path and generation params', async () => {
    openaiCreateMock.mockResolvedValue(buildToolResponse('{"value":"ok"}'));
    const schema = z.object({ value: z.string() });
    const llm = new ChatDeepSeek({
      model: 'deepseek-chat',
      temperature: 0.2,
      maxTokens: 256,
      topP: 0.7,
      seed: 9,
    });

    const response = await llm.ainvoke([new UserMessage('extract')], schema as any);
    const request = openaiCreateMock.mock.calls[0]?.[0] ?? {};

    expect(request.model).toBe('deepseek-chat');
    expect(request.temperature).toBe(0.2);
    expect(request.max_tokens).toBe(256);
    expect(request.top_p).toBe(0.7);
    expect(request.seed).toBe(9);
    expect(request.tools).toHaveLength(1);
    expect(request.tool_choice).toEqual({
      type: 'function',
      function: { name: 'response' },
    });
    expect(request.response_format).toBeUndefined();
    expect((response.completion as any).value).toBe('ok');
  });

  it('uses Mistral max_tokens and strict json_schema response format', async () => {
    openaiCreateMock.mockResolvedValue(buildResponse('{"value":"ok"}'));
    const schema = z.object({ value: z.string() });
    const llm = new ChatMistral({
      model: 'mistral-medium-latest',
      maxTokens: 512,
      topP: 0.9,
      seed: 7,
    });

    const response = await llm.ainvoke([new UserMessage('extract')], schema as any);
    const request = openaiCreateMock.mock.calls[0]?.[0] ?? {};

    expect(request.model).toBe('mistral-medium-latest');
    expect(request.max_tokens).toBe(512);
    expect(request.top_p).toBe(0.9);
    expect(request.seed).toBe(7);
    expect(request.max_completion_tokens).toBeUndefined();
    expect(request.response_format?.type).toBe('json_schema');
    expect(request.response_format?.json_schema?.strict).toBe(true);
    expect((response.completion as any).value).toBe('ok');
  });

  it('uses Cerebras prompt-based JSON extraction for structured output', async () => {
    openaiCreateMock.mockResolvedValue(
      buildResponse('```json\n{"value":"ok"}\n```')
    );
    const schema = z.object({ value: z.string() });
    const llm = new ChatCerebras({
      model: 'llama3.1-8b',
      maxTokens: 256,
      temperature: 0.2,
    });

    const response = await llm.ainvoke([new UserMessage('extract this')], schema as any);
    const request = openaiCreateMock.mock.calls[0]?.[0] ?? {};
    const lastMessage = request.messages?.[request.messages.length - 1];
    const contentText =
      typeof lastMessage?.content === 'string'
        ? lastMessage.content
        : JSON.stringify(lastMessage?.content ?? '');

    expect(request.model).toBe('llama3.1-8b');
    expect(request.max_tokens).toBe(256);
    expect(contentText).toContain('valid JSON only');
    expect((response.completion as any).value).toBe('ok');
  });
});
