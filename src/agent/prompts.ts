import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  SystemMessage,
  UserMessage,
  ContentPartTextParam,
  ContentPartImageParam,
  ImageURL,
} from '../llm/messages.js';
import { observe_debug } from '../observability.js';
import { is_new_tab_page } from '../utils.js';
import type { AgentStepInfo } from './views.js';
import type { BrowserStateSummary } from '../browser/views.js';
import type { FileSystem } from '../filesystem/file-system.js';

const readPromptTemplate = (filename: string) => {
  const filePath = fileURLToPath(new URL(filename, import.meta.url));
  return fs.readFileSync(filePath, 'utf-8');
};

export class SystemPrompt {
  private promptTemplate = '';
  private systemMessage: SystemMessage;

  constructor(
    private readonly actionDescription: string,
    private readonly maxActionsPerStep = 10,
    private readonly overrideSystemMessage: string | null = null,
    private readonly extendSystemMessage: string | null = null,
    private readonly useThinking = true,
    private readonly flashMode = false
  ) {
    if (overrideSystemMessage) {
      this.promptTemplate = overrideSystemMessage;
    } else {
      this.loadPromptTemplate();
    }

    let prompt = this.promptTemplate.replace(
      '{max_actions}',
      String(this.maxActionsPerStep)
    );
    if (this.extendSystemMessage) {
      prompt += `\n${this.extendSystemMessage}`;
    }
    this.systemMessage = new SystemMessage(prompt);
    this.systemMessage.cache = true;
  }

  private loadPromptTemplate() {
    const templateName = this.flashMode
      ? './system_prompt_flash.md'
      : this.useThinking
        ? './system_prompt.md'
        : './system_prompt_no_thinking.md';
    try {
      this.promptTemplate = readPromptTemplate(templateName);
    } catch (error) {
      throw new Error(
        `Failed to load system prompt template: ${(error as Error).message}`
      );
    }
  }

  get_system_message() {
    return this.systemMessage;
  }
}

interface AgentMessagePromptInit {
  browser_state_summary: BrowserStateSummary;
  file_system: FileSystem;
  agent_history_description?: string | null;
  read_state_description?: string | null;
  task?: string | null;
  include_attributes?: string[] | null;
  step_info?: AgentStepInfo | null;
  page_filtered_actions?: string | null;
  max_clickable_elements_length?: number;
  sensitive_data?: string | null;
  available_file_paths?: string[] | null;
  screenshots?: string[] | null;
  vision_detail_level?: 'auto' | 'low' | 'high';
}

export class AgentMessagePrompt {
  private readonly browserState: BrowserStateSummary;
  private readonly fileSystem: FileSystem;
  private readonly agentHistoryDescription: string | null;
  private readonly readStateDescription: string | null;
  private readonly task: string | null;
  private readonly includeAttributes?: string[] | null;
  private readonly stepInfo?: AgentStepInfo | null;
  private readonly pageFilteredActions: string | null;
  private readonly maxClickableElementsLength: number;
  private readonly sensitiveData: string | null;
  private readonly availableFilePaths?: string[] | null;
  private readonly screenshots: string[];
  private readonly visionDetailLevel: 'auto' | 'low' | 'high';

  constructor(init: AgentMessagePromptInit) {
    this.browserState = init.browser_state_summary;
    this.fileSystem = init.file_system;
    this.agentHistoryDescription = init.agent_history_description ?? null;
    this.readStateDescription = init.read_state_description ?? null;
    this.task = init.task ?? null;
    this.includeAttributes = init.include_attributes ?? null;
    this.stepInfo = init.step_info ?? null;
    this.pageFilteredActions = init.page_filtered_actions ?? null;
    this.maxClickableElementsLength =
      init.max_clickable_elements_length ?? 40000;
    this.sensitiveData = init.sensitive_data ?? null;
    this.availableFilePaths = init.available_file_paths ?? null;
    this.screenshots = init.screenshots ?? [];
    this.visionDetailLevel = init.vision_detail_level ?? 'auto';
  }

