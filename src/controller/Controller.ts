/**
 * Main Controller class that orchestrates all components of the browser-use system
 */

import { Browser } from '../browser/Browser';
import { BrowserContext } from '../browser/BrowserContext';
import { BrowserSession } from '../browser/BrowserSession';
import { Agent } from '../agent/Agent';
import { createLLMClient } from '../llm/factory';
import { BaseLLMClient } from '../llm/base-client';
import { getConfig } from '../config/index';
import { initializeLogger } from '../services/logging';
import {
  initializeSignalHandler,
  addCleanupFunction,
} from '../services/signal-handler';
import type { AppConfig } from '../config/schema';
import type { AgentHistory, AgentConfig, ActionResult } from '../types/agent';
import type { BrowserContextConfig } from '../types/browser';
import { registry } from './singleton';
import { z } from 'zod';
// ensure builtin actions are registered
import './actions';

export interface ControllerConfig {
  /** Configuration override (optional) */
  config?: Partial<AppConfig>;
  /** Whether to auto-initialize browser */
  autoInitializeBrowser?: boolean;
  /** Whether to setup signal handlers for graceful shutdown */
  setupSignalHandlers?: boolean;
}

/**
 * Main Controller class for the browser-use system
 */
export class Controller {
  private config: AppConfig;
  private browser: Browser | null = null;
  private browserContext: BrowserContext | null = null;
  private browserSession: BrowserSession | null = null;
  private agent: Agent | null = null;
  private llmClient: BaseLLMClient | null = null;
  private logger;
  private isInitialized = false;

  private controllerConfig: Required<Omit<ControllerConfig, 'config'>> & {
    config?: Partial<AppConfig>;
  };

  constructor(controllerConfig: ControllerConfig = {}) {
    // This will be set during initialization
    this.config = null as any;
    this.logger = null as any;

    // Store controller config for later use
    this.controllerConfig = {
      autoInitializeBrowser: true,
      setupSignalHandlers: true,
      ...controllerConfig,
    };
  }

  /**
   * Initialize the controller and all its components
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      throw new Error('Controller is already initialized');
    }

    try {
      // Load configuration
      this.config = await getConfig();

      // Apply any config overrides
      if (this.controllerConfig.config) {
        this.config = { ...this.config, ...this.controllerConfig.config };
      }

      // Initialize logging
      this.logger = initializeLogger(this.config.logging);
      this.logger.info('Browser-use controller initializing');

      // Setup signal handlers for graceful shutdown
      if (this.controllerConfig.setupSignalHandlers) {
        initializeSignalHandler();
        addCleanupFunction(async () => {
          await this.cleanup();
        });
      }

      // Initialize LLM client
      this.llmClient = createLLMClient(this.config.llm);
      this.logger.debug('LLM client initialized');

      // Mark initialized before initializing the browser so that dependent
      // methods that assert initialization can proceed.
      this.isInitialized = true;

      // Auto-initialize browser if requested
      if (this.controllerConfig.autoInitializeBrowser) {
        await this.initializeBrowser();
      }

      this.logger.info('Browser-use controller initialized successfully');
    } catch (error) {
      // Ensure state reflects failure
      this.isInitialized = false;
      if (this.logger) {
        this.logger.error('Failed to initialize controller', error as Error);
      } else {
        console.error('Failed to initialize controller:', error);
      }
      throw error;
    }
  }

  /**
   * Initialize browser components
   */
  async initializeBrowser(): Promise<void> {
    if (!this.isInitialized) {
      throw new Error('Controller must be initialized first');
    }

    try {
      this.logger.info('Initializing browser');

      // Create and launch browser
      this.browser = new Browser(this.config.browser);
      await this.browser.launch();

      // Create browser context
      const contextConfig: BrowserContextConfig = {
        headless: this.config.browser.headless,
        viewport: this.config.browser.viewport,
        timeout: this.config.browser.timeout,
      };

      this.browserContext = new BrowserContext(
        this.browser.getBrowser()!,
        contextConfig
      );
      await this.browserContext.launch();

      // Create unified session on top of browser/context
      this.browserSession = new BrowserSession({
        browser: this.browser.getBrowser()!,
        context: this.browserContext.getContext()!,
        config: {
          keepAlive: false,
          saveState: true,
          timeout: this.config.browser.timeout,
          viewport: this.config.browser.viewport,
        },
      });
      await this.browserSession.start();

      this.logger.info('Browser initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize browser', error as Error);
      throw error;
    }
  }

