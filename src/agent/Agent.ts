/**
 * Main Agent class that orchestrates web automation using LLM intelligence
 */

import { Page } from 'playwright';
import fs from 'fs';
import path from 'path';
import { BrowserSession } from '../browser/BrowserSession';
import { DOMService } from '../services/dom-service';
import { ViewportDOMService } from '../services/dom-tree-serializer';
import { BaseLLMClient } from '../llm/base-client';
import { ScreenshotService } from '../services/screenshot-service';
import { FileSystem } from '../services/file-system';
import type { LLMMessage } from '../types/llm';
import type { PageView } from '../types/dom';
import type {
  AgentHistory,
  ActionResult,
  AgentConfig,
  AgentState,
} from '../types/agent';
import {
  AgentHistoryManager,
  AgentStepInfo,
  AgentStepInfoImpl,
  AgentOutput,
} from './AgentHistory';
import {
  type Action,
  type AgentThought,
  createAgentThoughtSchema,
} from './views';
import {
  SystemPrompt,
  generatePageContextPrompt,
  generateStuckRecoveryPrompt,
} from './PromptManager';
import { getLogger } from '../services/logging';
import { JsonParser } from '../services/json-parser';
import { registry } from '../controller/singleton';

export type AgentHook = (agent: Agent) => Promise<void>;

/**
 * Agent class for intelligent web automation
 */
export class Agent {
  private browserSession: BrowserSession;
  llmClient: BaseLLMClient;
  private domService: DOMService;
  private viewportDOMService: ViewportDOMService; // Persistent ViewportDOMService for state management
  private fileSystem: FileSystem | null = null;
  private screenshotService: ScreenshotService | null = null;
  private config: AgentConfig;
  private history: AgentHistory[] = [];
  private agentHistoryManager: AgentHistoryManager; // New enhanced history manager
  private logger = getLogger();
  private state: AgentState;
  private isRunning = false;
  private screenshots: string[] = []; // Store recent screenshots for multimodal

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
    this.viewportDOMService = new ViewportDOMService(); // Initialize persistent ViewportDOMService
    this.config = {
      maxSteps: 100,
      actionTimeout: 30000,
      continueOnFailure: true,
      maxClickableElementsLength: 40000,
      flashMode: false,
      useThinking: true,
      maxActionsPerStep: 10,
      useVision: false, // Disable vision by default
      visionDetailLevel: 'auto',
      ...config,
    };

    this.logger.info('Agent config', { config: this.config });

    // Initialize file system
    this.initializeFileSystem();

    // Initialize screenshot service
    this.initializeScreenshotService();

    // Initialize agent state
    this.state = {
      n_steps: 0,
      consecutive_failures: 0,
      paused: false,
      stopped: false,
      last_model_output: null,
      last_result: null,
      last_messages: null,
    };

