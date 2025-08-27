/* eslint-disable @typescript-eslint/no-unused-vars */
import 'dotenv/config';
import {
  ActionResult,
  Agent,
  BaseLLMClient,
  createController,
  Controller,
  type AgentConfig,
} from '../src/index';
import { withHealthCheck } from '../src/services/health-check';
import { z } from 'zod';
import { Page } from 'playwright';
import { BrowserSession } from '../src/browser';
import type { BrowserContext as AgentBrowserContext } from '../src/browser/BrowserContext';
import { action } from '../src/controller/decorators';
import { FileSystem } from '../src/services/file-system';
import type { BrowserUseEvent } from './browserUseService';

export class ExtractDataActions {
  @action(
    'extract_structured_data',
    "Extract structured, semantic data (e.g. product description, price, all information about XYZ) from the current webpage based on a textual query. This tool takes the entire markdown of the page and extracts the query from it. Set extract_links=true ONLY if your query requires extracting links/URLs from the page. Only use this for specific queries for information retrieval from the page. Don't use this to get interactive elements - the tool does not see HTML elements, only the markdown.",
    z.object({
      query: z
        .string()
        .min(1)
        .describe('The query to extract information about'),
      extract_links: z
        .boolean()
        .default(false)
        .describe('Whether to include links and images in the extraction'),
    }),
    { isAvailableForPage: (page) => page && !page.isClosed() }
  )
  static async extractStructuredData({
    params,
    page,
    context,
  }: {
    params: { query: string; extract_links: boolean };
    page: Page;
    context: {
      browserContext?: AgentBrowserContext;
      browserSession?: BrowserSession;
      llmClient?: BaseLLMClient;
      fileSystem?: FileSystem;
      agent: Agent;
    };
  }): Promise<ActionResult> {
    console.log('extractStructuredData', params);
    // const { query, extract_links } = params;

    if (!context.llmClient) {
      return {
        success: false,
        message: 'LLM client not available',
        error: 'LLM_CLIENT_UNAVAILABLE',
      };
    }

    return withHealthCheck(page, async (p) => {
      return {
        success: true,
        message: 'Extracted structured data',
        attachments: [],
      };
    });
  }
}

