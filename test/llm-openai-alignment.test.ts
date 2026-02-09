import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const openaiCreateMock = vi.fn();

vi.mock('openai', () => {
  class OpenAI {
    chat = {
      completions: {
        create: openaiCreateMock,
      },
    };
  }
  return { default: OpenAI };
});

import { ChatOpenAI } from '../src/llm/openai/chat.js';
import { SystemMessage, UserMessage } from '../src/llm/messages.js';

const buildResponse = (content: string) => ({
  choices: [{ message: { content } }],
  usage: {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
    prompt_tokens_details: { cached_tokens: 2 },
  },
});

describe('ChatOpenAI alignment', () => {
  beforeEach(() => {
    openaiCreateMock.mockReset();
    openaiCreateMock.mockResolvedValue(buildResponse('ok'));
  });

  it('uses python-aligned defaults for non-reasoning models', async () => {
    const llm = new ChatOpenAI({ model: 'gpt-4o' });
    await llm.ainvoke([new UserMessage('hello')]);

    const request = openaiCreateMock.mock.calls[0]?.[0] ?? {};
    expect(request.temperature).toBe(0.2);
    expect(request.frequency_penalty).toBe(0.3);
    expect(request.max_completion_tokens).toBe(4096);
    expect(request.reasoning_effort).toBeUndefined();
  });

  it('switches to reasoning_effort for reasoning models', async () => {
    const llm = new ChatOpenAI({
      model: 'gpt-5-mini',
      reasoningEffort: 'medium',
    });
    await llm.ainvoke([new UserMessage('hello')]);

    const request = openaiCreateMock.mock.calls[0]?.[0] ?? {};
    expect(request.reasoning_effort).toBe('medium');
    expect(request.temperature).toBeUndefined();
    expect(request.frequency_penalty).toBeUndefined();
  });

  it('passes service_tier when configured', async () => {
    const llm = new ChatOpenAI({
      model: 'gpt-4o',
      serviceTier: 'priority',
    });
    await llm.ainvoke([new UserMessage('hello')]);

    const request = openaiCreateMock.mock.calls[0]?.[0] ?? {};
    expect(request.service_tier).toBe('priority');
  });

  it('supports zod structured output schema optimization toggles', async () => {
    openaiCreateMock.mockResolvedValue(
      buildResponse(JSON.stringify({ items: ['alpha'] }))
    );
    const schema = z.object({
      items: z.array(z.string()).min(1).default(['seed']),
    });

    const llm = new ChatOpenAI({
      model: 'gpt-4o',
      addSchemaToSystemPrompt: true,
      removeMinItemsFromSchema: true,
      removeDefaultsFromSchema: true,
    });

    const response = await llm.ainvoke(
      [new SystemMessage('system'), new UserMessage('user')],
      schema as any
    );

    const request = openaiCreateMock.mock.calls[0]?.[0] ?? {};
    const schemaPayload = request.response_format?.json_schema?.schema;
    expect(request.response_format?.type).toBe('json_schema');
    expect(JSON.stringify(schemaPayload)).not.toContain('minItems');
    expect(JSON.stringify(schemaPayload)).not.toContain('"default"');
    expect(String(request.messages?.[0]?.content ?? '')).toContain(
      '<json_schema>'
    );
    expect((response.completion as any).items).toEqual(['alpha']);
  });

  it('can skip forced response_format while keeping parser support', async () => {
    openaiCreateMock.mockResolvedValue(
      buildResponse(JSON.stringify({ value: 'ok' }))
    );
    const schema = z.object({ value: z.string() });
    const llm = new ChatOpenAI({
      model: 'gpt-4o',
      dontForceStructuredOutput: true,
    });

    const response = await llm.ainvoke([new UserMessage('user')], schema as any);
    const request = openaiCreateMock.mock.calls[0]?.[0] ?? {};

    expect(request.response_format).toBeUndefined();
    expect((response.completion as any).value).toBe('ok');
  });
});
