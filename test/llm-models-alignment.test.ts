import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getLlmByName } from '../src/llm/models.js';

describe('LLM models factory alignment', () => {
  const originalBrowserUseApiKey = process.env.BROWSER_USE_API_KEY;
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
  const originalAzureOpenAiApiKey = process.env.AZURE_OPENAI_API_KEY;
  const originalAzureOpenAiEndpoint = process.env.AZURE_OPENAI_ENDPOINT;

  beforeEach(() => {
    process.env.BROWSER_USE_API_KEY = 'test-bu-key';
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.AZURE_OPENAI_API_KEY = 'test-azure-key';
    process.env.AZURE_OPENAI_ENDPOINT = 'https://example.openai.azure.com';
  });

  afterEach(() => {
    if (originalBrowserUseApiKey === undefined) {
      delete process.env.BROWSER_USE_API_KEY;
    } else {
      process.env.BROWSER_USE_API_KEY = originalBrowserUseApiKey;
    }
    if (originalOpenAiApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiApiKey;
    }
    if (originalAzureOpenAiApiKey === undefined) {
      delete process.env.AZURE_OPENAI_API_KEY;
    } else {
      process.env.AZURE_OPENAI_API_KEY = originalAzureOpenAiApiKey;
    }
    if (originalAzureOpenAiEndpoint === undefined) {
      delete process.env.AZURE_OPENAI_ENDPOINT;
    } else {
      process.env.AZURE_OPENAI_ENDPOINT = originalAzureOpenAiEndpoint;
    }
  });

  it('parses python-style OpenAI model names', () => {
    const llm = getLlmByName('openai_gpt_4_1_mini');
    expect(llm.provider).toBe('openai');
    expect(llm.model).toBe('gpt-4.1-mini');
  });

  it('parses python-style Google model names', () => {
    const llm = getLlmByName('google_gemini_2_5_flash_lite');
    expect(llm.provider).toBe('google');
    expect(llm.model).toBe('gemini-2.5-flash-lite');
  });

  it('supports browser-use aliases from python llm.models', () => {
    const latest = getLlmByName('bu_latest');
    const explicit = getLlmByName('bu_2_0');
    expect(latest.provider).toBe('browser-use');
    expect(latest.model).toBe('bu-1-0');
    expect(explicit.provider).toBe('browser-use');
    expect(explicit.model).toBe('bu-2-0');
  });

  it('infers provider for plain model names', () => {
    const llm = getLlmByName('gpt-5-mini');
    expect(llm.provider).toBe('openai');
    expect(llm.model).toBe('gpt-5-mini');
  });

  it('supports provider-prefixed model aliases used in CLI', () => {
    const llm = getLlmByName('azure:gpt-4o');
    expect(llm.provider).toBe('azure');
    expect(llm.model).toBe('gpt-4o');
  });

  it('throws for unrecognized model names', () => {
    expect(() => getLlmByName('not-a-valid-model-name')).toThrow(
      /Invalid model name format/
    );
  });
});
