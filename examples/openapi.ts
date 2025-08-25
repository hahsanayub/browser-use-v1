/* eslint-disable @typescript-eslint/no-unused-vars */
import 'dotenv/config';
import {
  ActionResult,
  Agent,
  BaseLLMClient,
  createController,
  type AgentConfig,
} from '../src/index';
import { withHealthCheck } from '../src/services/health-check';
import { z } from 'zod';
import { Page } from 'playwright';
import { BrowserSession } from '../src/browser';
import type { BrowserContext as AgentBrowserContext } from '../src/browser/BrowserContext';
import { action } from '../src/controller/decorators';

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

const timestamp = new Date().toISOString();

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

## IMPORTANT INTERACTION RULES:
- NEVER click on elements with "+", "-", "▼", "▲" symbols in "Response samples"/"Requeset samples" sections
- NEVER interact with any UI controls in sample/example sections
- Focus only on the main API documentation content
- Ignore all "Copy", "Expand", "Collapse" buttons in sample areas


## Detailed Info Discovery Instructions

#### 0️⃣ Close Overlay
Before extracting any content:
- Look for and close any overlays that may block access to the main content, such as:
  - Cookie consent banners
  - Cookie Policy prompts
  - Pop-up modals
  - Subscription prompts
  - Sign-in dialogs
  - Floating ads or tooltips
  - Full-screen overlays

Identify and click buttons or icons commonly used to dismiss these overlays, such as:
- “Accept”, “Close”, “X”, “No thanks”, “Got it”, or “Dismiss”
- Icons that look like X, × (close) or checkmarks

If the overlay cannot be closed or skipped, attempt to scroll or interact to bypass it.

Wait 1–2 seconds after each interaction to allow the interface to update.

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
  - “Request”, “Request Body“, "Request Payload", "Request Schema" or similar!
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
- You can Click "Show more", "Show children" to get more info visible.
- Look for headings or tabs labeled:
  - "Response", "Response Body“, "Response Schema" or similar.
- Scroll to the "Responses" section of the endpoint.
- If the elements are already expanded/visible, DO NOT click the element to collapse it.
- Be careful to avoid duplicate clicks on the same element with multiple Indexes.

---

#### 5️⃣ Sections You Should Ignore To Expand
- Programming Language Sections, for example JavaScript, PHP...

---


#### 6️⃣ Ignore Those Items
- "API docs by Redocly" This is not an API endpoint.

---

</api_document_content_page_explore_guidelines>


## CRITICAL: API Document information Extraction Rules
<api_document_page_extraction_rules>
CRITICAL: API Document Information Extraction Rules

**extract_api_document_structured_data Query Guidelines for API Documentation:**

### For API Endpoint Page Content Extraction
1. When calling \`extract_api_document_structured_data\` for indivisual API documentation pages, you should bring below intent and combine it to the \`query\` with what endpoint (page) you think it needs to extract to the current browser state page you'r focusing on:
\`\`\`
Extract raw api document content for "Get users" endpoint, including: HTTP method, path, baseApiUrl, endpoint description, parameters (name, type, required/optional, description), request content type, query parameters, request headers, request body schema, detailed response schemas for each HTTP status code, including field descriptions, types, and required/optional properties. Preserve exact formatting and content. Do not fabricate data for API endpoint path, parameter name, type etc. Do not miss response/request fields.
\`\`\`
**Important**: Do not fabricate data for API endpoint path, parameter name, type etc.
</api_document_page_extraction_rules>

`;

const userRequest = `
I would like to generate the spec for "Transfers" related API from Adyen https://docs.adyen.com/api-explorer/transfers/4/overview

# Important Rules:
- This is "multi-step" task, you need to create a detailed plan with "todo.md" file before you start the task. Reference the <todo_file_management> section for the format of the "todo.md" file.
- Dynamically update the "todo.md" file with the new steps you need to take.
- Reference the <additional_todo_definition_rules> for the additional rules to organize tasks into logical phases for API document content extraction task.
- Follow the <additional_todo_management_rules> to explore/navigate the page content and extract the API document content.
- **Prioritize Interaction over Visibility**: Before checking for visible content, you MUST first inspect elements for clear interactive roles or attributes. If an element has a WAI-ARIA role like role='option', role='tab', role='radio', or a state attribute like aria-expanded='false', you must prioritize **clicking** it. This action is necessary to ensure the corresponding view is fully loaded and active. This rule **overrides** the general rule of extracting data just because some content appears to be visible.
- When you think content can be extracted and before calling extract_structured_data, if there are elements like 200, 400, 500 and so on, please click them first(Regardless of whether the information for 200, 400, 500, etc., is already displayed, please use the history to determine this and make sure to click it once.). Then, consider if there is any "default" related information (if so, be sure to click the "default" element), and then call extract_structured_data.

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

async function main() {
  const controller = await createController({
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

        timeout: 60000,
        maxTokens: 16384,
      },
      browser: {
        headless: false,
        browserType: 'chromium',
        viewport: { width: 1440, height: 900 },
        timeout: 45000,
        args: [],
      },
      logging: {
        level: 'debug',
        console: true,
        json: false,
      },
      maxSteps: 60,
    },
  });

  try {
    await controller.goto(
      'https://docs.adyen.com/api-explorer/transfers/4/overview'
    );

    const agentConfig: AgentConfig = {
      useVision: true,
      maxSteps: 25,
      actionTimeout: 15000,
      continueOnFailure: true,
      customInstructions,
      saveConversationPath: `logs/${timestamp}/conversations`,
      fileSystemPath: `logs/${timestamp}`,
    };

    const history = await controller.run(userRequest, agentConfig);

    const browserContext = controller.getBrowserContext();
    const page = browserContext?.getActivePage();
    if (page) {
      const title = await page.title();
      const url = page.url();
      console.log(`Final page: ${title} (${url})`);
    }

    console.log(`Steps executed: ${history.length}`);
  } catch (error) {
    console.error('example failed:', error);
  } finally {
    await controller.cleanup();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