  /**
   * Get or create an agent instance
   */
  async getAgent(agentConfig?: AgentConfig): Promise<Agent> {
    if (!this.isInitialized) {
      throw new Error('Controller must be initialized first');
    }

    if (!this.browserContext || !this.browserSession) {
      throw new Error(
        'Browser not initialized. Call initializeBrowser() first.'
      );
    }

    // Create agent if it doesn't exist or if new config is provided
    if (!this.agent || agentConfig) {
      this.logger.debug('Creating new agent instance');

      // Reuse the existing LLM client
      if (!this.llmClient) {
        throw new Error('LLM client not initialized');
      }

      // Merge agent config with global config
      const finalAgentConfig: AgentConfig = {
        maxSteps: this.config.maxSteps,
        ...agentConfig,
      };

      this.agent = new Agent(
        this.browserSession,
        this.llmClient,
        finalAgentConfig,
        async (name, params) => this.act(name, params)
      );
      this.logger.info('Agent created successfully');
    }

    return this.agent;
  }

  /**
   * Run a task with the agent
   */
  async run(
    objective: string,
    agentConfig?: AgentConfig
  ): Promise<AgentHistory[]> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (!this.browserContext || !this.browserSession) {
      await this.initializeBrowser();
    }

    this.logger.info('Starting task execution', { objective });

