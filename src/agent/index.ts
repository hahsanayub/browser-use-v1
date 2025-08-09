/**
 * Agent module exports
 */

export { Agent } from './Agent';
export {
  ActionSchema,
  AgentThoughtSchema,
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
} from './prompts';
export type { AgentHistory, ActionResult, AgentConfig } from '../types/agent';
