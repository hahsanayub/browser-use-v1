import type { BaseChatModel } from './base.js';
import { ChatAnthropic } from './anthropic/chat.js';
import { ChatBedrockConverse } from './aws/chat-bedrock.js';
import { ChatAzure } from './azure/chat.js';
import { ChatBrowserUse } from './browser-use/chat.js';
import { ChatDeepSeek } from './deepseek/chat.js';
import { ChatGoogle } from './google/chat.js';
import { ChatGroq } from './groq/chat.js';
import { ChatOllama } from './ollama/chat.js';
import { ChatOpenAI } from './openai/chat.js';
import { ChatOpenRouter } from './openrouter/chat.js';

type ResolvedProvider =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'deepseek'
  | 'groq'
  | 'openrouter'
  | 'azure'
  | 'ollama'
  | 'aws'
  | 'browser-use';

const AVAILABLE_PROVIDERS = [
  'openai',
  'anthropic',
  'google',
  'deepseek',
  'groq',
  'openrouter',
  'azure',
  'ollama',
  'aws',
  'browser-use',
] as const;

const convertPythonModelPart = (modelPart: string): string => {
  if (modelPart.includes('gpt_4_1_mini')) {
    return modelPart.replace('gpt_4_1_mini', 'gpt-4.1-mini');
  }
  if (modelPart.includes('gpt_4o_mini')) {
    return modelPart.replace('gpt_4o_mini', 'gpt-4o-mini');
  }
  if (modelPart.includes('gpt_4o')) {
    return modelPart.replace('gpt_4o', 'gpt-4o');
  }
  if (modelPart.includes('gemini_2_0')) {
    return modelPart.replace('gemini_2_0', 'gemini-2.0').replace(/_/g, '-');
  }
  if (modelPart.includes('gemini_2_5')) {
    return modelPart.replace('gemini_2_5', 'gemini-2.5').replace(/_/g, '-');
  }
  return modelPart.replace(/_/g, '-');
};

const inferProviderFromModel = (model: string): ResolvedProvider | null => {
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
  if (lower.startsWith('bedrock:')) {
    return 'aws';
  }
  if (lower.startsWith('anthropic.')) {
    return 'aws';
  }
  if (lower.startsWith('bu-') || lower.startsWith('browser-use/')) {
    return 'browser-use';
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

const normalizeModelForProvider = (
  provider: ResolvedProvider,
  model: string
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
  if (provider === 'aws' && lower.startsWith('bedrock:')) {
    return model.slice('bedrock:'.length);
  }
  return model;
};

const buildProviderModel = (
  provider: ResolvedProvider,
  model: string
): BaseChatModel => {
  switch (provider) {
    case 'openai':
      return new ChatOpenAI({
        model,
        apiKey: process.env.OPENAI_API_KEY,
      });
    case 'anthropic':
      return new ChatAnthropic({
        model,
        apiKey: process.env.ANTHROPIC_API_KEY,
      });
    case 'google':
      return new ChatGoogle({
        model,
        apiKey: process.env.GOOGLE_API_KEY || '',
      });
    case 'deepseek':
      return new ChatDeepSeek({
        model,
        apiKey: process.env.DEEPSEEK_API_KEY,
      });
    case 'groq':
      return new ChatGroq({
        model,
        apiKey: process.env.GROQ_API_KEY,
      });
    case 'openrouter':
      return new ChatOpenRouter({
        model,
        apiKey: process.env.OPENROUTER_API_KEY,
      });
    case 'azure':
      return new ChatAzure({
        model,
        apiKey: process.env.AZURE_OPENAI_KEY ?? process.env.AZURE_OPENAI_API_KEY,
        endpoint: process.env.AZURE_OPENAI_ENDPOINT,
      });
    case 'ollama':
      return new ChatOllama({
        model,
        host: process.env.OLLAMA_HOST || 'http://localhost:11434',
      });
    case 'aws':
      return new ChatBedrockConverse({
        model,
        region: process.env.AWS_REGION || 'us-east-1',
      });
    case 'browser-use':
      return new ChatBrowserUse({
        model,
        apiKey: process.env.BROWSER_USE_API_KEY,
      });
    default:
      throw new Error(
        `Unknown provider '${provider}'. Available providers: ${AVAILABLE_PROVIDERS.join(', ')}`
      );
  }
};

export const getLlmByName = (modelName: string): BaseChatModel => {
  const normalizedName = modelName.trim();
  if (!normalizedName) {
    throw new Error('Model name cannot be empty');
  }

  if (normalizedName === 'bu_latest') {
    return buildProviderModel('browser-use', 'bu-latest');
  }
  if (normalizedName === 'bu_1_0') {
    return buildProviderModel('browser-use', 'bu-1-0');
  }
  if (normalizedName === 'bu_2_0') {
    return buildProviderModel('browser-use', 'bu-2-0');
  }

  const separator = normalizedName.indexOf('_');
  if (separator > 0) {
    const provider = normalizedName.slice(0, separator);
    const modelPart = normalizedName.slice(separator + 1);
    if (provider === 'bu') {
      return buildProviderModel(
        'browser-use',
        `bu-${modelPart.replace(/_/g, '-')}`
      );
    }
    if (provider === 'browser-use') {
      return buildProviderModel(
        'browser-use',
        modelPart.replace(/_/g, '/')
      );
    }
    if (AVAILABLE_PROVIDERS.includes(provider as any)) {
      return buildProviderModel(
        provider as ResolvedProvider,
        convertPythonModelPart(modelPart)
      );
    }
  }

  const inferredProvider = inferProviderFromModel(normalizedName);
  if (!inferredProvider) {
    throw new Error(
      `Invalid model name format: '${normalizedName}'. Expected provider-prefixed name like 'openai_gpt_4o' or a recognizable model prefix.`
    );
  }

  const normalizedModel = normalizeModelForProvider(
    inferredProvider,
    normalizedName
  );
  return buildProviderModel(inferredProvider, normalizedModel);
};
