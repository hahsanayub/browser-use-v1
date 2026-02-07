import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getCliUsage, getLlmFromCliArgs, parseCliArgs } from '../src/cli.js';

const MANAGED_ENV_KEYS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_API_KEY',
  'DEEPSEEK_API_KEY',
  'GROQ_API_KEY',
  'OPENROUTER_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_ENDPOINT',
  'AWS_ACCESS_KEY_ID',
  'AWS_PROFILE',
  'OLLAMA_MODEL',
  'OLLAMA_HOST',
  'HOME',
] as const;

const ORIGINAL_ENV = Object.fromEntries(
  MANAGED_ENV_KEYS.map((key) => [key, process.env[key]])
) as Record<(typeof MANAGED_ENV_KEYS)[number], string | undefined>;

const clearManagedEnv = () => {
  for (const key of MANAGED_ENV_KEYS) {
    delete process.env[key];
  }
};

const restoreManagedEnv = () => {
  for (const key of MANAGED_ENV_KEYS) {
    const value = ORIGINAL_ENV[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
};

describe('CLI argument parsing', () => {
  beforeEach(() => {
    clearManagedEnv();
    process.env.HOME = '/home/tester';
  });

  afterEach(() => {
    restoreManagedEnv();
  });

  it('parses prompt mode and browser options', () => {
    const parsed = parseCliArgs([
      '--model',
      'claude-sonnet-4-20250514',
      '--headless',
      '--window-width',
      '1440',
      '--window-height=900',
      '--user-data-dir',
      '~/chrome-data',
      '--profile-directory',
      'Profile 1',
      '--cdp-url',
      'http://localhost:9222',
      '-p',
      'Open docs and summarize',
    ]);

    expect(parsed.model).toBe('claude-sonnet-4-20250514');
    expect(parsed.headless).toBe(true);
    expect(parsed.window_width).toBe(1440);
    expect(parsed.window_height).toBe(900);
    expect(parsed.user_data_dir).toBe('/home/tester/chrome-data');
    expect(parsed.profile_directory).toBe('Profile 1');
    expect(parsed.cdp_url).toBe('http://localhost:9222');
    expect(parsed.prompt).toBe('Open docs and summarize');
    expect(parsed.positional).toEqual([]);
  });

  it('parses positional task mode', () => {
    const parsed = parseCliArgs(['Go', 'to', 'example.com']);
    expect(parsed.prompt).toBeNull();
    expect(parsed.positional).toEqual(['Go', 'to', 'example.com']);
  });

  it('rejects unknown options', () => {
    expect(() => parseCliArgs(['--unknown-option'])).toThrow(
      'Unknown option: --unknown-option'
    );
  });

  it('rejects mixed prompt and positional task input', () => {
    expect(() => parseCliArgs(['--prompt', 'task one', 'task two'])).toThrow(
      'Use either positional task text or --prompt, not both.'
    );
  });

  it('renders usage help text', () => {
    const usage = getCliUsage();
    expect(usage).toContain('browser-use --mcp');
    expect(usage).toContain('--model <model>');
    expect(usage).toContain('--headless');
  });
});

describe('CLI model routing', () => {
  beforeEach(() => {
    clearManagedEnv();
  });

  afterEach(() => {
    restoreManagedEnv();
  });

  it('routes claude* model names to Anthropic', () => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic';
    const args = parseCliArgs([
      '--model',
      'claude-sonnet-4-20250514',
      '-p',
      'x',
    ]);
    const llm = getLlmFromCliArgs(args);
    expect(llm.provider).toBe('anthropic');
    expect(llm.model).toBe('claude-sonnet-4-20250514');
  });

  it('routes gpt* model names to OpenAI', () => {
    process.env.OPENAI_API_KEY = 'test-openai';
    const args = parseCliArgs(['--model', 'gpt-4o', '-p', 'x']);
    const llm = getLlmFromCliArgs(args);
    expect(llm.provider).toBe('openai');
    expect(llm.model).toBe('gpt-4o');
  });

  it('auto-detects OpenAI first when no model is specified', () => {
    process.env.OPENAI_API_KEY = 'test-openai';
    process.env.ANTHROPIC_API_KEY = 'test-anthropic';

    const args = parseCliArgs(['-p', 'task']);
    const llm = getLlmFromCliArgs(args);
    expect(llm.provider).toBe('openai');
    expect(llm.model).toBe('gpt-4o');
  });

  it('falls back to Ollama when no API credentials are present', () => {
    const args = parseCliArgs(['-p', 'task']);
    const llm = getLlmFromCliArgs(args);
    expect(llm.provider).toBe('ollama');
    expect(llm.model).toBe('qwen2.5:latest');
  });

  it('requires matching credentials for explicit provider models', () => {
    const args = parseCliArgs([
      '--model',
      'claude-sonnet-4-20250514',
      '-p',
      'x',
    ]);
    expect(() => getLlmFromCliArgs(args)).toThrow(
      'Missing environment variable: ANTHROPIC_API_KEY'
    );
  });
});
