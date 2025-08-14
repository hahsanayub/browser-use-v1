/**
 * Agent-related type definitions
 */

import type { Action } from '../agent/views';

export type ErrorAction = { action: 'error'; reasoning?: string };
export type HistoryAction = Action | ErrorAction;

export interface AgentHistory {
  /** Step number in the execution */
  step: number;
  /** Action that was taken */
  action: HistoryAction;
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
  /** Whether to use the flash prompt variant */
  flashMode?: boolean;
  /** Whether to enable detailed thinking in prompt/output */
  useThinking?: boolean;
  /** Max actions per step for prompt placeholder replacement */
  maxActionsPerStep?: number;
}

