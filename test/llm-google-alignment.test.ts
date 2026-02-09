import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const generateContentMock = vi.fn();
const googleCtorMock = vi.fn();

vi.mock('@google/genai', () => {
  class GoogleGenAI {
    models = {
      generateContent: generateContentMock,
    };

    constructor(options?: unknown) {
      googleCtorMock(options);
    }
  }

  return { GoogleGenAI };
});

import {
  ContentPartTextParam,
  SystemMessage,
  UserMessage,
} from '../src/llm/messages.js';
import { ChatGoogle } from '../src/llm/google/chat.js';
import { GoogleMessageSerializer } from '../src/llm/google/serializer.js';

const buildResult = (text: string) => ({
  candidates: [
    {
      content: {
        parts: [{ text }],
      },
      finishReason: 'STOP',
    },
  ],
  usageMetadata: {
    promptTokenCount: 10,
    candidatesTokenCount: 4,
    thoughtsTokenCount: 2,
    totalTokenCount: 16,
    cachedContentTokenCount: 3,
    promptTokensDetails: [{ modality: 'IMAGE', tokenCount: 5 }],
  },
});

describe('Google LLM alignment', () => {
  beforeEach(() => {
    generateContentMock.mockReset();
    googleCtorMock.mockReset();
    generateContentMock.mockResolvedValue(buildResult('plain response'));
  });

  it('extracts system instruction separately by default', () => {
    const serializer = new GoogleMessageSerializer();
    const { contents, systemInstruction } = serializer.serializeWithSystem([
      new SystemMessage('sys A'),
      new SystemMessage('sys B'),
      new UserMessage('hello'),
    ]);

    expect(systemInstruction).toBe('sys A\n\nsys B');
    expect(contents).toHaveLength(1);
    expect((contents[0] as any).role).toBe('user');
    expect((contents[0] as any).parts[0].text).toBe('hello');
  });

  it('can include system text in first user message', () => {
    const serializer = new GoogleMessageSerializer();
    const { contents, systemInstruction } = serializer.serializeWithSystem(
      [
        new SystemMessage('sys header'),
        new UserMessage([new ContentPartTextParam('task body')]),
      ],
      true
    );

    expect(systemInstruction).toBeNull();
    expect((contents[0] as any).parts[0].text).toContain('sys header');
    expect((contents[0] as any).parts[1].text).toBe('task body');
  });

  it('passes generation params and returns usage with cached/image/thought tokens', async () => {
    const llm = new ChatGoogle({
      model: 'gemini-2.5-flash',
      temperature: 0.3,
      topP: 0.8,
      seed: 7,
      maxOutputTokens: 512,
    });

    const response = await llm.ainvoke([
      new SystemMessage('sys'),
      new UserMessage('hello'),
    ]);
    const request = generateContentMock.mock.calls[0]?.[0] ?? {};

    expect(request.generationConfig.temperature).toBe(0.3);
    expect(request.generationConfig.topP).toBe(0.8);
    expect(request.generationConfig.seed).toBe(7);
    expect(request.generationConfig.maxOutputTokens).toBe(512);
    expect(request.systemInstruction.parts[0].text).toBe('sys');
    expect(response.completion).toBe('plain response');
    expect(response.usage?.completion_tokens).toBe(6);
    expect(response.usage?.prompt_cached_tokens).toBe(3);
    expect(response.usage?.prompt_image_tokens).toBe(5);
  });

  it('enforces structured output with includeSystemInUser mode', async () => {
    generateContentMock.mockResolvedValue(
      buildResult('```json\n{"value":"ok"}\n```')
    );
    const schema = z.object({ value: z.string() });
    const llm = new ChatGoogle({
      model: 'gemini-2.5-flash',
      includeSystemInUser: true,
      supportsStructuredOutput: true,
    });

    const response = await llm.ainvoke(
      [new SystemMessage('sys prompt'), new UserMessage('extract')],
      schema as any
    );
    const request = generateContentMock.mock.calls[0]?.[0] ?? {};

    expect(request.systemInstruction).toBeUndefined();
    expect((request.contents[0].parts[0].text as string)).toContain('sys prompt');
    expect(request.generationConfig.responseMimeType).toBe('application/json');
    expect(request.generationConfig.responseSchema).toBeDefined();
    expect((response.completion as any).value).toBe('ok');
  });
});
