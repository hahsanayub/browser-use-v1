/**
 * Main Agent class that orchestrates web automation using LLM intelligence
 */

import { Page } from 'playwright';
import { BrowserSession } from '../browser/BrowserSession';
import { DOMService } from '../services/dom-service';
import { BaseLLMClient } from '../llm/base-client';
import type { LLMMessage } from '../types/llm';
import type { PageView } from '../types/dom';
import type { AgentHistory, ActionResult, AgentConfig } from '../types/agent';
/* eslint-disable prettier/prettier */
import { type Action, type AgentThought, createAgentThoughtSchema } from './views';
import {
  SystemPrompt,
  generatePageContextPrompt,
  generateStuckRecoveryPrompt,
} from './prompts';
import { getLogger } from '../services/logging';
import { JsonParser } from '../services/json-parser';
import { registry } from '../controller/singleton';

/**
 * Agent class for intelligent web automation
 */
export class Agent {
  private browserSession: BrowserSession;
  private llmClient: BaseLLMClient;
  private domService: DOMService;
  private config: AgentConfig;
  private history: AgentHistory[] = [];
  private logger = getLogger();
  private currentStep = 0;
  private isRunning = false;

  constructor(
    browserSession: BrowserSession,
    llmClient: BaseLLMClient,
    config: AgentConfig = {},
    private actDelegate?: (
      actionName: string,
      params: Record<string, unknown>
    ) => Promise<ActionResult>
  ) {
    this.browserSession = browserSession;
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
      const page = this.browserSession.getContext().pages().slice(-1)[0];
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
          // Get current page view & signature
          // Step-level snapshot: refresh at start of step
          const pageView = await this.browserSession.getStateSummary(true);
          const beforeSig = await this.browserSession.getDomSignature();

          // Generate response from LLM
          const thought = await this.think(objective, pageView);
          this.logger.debug('[LLM response received] ===>>', {
            step: this.currentStep,
            response: JSON.stringify(thought, null, 2),
          });

          // Execute the action sequence proposed by the model
          const actionsToRun = [...(thought as any).action];
          if (!actionsToRun || actionsToRun.length === 0) {
            throw new Error('Model returned no actions to execute');
          }
          let result = { success: true, message: 'no-op' } as ActionResult;
          for (const act of actionsToRun) {
            const beforeSigForAct = await this.browserSession.getDomSignature();
            result = await this.executeAction(page, act);
            this.addToHistory(act, result, pageView);
            const afterSigForAct = await this.browserSession.getDomSignature();
            if (act.action === 'finish') {
              this.logger.info('Task completed', { step: this.currentStep });
              break;
            }
            if (
              afterSigForAct &&
              beforeSigForAct &&
              afterSigForAct !== beforeSigForAct
            ) {
              this.logger.debug(
                'DOM changed during multi-act; breaking to re-observe'
              );
              break;
            }
            if (!result.success) break;
          }

          // Already added during multi-act loop

          // Detect DOM change to decide whether to continue planning or re-observe
          const afterSig = await this.browserSession.getDomSignature();
          if (afterSig && beforeSig && afterSig !== beforeSig) {
            this.logger.debug('DOM changed after action, re-observing');
          }

          // Handle failures
          if (!result.success) {
            consecutiveFailures++;
            this.logger.warn(
              `Action failed (${consecutiveFailures}/${maxConsecutiveFailures})`,
              {
                step: this.currentStep,
                action: 'sequence',
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
    // Derive dynamic available actions for this page (name + description)
    const activePage = this.browserSession.getContext().pages().slice(-1)[0];
    const availableList = registry.list().filter((a) => {
      try {
        return activePage
          ? typeof a.isAvailableForPage === 'function'
            ? !!a.isAvailableForPage(activePage)
            : true
          : true;
      } catch {
        return true;
      }
    });
    const available = availableList.map((a) => ({
      name: a.name,
      description: a.description,
    }));
    const availableActions = available.map((a) => a.name);

    const systemContent = await SystemPrompt.load({
      flashMode: this.config.flashMode,
      useThinking: this.config.useThinking,
      placeholders: { max_actions: String(this.config.maxActionsPerStep ?? 3) },
    });

    const messages: LLMMessage[] = [
      {
        role: 'system',
        content:
          systemContent +
          (this.config.customInstructions
            ? `\n\n## Additional Instructions:\n${this.config.customInstructions}`
            : ''),
      },
      {
        role: 'user',
        content:
          generatePageContextPrompt(objective, pageView, this.history) +
          `\n\n## Available Actions (this step)\n` +
          available.map((a) => `- ${a.name}: ${a.description}`).join('\n'),
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

      // Parse JSON response safely
      const thoughtData = JsonParser.parse(response.content);
      this.logger.debug('[LLM response parsed] ===>>', {
        step: this.currentStep,
        response: JSON.stringify(thoughtData, null, 2),
      });
      // Normalize action array if returned as keyed objects
      if (Array.isArray((thoughtData as any).action)) {
        (thoughtData as any).action = (thoughtData as any).action.map(
          (item: any) => {
            if (item && typeof item === 'object' && !('action' in item)) {
              const entries = Object.entries(item);
              if (entries.length === 1) {
                const [name, params] = entries[0];
                const normalized: any = {
                  action: name,
                  reasoning:
                    'Auto-executed based on plan to progress toward goal.',
                };
                if (params && typeof params === 'object') {
                  Object.assign(normalized, params);
                }
                // Alias normalization for known variants
                if (normalized.action === 'send_keys') {
                  if (normalized.keys === undefined && typeof normalized.key === 'string') {
                    normalized.keys = normalized.key;
                    delete normalized.key;
                  }
                } else if (normalized.action === 'wait') {
                  // Support { time: 5 } as seconds by default; convert to ms for value
                  if (normalized.value === undefined && normalized.time !== undefined) {
                    const t = normalized.time;
                    if (typeof t === 'number') {
                      normalized.value = t < 1000 ? t * 1000 : t;
                    } else if (typeof t === 'string') {
                      const num = Number(t);
                      normalized.value = Number.isFinite(num)
                        ? num < 1000
                          ? num * 1000
                          : num
                        : t;
                    }
                    if (normalized.type === undefined) normalized.type = 'time';
                    delete normalized.time;
                  }
                  // If mistakenly provided selector for wait, coerce to element wait
                  if (
                    normalized.value === undefined && typeof normalized.selector === 'string'
                  ) {
                    normalized.type = normalized.type ?? 'element';
                    normalized.value = normalized.selector;
                  }
                }
                return normalized;
              }
            }
            return item;
          }
        );
      }
      // Build dynamic schema for this page and validate
      const dynamicActionSchema =
        registry.buildDynamicActionSchemaForPage(activePage);
      const AgentThoughtSchemaForStep =
        createAgentThoughtSchema(dynamicActionSchema);
      let thought = AgentThoughtSchemaForStep.parse(
        thoughtData
      ) as AgentThought;

      // Enforce dynamic action availability for each proposed action
      const filteredActions = thought.action.filter((a) =>
        availableActions.includes(a.action)
      );
      if (filteredActions.length === 0) {
        this.logger.warn(
          'No supported actions proposed; coercing to screenshot'
        );
        filteredActions.push({
          action: 'screenshot',
          reasoning: 'Fallback to screenshot due to unsupported actions',
        } as any);
      }
      thought = { ...thought, action: filteredActions } as AgentThought;

      this.logger.debug('LLM response received', {
        step: this.currentStep,
        actionCount: thought.action.length,
      });

      return thought;
    } catch (error) {
      this.logger.error('Failed to get LLM response', error as Error);

      // Fallback minimal output: take a screenshot
      return {
        memory: 'Failed to analyze page due to LLM error',
        action: [
          {
            action: 'screenshot',
            reasoning: 'Taking screenshot before finishing due to error',
          } as any,
        ],
      } as any;
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

    // Prefer Controller registry if provided
    if (this.actDelegate) {
      try {
        // Pass through all provided params except meta fields, so we support dynamic action shapes
        const cloned = { ...(action as unknown as Record<string, unknown>) };
        delete (cloned as any).action;
        delete (cloned as any).reasoning;
        delete (cloned as any).expectedOutcome;
        return await this.actDelegate(action.action, cloned);
      } catch (error) {
        return {
          success: false,
          message: `Action failed: ${(error as Error).message}`,
          error: (error as Error).message,
        };
      }
    }

    // Fallback to local implementations
    try {
      const result = await this.dispatchActionViaPage(page, action);
      return result;
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
    return this.actDelegate
      ? this.actDelegate('click', { selector: action.selector! })
      : { success: false, message: 'No dispatcher', error: 'NO_DISPATCH' };
  }

  /**
   * Execute type action
   */
  private async executeType(page: Page, action: Action): Promise<ActionResult> {
    return this.actDelegate
      ? this.actDelegate('type', {
          selector: action.selector!,
          text: action.text!,
        })
      : { success: false, message: 'No dispatcher', error: 'NO_DISPATCH' };
  }

  /**
   * Execute goto action
   */
  private async executeGoto(page: Page, action: Action): Promise<ActionResult> {
    return this.actDelegate
      ? this.actDelegate('goto', { url: action.url! })
      : { success: false, message: 'No dispatcher', error: 'NO_DISPATCH' };
  }

  /**
   * Execute scroll action
   */
  private async executeScroll(
    page: Page,
    action: Action
  ): Promise<ActionResult> {
    const direction = action.scroll?.direction ?? 'down';
    const amount = action.scroll?.amount ?? 3;
    return this.actDelegate
      ? this.actDelegate('scroll', { direction, amount })
      : { success: false, message: 'No dispatcher', error: 'NO_DISPATCH' };
  }

  /**
   * Execute wait action
   */
  private async executeWait(page: Page, action: Action): Promise<ActionResult> {
    const type = action.wait?.type ?? 'time';
    const value = action.wait?.value ?? 1000;
    const timeout = action.wait?.timeout;
    const params: Record<string, unknown> = { type, value };
    if (timeout !== undefined) params.timeout = timeout;
    return this.actDelegate
      ? this.actDelegate('wait', params)
      : { success: false, message: 'No dispatcher', error: 'NO_DISPATCH' };
  }

  /**
   * Execute key action
   */
  private async executeKey(page: Page, action: Action): Promise<ActionResult> {
    return this.actDelegate
      ? this.actDelegate('key', { key: action.key! })
      : { success: false, message: 'No dispatcher', error: 'NO_DISPATCH' };
  }

  /**
   * Execute hover action
   */
  private async executeHover(
    page: Page,
    action: Action
  ): Promise<ActionResult> {
    return this.actDelegate
      ? this.actDelegate('hover', { selector: action.selector! })
      : { success: false, message: 'No dispatcher', error: 'NO_DISPATCH' };
  }

  /**
   * Execute screenshot action
   */
  private async executeScreenshot(): Promise<ActionResult> {
    return this.actDelegate
      ? this.actDelegate('screenshot', {})
      : { success: false, message: 'No dispatcher', error: 'NO_DISPATCH' };
  }

  // temporary adapter: in this iteration, keep local implementations to avoid breaking behavior,
  // but expose a single dispatch point to facilitate Controller-based act() refactor next steps.
  private async dispatchActionViaPage(
    page: Page,
    action: Action
  ): Promise<ActionResult> {
    switch (action.action) {
      case 'click':
        return this.executeClick(page, action);
      case 'type':
        return this.executeType(page, action);
      case 'goto':
        return this.executeGoto(page, action);
      case 'scroll':
        return this.executeScroll(page, action);
      case 'wait':
        return this.executeWait(page, action);
      case 'key':
        return this.executeKey(page, action);
      case 'hover':
        return this.executeHover(page, action);
      case 'screenshot':
        return this.executeScreenshot();
      case 'click_element_by_index':
        if (typeof (action as any).index === 'number') {
          try {
            await this.browserSession.clickByIndex((action as any).index);
            return { success: true, message: `Clicked by index ${(action as any).index}` };
          } catch (e) {
            return { success: false, message: (e as Error).message, error: (e as Error).message };
          }
        }
        return { success: false, message: 'Missing index', error: 'MISSING_INDEX' };
      case 'finish':
        return { success: true, message: 'Task marked as complete' };
      default:
        return {
          success: false,
          message: `Unknown action: ${action.action}`,
          error: 'UNKNOWN_ACTION',
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
    await this.executeScreenshot();

    // Get fresh page view
    const pageView = await this.browserSession.getStateSummary(true);

    // Ask LLM for recovery strategy
    const systemContent = await SystemPrompt.load({
      flashMode: this.config.flashMode,
      useThinking: this.config.useThinking,
      placeholders: { max_actions: String(this.config.maxActionsPerStep ?? 3) },
    });
    const messages: LLMMessage[] = [
      { role: 'system', content: systemContent },
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
      const thoughtData = JsonParser.parse(response.content);
      // Normalize potential keyed action objects
      if (Array.isArray((thoughtData as any).action)) {
        (thoughtData as any).action = (thoughtData as any).action.map(
          (item: any) => {
            if (item && typeof item === 'object' && !('action' in item)) {
              const entries = Object.entries(item);
              if (entries.length === 1) {
                const [name, params] = entries[0];
                const normalized: any = {
                  action: name,
                  reasoning: 'Auto-executed during recovery.',
                };
                if (params && typeof params === 'object') {
                  Object.assign(normalized, params);
                }
                // Alias normalization for known variants in recovery too
                if (normalized.action === 'send_keys') {
                  if (
                    normalized.keys === undefined &&
                    typeof (normalized as any).key === 'string'
                  ) {
                    normalized.keys = (normalized as any).key;
                    delete (normalized as any).key;
                  }
                } else if (normalized.action === 'wait') {
                  if (
                    normalized.value === undefined &&
                    (normalized as any).time !== undefined
                  ) {
                    const t = (normalized as any).time;
                    if (typeof t === 'number') {
                      normalized.value = t < 1000 ? t * 1000 : t;
                    } else if (typeof t === 'string') {
                      const num = Number(t);
                      normalized.value = Number.isFinite(num)
                        ? num < 1000
                          ? num * 1000
                          : num
                        : t;
                    }
                    if (normalized.type === undefined) normalized.type = 'time';
                    delete (normalized as any).time;
                  }
                  if (
                    normalized.value === undefined &&
                    typeof normalized.selector === 'string'
                  ) {
                    normalized.type = normalized.type ?? 'element';
                    normalized.value = normalized.selector;
                  }
                }
                return normalized;
              }
            }
            return item;
          }
        );
      }
      const dynamicActionSchema =
        registry.buildDynamicActionSchemaForPage(page);
      const AgentThoughtSchemaForStep =
        createAgentThoughtSchema(dynamicActionSchema);
      const thought = AgentThoughtSchemaForStep.parse(
        thoughtData
      ) as AgentThought;

      // Execute first recovery action only
      const first = (thought as any).action?.[0];
      if (first) {
        const result = await this.executeAction(page, first);
        this.addToHistory(first, result, pageView);
      } else {
        this.logger.warn('Recovery LLM response returned no action');
      }
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
