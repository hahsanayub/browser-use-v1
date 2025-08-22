/**
 * Agent history management
 */

export interface Action {
  action: string;
  selector?: string;
  url?: string;
  text?: string;
  [key: string]: any;
}

export interface ActionResult {
  success: boolean;
  message: string;
  error?: string;
  // Enhanced fields for read_state functionality
  extractedContent?: string;
  includeExtractedContentOnlyOnce?: boolean;
  longTermMemory?: string;
}

/**
 * Agent step information
 */
export interface AgentStepInfo {
  stepNumber: number;
  maxSteps: number;

  /**
   * Check if this is the last step
   */
  isLastStep(): boolean;
}

/**
 * Implementation of AgentStepInfo
 */
export class AgentStepInfoImpl implements AgentStepInfo {
  constructor(
    public stepNumber: number,
    public maxSteps: number
  ) {}

  isLastStep(): boolean {
    return this.stepNumber >= this.maxSteps - 1;
  }
}

/**
 * Represents a single agent history item with its data and string representation
 */
export interface HistoryItem {
  stepNumber?: number;
  evaluationPreviousGoal?: string;
  memory?: string;
  nextGoal?: string;
  actionResults?: string;
  error?: string;
  systemMessage?: string;
}

/**
 * Current state information extracted from agent output
 */
export interface CurrentState {
  evaluationPreviousGoal?: string;
  memory?: string;
  nextGoal?: string;
}

/**
 * Agent output structure that includes current state
 */
export interface AgentOutput {
  currentState?: CurrentState;
  action?: Action[];
  thinking?: string;
}

/**
 * Message Manager State
 */
export interface MessageManagerState {
  toolId: number;
  agentHistoryItems: HistoryItem[];
  readStateDescription: string;
}

/**
 * Agent History Manager class
 * Manages agent history items and provides string formatting
 */
export class AgentHistoryManager {
  private state: MessageManagerState;

  constructor(initialState?: Partial<MessageManagerState>) {
    this.state = {
      toolId: 1,
      agentHistoryItems: [
        {
          stepNumber: 0,
          systemMessage: 'Agent initialized',
        },
      ],
      readStateDescription: '',
      ...initialState,
    };
  }

  /**
   * Get current message manager state
   */
  getState(): MessageManagerState {
    return { ...this.state };
  }

  /**
   * Update read state description
   */
  setReadStateDescription(description: string): void {
    this.state.readStateDescription = description;
  }

  /**
   * Get read state description
   */
  getReadStateDescription(): string {
    return this.state.readStateDescription;
  }

  /**
   * Get current tool ID and increment it
   */
  getNextToolId(): number {
    return this.state.toolId++;
  }

  /**
   * Convert a history item to string representation
   */
  static historyItemToString(item: HistoryItem): string {
    const stepStr =
      item.stepNumber !== undefined
        ? `step_${item.stepNumber}`
        : 'step_unknown';

    // Handle error format
    if (item.error) {
      return `<${stepStr}>
${item.error}
</${stepStr}>`;
    }

    // Handle system message format
    if (item.systemMessage) {
      return `<sys>
${item.systemMessage}
</sys>`;
    }

    // Handle normal format with evaluation, memory, goal, and results
    const contentParts: string[] = [];

    // Only include evaluation_previous_goal if it's not null/empty
    if (item.evaluationPreviousGoal) {
      contentParts.push(
        `Evaluation of Previous Step: ${item.evaluationPreviousGoal}`
      );
    }

    // Always include memory if present
    if (item.memory) {
      contentParts.push(`Memory: ${item.memory}`);
    }

    // Only include next_goal if it's not null/empty
    if (item.nextGoal) {
      contentParts.push(`Next Goal: ${item.nextGoal}`);
    }

    if (item.actionResults) {
      contentParts.push(item.actionResults);
    }

    const content = contentParts.join('\n');

    return `<${stepStr}>
${content}
</${stepStr}>`;
  }

