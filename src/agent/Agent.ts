/**
 * Main Agent class that orchestrates web automation using LLM intelligence
 */

import { Page } from 'playwright';
import { BrowserContext } from '../browser/BrowserContext';
import { DOMService } from '../services/dom-service';
import { BaseLLMClient } from '../llm/base-client';
import type { LLMMessage } from '../types/llm';
import type { PageView } from '../types/dom';
import type { AgentHistory, ActionResult, AgentConfig } from '../types/agent';
import { validateAgentThought, type Action, type AgentThought } from './views';
import {
  SYSTEM_PROMPT,
  generatePageContextPrompt,
  generateStuckRecoveryPrompt,
} from './prompts';
import { getLogger } from '../services/logging';

/**
 * Agent class for intelligent web automation
 */
export class Agent {
  private browserContext: BrowserContext;
  private llmClient: BaseLLMClient;
  private domService: DOMService;
  private config: AgentConfig;
  private history: AgentHistory[] = [];
  private logger = getLogger();
  private currentStep = 0;
  private isRunning = false;

  constructor(
    browserContext: BrowserContext,
    llmClient: BaseLLMClient,
    config: AgentConfig = {}
  ) {
    this.browserContext = browserContext;
    this.llmClient = llmClient;
    this.domService = new DOMService();
    this.config = {
      maxSteps: 100,
      actionTimeout: 30000,
      continueOnFailure: true,
      ...config,
    };
  }

