/**
 * Agent-related type definitions
 */

import { AgentHook } from '../agent/Agent';
import type { Action, AgentThought } from '../agent/views';
import { LLMMessage } from './llm';
import type { PageView } from './dom';

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
  /** Whether to enable vision/multimodal capabilities */
  useVision?: boolean;
  /** Vision detail level for image analysis */
  visionDetailLevel?: 'auto' | 'low' | 'high';
  /** Hooks for step start and end */
  onStepStart?: AgentHook;
  /** Hook for step end */
  onStepEnd?: AgentHook;

  /** Hook invoked right before sending messages to the LLM */
  onModelRequest?: (
    messages: LLMMessage[],
    step: number
  ) => Promise<void> | void;
  /** Hook invoked right after receiving and parsing the LLM response */
  onModelResponse?: (
    pageView: PageView,
    thought: AgentThought,
    step: number
  ) => Promise<void> | void;
  /** Hook invoked after the agent finishes (on done or loop end) */
  onDone?: (history: AgentHistory[]) => Promise<void> | void;

  /** Directory path to automatically save per-step conversation logs */
  saveConversationPath?: string;
  /** File encoding for saved conversation logs (default: 'utf-8') */
  saveConversationPathEncoding?: BufferEncoding | string;
  /** Directory path for agent file system (default: current working directory) */
  fileSystemPath?: string;
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
  last_model_output: AgentThought | null;
  /** Last action result */
  last_result: ActionResult[] | null;
  /** Step start time for timing */
  step_start_time?: number;
}
