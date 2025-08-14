/**
 * System prompts and prompt templates for the AI agent
 */
import { readFile } from 'node:fs/promises';
import { PageView } from '../types/dom';

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
  static async load(
    options: {
      flashMode?: boolean;
      useThinking?: boolean;
      placeholders?: Record<string, string | number>;
      overrideSystemMessage?: string;
      extendSystemMessage?: string;
    } = {}
  ): Promise<string> {
    const {
      flashMode,
      useThinking,
      placeholders,
      overrideSystemMessage,
      extendSystemMessage,
    } = options;

    // If caller provides a full override, prefer it
    let content: string | null = overrideSystemMessage ?? null;

    if (content == null) {
      let filename = 'system-prompt.md';
      if (flashMode) filename = 'system-prompt-flash.md';
      else if (useThinking === false) filename = 'system-prompt-no-thinking.md';

      const candidates: URL[] = [
        new URL(`./prompt/${filename}`, import.meta.url),
        // Fallback to source tree when running from dist
        new URL(`../../src/agent/prompt/${filename}`, import.meta.url),
      ];

      for (const candidate of candidates) {
        try {
          content = await readFile(candidate, 'utf-8');
          break;
        } catch {
          continue;
        }
      }
      if (content == null) {
        throw new Error(`Failed to load system prompt file: ${filename}`);
      }
    }

    if (placeholders) {
      for (const [key, value] of Object.entries(placeholders)) {
        const pattern = new RegExp(`\\{${key}\\}`, 'g');
        content = content.replace(pattern, String(value));
      }
    }

    if (extendSystemMessage) {
      content = `${content}\n${extendSystemMessage}`;
    }

    return content;
  }
}
/**
 * Generate a prompt for the current page context
 */
export function generatePageContextPrompt(
  objective: string,
  pageView: PageView,
  history: Array<{
    step: number;
    action: { action: string; selector?: string; url?: string; text?: string };
    result: { success: boolean; message: string; error?: string };
  }> = []
): string {
  const interactiveElementsList = pageView.interactiveElements
    .slice(0, 40)
    .map(
      (el, index) =>
        `[${index}] <${el.tagName}> ${el.text ?? ''} </${el.tagName}>`
    )
    .join('\n');

  const historySection =
    history.length > 0
      ? `${history
          .slice(-5)
          .map((h) => {
            const status = h.result.success ? 'Success' : 'Failure';
            return `<step_${h.step}>:\nAction: ${h.action.action}${h.action.selector ? ` (${h.action.selector})` : ''}${h.action.url ? ` [${h.action.url}]` : ''}\nResult: ${status}: ${h.result.message}${h.result.error ? ` — ${h.result.error}` : ''}\n</step_${h.step}>`;
          })
          .join('\n')}`
      : '';

  return (
    `<agent_history>\n` +
    historySection +
    `\n</agent_history>\n` +
    `<agent_state>\n<user_request>\n${objective}\n</user_request>\n<file_system>\nNo file system available\n</file_system>\n<todo_contents>\n[Current todo.md is empty, fill it with your plan when applicable]\n</todo_contents>\n</agent_state>\n` +
    `<browser_state>\nCurrent URL: ${pageView.url}\nTitle: ${pageView.title}\n\nInteractive elements from top layer of the current page inside the viewport:\n${interactiveElementsList}\n</browser_state>`
  );
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