const customInstructions = `

<todo_file_management>
This section defines the rules for how the TODO.md file should be generated, updated, and maintained by the agent.

**Rules**
- Always begin with a **title** (e.g., "Plan for extracting X API documentation").
- Must include a **## Goal** section that restates the user’s request in natural language.
- Must include a **## Steps** (or **## Tasks**) section with a numbered checklist of actions.
  - Each task is a Markdown checkbox:
    - \`[ ]\` = incomplete
    - \`[x]\` = complete
    - \`[-]\` = start processing, or in the progress
  - Subtasks are allowed:
    - Indented by 3 spaces
    - Numbered (1., 2., 3., etc.)
- When a parent step has in-process sub-task, update its checkbox from \`[ ]\` → \`[-]\`.
- When a step is starting, update its checkbox from \`[ ]\` → \`[-]\`.
- When a step is completed, update its checkbox from e.g. \`[ ]\`, \`[-]\` → \`[x]\`.
- When the workflow is finished (success, partial, or failure), append or update a **## Result** (or **## Summary**) section at the end.
  - This section must include a **brief summary of the final output** or the outcome of the workflow. E.g. what has been extracted for the user request, what files generated for what extracted.
- Do not delete or overwrite existing tasks; only update their status or append new ones.
- Always preserve the overall structure of the file when updating.

**Example**
This is just an example of the file strucure, never copy this as your todo.md content directly.
\`\`\`md
# Plan for extracting Tasks-related API documentation

## Goal
Extract all Tasks-related API endpoint documentation content from the HubSpot CRM API documentation.

## Steps

### Discovery
1. [x] Navigate to HubSpot CRM API documentation home page
2. [ ] Locate "Tasks" section
3. [ ] Expand to reveal all endpoints

### Enumeration
1. [ ] List all Tasks-related endpoints

### Extraction
1. [ ] Archive a batch of tasks by ID
2. [ ] Create a batch of tasks
3. [ ] Create a task
4. [ ] Update a task by ID

### Verification
1. [ ] Confirm all listed endpoints are extracted

## Result
- Navigation complete.
- Enumeration in progress.
\`\`\`

</todo_file_management>




<api_document_content_page_explore_guidelines>
You are controlling a browser to extract complete information from an API documentation page.

## Workflow Guideline You Must Apply to Browse the page to Extract API document content
0. Firtly, you must identify what pages(endpoints) you need to browse to complete the user_request in your plan, follow this when you process your steps. Skip the pages (endpoints) that doesn't match the user_request.
1. Do not start browsing and extracting page content in a group section menu scope, always click the endpoint mene item. If the navigation section has many endpoints, open them by clicking one by one.
2. If the page doesn't look like an "API-endpoint" document page, for example the page just tells the end-point usage, api versions, rate-limit info, general authorzation-info of the API service, you should just extract the page content's summary content with a query like: \`Extract summary info, and what this page describes.\`.
3. You must memorize clearly what elements have been expanded, do not repeat to click them again.
4. Your goal is to explore the every single endpoint page, you should be able to distinglish if the page is a category section, or an endpoint detailed page. Click its sub nav items to enter the endpoint page, instead of doing extraction for the entire section.
5. Handle navigation menu:
  1. If the entry page open but the selected navigation menu item is not fully visible, you must observe the navigation panel and do necessary interaction scrollin(0.5 page to 1 page) individually on the panel as needed to make sure the selected navigation item of the entry page is visible before doing API document content extraction. For example, you can locate the first "nav" or "NavMenu" element on the page, or a div with class "SideNav" (or similar), this element is scrollable vertically.
  2. Make sure to get the selected endpoint page, or the endpoint you're currently exploring is visible in the navigation menu (if has) by using the scrolling tool, or do necessary interaction on the nav menu, nav panel decidedly.
  3. If the Nav item is already expanded, do not click to collapse them.
6. **IMPORTANT** Process indivisual endpoint at once, when the page contains multiple endpoints, please keep navivating to the sub endpoint.
7. Ignore **deprecated** endpoints, endpoint pages with "strikethrough" line. Skip those pages, indicate this in the todo.md file in your plan.
8. Folllow the **Detailed Info Discovery Instructions** below to browse the page to identify and discover API Spec content.
9. Use "extract_structured_data" tool to do API content extraction, and deliver the results.

## IMPORTANT INTERACTION RULES:
- NEVER click on elements with "+", "-", "▼", "▲" symbols in "Response samples"/"Requeset samples" sections
- NEVER interact with any UI controls in sample/example sections
- Focus only on the main API documentation content
- Ignore all "Copy", "Expand", "Collapse" buttons in sample areas


## Detailed Info Discovery Instructions

#### 0️⃣ Close Overlay: Highest Priority Action

CRITICAL: Before proceeding with any other actions on a new page (including those planned in todo.md), you MUST first scan the entire page for any overlays.

- **What to look for:** Overlays are elements that may block access to the main content. They include, but are not limited to:
  - Cookie consent banners & Cookie Policy prompts
  - Pop-up modals
  - Subscription prompts or sign-in dialogs
  - Floating ads or tooltips

- **What to do:** If an overlay is detected, your **immediate and only action for the current step must be to click the button or icon to dismiss it.**
  - Look for common dismissal elements like: "Accept”, "Close”, "X”, "No thanks”, "Got it”, or "Dismiss”.
  - Icons that look like X, × (close) or checkmarks are also valid targets.

- **Important Constraints:**
  - Defer your originally planned task to the next step after the overlay has been successfully closed.
  - Do not combine closing an overlay with any other action in the same step.
  - If an overlay cannot be closed, attempt to scroll or interact to bypass it.
  - Always wait 1–2 seconds after the interaction to allow the interface to update.

---

#### 1️⃣ Handle Page Navigating and Scrolling
- Do not mess up contents when page scrolling, you must extractly know what page you're exploring, and strictly recognize and remember the boundary when page is scrolling, here is same guides:
  - Anchor the current page by the location url, if the location url changed after scrolling, meaning the page is changed, you should scrolling back.
  - When scrolling, if more content is displaying, you must learn the context, if the content is not relative to the API content under the current page url, you should not extract or do interactive actions with that.
- You must always keep the focus on the content extraction on the current page you're working on, you should memory the page link you're working on.
- You can only change the navigation menu focused item, until the page content is extracted to meet the goal of the step.
- If the navigation menu bar(panel) is too long, you can scroll that container to get more content visible.
- Observe and learn the page to explore and expand the nav menu appropriatly.
- Wait 1-2s for content to load before proceeding.

---

#### 2️⃣ Discover Each Endpoint
For each visible API endpoint (e.g., GET \`/products\`, POST \`/users\`):
- Click its title or section to ensure details are visible.
- Wait 1-2s for content to load before proceeding.

---

#### 3️⃣ Discover **Request** Definitions
Within each endpoint section:
- Do not consider/explore "example" as the request body type
- You must firstly locate and click the elements under section where its field has description info to extract content, then check other example/samples area.
- Look for headings or tabs labeled:
  - "Request”, "Request Body", "Request Payload", "Request Schema" or similar!
- Identify all clickable elements, for example item with arrow indicator symbols like: ▼, +, or arrow indicators!
- **Important** If the elements are already expanded/visible, DO NOT click the element to collapse it.
- Avoid duplicate clicks on already active tabs.

**CRITICAL RULE: You MUST FIRST CLICK on tabs labeled 'Schema', 'Request Schema', or 'Response Schema' to reveal their content.**
**NEVER call \`extract_structured_data\` on an API endpoint section IF a 'Schema' tab is visible but not active.**Your immediate next action must be to \`click\` the schema tab. Only after the schema content is visible can you proceed with extraction in a subsequent step. This is a mandatory prerequisite, not an optional step.

---

#### 4️⃣ Discover **Response** Definitions
- Do not consider/explore "example" as the response body type
- Always put to your thinking that: "Under labels like \`Responses\`, there would have Request Schema definition, you must firstly interact those elements under there"!
- You must always locate and interact the expandable elements under section where the fields have description info.
- If there are elements with label like below pattern examples, you must firstly click them just once to show the Response Schema Definition entries. For example:
   - Http Status Buttons under Responses section like: 200, 404, 500,
- Look for headings or tabs labeled:
  - "Response", "Response Body", "Response Schema" or similar.
- Scroll to the "Responses" section of the endpoint.
- If the elements are already expanded/visible, DO NOT click the element to collapse it.
- Be careful to avoid duplicate clicks on the same element with multiple Indexes.


**CRITICAL RULE: You MUST FIRST CLICK on tabs labeled 'Schema', 'Request Schema', or 'Response Schema' to reveal their content.**
**NEVER call \`extract_structured_data\` on an API endpoint section IF a 'Schema' tab is visible but not active.**Your immediate next action must be to \`click\` the schema tab. Only after the schema content is visible can you proceed with extraction in a subsequent step. This is a mandatory prerequisite, not an optional step.
---

#### 5️⃣ Sections You Should Ignore To Expand
- Programming Language Sections, for example JavaScript, PHP...

---


#### 6️⃣ Ignore Those Items
- "API docs by Redocly" This is not an API endpoint.

---

#### 7️⃣ CRITICAL: Iterative Expansion Protocol for Schemas

**This is a mandatory protocol before any data extraction.**

- **Principle:** You are not finished exploring a request or response until ALL nested elements are fully visible. The presence of any expandable element means your view is incomplete.

- **Action Loop:**
  1. After revealing a primary section (e.g., by clicking a "200" status code or a "Request Body" tab), you MUST immediately scan its content for any further expandable elements.
  2. These elements are often buttons indicated by symbols like \`+\`, \`▼\`, \`▶\`, text labels like "expand", "show children", or HTML attributes like \`aria-expanded="false"\`. The case you encountered, \`[41]<button aria-label="expand product" />\`, is a perfect example.
  3. **If one or more such elements exist, your IMMEDIATE and ONLY \`next_goal\` is to \`click\` one of them.** Do not proceed to extraction.
  4. After the click, the page state will update. You must **repeat this scanning process (Step 1-3)** because expanding one object may reveal new, deeper nested expandable objects.
  5. Continue this click-and-scan loop until a scan of the current endpoint's section reveals **NO MORE** expandable elements.

- **Extraction Condition:** The action \`extract_api_document_structured_data\` may ONLY be called on an endpoint's section after you have confirmed that this Iterative Expansion Protocol is complete and the schema is in a fully expanded state.

---

</api_document_content_page_explore_guidelines>


## CRITICAL: API Document information Extraction Rules
<api_document_page_extraction_rules>
CRITICAL: API Document Information Extraction Rules

**extract_structured_data Query Guidelines for API Documentation:**

### For API Endpoint Page Content Extraction
1. When calling \`extract_structured_data\` for indivisual API documentation pages, you should bring below intent and combine it to the \`query\` with what endpoint (page) you think it needs to extract the current browser page(endpoint) you'r focusing on:
\`\`\`md
Extract raw api document content for "Get users" endpoint, including:
  1. HTTP method, path, baseApiUrl, endpoint description
  2. Request content type, query/path parameters, request headers, request body schema, including field descriptions, types, and required/optional properties.
  3. Detailed response schemas for each HTTP status code, including field descriptions, types, and required/optional properties.
\`\`\`
</api_document_page_extraction_rules>

`;

