/**
 * Action model definitions using Zod for LLM output validation
 */

import { z } from 'zod';

/**
 * Available actions that the agent can perform
 */
export const ActionSchema = z.object({
  /** Type of action to perform */
  action: z.enum([
    'click', // Click on an element
    'type', // Type text into an input field
    'scroll', // Scroll the page
    'goto', // Navigate to a URL
    'wait', // Wait for a specified time or condition
    'screenshot', // Take a screenshot
    'finish', // Complete the task
    'key', // Press a keyboard key
    'hover', // Hover over an element
  ]),

  /** CSS selector for the target element (required for click, type, hover) */
  selector: z
    .string()
    .optional()
    .describe('CSS selector for the target element'),

  /** Text to type (required for type action) */
  text: z.string().optional().describe('Text to type into the element'),

  /** URL to navigate to (required for goto action) */
  url: z.string().url().optional().describe('URL to navigate to'),

  /** Scroll direction and amount */
  scroll: z
    .object({
      direction: z.enum(['up', 'down', 'left', 'right']).default('down'),
      amount: z
        .number()
        .min(1)
        .max(10)
        .default(3)
        .describe('Scroll amount (1-10)'),
    })
    .optional(),

  /** Wait configuration */
  wait: z
    .object({
      type: z.enum(['time', 'element', 'navigation']).default('time'),
      value: z
        .union([z.number(), z.string()])
        .describe('Time in ms, selector, or URL pattern'),
      timeout: z.number().min(1000).max(30000).default(5000),
    })
    .optional(),

  /** Keyboard key to press */
  key: z
    .string()
    .optional()
    .describe('Keyboard key to press (e.g., "Enter", "Escape", "Tab")'),

  /** Reasoning behind this action (required) */
  reasoning: z
    .string()
    .min(10)
    .describe('Detailed explanation of why this action is needed'),

  /** Expected outcome of this action */
  expectedOutcome: z
    .string()
    .optional()
    .describe('What should happen after this action'),
});

export type Action = z.infer<typeof ActionSchema>;

/**
 * Agent's thinking and planning schema
 */
export const AgentThoughtSchema = z.object({
  /** Optional chain-of-thought or structured thinking block */
  thinking: z.string().optional(),

  /** One-sentence evaluation of previous goal */
  evaluation_previous_goal: z
    .string()
    .optional()
    .describe('Evaluation of the previous step goal'),

  /** Short memory for progress tracking */
  memory: z
    .string()
    .describe(
      '1-3 sentences of memory of this step and overall progress to guide future steps'
    ),

  /** Next immediate goal */
  next_goal: z
    .string()
    .optional()
    .describe('Next immediate goal to achieve in one sentence'),

  /** Actions to execute in sequence for this step */
  action: z.array(ActionSchema).min(1),
});

export type AgentThought = z.infer<typeof AgentThoughtSchema>;

/**
 * Validation function for agent responses
 */
export function validateAction(data: unknown): Action {
  try {
    return ActionSchema.parse(data);
  } catch (error) {
    throw new Error(`Invalid action format: ${error}`);
  }
}

/**
 * Validation function for agent thoughts
 */
export function validateAgentThought(data: unknown): AgentThought {
  try {
    return AgentThoughtSchema.parse(data);
  } catch (error) {
    throw new Error(`Invalid agent thought format: ${error}`);
  }
}

/**
 * Helper function to create a finish action
 */
export function createFinishAction(reasoning: string): Action {
  return {
    action: 'finish',
    reasoning,
    expectedOutcome: 'Task completed successfully',
  };
}

/**
 * Helper function to create a click action
 */
export function createClickAction(
  selector: string,
  reasoning: string,
  expectedOutcome?: string
): Action {
  return {
    action: 'click',
    selector,
    reasoning,
    expectedOutcome,
  };
}

/**
 * Helper function to create a type action
 */
export function createTypeAction(
  selector: string,
  text: string,
  reasoning: string,
  expectedOutcome?: string
): Action {
  return {
    action: 'type',
    selector,
    text,
    reasoning,
    expectedOutcome,
  };
}

/**
 * Helper function to create a goto action
 */
export function createGotoAction(
  url: string,
  reasoning: string,
  expectedOutcome?: string
): Action {
  return {
    action: 'goto',
    url,
    reasoning,
    expectedOutcome,
  };
}
