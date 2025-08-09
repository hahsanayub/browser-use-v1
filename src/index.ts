/**
 * Browser-use library - TypeScript-first browser automation for AI agents
 */

// Main exports
export { Controller } from './controller/index';
export type { ControllerConfig } from './controller/index';

// Browser components
export { Browser, BrowserContext } from './browser/index';

// Agent components
export { Agent } from './agent/index';
export type {
  Action,
  AgentThought,
  AgentHistory,
  ActionResult,
  AgentConfig,
} from './agent/index';

// LLM components
export {
  BaseLLMClient,
  OpenAIClient,
  AnthropicClient,
  createLLMClient,
  validateLLMConfig,
  getSupportedProviders,
  getDefaultModels,
} from './llm/index';
export type {
  LLMMessage,
  LLMResponse,
  LLMRequestOptions,
  LLMClientConfig,
} from './llm/index';

// Configuration
export { getConfig, loadConfig, resetConfig } from './config/index';
export type {
  AppConfig,
  BrowserConfig,
  LLMConfig,
  LoggingConfig,
} from './config/index';

// Services
export { DOMService } from './services/dom-service';
export {
  Logger,
  initializeLogger,
  getLogger,
  createLogger,
} from './services/logging';
export {
  SignalHandler,
  initializeSignalHandler,
  getSignalHandler,
  addCleanupFunction,
  createSignalHandler,
} from './services/signal-handler';

// Types
export type { BrowserContextConfig } from './types/browser';
export type {
  PageView,
  InteractiveElement,
  DOMProcessingOptions,
} from './types/dom';

/**
 * Create a new browser-use controller instance
 * This is the main entry point for most users
 */
export async function createController(
  config?: Partial<import('./controller/Controller.js').ControllerConfig>
) {
  const { Controller } = await import('./controller/Controller.js');
  const controller = new Controller(config);
  await controller.initialize();
  return controller;
}

/**
 * Quick start function for simple automation tasks
 */
export async function run(
  objective: string,
  config?: {
    llmApiKey?: string;
    llmProvider?: 'openai' | 'anthropic';
    headless?: boolean;
    startUrl?: string;
  }
) {
  const controller = await createController({
    config: config
      ? {
          llm: {
            provider: config.llmProvider || 'openai',
            apiKey: config.llmApiKey || process.env.LLM_API_KEY || '',
            model:
              config.llmProvider === 'anthropic'
                ? 'claude-3-sonnet-20240229'
                : 'gpt-3.5-turbo',
            timeout: 30000,
            maxTokens: 4000,
            temperature: 0.7,
          },
          browser: {
            browserType: 'chromium' as const,
            headless: config.headless ?? true,
            args: [],
            timeout: 30000,
            viewport: { width: 1280, height: 720 },
          },
          logging: {
            level: 'info' as const,
            console: true,
            json: false,
          },
          maxSteps: 100,
        }
      : undefined,
  });

  try {
    // Navigate to start URL if provided
    if (config?.startUrl) {
      await controller.goto(config.startUrl);
    }

    // Run the task
    const history = await controller.run(objective);
    return { controller, history };
  } catch (error) {
    // Cleanup on error
    await controller.cleanup();
    throw error;
  }
}