export class BrowserUseSSEAgent {
  private cancelled = false;
  private controller?: Controller;
  private sessionId?: string;

  constructor(sessionId?: string) {
    this.sessionId = sessionId;
  }

  async cancel(): Promise<void> {
    try {
      // Cancel any ongoing execution
      this.cancelled = true;

      // Cleanup controller if exists
      if (this.controller) {
        await this.controller.cleanup();
        this.controller = undefined;
      }
      // Session cleanup is now handled by BrowserUseService
    } catch (error) {
      console.warn('Error during cleanup:', error);
    }
  }

  /**
   * Execute agent with SSE event streaming (simplified)
   */
  async *executeWithSSE(userRequest: string, maxSteps: number = 100, sessionId?: string, sendEvent?: (event: BrowserUseEvent) => void): AsyncGenerator<BrowserUseEvent, void, unknown> {
    try {
      // Initialize controller
      this.controller = await createController({
        config: {
          llm: {
            provider: 'azure',
            model: 'gpt-5',
            azureEndpoint: 'https://oai-ai4m-rnd-eastus-001.openai.azure.com',
            azureDeployment: 'oai-ai4m-rnd-eastus-001-gpt-4-0125-Preview-001',
            apiVersion: '2025-03-01-preview',
            apiKey: process.env.AZURE_OPENAI_API_KEY,

            // provider: 'google',
            // model: 'gemini-2.5-flash',
            // baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
            // apiKey: process.env.GOOGLE_API_KEY,
            temperature: 0.1,
            frequencyPenalty: 0.2,
            timeout: 60000,
            maxTokens: 16384,
          },
          browser: {
            headless: process.env.HEADLESS === 'true' || false,
            browserType: 'chromium',
            viewport: { width: 1440, height: 1080 },
            timeout: 45000,
            args: [],
            viewportExpansion: 2000,
          },
          logging: {
            level: 'debug',
            console: true,
            json: false,
          },
          maxSteps: maxSteps,
        },
      });

      // Start execution event
      const startEvent: BrowserUseEvent = {
          type: 'execution_start',
          timestamp: new Date().toISOString(),
          session_id: sessionId || 'default',
          message: 'Agent execution started'
        };
      if (sendEvent) sendEvent(startEvent);

      // Enhanced agent config with SSE event handling
      const enhancedConfig: AgentConfig = {
        useVision: true,
        maxSteps: maxSteps,
        actionTimeout: 15000,
        continueOnFailure: true,
        customInstructions: customInstructions,
        saveConversationPath: `projects/${sessionId}/conversations`,
        fileSystemPath: `projects/${sessionId}`,
        onStepStart: this._createOnStepStartHandler(sessionId, sendEvent),
        onStepEnd: this._createOnStepEndHandler(sessionId, sendEvent)
      };

      const request = `
${userRequest}

# Important Rules:
- This is "multi-step" task, you need to create a detailed plan with "todo.md" file before you start the task. Reference the <todo_file_management> section for the format of the "todo.md" file.
- Dynamically update the "todo.md" file with the new steps you need to take.
- Ignore **deprecated** endpoints, or endpoint pages with "strikethrough" line. Skip those pages, endpoint pages with "deprecated" text. Indicate this in the todo.md file in your plan as "skipped" with \`[x]\` flag as default.
- Reference the <additional_todo_definition_rules> for the additional rules to organize tasks into logical phases for API document content extraction task.
- Follow the <additional_todo_management_rules> to explore/navigate the page content and extract the API document content.
- **Prioritize Interaction over Visibility**: Before checking for visible content, you MUST first inspect elements for clear interactive roles or attributes. If an element has a WAI-ARIA role like role='option', role='tab', role='radio', role='presentation', or a state attribute like aria-expanded='false', you must prioritize **clicking** it. This action is necessary to ensure the corresponding view is fully loaded and active. This rule **overrides** the general rule of extracting data just because some content appears to be visible.
- When you think content can be extracted and before calling extract_structured_data, if there are buttons like 200, 201, 400, 500 and so on, please click them first(Regardless of whether the information for 200, 201, 400, 500, etc., is already displayed, please use the history to determine this and make sure to click it once.). Then, consider if there is any "default" related information (if so, be sure to click the "default" element), and then call extract_structured_data.

<additional_todo_management_rules>
CRITICAL Rules to organize tasks into logical phases:
- Organize tasks into the following logical phases. The todo.md should be structured with headings that reflect these phases.
  - **Discovery**: The first phase for navigation, locating the relevant API documentation sections, and revealing all the endpoints.
  - **Enumeration**: The phase for listing all relevant items. Create a single, comprehensive checklist. List every individual endpoint you need to process as a **numbered** checkbox item (e.g., \`1. [ ] Endpoint Name\`).
  - **Extraction**: The execution phase. Work through the checklist created during the Enumeration phase. As soon as you have extracted data for an endpoint, mark its corresponding checkbox from \`[ ]\` to \`[x]\` in that same list.
  - **Verification**: The final phase. After all items in the checklist are marked as complete, confirm that all work has been done correctly.

**Example**
This is just an example of the file strucure, never copy this this as your todo.md content directly.
\`\`\`md
# Plan for extracting Tasks-related API documentation

## Goal
Extract all Tasks-related API endpoint documentation content from the HubSpot CRM API documentation.

## Steps

### Discovery
1. [x] Navigate to HubSpot CRM API documentation home page
2. [ ] Locate "Tasks" section
3. [ ] Expand to reveal all endpoints

### Enumeration
1. [x] Archive a batch of tasks by ID
2. [-] Create a batch of tasks
3. [ ] Create a task
4. [ ] Update a task by ID

### Extraction
1. [x] Archive a batch of tasks by ID
2. [-] Create a batch of tasks
3. [ ] Create a task
4. [ ] Update a task by ID

### Verification
1. [ ] Confirm all listed endpoints are extracted

## Result
- Navigation complete.
- Enumeration in progress.
\`\`\`

</additional_todo_management_rules>
`;

      // Execute agent
      const history = await this.controller.run(request, enhancedConfig);

      // Get final page info
      const browserContext = this.controller.getBrowserContext();
      const page = browserContext?.getActivePage();
      let finalPageInfo = null;

      if (page) {
        try {
          const title = await page.title();
          const url = page.url();
          finalPageInfo = { title, url };
        } catch (error) {
          console.warn('Failed to get final page info:', error);
        }
      }

      // Send completion event
      const completeEvent: BrowserUseEvent = {
        type: this.cancelled ? 'cancelled' : 'agent_complete',
        timestamp: new Date().toISOString(),
        session_id: sessionId || 'default',
        data: {
          stepsExecuted: history.length,
          finalPage: finalPageInfo
        },
        message: this.cancelled ? 'Agent execution cancelled' : 'Agent execution completed successfully'
      };
      if (sendEvent) sendEvent(completeEvent);
    } catch (error) {
      const errorEvent: BrowserUseEvent = {
        type: 'error',
        timestamp: new Date().toISOString(),
        session_id: sessionId || 'default',
        message: (error as Error).message,
        error: (error as Error).message
      };
      if (sendEvent) sendEvent(errorEvent);
    } finally {
      await this.cancel();
    }
  }