    try {
      // Get or create agent
      const agent = await this.getAgent(agentConfig);

      // Ensure we have an active page
      const activePage = this.browserContext!.getActivePage();
      if (!activePage) {
        this.logger.debug('No active page found, creating new page');
        await this.browserContext!.newPage();
      }

      // Execute the task
      const history = await agent.run(objective, {
        onStepStart: agentConfig?.onStepStart,
        onStepEnd: agentConfig?.onStepEnd,
      });

      this.logger.info('Task execution completed', {
        objective,
        steps: history.length,
        success: history[history.length - 1]?.result.success,
      });

      return history;
    } catch (error) {
      this.logger.error('Task execution failed', error as Error, { objective });
      throw error;
    }
  }

  /**
   * Execute a registered action via the registry
   */
  async act(
    actionName: string,
    params: Record<string, unknown> = {}
  ): Promise<ActionResult> {
    if (!this.browserContext || !this.browserSession) {
      throw new Error('Browser context not initialized');
    }

    const action = registry.get(actionName);
    if (!action) {
      return {
        success: false,
        message: `Unknown action: ${actionName}`,
        error: 'UNKNOWN_ACTION',
      };
    }

    // validate params
    let validatedParams: Record<string, unknown> = {};
    try {
      validatedParams = (action.paramSchema as z.ZodTypeAny).parse(params);
    } catch (error) {
      return {
        success: false,
        message: `Invalid params for action: ${actionName}`,
        error: (error as Error).message,
      };
    }

    // Controller负责获取和注入核心依赖
    let page = this.browserContext.getActivePage();
    if (!page) page = await this.browserContext.newPage();

    // Pre-signature
    const beforeSig = await this.browserSession.getDomSignature();

    const result = await action.execute({
      params: validatedParams,
      page,
      context: {
        browserContext: this.browserContext,
        browserSession: this.browserSession,
        llmClient: this.llmClient,
      },
    });

    // Post-signature and cache invalidation if changed
    try {
      const afterSig = await this.browserSession.getDomSignature();
      if (beforeSig !== afterSig) {
        this.browserSession.invalidateCache();
      }
    } catch {
      // ignore signature check failures
    }

    return result;
  }

  /**
   * Navigate to a URL
   */
  async goto(url: string): Promise<void> {
    if (!this.browserContext || !this.browserSession) {
      throw new Error('Browser context not initialized');
    }

    this.logger.info('Navigating to URL', { url });

    try {
      let page = this.browserContext.getActivePage();
      if (!page) {
        page = await this.browserContext.newPage();
      }
      // Minimal health check: recreate page if unresponsive
      try {
        await page.evaluate(() => true, { timeout: 1000 });
      } catch {
        await page.close().catch(() => {});
        page = await this.browserContext.newPage();
      }
      await this.browserSession!.navigate(url);
      this.logger.info('Navigation completed', { url });
    } catch (error) {
      this.logger.error('Navigation failed', error as Error, { url });
      throw error;
    }
  }

  /**
   * Create a new page in the browser context
   */
  async newPage(): Promise<void> {
    if (!this.browserContext) {
      throw new Error('Browser context not initialized');
    }

    await this.browserContext.newPage();
    this.logger.debug('New page created');
  }

  /**
   * Get the current browser instance
   */
  getBrowser(): Browser | null {
    return this.browser;
  }

  /**
   * Get the current browser context
   */
  getBrowserContext(): BrowserContext | null {
    return this.browserContext;
  }

  /** Get the current browser session */
  getBrowserSession(): BrowserSession | null {
    return this.browserSession;
  }

  /**
   * Get the current agent instance
   */
  getCurrentAgent(): Agent | null {
    return this.agent;
  }

  /**
   * Get the current configuration
   */
  getConfig(): AppConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<AppConfig>): void {
    this.config = { ...this.config, ...config };
    this.logger.info('Configuration updated');

    // Update component configurations
    if (this.browser && config.browser) {
      this.browser.updateConfig(config.browser);
    }

    if (this.agent && config.maxSteps !== undefined) {
      this.agent.updateConfig({ maxSteps: config.maxSteps });
    }
  }

  /**
   * Check if controller is initialized
   */
  isReady(): boolean {
    return this.isInitialized;
  }

  /**
   * Check if browser is ready
   */
  isBrowserReady(): boolean {
    return this.browser !== null && this.browserContext !== null;
  }

  /**
   * Cleanup all resources
   */
  async cleanup(): Promise<void> {
    this.logger?.info('Starting cleanup');

    try {
      // Stop agent if running
      if (this.agent?.getIsRunning()) {
        this.agent.stop();
        await new Promise((resolve) => setTimeout(resolve, 1000)); // Give it time to stop
      }

      // Close browser context
      if (this.browserContext) {
        await this.browserContext.close();
        this.browserContext = null;
      }

      // Close browser
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
      }



      this.agent = null;
      this.isInitialized = false;

      this.logger?.info('Cleanup completed');
    } catch (error) {
      this.logger?.error('Error during cleanup', error as Error);
      throw error;
    }
  }

  /**
   * Restart the browser (useful for recovery)
   */
  async restartBrowser(): Promise<void> {
    this.logger.info('Restarting browser');

    try {
      // Close existing browser context
      if (this.browserContext) {
        await this.browserContext.close();
        this.browserContext = null;
      }

      // Restart browser
      if (this.browser) {
        await this.browser.restart();
      } else {
        await this.initializeBrowser();
        return;
      }

      // Recreate browser context
      const contextConfig: BrowserContextConfig = {
        headless: this.config.browser.headless,
        viewport: this.config.browser.viewport,
        timeout: this.config.browser.timeout,
      };

      this.browserContext = new BrowserContext(
        this.browser.getBrowser()!,
        contextConfig
      );
      await this.browserContext.launch();

      // Recreate session as well
      this.browserSession = new BrowserSession({
        browser: this.browser.getBrowser()!,
        context: this.browserContext.getContext()!,
        config: {
          keepAlive: false,
          saveState: true,
          timeout: this.config.browser.timeout,
          viewport: this.config.browser.viewport,
        },
      });
      await this.browserSession.start();

      // Reset agent since browser context changed
      this.agent = null;

      this.logger.info('Browser restarted successfully');
    } catch (error) {
      this.logger.error('Failed to restart browser', error as Error);
      throw error;
    }
  }
}
