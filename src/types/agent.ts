/**
 * Agent-related type definitions
 */

// Forward declaration - Action will be imported from agent module
export interface AgentHistory {
  /** Step number in the execution */
  step: number;
  /** Action that was taken */
  action: {
    action: string;
    selector?: string;
    text?: string;
    url?: string;
    scroll?: { direction: 'up' | 'down' | 'left' | 'right'; amount?: number };
    wait?: { type: 'time' | 'element' | 'navigation'; value: number | string; timeout?: number };
    key?: string;
    reasoning?: string;
    expectedOutcome?: string;
  };
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