  /**
   * Create onStepStart handler
   */
  private _createOnStepStartHandler(sessionId?: string, sendEvent?: (event: BrowserUseEvent) => void) {
    return async (agent: Agent) => {
      try {
        // Get current page state from browser session
        const browserSession = (agent as any).browserSession;
        const context = browserSession?.getContext();
        const page = context?.pages().slice(-1)[0];
        const currentUrl = page ? page.url() : 'N/A';

        // Get agent state information
        const history = agent.getHistory();
        const stepNumber = agent.getCurrentStep();

        // Extract history data using safe method
        const historyData = this._extractSafeHistoryData(history);

        // Create step event data matching Python format
        const stepData = {
          step: stepNumber,
          url: currentUrl,
          ...historyData,
          timestamp: new Date().toISOString(),
        };

        const event: BrowserUseEvent = {
          type: 'step_start',
          message: `Starting step ${stepNumber}`,
          timestamp: new Date().toISOString(),
          session_id: sessionId || 'default',
          data: stepData
        };
        if (sendEvent) sendEvent(event);
      } catch (error) {
        console.error('Error in step start hook:', error);
        const errorEvent: BrowserUseEvent = {
          type: 'error',
          message: `Error in step start hook: ${error}`,
          timestamp: new Date().toISOString(),
          session_id: sessionId || 'default',
          error: String(error)
        };
        if (sendEvent) sendEvent(errorEvent);
      }
    };
  }

