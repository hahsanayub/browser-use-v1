#!/usr/bin/env node
import path from 'node:path';
import { Agent } from './agent/service.js';
import {
  BrowserProfile,
  type BrowserProfileOptions,
} from './browser/profile.js';
import { BrowserSession } from './browser/session.js';
import { ChatOpenAI } from './llm/openai/chat.js';
import { ChatAnthropic } from './llm/anthropic/chat.js';
import { ChatGoogle } from './llm/google/chat.js';
import { ChatDeepSeek } from './llm/deepseek/chat.js';
import { ChatGroq } from './llm/groq/chat.js';
import { ChatOpenRouter } from './llm/openrouter/chat.js';
import { ChatAzure } from './llm/azure/chat.js';
import { ChatOllama } from './llm/ollama/chat.js';
import { ChatAnthropicBedrock } from './llm/aws/chat-anthropic.js';
import { ChatBedrockConverse } from './llm/aws/chat-bedrock.js';
import type { BaseChatModel } from './llm/base.js';
import { MCPServer } from './mcp/server.js';
import { get_browser_use_version } from './utils.js';
import { setupLogging } from './logging-config.js';
import dotenv from 'dotenv';

dotenv.config();

export interface ParsedCliArgs {
  help: boolean;
  version: boolean;
  debug: boolean;
  headless: boolean | null;
  window_width: number | null;
  window_height: number | null;
  user_data_dir: string | null;
  profile_directory: string | null;
  cdp_url: string | null;
  model: string | null;
  prompt: string | null;
  mcp: boolean;
  positional: string[];
}