  /**
   * Update agent history with new step results
   */
  updateAgentHistory(
    stepNumber: number,
    modelOutput?: AgentOutput,
    results?: ActionResult[],
    stepInfo?: AgentStepInfo,
    actions?: Action[]
  ): void {
    // Reset read state description
    this.state.readStateDescription = '';

    // Build action results string and process read state
    let actionResults: string | undefined;
    if (results && results.length > 0) {
      const resultStrings: string[] = [];
      let readStateIdx = 0;

      for (let idx = 0; idx < results.length; idx++) {
        const result = results[idx];
        const action = actions && actions[idx];

        // Handle extracted content for read_state
        if (result.includeExtractedContentOnlyOnce && result.extractedContent) {
          this.state.readStateDescription += `<read_state_${readStateIdx}>\n${result.extractedContent}\n</read_state_${readStateIdx}>\n`;
          readStateIdx++;
        }

        // Handle long term memory
        if (result.longTermMemory) {
          resultStrings.push(
            `Action ${idx + 1}/${results.length}: ${result.longTermMemory}`
          );
        }
        // Handle extracted content (not include once)
        else if (
          result.extractedContent &&
          !result.includeExtractedContentOnlyOnce
        ) {
          resultStrings.push(
            `Action ${idx + 1}/${results.length}: ${result.extractedContent}`
          );
        }
        // Handle regular action with message
        else if (action && result.message) {
          // Build action description
          let actionDesc = '';
          if (action.action === 'goto' && action.url) {
            actionDesc = `Navigated to ${action.url}`;
          } else if (action.action === 'click' && action.selector) {
            actionDesc = `Clicked element ${action.selector}`;
          } else if (
            action.action === 'type' &&
            action.selector &&
            action.text
          ) {
            actionDesc = `Typed "${action.text}" into ${action.selector}`;
          } else if (action.action === 'write_file' && result.message) {
            actionDesc = result.message;
          } else if (action.action === 'click_element_by_index') {
            actionDesc = result.message;
          } else {
            actionDesc = `${action.action}: ${result.message}`;
          }
          resultStrings.push(
            `Action ${idx + 1}/${results.length}: ${actionDesc}`
          );
        }
        // Fallback for result message only
        else if (result.message) {
          resultStrings.push(
            `Action ${idx + 1}/${results.length}: ${result.message}`
          );
        }

        // Handle errors
        if (result.error) {
          let errorText = result.error;
          if (errorText.length > 200) {
            errorText =
              errorText.substring(0, 100) +
              '......' +
              errorText.substring(errorText.length - 100);
          }
          resultStrings.push(
            `Action ${idx + 1}/${results.length}: ${errorText}`
          );
        }
      }

      // Clean up read state description
      this.state.readStateDescription = this.state.readStateDescription.trim();

      if (resultStrings.length > 0) {
        actionResults = `Action Results:\n${resultStrings.join('\n')}`;
        actionResults = actionResults.trim();
      }
    }

    // Build the history item
    if (!modelOutput) {
      // Only add error history item if we have a valid step number
      if (stepNumber > 0) {
        const historyItem: HistoryItem = {
          stepNumber,
          error: 'Agent failed to output in the right format.',
        };
        this.state.agentHistoryItems.push(historyItem);
      }
    } else {
      const historyItem: HistoryItem = {
        stepNumber,
        evaluationPreviousGoal:
          modelOutput.currentState?.evaluationPreviousGoal,
        memory: modelOutput.currentState?.memory,
        nextGoal: modelOutput.currentState?.nextGoal,
        actionResults,
      };
      this.state.agentHistoryItems.push(historyItem);
    }
  }

  /**
   * Get the complete agent history description as a string
   */
  getAgentHistoryDescription(): string {
    return this.state.agentHistoryItems
      .map((item) => AgentHistoryManager.historyItemToString(item))
      .join('\n');
  }

  /**
   * Get all history items
   */
  getHistoryItems(): HistoryItem[] {
    return [...this.state.agentHistoryItems];
  }

