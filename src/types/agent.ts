/**
 * Agent-related type definitions
 */

// Forward declaration - Action will be imported from agent module
export interface AgentHistory {
  /** Step number in the execution */
  step: number;
  /** Action that was taken */
  action: any; // Will be properly typed as Action when imported
  /** Result of the action */
  result: ActionResult;
  /** Page state at the time of action */
  pageState?: {
    url: string;
    title: string;
    timestamp: number;
  };
  /** Timestamp when the action was executed */
  timestamp: number;
}

export interface ActionResult {
  /** Whether the action was successful */
  success: boolean;
  /** Result message */
  message: string;
  /** Error details if action failed */
  error?: string;
  /** Additional metadata */
  metadata?: Record<string, any>;
}

export interface AgentConfig {
  /** Maximum number of steps to execute */
  maxSteps?: number;
  /** Timeout for individual actions in milliseconds */
  actionTimeout?: number;
  /** Whether to continue on action failures */
  continueOnFailure?: boolean;
  /** Custom instructions to add to system prompt */
  customInstructions?: string;
}