const parsePositiveInt = (name: string, value: string): number => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got "${value}"`);
  }
  return parsed;
};

const takeOptionValue = (
  arg: string,
  currentIndex: number,
  argv: string[]
): { value: string; nextIndex: number } => {
  const eqIndex = arg.indexOf('=');
  if (eqIndex >= 0) {
    const inlineValue = arg.slice(eqIndex + 1).trim();
    if (!inlineValue) {
      throw new Error(`Missing value for option: ${arg.slice(0, eqIndex)}`);
    }
    return { value: inlineValue, nextIndex: currentIndex };
  }

  const next = argv[currentIndex + 1];
  if (!next || next.startsWith('-')) {
    throw new Error(`Missing value for option: ${arg}`);
  }
  return { value: next, nextIndex: currentIndex + 1 };
};

const expandHome = (value: string): string => {
  if (!value.startsWith('~')) {
    return value;
  }
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (!home) {
    return value;
  }
  if (value === '~') {
    return home;
  }
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(home, value.slice(2));
  }
  return value;
};

export const parseCliArgs = (argv: string[]): ParsedCliArgs => {
  const parsed: ParsedCliArgs = {
    help: false,
    version: false,
    debug: false,
    headless: null,
    window_width: null,
    window_height: null,
    user_data_dir: null,
    profile_directory: null,
    cdp_url: null,
    model: null,
    prompt: null,
    mcp: false,
    positional: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--') {
      parsed.positional.push(...argv.slice(i + 1));
      break;
    }

    if (arg === '-h' || arg === '--help') {
      parsed.help = true;
      continue;
    }
    if (arg === '--version') {
      parsed.version = true;
      continue;
    }
    if (arg === '--debug') {
      parsed.debug = true;
      continue;
    }
    if (arg === '--headless') {
      parsed.headless = true;
      continue;
    }
    if (arg === '--mcp') {
      parsed.mcp = true;
      continue;
    }

    if (arg === '-p' || arg === '--prompt' || arg.startsWith('--prompt=')) {
      const { value, nextIndex } = takeOptionValue(arg, i, argv);
      parsed.prompt = value;
      i = nextIndex;
      continue;
    }
    if (arg === '--model' || arg.startsWith('--model=')) {
      const { value, nextIndex } = takeOptionValue(arg, i, argv);
      parsed.model = value;
      i = nextIndex;
      continue;
    }
    if (arg === '--window-width' || arg.startsWith('--window-width=')) {
      const { value, nextIndex } = takeOptionValue(arg, i, argv);
      parsed.window_width = parsePositiveInt('--window-width', value);
      i = nextIndex;
      continue;
    }
    if (arg === '--window-height' || arg.startsWith('--window-height=')) {
      const { value, nextIndex } = takeOptionValue(arg, i, argv);
      parsed.window_height = parsePositiveInt('--window-height', value);
      i = nextIndex;
      continue;
    }
    if (arg === '--user-data-dir' || arg.startsWith('--user-data-dir=')) {
      const { value, nextIndex } = takeOptionValue(arg, i, argv);
      parsed.user_data_dir = path.resolve(expandHome(value));
      i = nextIndex;
      continue;
    }
    if (
      arg === '--profile-directory' ||
      arg.startsWith('--profile-directory=')
    ) {
      const { value, nextIndex } = takeOptionValue(arg, i, argv);
      parsed.profile_directory = value;
      i = nextIndex;
      continue;
    }
    if (arg === '--cdp-url' || arg.startsWith('--cdp-url=')) {
      const { value, nextIndex } = takeOptionValue(arg, i, argv);
      parsed.cdp_url = value;
      i = nextIndex;
      continue;
    }

    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    }
    parsed.positional.push(arg);
  }

  if (parsed.prompt && parsed.positional.length > 0) {
    throw new Error('Use either positional task text or --prompt, not both.');
  }

  return parsed;
};

const resolveTask = (args: ParsedCliArgs): string | null => {
  if (args.prompt) {
    return args.prompt.trim();
  }
  if (args.positional.length > 0) {
    return args.positional.join(' ').trim();
  }
  return null;
};

const requireEnv = (name: string) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
};

const inferProviderFromModel = (
  model: string
):
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'deepseek'
  | 'groq'
  | 'openrouter'
  | 'azure'
  | 'aws-anthropic'
  | 'aws'
  | 'ollama'
  | null => {
  const lower = model.toLowerCase();

  if (
    lower.startsWith('gpt') ||
    lower.startsWith('o1') ||
    lower.startsWith('o3') ||
    lower.startsWith('o4') ||
    lower.startsWith('gpt-5')
  ) {
    return 'openai';
  }
  if (lower.startsWith('claude')) {
    return 'anthropic';
  }
  if (lower.startsWith('gemini')) {
    return 'google';
  }
  if (lower.startsWith('deepseek')) {
    return 'deepseek';
  }
  if (lower.startsWith('groq:')) {
    return 'groq';
  }
  if (lower.startsWith('openrouter:')) {
    return 'openrouter';
  }
  if (lower.startsWith('azure:')) {
    return 'azure';
  }
  if (lower.startsWith('ollama:')) {
    return 'ollama';
  }
  if (lower.startsWith('bedrock:anthropic.')) {
    return 'aws-anthropic';
  }
  if (lower.startsWith('bedrock:')) {
    return 'aws';
  }
  if (lower.startsWith('anthropic.')) {
    return 'aws-anthropic';
  }
  if (
    lower.includes('/') &&
    !lower.startsWith('http://') &&
    !lower.startsWith('https://')
  ) {
    return 'openrouter';
  }
  return null;
};

const normalizeModelValue = (
  model: string,
  provider:
    | 'openai'
    | 'anthropic'
    | 'google'
    | 'deepseek'
    | 'groq'
    | 'openrouter'
    | 'azure'
    | 'aws-anthropic'
    | 'aws'
    | 'ollama'
): string => {
  const lower = model.toLowerCase();
  if (provider === 'groq' && lower.startsWith('groq:')) {
    return model.slice('groq:'.length);
  }
  if (provider === 'openrouter' && lower.startsWith('openrouter:')) {
    return model.slice('openrouter:'.length);
  }
  if (provider === 'azure' && lower.startsWith('azure:')) {
    return model.slice('azure:'.length);
  }
  if (provider === 'ollama' && lower.startsWith('ollama:')) {
    return model.slice('ollama:'.length);
  }
  if (provider === 'aws-anthropic' && lower.startsWith('bedrock:')) {
    return model.slice('bedrock:'.length);
  }
  if (provider === 'aws' && lower.startsWith('bedrock:')) {
    return model.slice('bedrock:'.length);
  }
  return model;
};

export const getLlmFromCliArgs = (args: ParsedCliArgs): BaseChatModel => {
  if (args.model) {
    const provider = inferProviderFromModel(args.model);
    if (!provider) {
      throw new Error(
        `Cannot infer provider from model "${args.model}". Supported prefixes: gpt*/o*, claude*, gemini*, deepseek*, groq:, openrouter:, azure:, ollama:, bedrock:.`
      );
    }
    const normalizedModel = normalizeModelValue(args.model, provider);

    switch (provider) {
      case 'openai':
        return new ChatOpenAI({
          model: normalizedModel,
          apiKey: requireEnv('OPENAI_API_KEY'),
        });
      case 'anthropic':
        return new ChatAnthropic({
          model: normalizedModel,
          apiKey: requireEnv('ANTHROPIC_API_KEY'),
        });
      case 'google':
        requireEnv('GOOGLE_API_KEY');
        return new ChatGoogle(normalizedModel);
      case 'deepseek':
        requireEnv('DEEPSEEK_API_KEY');
        return new ChatDeepSeek(normalizedModel);
      case 'groq':
        requireEnv('GROQ_API_KEY');
        return new ChatGroq(normalizedModel);
      case 'openrouter':
        requireEnv('OPENROUTER_API_KEY');
        return new ChatOpenRouter(normalizedModel);
      case 'azure':
        requireEnv('AZURE_OPENAI_API_KEY');
        requireEnv('AZURE_OPENAI_ENDPOINT');
        return new ChatAzure(normalizedModel);
      case 'ollama': {
        const host = process.env.OLLAMA_HOST || 'http://localhost:11434';
        return new ChatOllama(normalizedModel, host);
      }
      case 'aws-anthropic':
        return new ChatAnthropicBedrock({
          model: normalizedModel,
          region: process.env.AWS_REGION || 'us-east-1',
        });
      case 'aws':
        return new ChatBedrockConverse(
          normalizedModel,
          process.env.AWS_REGION || 'us-east-1'
        );
      default:
        throw new Error(`Unsupported model provider for "${args.model}"`);
    }
  }

  if (process.env.OPENAI_API_KEY) {
    return new ChatOpenAI({
      model: 'gpt-4o',
      apiKey: process.env.OPENAI_API_KEY,
    });
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return new ChatAnthropic({
      model: 'claude-sonnet-4-20250514',
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
  }
  if (process.env.GOOGLE_API_KEY) {
    return new ChatGoogle('gemini-2.5-flash');
  }
  if (process.env.DEEPSEEK_API_KEY) {
    return new ChatDeepSeek('deepseek-chat');
  }
  if (process.env.GROQ_API_KEY) {
    return new ChatGroq('llama-3.1-70b-versatile');
  }
  if (process.env.OPENROUTER_API_KEY) {
    return new ChatOpenRouter('openai/gpt-4o');
  }
  if (process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_ENDPOINT) {
    return new ChatAzure('gpt-4o');
  }
  if (process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE) {
    return new ChatAnthropicBedrock({
      model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      region: process.env.AWS_REGION || 'us-east-1',
    });
  }

  return new ChatOllama(
    process.env.OLLAMA_MODEL || 'qwen2.5:latest',
    process.env.OLLAMA_HOST || 'http://localhost:11434'
  );
};

const buildBrowserProfileFromCliArgs = (
  args: ParsedCliArgs
): BrowserProfile | null => {
  const profile: Partial<BrowserProfileOptions> = {};

  if (args.headless !== null) {
    profile.headless = args.headless;
  }
  if (args.window_width !== null) {
    profile.window_width = args.window_width;
  }
  if (args.window_height !== null) {
    profile.window_height = args.window_height;
  }
  if (args.user_data_dir) {
    profile.user_data_dir = args.user_data_dir;
  }
  if (args.profile_directory) {
    profile.profile_directory = args.profile_directory;
  }

  if (Object.keys(profile).length === 0) {
    return null;
  }
  return new BrowserProfile(profile);
};

export const getCliUsage = () => `Usage:
  browser-use <task>
  browser-use -p "<task>"
  browser-use [options] <task>
  browser-use --mcp