  /**
   * Clear history items but keep the initial system message
   */
  clearHistory(): void {
    this.state.agentHistoryItems = [
      {
        stepNumber: 0,
        systemMessage: 'Agent initialized',
      },
    ];
    this.state.readStateDescription = '';
  }

  /**
   * Add a system message to history
   */
  addSystemMessage(message: string): void {
    this.state.agentHistoryItems.push({
      systemMessage: message,
    });
  }

  /**
   * Format error message based on error type
   */
  static formatError(
    error: Error | string,
    includeTrace: boolean = false
  ): string {
    if (error instanceof Error) {
      // Handle specific error types
      if (error.name === 'ZodError' || error.message.includes('validation')) {
        return `Invalid model output format. Please follow the correct schema.\nDetails: ${error.message}`;
      }

      if (
        error.message.includes('rate limit') ||
        error.message.includes('Rate limit')
      ) {
        return 'Rate limit reached. Waiting before retry.';
      }

      if (error.message.includes('JSON') || error.message.includes('parse')) {
        return `JSON parsing error: ${error.message}\nPlease ensure your response is properly formatted JSON.`;
      }

      // Include stack trace if requested and available
      if (includeTrace && error.stack) {
        return `${error.message}\nStacktrace:\n${error.stack}`;
      }

      return error.message;
    }

    return String(error);
  }

  /**
   * Add an error to history with proper formatting
   */
  addError(stepNumber: number, error: string | Error): void {
    let errorMessage =
      typeof error === 'string'
        ? error
        : AgentHistoryManager.formatError(error);

    // Truncate long error messages
    if (errorMessage.length > 1000) {
      errorMessage =
        errorMessage.substring(0, 400) +
        '\n......[truncated]......\n' +
        errorMessage.substring(errorMessage.length - 400);
    }

    this.state.agentHistoryItems.push({
      stepNumber,
      error: errorMessage,
    });
  }

  /**
   * Add new task to history
   */
  addNewTask(newTask: string): void {
    const taskUpdateItem: HistoryItem = {
      systemMessage: `Task updated to: ${newTask}`,
    };
    this.state.agentHistoryItems.push(taskUpdateItem);
  }

  /**
   * Validate that error and system_message are not both provided
   */
  static validateHistoryItem(item: HistoryItem): void {
    if (item.error && item.systemMessage) {
      throw new Error(
        'Cannot have both error and system_message at the same time'
      );
    }
  }
}

/**
 * Enhanced history structure for backward compatibility
 * This maintains the existing simple structure while adding new fields
 */
export interface EnhancedHistoryItem {
  step: number;
  action: Action;
  result: ActionResult;
  evaluationPreviousGoal?: string;
  memory?: string;
  nextGoal?: string;
  error?: string;
  systemMessage?: string;
}

/**
 * Convert legacy history format to new enhanced format
 */
export function convertLegacyHistory(
  legacyHistory: Array<{
    step: number;
    action: Action;
    result: ActionResult;
  }>
): EnhancedHistoryItem[] {
  return legacyHistory.map((item) => ({
    step: item.step,
    action: item.action,
    result: item.result,
  }));
}

/**
 * Convert enhanced history to HistoryItem format
 */
export function enhancedHistoryToHistoryItems(
  enhancedHistory: EnhancedHistoryItem[]
): HistoryItem[] {
  return enhancedHistory.map((item) => {
    const actionResults = `Action: ${item.action.action}${item.action.selector ? ` (${item.action.selector})` : ''}${item.action.url ? ` [${item.action.url}]` : ''}\nResult: ${item.result.success ? 'Success' : 'Failure'}: ${item.result.message}${item.result.error ? ` — ${item.result.error}` : ''}`;

    return {
      stepNumber: item.step,
      evaluationPreviousGoal: item.evaluationPreviousGoal,
      memory: item.memory,
      nextGoal: item.nextGoal,
      actionResults,
      error: item.error,
      systemMessage: item.systemMessage,
    };
  });
}