  /**
   * Create onStepEnd handler
   */
  private _createOnStepEndHandler(sessionId?: string, sendEvent?: (event: BrowserUseEvent) => void) {
    return async (agent: Agent) => {
      try {
        // Get current page state from browser session
        const browserSession = (agent as any).browserSession;
        const context = browserSession?.getContext();
        const page = context?.pages().slice(-1)[0];
        const currentUrl = page ? page.url() : 'N/A';

        // Get agent state information
        const history = agent.getHistory();
        const stepNumber = agent.getCurrentStep();

        // Extract history data using safe method
        const historyData = this._extractSafeHistoryData(history);

        // Create step completion event data matching Python format
        const stepData = {
          step: stepNumber,
          url: currentUrl,
          ...historyData,
          timestamp: new Date().toISOString(),
        };

        const event: BrowserUseEvent = {
          type: 'step_complete',
          message: `Completed step ${stepNumber}`,
          timestamp: new Date().toISOString(),
          session_id: sessionId || 'default',
          data: stepData
        };
        if (sendEvent) sendEvent(event);
      } catch (error) {
        console.error('Error in step end hook:', error);
        const errorEvent: BrowserUseEvent = {
          type: 'error',
          message: `Error in step end hook: ${error}`,
          timestamp: new Date().toISOString(),
          session_id: sessionId || 'default',
          error: String(error)
        };
        if (sendEvent) sendEvent(errorEvent);
      }
    };
  }