Options:
  -h, --help                  Show this help message
  --version                   Print version and exit
  --mcp                       Run as MCP server
  --model <model>             Set model (e.g., gpt-4o, claude-sonnet-4-20250514, gemini-2.5-flash)
  -p, --prompt <task>         Run a single task
  --headless                  Run browser in headless mode
  --window-width <px>         Browser window width
  --window-height <px>        Browser window height
  --user-data-dir <path>      Chrome user data directory
  --profile-directory <name>  Chrome profile directory (Default, Profile 1, ...)
  --cdp-url <url>             Connect to an existing Chromium instance via CDP
  --debug                     Enable debug logging`;

async function runMcpServer() {
  const server = new MCPServer('browser-use', get_browser_use_version());
  await server.start();

  const shutdown = async () => {
    await server.stop();
    process.exit(0);
  };

  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

  await new Promise(() => {});
}

export async function main(argv: string[] = process.argv.slice(2)) {
  let args: ParsedCliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (error) {
    console.error((error as Error).message);
    console.error(getCliUsage());
    process.exit(1);
    return;
  }

  if (args.help) {
    console.log(getCliUsage());
    return;
  }

  if (args.version) {
    console.log(get_browser_use_version());
    return;
  }

  if (args.debug) {
    process.env.BROWSER_USE_LOGGING_LEVEL = 'debug';
    setupLogging({ logLevel: 'debug', forceSetup: true });
  }

  if (args.mcp) {
    await runMcpServer();
    return;
  }

  const task = resolveTask(args);
  if (!task) {
    console.error(getCliUsage());
    process.exit(1);
    return;
  }
  console.log(`Starting task: ${task}`);

  let llm: BaseChatModel;
  try {
    llm = getLlmFromCliArgs(args);
  } catch (error) {
    console.error(`Error selecting LLM: ${(error as Error).message}`);
    process.exit(1);
    return;
  }

  const browserProfile = buildBrowserProfileFromCliArgs(args);
  const browserSession = args.cdp_url
    ? new BrowserSession({
        browser_profile: browserProfile ?? undefined,
        cdp_url: args.cdp_url,
      })
    : null;
  const agent = new Agent({
    task,
    llm,
    ...(browserProfile ? { browser_profile: browserProfile } : {}),
    ...(browserSession ? { browser_session: browserSession } : {}),
    source: 'cli',
  });

  try {
    await agent.run();
  } catch (error) {
    console.error('Error running agent:', error);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