  /**
   * Execute the agent to accomplish the given objective
   */
  async run(objective: string): Promise<AgentHistory[]> {
    if (this.isRunning) {
      throw new Error('Agent is already running');
    }

    this.isRunning = true;
    this.currentStep = 0;
    this.history = [];

    this.logger.info('Agent started', { objective, config: this.config });

    try {
      const page = this.browserContext.getActivePage();
      if (!page) {
        throw new Error(
          'No active page found. Create a page in the browser context first.'
        );
      }

      let consecutiveFailures = 0;
      const maxConsecutiveFailures = 3;

      while (this.currentStep < this.config.maxSteps!) {
        this.currentStep++;

        this.logger.debug(`Starting step ${this.currentStep}`, { objective });

        try {
          // Get current page view
          const pageView = await this.domService.getPageView(page);

          // Generate response from LLM
          const thought = await this.think(objective, pageView);

          // Check if task is complete
          if (thought.isComplete || thought.nextAction.action === 'finish') {
            this.logger.info('Task completed', { step: this.currentStep });

            const finishResult: ActionResult = {
              success: true,
              message: 'Task completed successfully',
            };

            this.addToHistory(thought.nextAction, finishResult, pageView);
            break;
          }

          // Execute the action
          const result = await this.executeAction(page, thought.nextAction);

          // Add to history
          this.addToHistory(thought.nextAction, result, pageView);

          // Handle failures
          if (!result.success) {
            consecutiveFailures++;
            this.logger.warn(
              `Action failed (${consecutiveFailures}/${maxConsecutiveFailures})`,
              {
                step: this.currentStep,
                action: thought.nextAction.action,
                error: result.error,
              }
            );

            if (consecutiveFailures >= maxConsecutiveFailures) {
              if (this.config.continueOnFailure) {
                // Try recovery
                await this.attemptRecovery(
                  page,
                  objective,
                  consecutiveFailures
                );
                consecutiveFailures = 0;
              } else {
                throw new Error(
                  `Too many consecutive failures: ${result.error}`
                );
              }
            }
          } else {
            consecutiveFailures = 0; // Reset on success
          }

          // Wait a bit between actions to be respectful
          await this.sleep(1000);
        } catch (error) {
          this.logger.error(
            `Error in step ${this.currentStep}`,
            error as Error
          );

          if (!this.config.continueOnFailure) {
            throw error;
          }

          // Add error to history and continue
          const errorResult: ActionResult = {
            success: false,
            message: 'Step failed due to error',
            error: (error as Error).message,
          };

          this.addToHistory(
            {
              action: 'error' as any,
              reasoning: 'Error occurred during execution',
            },
            errorResult
          );
        }
      }

      if (this.currentStep >= this.config.maxSteps!) {
        this.logger.warn('Agent reached maximum steps', {
          maxSteps: this.config.maxSteps,
        });
      }

      this.logger.info('Agent finished', {
        steps: this.currentStep,
        historyLength: this.history.length,
      });

      return this.history;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Get the agent's thought process for the current situation
   */
  private async think(
    objective: string,
    pageView: PageView
  ): Promise<AgentThought> {
    const messages: LLMMessage[] = [
      {
        role: 'system',
        content:
          SYSTEM_PROMPT +
          (this.config.customInstructions
            ? `\n\n## Additional Instructions:\n${this.config.customInstructions}`
            : ''),
      },
      {
        role: 'user',
        content: generatePageContextPrompt(objective, pageView, this.history),
      },
    ];

    this.logger.debug('Sending request to LLM', {
      step: this.currentStep,
      messageCount: messages.length,
    });

    try {
      const response = await this.llmClient.generateResponse(messages, {
        temperature: 0.1, // Low temperature for more consistent responses
        maxTokens: 2000,
      });

      // Parse JSON response
      const thoughtData = JSON.parse(response.content);
      const thought = validateAgentThought(thoughtData);

      this.logger.debug('LLM response received', {
        step: this.currentStep,
        action: thought.nextAction.action,
        progress: thought.progressPercent,
      });

      return thought;
    } catch (error) {
      this.logger.error('Failed to get LLM response', error as Error);

      // Fallback: try to take a screenshot and finish
      return {
        observation: 'Failed to analyze page due to LLM error',
        analysis: 'Cannot proceed due to communication error',
        plan: 'Take screenshot and finish task',
        nextAction: {
          action: 'screenshot',
          reasoning: 'Taking screenshot before finishing due to error',
        },
        progressPercent: 0,
        isComplete: false,
      };
    }
  }

  /**
   * Execute a specific action on the page
   */
  private async executeAction(
    page: Page,
    action: Action
  ): Promise<ActionResult> {
    this.logger.debug('Executing action', {
      step: this.currentStep,
      action: action.action,
      selector: action.selector,
      reasoning: action.reasoning,
    });

    try {
      switch (action.action) {
        case 'click':
          return await this.executeClick(page, action);

        case 'type':
          return await this.executeType(page, action);

        case 'goto':
          return await this.executeGoto(page, action);

        case 'scroll':
          return await this.executeScroll(page, action);

        case 'wait':
          return await this.executeWait(page, action);

        case 'key':
          return await this.executeKey(page, action);

        case 'hover':
          return await this.executeHover(page, action);

        case 'screenshot':
          return await this.executeScreenshot(page);

        case 'finish':
          return {
            success: true,
            message: 'Task marked as complete',
          };

        default:
          return {
            success: false,
            message: `Unknown action: ${action.action}`,
            error: 'UNKNOWN_ACTION',
          };
      }
    } catch (error) {
      return {
        success: false,
        message: `Action failed: ${(error as Error).message}`,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Execute click action
   */
  private async executeClick(
    page: Page,
    action: Action
  ): Promise<ActionResult> {
    if (!action.selector) {
      return {
        success: false,
        message: 'Click action requires a selector',
        error: 'MISSING_SELECTOR',
      };
    }

    try {
      await page.click(action.selector, { timeout: this.config.actionTimeout });

      // Wait for potential navigation or page changes
      await page.waitForTimeout(1000);

      return {
        success: true,
        message: `Successfully clicked element: ${action.selector}`,
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to click element: ${action.selector}`,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Execute type action
   */
  private async executeType(page: Page, action: Action): Promise<ActionResult> {
    if (!action.selector || !action.text) {
      return {
        success: false,
        message: 'Type action requires both selector and text',
        error: 'MISSING_PARAMETERS',
      };
    }

    try {
      // Clear existing text first
      await page.fill(action.selector, '');
      await page.type(action.selector, action.text, {
        delay: 50, // Simulate human typing
        timeout: this.config.actionTimeout,
      });

      return {
        success: true,
        message: `Successfully typed text into element: ${action.selector}`,
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to type into element: ${action.selector}`,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Execute goto action
   */
  private async executeGoto(page: Page, action: Action): Promise<ActionResult> {
    if (!action.url) {
      return {
        success: false,
        message: 'Goto action requires a URL',
        error: 'MISSING_URL',
      };
    }

    try {
      await page.goto(action.url, {
        waitUntil: 'domcontentloaded',
        timeout: this.config.actionTimeout,
      });

      return {
        success: true,
        message: `Successfully navigated to: ${action.url}`,
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to navigate to: ${action.url}`,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Execute scroll action
   */
  private async executeScroll(
    page: Page,
    action: Action
  ): Promise<ActionResult> {
    try {
      const scrollConfig = action.scroll || { direction: 'down', amount: 3 };
      const scrollPixels = scrollConfig.amount * 300; // 300px per unit

      const scrollDirection = {
        x:
          scrollConfig.direction === 'left'
            ? -scrollPixels
            : scrollConfig.direction === 'right'
              ? scrollPixels
              : 0,
        y:
          scrollConfig.direction === 'up'
            ? -scrollPixels
            : scrollConfig.direction === 'down'
              ? scrollPixels
              : 0,
      };

      await page.mouse.wheel(scrollDirection.x, scrollDirection.y);
      await page.waitForTimeout(500); // Wait for scroll to complete

      return {
        success: true,
        message: `Successfully scrolled ${scrollConfig.direction} by ${scrollConfig.amount} units`,
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to scroll',
        error: (error as Error).message,
      };
    }
  }

  /**
   * Execute wait action
   */
  private async executeWait(page: Page, action: Action): Promise<ActionResult> {
    try {
      const waitConfig = action.wait || {
        type: 'time',
        value: 2000,
        timeout: 5000,
      };

      switch (waitConfig.type) {
        case 'time':
          await page.waitForTimeout(waitConfig.value as number);
          break;

        case 'element':
          await page.waitForSelector(waitConfig.value as string, {
            timeout: waitConfig.timeout,
          });
          break;

        case 'navigation':
          await page.waitForURL(waitConfig.value as string, {
            timeout: waitConfig.timeout,
          });
          break;
      }

      return {
        success: true,
        message: `Successfully waited for ${waitConfig.type}: ${waitConfig.value}`,
      };
    } catch (error) {
      return {
        success: false,
        message: 'Wait action failed',
        error: (error as Error).message,
      };
    }
  }

  /**
   * Execute key action
   */
  private async executeKey(page: Page, action: Action): Promise<ActionResult> {
    if (!action.key) {
      return {
        success: false,
        message: 'Key action requires a key parameter',
        error: 'MISSING_KEY',
      };
    }

    try {
      await page.keyboard.press(action.key);
      await page.waitForTimeout(500); // Wait for any resulting changes

      return {
        success: true,
        message: `Successfully pressed key: ${action.key}`,
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to press key: ${action.key}`,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Execute hover action
   */
  private async executeHover(
    page: Page,
    action: Action
  ): Promise<ActionResult> {
    if (!action.selector) {
      return {
        success: false,
        message: 'Hover action requires a selector',
        error: 'MISSING_SELECTOR',
      };
    }

    try {
      await page.hover(action.selector, { timeout: this.config.actionTimeout });
      await page.waitForTimeout(500); // Wait for hover effects

      return {
        success: true,
        message: `Successfully hovered over element: ${action.selector}`,
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to hover over element: ${action.selector}`,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Execute screenshot action
   */
  private async executeScreenshot(page: Page): Promise<ActionResult> {
    try {
      const screenshot = await page.screenshot({
        fullPage: true,
        type: 'png',
      });

      return {
        success: true,
        message: 'Screenshot taken successfully',
        metadata: {
          screenshotSize: screenshot.length,
          timestamp: Date.now(),
        },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to take screenshot',
        error: (error as Error).message,
      };
    }
  }

  /**
   * Attempt recovery when the agent gets stuck
   */
  private async attemptRecovery(
    page: Page,
    objective: string,
    consecutiveFailures: number
  ): Promise<void> {
    this.logger.info('Attempting recovery', { consecutiveFailures });

    // Take a screenshot first to see current state
    await this.executeScreenshot(page);

    // Get fresh page view
    const pageView = await this.domService.getPageView(page);

    // Ask LLM for recovery strategy
    const messages: LLMMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: generateStuckRecoveryPrompt(
          consecutiveFailures,
          this.history.slice(-3).map((h) => h.action)
        ),
      },
      {
        role: 'user',
        content: generatePageContextPrompt(objective, pageView, this.history),
      },
    ];

    try {
      const response = await this.llmClient.generateResponse(messages);
      const thoughtData = JSON.parse(response.content);
      const thought = validateAgentThought(thoughtData);

      // Execute recovery action
      const result = await this.executeAction(page, thought.nextAction);
      this.addToHistory(thought.nextAction, result, pageView);
    } catch (error) {
      this.logger.error('Recovery attempt failed', error as Error);
    }
  }

  /**
   * Add an action and result to the history
   */
  private addToHistory(
    action: Action,
    result: ActionResult,
    pageView?: PageView
  ): void {
    const historyEntry: AgentHistory = {
      step: this.currentStep,
      action,
      result,
      pageState: pageView
        ? {
            url: pageView.url,
            title: pageView.title,
            timestamp: pageView.timestamp,
          }
        : undefined,
      timestamp: Date.now(),
    };

    this.history.push(historyEntry);
  }

  /**
   * Sleep for specified milliseconds
   */
  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get the current execution history
   */
  getHistory(): AgentHistory[] {
    return [...this.history];
  }

  /**
   * Check if the agent is currently running
   */
  getIsRunning(): boolean {
    return this.isRunning;
  }

  /**
   * Stop the agent execution
   */
  stop(): void {
    this.isRunning = false;
    this.logger.info('Agent stopped by user');
  }

  /**
   * Update agent configuration
   */
  updateConfig(config: Partial<AgentConfig>): void {
    this.config = { ...this.config, ...config };
    this.logger.debug('Agent configuration updated', { config: this.config });
  }
}