    // Initialize enhanced history manager
    this.agentHistoryManager = new AgentHistoryManager();
  }

  /**
   * Initialize the file system for the agent
   */
  private initializeFileSystem(): void {
    try {
      const fileSystemPath = this.config.fileSystemPath || process.cwd();
      this.fileSystem = new FileSystem(fileSystemPath);
      this.logger.info(`FileSystem initialized at: ${fileSystemPath}`);
    } catch (error) {
      this.logger.error('Failed to initialize FileSystem', error as Error);
      // FileSystem is optional, so we don't throw here
      this.fileSystem = null;
    }
  }

  /**
   * Initialize the screenshot service for vision capabilities
   */
  private initializeScreenshotService(): void {
    try {
      if (this.config.useVision) {
        const agentDirectory = this.config.fileSystemPath || process.cwd();
        this.screenshotService = new ScreenshotService(agentDirectory);
        // Initialize async in background
        this.screenshotService.initialize().catch((error) => {
          this.logger.error(
            'Failed to initialize ScreenshotService directories',
            error
          );
        });
        this.logger.info(`ScreenshotService initialized for vision support`);
      } else {
        this.logger.debug('Vision disabled, ScreenshotService not initialized');
      }
    } catch (error) {
      this.logger.error(
        'Failed to initialize ScreenshotService',
        error as Error
      );
      // ScreenshotService is optional, so we don't throw here
      this.screenshotService = null;
    }
  }

  /**
   * Get file system instance
   */
  getFileSystem(): FileSystem | null {
    return this.fileSystem;
  }

  /**
   * Capture screenshot for the current step if vision is enabled
   */
  private async captureStepScreenshot(): Promise<void> {
    if (!this.config.useVision || !this.screenshotService) {
      return;
    }

    try {
      const screenshot = await this.browserSession.takeScreenshotForVision(
        this.config.useFullVision
      );

      if (screenshot) {
        // Add to screenshots array for multimodal messages
        this.screenshots.push(screenshot);

        // Keep only the last 2 screenshots to manage memory
        if (this.screenshots.length > 2) {
          this.screenshots = this.screenshots.slice(-2);
        }

        this.logger.debug('Screenshot captured for vision', {
          step: this.state.n_steps,
          screenshotCount: this.screenshots.length,
        });
      }
    } catch (error) {
      this.logger.warn('Failed to capture step screenshot', {
        step: this.state.n_steps,
        error: (error as Error).message,
      });
      // Don't throw - screenshot failure shouldn't stop the agent
    }
  }

  /**
   * Store screenshot to disk during finalization
   */
  private async storeStepScreenshot(screenshot: string | null): Promise<void> {
    if (!this.config.useVision || !this.screenshotService || !screenshot) {
      return;
    }

    try {
      await this.screenshotService.storeScreenshot(
        screenshot,
        this.state.n_steps
      );
      this.logger.debug('Screenshot stored to disk', {
        step: this.state.n_steps,
      });
    } catch (error) {
      this.logger.warn('Failed to store screenshot to disk', {
        step: this.state.n_steps,
        error: (error as Error).message,
      });
    }
  }

  /**
   * Build user message with multimodal content (text + screenshots)
   */
  private async buildUserMessage(
    objective: string,
    pageView: PageView
  ): Promise<LLMMessage> {
    // Create step info for current step (using 0-based indexing internally)
    const stepInfo: AgentStepInfo = new AgentStepInfoImpl(
      this.state.n_steps,
      this.config.maxSteps || 100
    );

    // Generate page-specific actions for current URL
    let pageSpecificActions: string | undefined;
    try {
      const activePage = this.browserSession.getContext()?.pages().slice(-1)[0];
      if (activePage) {
        const currentUrl = activePage.url();
        const pageActions = registry.getPromptDescription(currentUrl);
        if (pageActions && pageActions.trim()) {
          pageSpecificActions = pageActions;
        }
      }
    } catch (error) {
      this.logger.warn(
        'Failed to generate page-specific actions',
        error as Error
      );
    }

    const textContent = await generatePageContextPrompt(
      objective,
      pageView,
      this.agentHistoryManager.getHistoryItems(), // Use enhanced history items
      this.config.maxClickableElementsLength,
      this.fileSystem,
      true, // useViewportAware
      undefined, // simplifiedDOMOptions
      this.agentHistoryManager, // Pass the enhanced history manager
      undefined, // readStateDescription (will be retrieved from manager)
      {
        stepNumber: stepInfo.stepNumber,
        maxSteps: stepInfo.maxSteps,
        isLastStep: stepInfo.isLastStep(),
      },
      pageSpecificActions, // Pass page-specific actions
      registry, // Pass the action registry for default actions
      this.viewportDOMService // Pass the persistent ViewportDOMService instance
    );

    // If vision is disabled or no screenshots available, return text-only message
    if (!this.config.useVision || this.screenshots.length === 0) {
      return {
        role: 'user',
        content: textContent,
      };
    }

    // Build multimodal message with text and screenshots
    const contentParts: any[] = [
      {
        type: 'text',
        text: textContent,
      },
    ];

    // Add screenshots with labels
    for (let i = 0; i < this.screenshots.length; i++) {
      const screenshot = this.screenshots[i];
      const label =
        i === this.screenshots.length - 1
          ? 'Current screenshot:'
          : 'Previous screenshot:';

      // Add label as text content
      contentParts.push({
        type: 'text',
        text: label,
      });

      // Add the screenshot
      contentParts.push({
        type: 'image',
        imageUrl: {
          url: `data:image/png;base64,${screenshot}`,
          mediaType: 'image/png' as const,
          detail: this.config.visionDetailLevel || 'auto',
        },
      });
    }

    return {
      role: 'user',
      content: contentParts,
    };
  }

  /**
   * Save the conversation (input messages and model output) for the current step
   */
  private async saveConversation(
    messages: LLMMessage[],
    thought: AgentThought,
    step: number
  ): Promise<void> {
    try {
      const dir = this.config.saveConversationPath;
      if (!dir) return;
      const encoding = (this.config.saveConversationPathEncoding ||
        'utf-8') as BufferEncoding;
      await fs.promises.mkdir(dir, { recursive: true });
      const filePath = path.join(dir, `conversation_${step}.txt`);
      const parts: string[] = [];
      for (const m of messages) {
        parts.push(
          `##${m.role}\n${typeof m.content === 'string' ? m.content : m.content?.[0]?.type === 'text' ? m.content[0].text : JSON.stringify(m.content, null, 2)}`
        );
      }
      parts.push('\n\n\n\n##LLM Response');
      parts.push(JSON.stringify(thought, null, 2));
      await fs.promises.writeFile(filePath, parts.join('\n\n'), { encoding });
    } catch (error) {
      this.logger.warn('Failed to save conversation log', error as Error);
    }
  }

  /**
   * Execute the agent to accomplish the given objective
   */
  async run(
    objective: string,
    {
      onStepStart,
      onStepEnd,
    }: { onStepStart?: AgentHook; onStepEnd?: AgentHook } = {}
  ): Promise<AgentHistory[]> {
    if (this.isRunning) {
      throw new Error('Agent is already running');
    }

    this.isRunning = true;
    this.state.n_steps = 0;
    this.state.consecutive_failures = 0;
    this.state.paused = false;
    this.state.stopped = false;
    this.state.last_model_output = null;
    this.state.last_result = null;
    this.history = [];

    let taskCompleted = false; // Track when done action is executed

    this.logger.info('Agent started', { objective, config: this.config });

    try {
      const page = this.browserSession.getContext()?.pages().slice(-1)[0];
      if (!page) {
        throw new Error(
          'No active page found. Create a page in the browser context first.'
        );
      }

      const maxConsecutiveFailures = 3;

      while (this.state.n_steps < this.config.maxSteps! && !taskCompleted) {
        // Check if agent should be stopped or paused
        if (
          this.state.stopped ||
          !this.browserSession.getBrowser()?.isConnected()
        ) {
          this.logger.info('Agent stopped');
          break;
        }

        // Handle pause state
        while (this.state.paused) {
          this.logger.debug('Agent paused, waiting...');
          await this.sleep(200); // Small delay to prevent CPU spinning
          if (this.state.stopped) break;
        }

        this.state.n_steps++;
        this.state.step_start_time = Date.now();

        this.logger.debug(`Starting step ${this.state.n_steps}`, { objective });

        try {
          // Get current page view & signature
          // Step-level snapshot: refresh at start of step
          const pageView = await this.browserSession.getStateSummary(true);
          const beforeSig = await this.browserSession.getDomSignature();

          // Take screenshot for vision if enabled
          await this.captureStepScreenshot();

          // Before step hook
          await onStepStart?.(this);

          // Generate response from LLM
          const thought = await this.think(objective, pageView);
          this.state.last_model_output = thought;

          // After step hook
          await onStepEnd?.(this);

          // Execute the action sequence proposed by the model
          const actionsToRun = [...(thought as any).action];
          if (!actionsToRun || actionsToRun.length === 0) {
            throw new Error('Model returned no actions to execute');
          }
          let result = { success: true, message: 'no-op' } as ActionResult;
          const results: ActionResult[] = [];
          let lastKnownSig = beforeSig;

          for (let i = 0; i < actionsToRun.length; i++) {
            const act = actionsToRun[i];
            const isLastAction = i === actionsToRun.length - 1;

            // Skip redundant DOM checks for rapid action sequences
            // Only check DOM before first action and after potentially DOM-changing actions
            const shouldCheckBefore = i === 0 || this.isDOMChangingAction(act);
            const currentSigBefore = shouldCheckBefore
              ? await this.browserSession.getDomSignature()
              : lastKnownSig;

            result = await this.executeAction(page, act);
            results.push(result);
            await this.addToHistory(act, result, pageView);

            if (act.action === 'done') {
              this.logger.info('Task completed', { step: this.state.n_steps });
              taskCompleted = true;
              break;
            }

            // Smart DOM change detection - only check after potentially changing actions
            if (this.isDOMChangingAction(act) || isLastAction) {
              const afterSigForAct =
                await this.browserSession.getDomSignature();

              if (
                afterSigForAct &&
                currentSigBefore &&
                afterSigForAct !== currentSigBefore
              ) {
                this.logger.debug(
                  'DOM changed during action; breaking to re-observe',
                  {
                    action: act.action,
                    step: i + 1,
                    total: actionsToRun.length,
                  }
                );
                lastKnownSig = afterSigForAct;
                break;
              }
              lastKnownSig = afterSigForAct;
            }

            if (!result.success) break;
          }

          // Save results to state
          this.state.last_result = results;

          // Update enhanced history manager with step results
          const stepInfo: AgentStepInfo = new AgentStepInfoImpl(
            this.state.n_steps,
            this.config.maxSteps || 100
          );

          // Convert AgentThought to AgentOutput format
          const agentOutput: AgentOutput = {
            currentState: {
              evaluationPreviousGoal: (thought as any).evaluation_previous_goal,
              memory: (thought as any).memory,
              nextGoal: (thought as any).next_goal,
            },
            action: (thought as any).action,
            thinking: (thought as any).thinking,
          };

          this.agentHistoryManager.updateAgentHistory(
            this.state.n_steps,
            agentOutput,
            results,
            stepInfo,
            actionsToRun // Pass the actions array for better formatting
          );

          // Final DOM change detection - only if we haven't checked recently
          const finalSig =
            lastKnownSig || (await this.browserSession.getDomSignature());
          if (finalSig && beforeSig && finalSig !== beforeSig) {
            this.logger.debug(
              'DOM changed after action sequence, re-observing'
            );
          }

          // Handle failures
          if (!result.success) {
            this.state.consecutive_failures++;
            this.logger.warn(
              `Action failed (${this.state.consecutive_failures}/${maxConsecutiveFailures})`,
              {
                step: this.state.n_steps,
                action: 'sequence',
                error: result.error,
              }
            );

            if (this.state.consecutive_failures >= maxConsecutiveFailures) {
              if (this.config.continueOnFailure) {
                // Try recovery
                await this.attemptRecovery(
                  page,
                  objective,
                  this.state.consecutive_failures
                );
                this.state.consecutive_failures = 0;
              } else {
                throw new Error(
                  `Too many consecutive failures: ${result.error}`
                );
              }
            }
          } else {
            this.state.consecutive_failures = 0; // Reset on success
          }

          // Wait a bit between actions to be respectful
          await this.sleep(1000);
        } catch (error) {
          const errorMessage = (error as Error).message;
          if (
            errorMessage.includes(
              'Target page, context or browser has been closed'
            )
          ) {
            this.logger.warn(
              'Browser has been closed, terminating agent loop.',
              error as Error
            );
            break;
          }
          this.logger.error(
            `Error in step ${this.state.n_steps}`,
            error as Error
          );

          if (!this.config.continueOnFailure) {
            throw error;
          }

          // Add detailed error to AgentHistoryManager for LLM feedback
          let stepErrorMessage = 'Step Execution Error:\n';
          stepErrorMessage += `${AgentHistoryManager.formatError(error as Error, true)}\n`;
          stepErrorMessage += `This error occurred during step ${this.state.n_steps} execution.\n`;

          this.agentHistoryManager.addError(
            this.state.n_steps,
            stepErrorMessage
          );

          // Also add error to legacy history for backward compatibility
          const errorResult: ActionResult = {
            success: false,
            message: 'Step failed due to error',
            error: (error as Error).message,
          };

          await this.addToHistory(
            {
              action: 'error' as any,
              reasoning: 'Error occurred during execution',
            },
            errorResult
          );
        }
      }

      if (this.state.n_steps >= this.config.maxSteps!) {
        this.logger.warn('Agent reached maximum steps', {
          maxSteps: this.config.maxSteps,
        });
      }

      this.logger.info('Agent finished', {
        steps: this.state.n_steps,
        historyLength: this.history.length,
      });
      // onDone callback after the run completes
      if (this.config.onDone) {
        try {
          await this.config.onDone(this.history);
        } catch (err) {
          this.logger.warn('onDone hook failed', err as Error);
        }
      }

      return this.history;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Convert LLM response action format to Zod expected format
   * LLM returns: [{"action_name": {"param": "value"}}]
   * Zod expects: [{"action": "action_name", "param": "value"}]
   */
  private normalizeActionFormat(actionArray: any[]): any[] {
    return actionArray.map((actionObj) => {
      // Handle the case where action is a nested object like {"input_text": {"index": 21, "text": "TDD"}}
      const actionKeys = Object.keys(actionObj);
      if (actionKeys.length === 1) {
        const actionName = actionKeys[0];
        const actionParams = actionObj[actionName];

        // If actionParams is an object, flatten it
        if (typeof actionParams === 'object' && actionParams !== null) {
          const normalizedParams = { ...actionParams };

          // Handle LLM parameter name variations for file operations
          // Convert 'filename' to 'file_name' for Python compatibility
          // if (['write_file', 'read_file', 'replace_file_str'].includes(actionName)) {
          //   if (normalizedParams.filename && !normalizedParams.file_name) {
          //     normalizedParams.file_name = normalizedParams.filename;
          //     delete normalizedParams.filename;
          //   }
          // }

          return {
            action: actionName,
            ...normalizedParams,
          };
        }

        // If actionParams is a primitive value, use it directly
        return {
          action: actionName,
          value: actionParams,
        };
      }

      // If it's already in the expected format, return as is
      return actionObj;
    });
  }

  /**
   * Think about the current state and decide on next actions
   */
  private async think(
    objective: string,
    pageView: PageView
  ): Promise<AgentThought> {
    // Derive dynamic available actions for this page (name + description)
    const activePage = this.browserSession.getContext()?.pages().slice(-1)[0];
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
      await this.buildUserMessage(objective, pageView),
    ];

    this.state.last_messages = messages;

    // Hook: before sending to LLM
    if (this.config.onModelRequest) {
      try {
        await this.config.onModelRequest(messages, this.state.n_steps);
      } catch (err) {
        this.logger.warn('onModelRequest hook failed', err as Error);
      }
    }

    this.logger.debug('Sending request to LLM', {
      step: this.state.n_steps,
      messageCount: messages.length,
    });

    let responseContent: string = 'none';

    let thoughtData: AgentThought | null = null;

    try {
      // Build dynamic schema for this page and validate
      const dynamicActionSchema =
        registry.buildDynamicActionSchemaForPage(activePage);
      const AgentThoughtSchemaForStep =
        createAgentThoughtSchema(dynamicActionSchema);

      const response = await this.llmClient.generateResponse(messages, {
        responseFormat: {
          type: 'zod_schema',
          schema: AgentThoughtSchemaForStep, // Use structured output like Python's output_format
        },
        temperature: 0.1, // Low temperature for more consistent responses
        maxTokens: 16384,
      });

      responseContent = response.content;

      // Parse the already-validated response (like Python's response.completion)
      thoughtData = JSON.parse(response.content);

      // Normalize action format from LLM response to Zod expected format
      if (
        thoughtData &&
        thoughtData.action &&
        Array.isArray(thoughtData.action)
      ) {
        thoughtData.action = this.normalizeActionFormat(thoughtData.action);
      }

      // The response is already validated by the LLM client, but we still parse it for type safety
      let thought = thoughtData as AgentThought;

      // Cut the number of actions to max_actions_per_step if needed
      if (thought.action.length > this.config.maxActionsPerStep!) {
        thought.action = thought.action.slice(0, this.config.maxActionsPerStep);
      }

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

      // Log next action summary
      this.logNextActionSummary(thought);

      // Hook: after receiving model response (with normalized thought)
      if (this.config.onModelResponse) {
        try {
          await this.config.onModelResponse(
            pageView,
            thought,
            this.state.n_steps
          );
        } catch (err) {
          this.logger.warn('onModelResponse hook failed', err as Error);
        }
      }

      // Optional: save conversation for this step
      if (this.config.saveConversationPath) {
        await this.saveConversation(messages, thought, this.state.n_steps);
      }

      this.logger.debug('LLM response received', {
        step: this.state.n_steps,
        actionCount: thought.action.length,
      });

      return thought;
    } catch (error) {
      this.logger.debug(`Error Response Content:`, {
        thoughtData,
        responseContent,
      });
      this.logger.error('Failed to get LLM response', error as Error);

      // Create detailed error message for LLM feedback
      let detailedErrorMessage = 'LLM Response Error:\n';

      // Use the new formatError method from AgentHistoryManager for base error formatting
      if (error instanceof Error) {
        detailedErrorMessage += `${AgentHistoryManager.formatError(error, true)}\n`;
      } else {
        detailedErrorMessage += `Unknown error: ${String(error)}\n`;
      }

      // Add context about what was attempted
      if (responseContent && responseContent !== 'none') {
        const truncatedContent =
          responseContent.length > 500
            ? responseContent.substring(0, 500) + '...[truncated]'
            : responseContent;
        detailedErrorMessage += `\nRaw LLM Response:\n${truncatedContent}\n`;
      }

      if (thoughtData) {
        detailedErrorMessage += `\nParsed thought data (partial): ${JSON.stringify(thoughtData, null, 2)}\n`;
      }

      // Add this detailed error to agent history for LLM feedback in next step
      this.agentHistoryManager.addError(
        this.state.n_steps,
        detailedErrorMessage
      );

      // Fallback minimal output: take a screenshot
      return {
        memory:
          'Failed to analyze page due to LLM error - see agent history for details',
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
    this.logger.debug('🌟 Executing action', {
      step: this.state.n_steps,
      ...action,
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
    // Normalize parameters to Controller's scroll schema: { down, num_pages, index? }
    // Support both top-level fields (down/num_pages/index) and nested scroll.{direction,amount,index}
    const a: any = action;
    const topDown: boolean | undefined = a.down;
    const topNumPages: number | undefined = a.num_pages;
    const topIndex: number | undefined = a.index;

    // Fallback to nested scroll object if top-level not provided
    const direction: 'up' | 'down' = a.scroll?.direction ?? 'down';
    const amount: number | string = a.scroll?.amount ?? 1; // align with Action schema default
    const nestedIndex: number | undefined = a.scroll?.index;

    const down: boolean =
      typeof topDown === 'boolean' ? topDown : direction !== 'up';
    let num_pages: number;
    if (typeof topNumPages === 'number' && Number.isFinite(topNumPages)) {
      num_pages = topNumPages;
    } else if (typeof amount === 'number' && Number.isFinite(amount)) {
      // Treat "amount" as number of pages
      num_pages = amount;
    } else if (typeof amount === 'string') {
      const parsed = Number(amount);
      num_pages = Number.isFinite(parsed) ? parsed : 1;
    } else {
      num_pages = 1;
    }

    const index: number | undefined =
      typeof topIndex === 'number'
        ? topIndex
        : typeof nestedIndex === 'number'
          ? nestedIndex
          : undefined;

    const payload: Record<string, unknown> = { down, num_pages };
    if (typeof index === 'number') payload.index = index;

    return this.actDelegate
      ? this.actDelegate('scroll', payload)
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
            return {
              success: true,
              message: `Clicked by index ${(action as any).index}`,
            };
          } catch (e) {
            return {
              success: false,
              message: (e as Error).message,
              error: (e as Error).message,
            };
          }
        }
        return {
          success: false,
          message: 'Missing index',
          error: 'MISSING_INDEX',
        };
      case 'done':
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
        content: await generatePageContextPrompt(
          objective,
          pageView,
          this.agentHistoryManager.getHistoryItems(), // Use enhanced history items
          this.config.maxClickableElementsLength,
          this.fileSystem,
          true, // useViewportAware
          undefined, // simplifiedDOMOptions
          this.agentHistoryManager, // Pass the enhanced history manager
          undefined, // readStateDescription
          undefined, // stepInfo
          undefined, // pageSpecificActions
          undefined, // actionRegistry
          this.viewportDOMService // Pass the persistent ViewportDOMService instance
        ),
      },
    ];

    try {
      const response = await this.llmClient.generateResponse(messages);
      const thoughtData = JsonParser.parse(response.content);
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
  private async addToHistory(
    action: Action,
    result: ActionResult,
    pageView?: PageView
  ): Promise<void> {
    // Store screenshot to disk during finalization
    if (this.screenshots.length > 0) {
      const latestScreenshot = this.screenshots[this.screenshots.length - 1];
      await this.storeStepScreenshot(latestScreenshot);
    }

    const historyEntry: AgentHistory = {
      step: this.state.n_steps,
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
   * Determine if an action is likely to change the DOM
   */
  private isDOMChangingAction(action: Action): boolean {
    const domChangingActions = new Set([
      'click',
      'click_element_by_index',
      'type',
      'key',
      'submit',
      'goto',
      'goBack',
      'goForward',
      'reload',
      'select',
    ]);

    // Actions that typically don't change DOM
    const safActions = new Set([
      'screenshot',
      'wait',
      'hover',
      'scroll',
      'done',
      'read_file',
      'write_file',
    ]);

    if (safActions.has(action.action)) {
      return false;
    }

    return (
      domChangingActions.has(action.action) || !safActions.has(action.action)
    );
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
   * Update agent configuration
   */
  updateConfig(config: Partial<AgentConfig>): void {
    this.config = { ...this.config, ...config };
    this.logger.debug('Agent configuration updated', { config: this.config });
  }

  /**
   * Pause the agent execution
   */
  pause(): void {
    this.state.paused = true;
    this.logger.info('Agent paused');
  }

  /**
   * Resume the agent execution
   */
  resume(): void {
    this.state.paused = false;
    this.logger.info('Agent resumed');
  }

  /**
   * Stop the agent execution
   */
  stop(): void {
    this.state.stopped = true;
    this.isRunning = false;
    this.logger.info('Agent stopped');
  }

  /**
   * Get the current agent state
   */
  getState(): AgentState {
    return { ...this.state };
  }

  /**
   * Check if the agent is paused
   */
  isPaused(): boolean {
    return this.state.paused;
  }

  /**
   * Check if the agent is stopped
   */
  isStopped(): boolean {
    return this.state.stopped;
  }

  /**
   * Get current step number
   */
  getCurrentStep(): number {
    return this.state.n_steps;
  }

  /**
   * Get consecutive failures count
   */
  getConsecutiveFailures(): number {
    return this.state.consecutive_failures;
  }

  /**
   * Log a comprehensive summary of the next action(s)
   */
  private logNextActionSummary(thought: AgentThought): void {
    if (!thought.action || thought.action.length === 0) {
      return;
    }

    const actionCount = thought.action.length;

    // Collect action details
    const actionDetails: string[] = [];
    for (let i = 0; i < thought.action.length; i++) {
      const action = thought.action[i];
      const actionName = action.action;

      // Format key parameters concisely
      const paramSummary: string[] = [];

      if (action.selector) {
        paramSummary.push(`selector="${action.selector}"`);
      }
      if (action.text) {
        const textPreview =
          action.text.length > 30
            ? action.text.substring(0, 30) + '...'
            : action.text;
        paramSummary.push(`text="${textPreview}"`);
      }
      if (action.url) {
        paramSummary.push(`url="${action.url}"`);
      }
      if (action.key) {
        paramSummary.push(`key="${action.key}"`);
      }
      if (action.scroll) {
        paramSummary.push(
          `scroll=${action.scroll.direction}:${action.scroll.amount}`
        );
      }
      if (action.wait) {
        paramSummary.push(`wait=${action.wait.type}:${action.wait.value}`);
      }

      const paramStr =
        paramSummary.length > 0 ? `(${paramSummary.join(', ')})` : '';
      actionDetails.push(`${actionName}${paramStr}`);
    }

    // Create summary based on single vs multi-action
    if (actionCount === 1) {
      this.logger.info(`☝️ Decided next action: ${actionDetails[0]}`);
    } else {
      const summaryLines = [`✌️ Decided next ${actionCount} multi-actions:`];
      for (let i = 0; i < actionDetails.length; i++) {
        summaryLines.push(`          ${i + 1}. ${actionDetails[i]}`);
      }
      this.logger.info(summaryLines.join('\n'));
    }
  }
}
