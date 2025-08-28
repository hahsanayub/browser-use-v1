/**
 * System prompts and prompt templates for the AI agent
 */
import { readFile } from 'node:fs/promises';
import {
  PageView,
  DOMElementNode,
  DOMBaseNode,
  DOMTextNode,
} from '../types/dom';
import { DOMService } from '../services/dom-service';
import {
  ViewportDOMService,
  SimplifiedDOMOptions,
} from '../services/dom-tree-serializer';
import { FileSystem } from '../services/file-system';
import {
  AgentHistoryManager,
  HistoryItem,
  EnhancedHistoryItem,
  enhancedHistoryToHistoryItems,
  convertLegacyHistory,
} from './AgentHistory';
import type { ActionRegistry } from '../controller/registry';
// Import TODO context provider for intelligent todo content generation
import { TodoContextProvider } from '../../server/browserUseAgent';

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
      let filename = 'system_prompt.md';
      if (flashMode) filename = 'system_prompt_flash.md';
      else if (useThinking === false) filename = 'system_prompt_no_thinking.md';

      const candidates: URL[] = [
        new URL(`./prompts/${filename}`, import.meta.url),
        // Fallback to source tree when running from dist
        new URL(`../../src/agent/prompts/${filename}`, import.meta.url),
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

function getBrowserStateDescription(
  pageView: PageView,
  truncatedText: string,
  interactiveElementsList: string
): string {
  const { pageInfo, tabsInfo, isPdfViewer } = pageView;

  // Check if there's content above or below the viewport
  const hasContentAbove = (pageInfo.pixelsAbove || 0) > 0;
  const hasContentBelow = (pageInfo.pixelsBelow || 0) > 0;

  // Enhanced page information for the model
  let pageInfoText = '';
  if (pageInfo) {
    // Compute page statistics dynamically
    const pagesAbove =
      pageInfo.viewportHeight > 0
        ? pageInfo.pixelsAbove / pageInfo.viewportHeight
        : 0;
    const pagesBelow =
      pageInfo.viewportHeight > 0
        ? pageInfo.pixelsBelow / pageInfo.viewportHeight
        : 0;
    const totalPages =
      pageInfo.viewportHeight > 0
        ? pageInfo.pageHeight / pageInfo.viewportHeight
        : 0;
    const currentPagePosition =
      pageInfo.scrollY /
      Math.max(pageInfo.pageHeight - pageInfo.viewportHeight, 1);

    pageInfoText = `Page info: ${pageInfo.viewportWidth}x${pageInfo.viewportHeight}px viewport, ${pageInfo.pageWidth}x${pageInfo.pageHeight}px total page size, ${pagesAbove.toFixed(1)} pages above, ${pagesBelow.toFixed(1)} pages below, ${totalPages.toFixed(1)} total pages, at ${Math.round(currentPagePosition * 100)}% of page`;
  }

  // Process interactive elements text with scroll indicators
  let elementsText = '';
  if (interactiveElementsList !== '') {
    if (hasContentAbove) {
      const pagesAbove =
        pageInfo.viewportHeight > 0
          ? pageInfo.pixelsAbove / pageInfo.viewportHeight
          : 0;
      elementsText = `... ${pageInfo.pixelsAbove} pixels above (${pagesAbove.toFixed(1)} pages) - scroll to see more or extract structured data if you are looking for specific information ...\n${interactiveElementsList}`;
    } else {
      elementsText = `[Start of page]\n${interactiveElementsList}`;
    }

    if (hasContentBelow) {
      const pagesBelow =
        pageInfo.viewportHeight > 0
          ? pageInfo.pixelsBelow / pageInfo.viewportHeight
          : 0;
      elementsText = `${elementsText}\n... ${pageInfo.pixelsBelow} pixels below (${pagesBelow.toFixed(1)} pages) - scroll to see more or extract structured data if you are looking for specific information ...`;
    } else {
      elementsText = `${elementsText}\n[End of page]`;
    }
  } else {
    elementsText = 'empty page';
  }

  // Process tabs information
  let tabsText = '';
  const currentTabCandidates: number[] = [];

  // Find tabs that match both URL and title to identify current tab more reliably
  for (const tab of tabsInfo) {
    if (tab.url === pageView.url && tab.title === pageView.title) {
      currentTabCandidates.push(tab.pageId);
    }
  }

  // If we have exactly one match, mark it as current
  // Otherwise, don't mark any tab as current to avoid confusion
  const currentTabId =
    currentTabCandidates.length === 1 ? currentTabCandidates[0] : null;

  for (const tab of tabsInfo) {
    tabsText += `Tab ${tab.pageId}: ${tab.url} - ${tab.title.substring(
      0,
      30
    )}\n`;
  }

  const currentTabText =
    currentTabId !== null ? `\nCurrent tab: ${currentTabId}` : '';

  // Check if current page is a PDF viewer and add appropriate message
  const pdfMessage = isPdfViewer
    ? 'PDF viewer cannot be rendered. In this page, DO NOT use the extract_structured_data action as PDF content cannot be rendered. Use the read_file action on the downloaded PDF in available_file_paths to read the full content.\n\n'
    : '';

  const browserState = `${currentTabText}
Available tabs:
${tabsText}
${pageInfoText}
${pdfMessage}Interactive elements from top layer of the current page inside the viewport${truncatedText}:
${elementsText}
`;

  return browserState;
}

/**
 * Fallback method to convert elementTree to string when DOM service fails
 */
function fallbackElementTreeToString(elementTree: DOMElementNode): string {
  let result = '';

  function traverse(node: DOMBaseNode, depth: number = 0): void {
    const indent = '\t'.repeat(depth);

    if (node.type === 'TEXT_NODE') {
      const textNode = node as DOMTextNode;
      if (textNode.text.trim()) {
        result += `${indent}${textNode.text.trim()}\n`;
      }
      return;
    }

    const elementNode = node as DOMElementNode;
    if (elementNode.isInteractive && elementNode.isVisible) {
      const attrs = Object.entries(elementNode.attributes)
        .map(([key, value]) => `${key}="${value}"`)
        .join(' ');

      const highlightInfo =
        elementNode.highlightIndex !== null
          ? `[${elementNode.highlightIndex}]`
          : '';

      result += `${indent}${highlightInfo}<${elementNode.tagName}${attrs ? ' ' + attrs : ''}>\n`;
    }

    // Traverse children
    for (const child of elementNode.children) {
      traverse(child, depth + 1);
    }
  }

  traverse(elementTree);
  return result;
}

/**
 * Generate a prompt for the current page context with viewport-aware DOM processing
 */
export async function generatePageContextPrompt(
  objective: string,
  pageView: PageView,
  history:
    | Array<{
        step: number;
        action: {
          action: string;
          selector?: string;
          url?: string;
          text?: string;
        };
        result: { success: boolean; message: string; error?: string };
      }>
    | EnhancedHistoryItem[]
    | HistoryItem[] = [],
  maxClickableElementsLength: number = 40000,
  fileSystem?: FileSystem | null,
  useViewportAware: boolean = true,
  simplifiedDOMOptions?: Partial<SimplifiedDOMOptions>,
  // New parameters for enhanced functionality
  agentHistoryManager?: AgentHistoryManager,
  readStateDescription?: string,
  stepInfo?: { stepNumber: number; maxSteps: number; isLastStep: boolean },
  pageSpecificActions?: string,
  actionRegistry?: ActionRegistry,
  viewportDOMService?: ViewportDOMService // Add ViewportDOMService parameter
): Promise<string> {
  let interactiveElementsList: string;
  let truncatedText = '';

  // Use simplified DOM processing if available and enabled
  if (pageView.domState?.elementTree && useViewportAware) {
    // Use provided ViewportDOMService instance or create a new one as fallback
    const viewportAwareDOMService =
      viewportDOMService || new ViewportDOMService();

    const options: SimplifiedDOMOptions = {
      maxTotalLength: maxClickableElementsLength,
      ...simplifiedDOMOptions,
    };

    interactiveElementsList =
      viewportAwareDOMService.clickableElementsToStringViewportAware(
        pageView.domState.elementTree,
        options
      );

    // Check if content was truncated based on length
    if (interactiveElementsList.length >= maxClickableElementsLength) {
      truncatedText = ` (simplified truncation applied)`;
    }
  } else if (pageView.domState?.elementTree) {
    // Fallback to standard DOM service - using placeholder page object
    const domService = new DOMService();
    const placeholderPage = {
      evaluate: () => Promise.resolve({}),
      url: () => pageView.url || '',
    } as any;

    try {
      const { html } =
        await domService.getEnhancedClickableElementsString(placeholderPage);
      interactiveElementsList = html;
    } catch {
      // Final fallback using elementTree directly
      interactiveElementsList = fallbackElementTreeToString(
        pageView.domState.elementTree
      );
    }

    // Apply simple length truncation for fallback
    if (interactiveElementsList.length > maxClickableElementsLength) {
      interactiveElementsList = interactiveElementsList.substring(
        0,
        maxClickableElementsLength
      );
      truncatedText = ` (truncated to ${maxClickableElementsLength} characters)`;
    }
  } else {
    // Fallback to original logic if elementTree is not available
    interactiveElementsList = Object.entries(pageView.domState?.map || {})
      .map(
        ([index, el]) =>
          `[${index}] <${el.tagName}> ${el.text ?? ''} </${el.tagName}>`
      )
      .join('\n');

    // Apply simple length truncation for fallback
    if (interactiveElementsList.length > maxClickableElementsLength) {
      interactiveElementsList = interactiveElementsList.substring(
        0,
        maxClickableElementsLength
      );
      truncatedText = ` (truncated to ${maxClickableElementsLength} characters)`;
    }
  }

  // Generate history section with enhanced support for different history formats
  let historySection = '';
  if (history.length > 0) {
    // Check if this is the new HistoryItem format
    if (isHistoryItemArray(history)) {
      historySection = history
        .map((item) => AgentHistoryManager.historyItemToString(item))
        .join('\n');
    }
    // Check if this is the enhanced history format
    else if (isEnhancedHistoryArray(history)) {
      const historyItems = enhancedHistoryToHistoryItems(history);
      historySection = historyItems
        .map((item) => AgentHistoryManager.historyItemToString(item))
        .join('\n');
    }
    // Fallback to legacy format for backward compatibility
    else {
      const enhancedHistory = convertLegacyHistory(
        history as Array<{
          step: number;
          action: {
            action: string;
            selector?: string;
            url?: string;
            text?: string;
          };
          result: { success: boolean; message: string; error?: string };
        }>
      );
      const historyItems = enhancedHistoryToHistoryItems(enhancedHistory);
      historySection = historyItems
        .map((item) => AgentHistoryManager.historyItemToString(item))
        .join('\n');
    }
  }

  // Generate file system information
  let fileSystemContent = 'No file system available';
  let todoContents =
    '[Current todo.md is empty, fill it with your plan when applicable]';

  if (fileSystem) {
    try {
      const description = fileSystem.describe();
      fileSystemContent =
        description || 'File system available but no files found';

      // Get todo.md contents if available - use intelligent TODO context
      const todoContent = fileSystem.getTodoContents();
      if (todoContent && todoContent.trim()) {
        // Use intelligent TODO context that shows current focus and guidance
        try {
          const stepNumber = stepInfo ? stepInfo.stepNumber + 1 : 1;
          const intelligentTodoContext = TodoContextProvider.getCurrentTodoContext(
            fileSystem,
            stepNumber,
            undefined, // sessionId not available here
            pageView.url
          );
          todoContents = intelligentTodoContext;
        } catch (error) {
          // Fallback to original content if intelligent context fails
          console.warn('Failed to generate intelligent TODO context:', error);
          todoContents = todoContent;
        }
      }
    } catch {
      fileSystemContent = 'File system available but error reading contents';
    }
  }

  // Determine read state content - prioritize agentHistoryManager over direct parameter
  let readStateContent = '';
  if (agentHistoryManager) {
    readStateContent = agentHistoryManager.getReadStateDescription();
  } else if (readStateDescription) {
    readStateContent = readStateDescription;
  }

  // Clean up read state content and prepare for inclusion
  const cleanReadState = readStateContent.trim();
  const readStateSection = cleanReadState
    ? `<read_state>\n${cleanReadState}\n</read_state>\n`
    : '';

  // Generate step_info section
  let stepInfoSection = '';
  if (stepInfo) {
    // Format date and time
    const now = new Date();
    const timeStr = now.toISOString().substring(0, 16).replace('T', ' ');

    stepInfoSection = `\n<step_info>\nStep ${stepInfo.stepNumber + 1} of ${stepInfo.maxSteps} max possible steps\nCurrent date and time: ${timeStr}\n</step_info>`;
  }

  // Add page-specific actions section if provided
  const pageActionsSection = pageSpecificActions
    ? `<page_specific_actions>\n${pageSpecificActions}\n</page_specific_actions>\n`
    : '';

  // Add default page actions section if actionRegistry is provided
  let defaultActionsSection = '';
  if (actionRegistry) {
    const defaultActionsDescription = actionRegistry.getPromptDescription();
    if (defaultActionsDescription.trim()) {
      defaultActionsSection = `<page_actions>\n${defaultActionsDescription}\n</page_actions>\n`;
    }
  }

  return (
    `<agent_history>\n` +
    historySection +
    `\n</agent_history>\n` +
    `<agent_state>\n<user_request>\n${objective}\n</user_request>\n<file_system>\n${fileSystemContent}\n</file_system>\n<todo_contents>\n${todoContents}\n</todo_contents>${stepInfoSection}\n</agent_state>\n` +
    `<browser_state>${getBrowserStateDescription(
      pageView,
      truncatedText,
      interactiveElementsList
    )}</browser_state>\n` +
    readStateSection +
    defaultActionsSection +
    pageActionsSection
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

/**
 * Type guard to check if history is HistoryItem array
 */
function isHistoryItemArray(history: any[]): history is HistoryItem[] {
  if (history.length === 0) return false;
  const first = history[0];
  return (
    first &&
    typeof first === 'object' &&
    ('stepNumber' in first ||
      'evaluationPreviousGoal' in first ||
      'memory' in first ||
      'nextGoal' in first ||
      'actionResults' in first ||
      'error' in first ||
      'systemMessage' in first) &&
    !('step' in first) &&
    !('action' in first) &&
    !('result' in first)
  );
}

/**
 * Type guard to check if history is EnhancedHistoryItem array
 */
function isEnhancedHistoryArray(
  history: any[]
): history is EnhancedHistoryItem[] {
  if (history.length === 0) return false;
  const first = history[0];
  return (
    first &&
    typeof first === 'object' &&
    'step' in first &&
    'action' in first &&
    'result' in first &&
    ('evaluationPreviousGoal' in first ||
      'memory' in first ||
      'nextGoal' in first ||
      'error' in first ||
      'systemMessage' in first)
  );
}
