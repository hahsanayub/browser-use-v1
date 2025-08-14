/**
 * Agent-related type definitions
 */

import { AgentHook } from '../agent/Agent';
import type { Action } from '../agent/views';
import { LLMMessage } from './llm';

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
  /** Files to display to the user */
  attachments?: string[];
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
  /** Maximum length of clickable elements string before truncation */
  maxClickableElementsLength?: number;
  /** Hooks for step start and end */
  onStepStart?: AgentHook;
  /** Hook for step end */
  onStepEnd?: AgentHook;
}

export interface AgentState {
  /** Current step number */
  n_steps: number;
  /** Number of consecutive failures */
  consecutive_failures: number;
  /** Whether the agent is paused */
  paused: boolean;
  /** Whether the agent is stopped */
  stopped: boolean;
  /** Last messages from the model */
  last_messages: LLMMessage[] | null;
  /** Last model output */
  last_model_output: any | null;
  /** Last action result */
  last_result: ActionResult[] | null;
  /** Step start time for timing */
  step_start_time?: number;
}
