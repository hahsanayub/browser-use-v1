import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const azureCtorMock = vi.fn();
const chatCreateMock = vi.fn();
const responsesCreateMock = vi.fn();

vi.mock('openai', () => {
  class AzureOpenAI {
    chat = {
      completions: {
        create: chatCreateMock,
      },
    };

    responses = {
      create: responsesCreateMock,
    };

    constructor(options?: unknown) {
      azureCtorMock(options);
    }
  }

  return { AzureOpenAI };
});

import { SystemMessage, UserMessage } from '../src/llm/messages.js';
import { ChatAzure } from '../src/llm/azure/chat.js';

const buildChatResponse = (content: string) => ({
  choices: [{ message: { content } }],
  usage: {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
    prompt_tokens_details: { cached_tokens: 2 },
    completion_tokens_details: { reasoning_tokens: 1 },
  },
});

const buildResponsesResponse = (outputText: string) => ({
  output_text: outputText,
  usage: {
    input_tokens: 12,
    output_tokens: 6,
    total_tokens: 18,
    input_tokens_details: { cached_tokens: 3 },
  },
});

describe('ChatAzure alignment', () => {
  beforeEach(() => {
    azureCtorMock.mockReset();
    chatCreateMock.mockReset();
    responsesCreateMock.mockReset();
    chatCreateMock.mockResolvedValue(buildChatResponse('chat-ok'));
    responsesCreateMock.mockResolvedValue(buildResponsesResponse('resp-ok'));
  });

  it('uses chat completions mode for regular models', async () => {
    const llm = new ChatAzure({
      model: 'gpt-4o',
      apiKey: 'test-key',
      endpoint: 'https://example.openai.azure.com',
      apiVersion: '2024-12-01-preview',
      temperature: 0.1,
      frequencyPenalty: 0.2,
      serviceTier: 'priority',
      maxRetries: 7,
    });

    const response = await llm.ainvoke([new UserMessage('hello')]);
    const request = chatCreateMock.mock.calls[0]?.[0] ?? {};

    expect(chatCreateMock).toHaveBeenCalledTimes(1);
    expect(responsesCreateMock).not.toHaveBeenCalled();
    expect(request.model).toBe('gpt-4o');
    expect(request.temperature).toBe(0.1);
    expect(request.frequency_penalty).toBe(0.2);
    expect(request.service_tier).toBe('priority');
    expect(response.completion).toBe('chat-ok');
    expect(response.usage?.completion_tokens).toBe(6);
    expect(response.usage?.prompt_cached_tokens).toBe(2);
    expect(azureCtorMock.mock.calls[0]?.[0]).toMatchObject({
      apiKey: 'test-key',
      endpoint: 'https://example.openai.azure.com',
      apiVersion: '2024-12-01-preview',
      maxRetries: 7,
    });
  });

  it('auto-switches to responses api for codex models', async () => {
    const llm = new ChatAzure({
      model: 'gpt-5.1-codex',
      useResponsesApi: 'auto',
    });

    const response = await llm.ainvoke([new UserMessage('hello')]);
    const request = responsesCreateMock.mock.calls[0]?.[0] ?? {};

    expect(responsesCreateMock).toHaveBeenCalledTimes(1);
    expect(chatCreateMock).not.toHaveBeenCalled();
    expect(request.model).toBe('gpt-5.1-codex');
    expect(request.input).toBeDefined();
    expect(request.reasoning).toEqual({ effort: 'low' });
    expect(response.completion).toBe('resp-ok');
    expect(response.usage?.prompt_cached_tokens).toBe(3);
  });

  it('optimizes structured schema when using responses api', async () => {
    responsesCreateMock.mockResolvedValue(
      buildResponsesResponse(JSON.stringify({ items: ['alpha'] }))
    );
    const schema = z.object({
      items: z.array(z.string()).min(1).default(['seed']),
    });
    const llm = new ChatAzure({
      model: 'gpt-5.1-codex',
      removeMinItemsFromSchema: true,
      removeDefaultsFromSchema: true,
    });

    const response = await llm.ainvoke([new UserMessage('extract')], schema as any);
    const request = responsesCreateMock.mock.calls[0]?.[0] ?? {};
    const schemaPayload = request.text?.format?.schema;

    expect(request.text?.format?.type).toBe('json_schema');
    expect(JSON.stringify(schemaPayload)).not.toContain('minItems');
    expect(JSON.stringify(schemaPayload)).not.toContain('min_items');
    expect(JSON.stringify(schemaPayload)).not.toContain('"default"');
    expect((response.completion as any).items).toEqual(['alpha']);
  });

  it('can force chat completions mode for codex models', async () => {
    const llm = new ChatAzure({
      model: 'gpt-5.1-codex',
      useResponsesApi: false,
    });

    await llm.ainvoke([new UserMessage('hello')]);

    expect(chatCreateMock).toHaveBeenCalledTimes(1);
    expect(responsesCreateMock).not.toHaveBeenCalled();
  });

  it('injects schema into system input for responses api when configured', async () => {
    responsesCreateMock.mockResolvedValue(
      buildResponsesResponse(JSON.stringify({ value: 'ok' }))
    );
    const schema = z.object({ value: z.string() });
    const llm = new ChatAzure({
      model: 'gpt-5.1-codex',
      useResponsesApi: true,
      addSchemaToSystemPrompt: true,
    });

    const response = await llm.ainvoke(
      [new SystemMessage('sys'), new UserMessage('extract')],
      schema as any
    );
    const request = responsesCreateMock.mock.calls[0]?.[0] ?? {};

    expect((request.input?.[0]?.content as string) ?? '').toContain(
      '<json_schema>'
    );
    expect(request.text?.format?.type).toBe('json_schema');
    expect((response.completion as any).value).toBe('ok');
  });
});