  /**
   * Safely extract data from browser_use history object.
   * Matches Python version's _extract_safe_history_data functionality.
   */
  private _extractSafeHistoryData(history: any[]): any {
    try {
      // Validate history object
      if (!history || !Array.isArray(history)) {
        console.warn('Invalid history object provided');
        return {
          model_thoughts: null,
          model_outputs: null,
          model_actions: null,
          extracted_content: null,
          urls: [],
        };
      }

      if (history.length === 0) {
        console.warn('Empty history object provided');
        return {
          model_thoughts: null,
          model_outputs: null,
          model_actions: null,
          extracted_content: null,
          urls: [],
        };
      }

      // Extract data from all history steps, similar to Python version
      const model_thoughts: string[] = [];
      const model_outputs: string[] = [];
      const model_actions: any[] = [];
      const extracted_contents: string[] = [];
      const urls: string[] = [];

      // Process each history step
      for (const step of history) {
        if (!step) continue;

        // Extract thoughts from various possible locations
        // Check result.metadata.thoughts, result.longTermMemory, or action reasoning
        const thoughts = step.result?.metadata?.thoughts ||
                        step.result?.longTermMemory ||
                        (typeof step.action === 'object' && step.action?.reasoning) ||
                        null;
        if (thoughts && typeof thoughts === 'string') {
          model_thoughts.push(thoughts);
        }

        // Extract model outputs (result messages)
        const output = step.result?.message;
        if (output && typeof output === 'string') {
          model_outputs.push(output);
        }

        // Extract actions
        if (step.action) {
          model_actions.push(step.action);
        }

        // Extract content
        const content = step.result?.extractedContent;
        if (content && typeof content === 'string') {
          extracted_contents.push(content);
        }

        // Extract URLs from page state
        const url = step.pageState?.url;
        if (url && typeof url === 'string') {
          urls.push(url);
        }
      }

      // Return the last item for most fields (matching Python behavior)
      // and all URLs
      return {
        model_thoughts: model_thoughts.length > 0 ? model_thoughts[model_thoughts.length - 1] : null,
        model_outputs: model_outputs.length > 0 ? model_outputs[model_outputs.length - 1] : null,
        model_actions: model_actions.length > 0 ? model_actions[model_actions.length - 1] : null,
        extracted_content: extracted_contents.length > 0 ? extracted_contents[extracted_contents.length - 1] : null,
        urls: Array.from(new Set(urls)), // Remove duplicates
      };
    } catch (error) {
      console.warn(`Failed to extract history data: ${error}`);
      return {
        model_thoughts: null,
        model_outputs: null,
        model_actions: null,
        extracted_content: null,
        urls: [],
      };
    }
  }