  private browserStateDescription() {
    let elementsText =
      this.browserState.element_tree.clickable_elements_to_string(
        this.includeAttributes ?? undefined
      );
    let truncatedText = '';
    if (elementsText.length > this.maxClickableElementsLength) {
      elementsText = elementsText.slice(0, this.maxClickableElementsLength);
      truncatedText = ` (truncated to ${this.maxClickableElementsLength} characters)`;
    }

    const hasContentAbove = (this.browserState.pixels_above ?? 0) > 0;
    const hasContentBelow = (this.browserState.pixels_below ?? 0) > 0;

    const pi = this.browserState.page_info;
    let pageInfoText = '';
    if (pi) {
      const pagesAbove =
        pi.viewport_height > 0 ? pi.pixels_above / pi.viewport_height : 0;
      const pagesBelow =
        pi.viewport_height > 0 ? pi.pixels_below / pi.viewport_height : 0;
      const totalPages =
        pi.viewport_height > 0 ? pi.page_height / pi.viewport_height : 0;
      const currentPosition =
        pi.scroll_y / Math.max(pi.page_height - pi.viewport_height, 1);
      pageInfoText = `Page info: ${pi.viewport_width}x${pi.viewport_height}px viewport, ${pi.page_width}x${pi.page_height}px total page size, ${pagesAbove.toFixed(1)} pages above, ${pagesBelow.toFixed(1)} pages below, ${totalPages.toFixed(1)} total pages, at ${(currentPosition * 100).toFixed(0)}% of page`;
    }

    if (elementsText) {
      if (hasContentAbove) {
        if (pi) {
          const pagesAbove =
            pi.viewport_height > 0 ? pi.pixels_above / pi.viewport_height : 0;
          elementsText = `... ${this.browserState.pixels_above} pixels above (${pagesAbove.toFixed(1)} pages) - scroll to see more or extract structured data if you are looking for specific information ...\n${elementsText}`;
        } else {
          elementsText = `... ${this.browserState.pixels_above} pixels above - scroll to see more or extract structured data if you are looking for specific information ...\n${elementsText}`;
        }
      } else {
        elementsText = `[Start of page]\n${elementsText}`;
      }

      if (hasContentBelow) {
        if (pi) {
          const pagesBelow =
            pi.viewport_height > 0 ? pi.pixels_below / pi.viewport_height : 0;
          elementsText = `${elementsText}\n... ${this.browserState.pixels_below} pixels below (${pagesBelow.toFixed(1)} pages) - scroll to see more or extract structured data if you are looking for specific information ...`;
        } else {
          elementsText = `${elementsText}\n... ${this.browserState.pixels_below} pixels below - scroll to see more or extract structured data if you are looking for specific information ...`;
        }
      } else {
        elementsText = `${elementsText}\n[End of page]`;
      }
    } else {
      elementsText = 'empty page';
    }

    let tabsText = '';
    const currentTabCandidates: number[] = [];
    for (const tab of this.browserState.tabs) {
      if (
        tab.url === this.browserState.url &&
        tab.title === this.browserState.title
      ) {
        currentTabCandidates.push(tab.page_id);
      }
    }
    const currentTabId =
      currentTabCandidates.length === 1 ? currentTabCandidates[0] : null;
    for (const tab of this.browserState.tabs) {
      tabsText += `Tab ${tab.page_id}: ${tab.url} - ${tab.title.slice(0, 30)}\n`;
    }

    const currentTabText =
      currentTabId !== null ? `Current tab: ${currentTabId}` : '';
    const pdfMessage = this.browserState.is_pdf_viewer
      ? 'PDF viewer cannot be rendered. Do not use extract_structured_data here; use read_file on downloaded PDF via available_file_paths.\n\n'
      : '';

    return `${currentTabText}
Available tabs:
${tabsText}
${pageInfoText}
${pdfMessage}Interactive elements from top layer of the current page inside the viewport${truncatedText}:
${elementsText}
`;
  }

  private agentStateDescription() {
    const todoContents = this.fileSystem.get_todo_contents();
    const todoText =
      todoContents ||
      '[Current todo.md is empty, fill it with your plan when applicable]';
    const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const stepInfo =
      this.stepInfo != null
        ? `Step ${this.stepInfo.step_number + 1} of ${this.stepInfo.max_steps}\n`
        : '';
    const stepInfoDescription = `${stepInfo}Current date and time: ${timestamp}`;

    let agentState = `<user_request>
${this.task ?? ''}
</user_request>
<file_system>
${this.fileSystem.describe()}
</file_system>
<todo_contents>
${todoText}
</todo_contents>
`;
    if (this.sensitiveData) {
      agentState += `<sensitive_data>
${this.sensitiveData}
</sensitive_data>
`;
    }

    agentState += `<step_info>
${stepInfoDescription}
</step_info>
`;

    if (this.availableFilePaths?.length) {
      agentState += `<available_file_paths>
${this.availableFilePaths.join('\n')}
</available_file_paths>
`;
    }

    return agentState;
  }

  @observe_debug({
    name: 'agent_message_prompt:get_user_message',
    ignore_input: true,
    ignore_output: true,
  })
  get_user_message(use_vision = true) {
    if (
      is_new_tab_page(this.browserState.url) &&
      this.stepInfo &&
      this.stepInfo.step_number === 0 &&
      this.browserState.tabs.length === 1
    ) {
      use_vision = false;
    }

    let stateDescription = `<agent_history>
${(this.agentHistoryDescription ?? '').trim()}
</agent_history>
`;
    stateDescription += `<agent_state>
${this.agentStateDescription().trim()}
</agent_state>
`;
    stateDescription += `<browser_state>
${this.browserStateDescription().trim()}
</browser_state>
`;

    const readState = (this.readStateDescription ?? '').trim();
    if (readState) {
      stateDescription += `<read_state>
${readState}
</read_state>
`;
    }

    if (this.pageFilteredActions) {
      stateDescription += `<page_specific_actions>
${this.pageFilteredActions}
</page_specific_actions>
`;
    }

    if (use_vision && this.screenshots.length > 0) {
      const parts: Array<ContentPartTextParam | ContentPartImageParam> = [
        new ContentPartTextParam(stateDescription),
      ];
      this.screenshots.forEach((shot, index) => {
        const label =
          index === this.screenshots.length - 1
            ? 'Current screenshot:'
            : 'Previous screenshot:';
        parts.push(new ContentPartTextParam(label));
        parts.push(
          new ContentPartImageParam(
            new ImageURL(
              `data:image/png;base64,${shot}`,
              this.visionDetailLevel,
              'image/png'
            )
          )
        );
      });
      const message = new UserMessage(parts);
      message.cache = true;
      return message;
    }

    const message = new UserMessage(stateDescription);
    message.cache = true;
    return message;
  }
}
