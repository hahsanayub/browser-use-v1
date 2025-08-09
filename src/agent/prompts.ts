/**
 * System prompts and prompt templates for the AI agent
 */
import { readFile } from 'node:fs/promises';

/**
 * Dynamically load system prompts from markdown files based on configuration.
 */
export class SystemPrompt {
  /**
   * Load the appropriate system prompt file.
   * - flashMode: use `system-prompt-flash.md`
   * - useThinking: if explicitly false, use `system-prompt-no-thinking.md`
   * - default: `system-prompt.md`
   */
  static async load(options: {
    flashMode?: boolean;
    useThinking?: boolean;
    placeholders?: Record<string, string | number>;
  } = {}): Promise<string> {
    const { flashMode, useThinking, placeholders } = options;
    let filename = 'system-prompt.md';
    if (flashMode) filename = 'system-prompt-flash.md';
    else if (useThinking === false) filename = 'system-prompt-no-thinking.md';

    const candidates: URL[] = [
      new URL(`./prompt/${filename}`, import.meta.url),
      // Fallback to source tree when running from dist
      new URL(`../../src/agent/prompt/${filename}`, import.meta.url),
    ];

    let content: string | null = null;
    for (const candidate of candidates) {
      try {
        content = await readFile(candidate, 'utf-8');
        break;
      } catch {}
    }
    if (content == null) {
      throw new Error(`Failed to load system prompt file: ${filename}`);
    }

    if (placeholders) {
      for (const [key, value] of Object.entries(placeholders)) {
        const pattern = new RegExp(`\\{${key}\\}`, 'g');
        content = content.replace(pattern, String(value));
      }
    }

    return content;
  }
}

/**
 * Main system prompt that defines the agent's behavior and capabilities
 */
export const SYSTEM_PROMPT = `You are an intelligent web automation agent that can control a browser to accomplish user objectives. You can see what's on the webpage and interact with it using various actions.

## Your Capabilities:
- **click**: Click on buttons, links, or other clickable elements
- **type**: Type text into input fields, textareas, or editable elements
- **scroll**: Scroll the page in any direction
- **goto**: Navigate to a specific URL
- **wait**: Wait for elements to appear or for a specific amount of time
- **key**: Press keyboard keys (Enter, Tab, Escape, etc.)
- **hover**: Hover over elements to reveal hidden content
- **screenshot**: Take a screenshot of the current page
- **finish**: Mark the task as completed

## Instructions:
1. **Analyze the current page**: Carefully observe the page content, interactive elements, and current state
2. **Plan your approach**: Think step-by-step about how to achieve the objective
3. **Take precise actions**: Use the most appropriate action for each step
4. **Be patient**: Wait for pages to load and elements to become available
5. **Handle errors gracefully**: If an action fails, try alternative approaches
6. **Provide clear reasoning**: Explain why you're taking each action

## Response Format:
Always respond with a JSON object containing:
- **observation**: What you currently see on the page
- **analysis**: Your analysis of the current situation
- **plan**: Your step-by-step plan to achieve the objective
- **nextAction**: The specific action to take next (with all required parameters)
- **progressPercent**: Your estimated progress (0-100)
- **isComplete**: Whether the objective has been achieved

## Action Guidelines:
- **Selectors**: Use clear, specific CSS selectors that uniquely identify elements
- **Timing**: Use wait actions when pages are loading or changing
- **Navigation**: Always wait for page loads after goto actions
- **Forms**: Fill out forms completely before submitting
- **Verification**: Check if actions had the expected effect

## Safety Rules:
- Only interact with elements that are visible and clickable
- Don't perform destructive actions unless specifically requested
- Respect website rate limits and don't spam actions
- If you encounter errors, explain what went wrong and try alternatives

Remember: You are helping the user accomplish their objective efficiently and accurately. Take your time to understand the page and plan your actions carefully.`;

/**
 * Generate a prompt for the current page context
 */
export function generatePageContextPrompt(
  objective: string,
  pageView: {
    url: string;
    title: string;
    html: string;
    interactiveElements: Array<{
      id: string;
      tagName: string;
      type: string;
      text?: string;
      selector: string;
    }>;
  },
  history: Array<{
    step: number;
    action: { action: string; selector?: string; url?: string; text?: string };
    result: { success: boolean; message: string; error?: string };
  }> = []
): string {
  const interactiveElementsList = pageView.interactiveElements
    .slice(0, 20) // Limit to prevent token overflow
    .map((el) => `- ${el.selector}: ${el.tagName} (${el.type})`)
    .join('\n');

  const historyText =
    history.length > 0
      ? `\n## Previous Actions:\n${history
          .slice(-5) // Show last 5 actions
          .map(
            (h) =>
              `Step ${h.step}: ${h.action.action} - ${h.result.success ? 'Success' : 'Failed'}: ${h.result.message}`
          )
          .join('\n')}\n`
      : '';

  return `## Current Objective:
${objective}

## Current Page:
- URL: ${pageView.url}
- Title: ${pageView.title}

## Interactive Elements Available:
${interactiveElementsList}

${historyText}

## Current Page Content:
${pageView.html.substring(0, 8000)}${pageView.html.length > 8000 ? '...[truncated]' : ''}

Analyze the current situation and determine the next action to take to achieve the objective.`;
}

/**
 * Generate a prompt for error recovery
 */
export function generateErrorRecoveryPrompt(
  error: string,
  lastAction: any,
  retryCount: number
): string {
  return `## Error Occurred:
The last action "${lastAction.action}" failed with error: ${error}

This is retry attempt #${retryCount}.

Please analyze what went wrong and try a different approach. Consider:
- Was the selector correct and specific enough?
- Did the element exist and was it visible?
- Was the timing appropriate (did the page finish loading)?
- Is there an alternative way to accomplish the same goal?

Provide a different action or approach to recover from this error.`;
}

/**
 * Generate a prompt for task completion verification
 */
export function generateCompletionVerificationPrompt(
  objective: string
): string {
  return `## Verification Required:
Please verify if the objective "${objective}" has been successfully completed.

Look at the current page state and confirm:
1. Has the main goal been achieved?
2. Are there any remaining steps needed?
3. Is the user in the expected final state?

If the task is complete, use the "finish" action. If not, continue with the necessary steps.`;
}

/**
 * Generate a prompt for when the agent is stuck
 */
export function generateStuckRecoveryPrompt(
  consecutiveFailures: number,
  lastActions: any[]
): string {
  const recentActions = lastActions
    .slice(-3)
    .map(
      (action) =>
        `${action.action} (${action.selector || action.url || 'no target'})`
    )
    .join(', ');

  return `## Recovery Needed:
You've had ${consecutiveFailures} consecutive failures or seem to be stuck.

Recent actions: ${recentActions}

Please try a completely different approach:
1. Take a screenshot to see the current state
2. Look for alternative ways to achieve the objective
3. Consider if the page layout has changed
4. Try using different selectors or interaction methods
5. If truly stuck, explain the situation and finish the task

Break out of the current pattern and try something new.`;
}