  /**
   * Get session status
   */
  getStatus(): any {
    return {
      sessionId: this.sessionId,
      cancelled: this.cancelled,
      isRunning: !!this.controller,
      timestamp: Date.now()
    };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const browserUseAgent = new BrowserUseSSEAgent();

  const timestamp = new Date().toISOString();
  const request = {
  hubspot: {
    url: 'https://developers.hubspot.com/docs/reference/api/crm/objects/tickets',
    text: `Extract the entire original API documentation content for the List Tickets API from this page: https://developers.hubspot.com/docs/reference/api/crm/objects/tickets. You must extract all available details required for OpenAPI Spec, including endpoints, HTTP methods, versioning, baseApiUrl, auth requirements, request parameters, request body schema, response codes, bodies, and error responses. Preserve exact wording from the source.`,
  },
  adyen: {
    url: 'https://docs.adyen.com/api-explorer/transfers/4/overview',
    text: `I would like to generate the spec for "Transfers" related API from Adyen https://docs.adyen.com/api-explorer/transfers/4/overview`,
  },
  jumpseller: {
    url: 'https://jumpseller.com/support/api/#tag/Products',
    text: `I would like to generate the spec for "Products" related API from Jumpseller website https://jumpseller.com/support/api/#tag/Products`,
  },
  zuho: {
    url: 'https://www.zoho.com/crm/developer/docs/api/v8/delete-tag.html',
    text: `Extract the entire original API documentation content for the 'Delete Tag' API from the page https://www.zoho.com/crm/developer/docs/api/v8/delete-tag.html. Extract all available details required for OpenAPI Spec generation, including endpoints, HTTP methods, versioning, baseApiUrl, auth requirements, request parameters, request body schema, response codes, bodies, and error responses. Preserve exact wording from the source.`,
  },
}[(process.env.API_NAME as string) ?? 'hubspot']!;

  const generator = browserUseAgent.executeWithSSE(request.text, 100, timestamp);
  // Consume the async generator
  (async () => {
    try {
      for await (const event of generator) {
        console.log('Event:', event);
      }
    } catch (error) {
      console.error('Error:', error);
    }
  })();
}
