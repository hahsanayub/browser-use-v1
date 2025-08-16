/**
 * Agent module exports
 */

export { Agent } from './Agent';
export {
  ActionSchema,
  createAgentThoughtSchema,
  validateAction,
  validateAgentThought,
  createFinishAction,
  createClickAction,
  createTypeAction,
  createGotoAction,
  type Action,
  type AgentThought,
} from './views';
export {
  SystemPrompt,
  generatePageContextPrompt,
  generateErrorRecoveryPrompt,
  generateCompletionVerificationPrompt,
  generateStuckRecoveryPrompt,
} from './PromptManager';
export type { AgentHistory, ActionResult, AgentConfig } from '../types/agent';
