import 'dotenv/config';
import { createController, type AgentConfig } from '../src';

const timestamp = new Date().toISOString();

const customInstructions = `
You are controlling a browser to extract complete information from an API documentation page that may require scrolling to reveal all content.

## Workflow Guideline You Must Apply to Browse the page to Extract API document content
1. Do not start browsing and extracting page content in a group section menu scope, always click the endpoint mene item. If the navigation section has many endpoints, open them by clicking one by one.
2. If the page doesn't look like an "API-endpoint" document page, for example the page just tells the end-point usage, api versions, rate-limit info, general authorzation-info of the API service, you can just extract the page content's summary content with a query like: "Extract summary info".
3. You must memorize clearly what elements have been expanded, do not repeat to click them again.
4. Your goal is to explore the every single endpoint page, you should be able to distinglish if the page is a category section, or an endpoint detailed page. Click its sub nav items to enter the endpoint page, instead of doing extraction for the entire section.
5. Folllow the **Detailed Info Discovery Instructions** below to browse the page to identify and discover API Spec content.

## IMPORTANT INTERACTION RULES:
- NEVER click on elements with "+", "-", "▼", "▲" symbols in "Response samples"/"Requeset samples" sections
- NEVER interact with any UI controls in sample/example sections
- Focus only on the main API documentation content
- Ignore all "Copy", "Expand", "Collapse" buttons in sample areas
- Do not click on any elements that are part of response examples or code samples

## Detailed Info Discovery Instructions

#### 1️⃣ Handle Page Navigating and Scrolling
- Do not mess up contents when page scrolling, you must extractly know what page you're exploring, and strictly recognize and remember the boundary when page is scrolling, here is same guides:
  - Anchor the current page by the location url, if the location url changed after scrolling, meaning the page is changed, you should scrolling back.
  - When scrolling, if more content is displaying, you must learn the context, if the content is not relative to the API content under the current page url, you should not extract or do interactive actions with that.
- You must always keep the focus on the content extraction on the current page you're working on, you should memory the page link you're working on, if the page scrolling has changed the navigation menu which can leads to the current page inditication changed, you must scrolling down or up back to it.
- You can only change the navigation menu focused item, until the page content is extracted to meet the goal of the step.
- If the navigation menu bar(panel) is too long, you should scroll that container to get more content visible.
---

#### 2️⃣ Discover Each Endpoint
For each visible API endpoint (e.g., GET "/products", POST "/users"):
- Click its title or section to ensure details are visible.
- Wait for content to load before proceeding.

---

#### 3️⃣ Discover **Request** Definitions
Within each endpoint section:
- Do not consider/explore "example" as the request body type
- You must firstly locate and click the elements under section where its field has description info to extract content, then check other example/samples area.
- Look for headings or tabs labeled:
  - “Request”, “Request Body“, "Request Payload", "Request Schema" or similar!
- Identify all clickable elements, for example item with arrow indicator symbols like: ▼, +, or arrow indicators!
- Keep expand until all Request Type/Properties and their sub types, untile all nested fields info (no any array, object type or elements display) are visible!
- **Important** If the elements are already expanded/visible, DO NOT click the element to collapse it.
- Avoid duplicate clicks on already active tabs.

---

#### 4️⃣ Discover **Response** Definitions
- Do not consider/explore "example" as the response body type
- If you see "200" string and its parent node has "role='option'", "role='tab'", "role='radio'", please click it first.
- Always put to your thinking that: "Under labels like "Responses", there would have Request Schema definition, you must firstly interact those elements under there"!
- You must always locate and click the elements under section where the fields have description info.
- If there are elements with label like below pattern examples, you must firstly click them just once to show the Response Schema Definition entries.
   - 200
   - 200 OK
   - 200 Account is accepted
   - 400 Not found
   - 500 Server error etc.
- Look for headings or tabs labeled:
  - "Response", "Response Body“, "Response Schema" or similar.
- Scroll to the "Responses" section of the endpoint.
- If the elements are already expanded/visible, DO NOT click the element to collapse it.
- Be careful to avoid duplicate clicks on the same element with multiple Indexes.
-

---

#### 5️⃣ Sections You Should Ignore To Expand
- Programming Language Sections, for example JavaScript, PHP...

---


#### 6️⃣ Track processed page/navigation items
- **IMPORTANT** You must record what navigation items you have processed in the TODO.md, DO NOT repeat navigating/extracting content to the same page already processed!

---


#### 7️⃣ Ignore Those Items
- "API docs by Redocly" This is not an API endpoint.

---
`;

const userRequest = `
Extract detailed API documentation content for the 'Tickets' API from 'https://developers.hubspot.com/docs/reference/api/crm/objects/tickets'
`;

async function main() {
  const controller = await createController({
    config: {
      llm: {
        provider: 'azure',
        model: 'gpt-4.1',
        azureEndpoint: 'https://oai-ai4m-rnd-eastus-001.openai.azure.com',
        azureDeployment: 'oai-ai4m-rnd-eastus-001-gpt-4-0125-Preview-001',
        apiVersion: '2025-03-01-preview',
        apiKey: process.env.AZURE_OPENAI_API_KEY,

        // provider: 'google',
        // model: 'gemini-2.5-flash',
        // baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        // apiKey: process.env.GOOGLE_API_KEY,

        timeout: 60000,
        maxTokens: 1024 * 1024,
        temperature: 0.7,
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
      'https://developers.hubspot.com/docs/reference/api/crm/objects/tickets'
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
