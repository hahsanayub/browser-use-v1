/**
 * Smart OpenAPI Spec Extraction Agent (OAS-Agent)
 *
 * Based on browser-use framework, this agent extracts OpenAPI specifications from
 * interactive web documentation sites through a three-phase workflow:
 * 1. Reconnaissance & Planning: Scan and create todo.md
 * 2. Execution & Logging: Extract each endpoint to separate JSON files
 * 3. Synthesis & Delivery: Combine into final OpenAPI spec
 */

import 'dotenv/config';
import {
  ActionResult,
  Agent,
  BaseLLMClient,
  createController,
  registry,
  type AgentConfig,
} from '../src/index';
import { withHealthCheck } from '../src/services/health-check';
import { z } from 'zod';
import { Page } from 'playwright';
import { BrowserSession } from '../src/browser';
import type { BrowserContext as AgentBrowserContext } from '../src/browser/BrowserContext';
import { action } from '../src/controller/decorators';
import { FileSystem } from '../src/services/file-system';
import * as path from 'path';
import * as fs from 'fs/promises';

/**
 * Custom actions for OAS Agent - specialized for OpenAPI documentation extraction
 */
export class OASActions {
  @action(
    'find_contextual_interactive_elements',
    'Find all interactive elements (buttons, links, tabs, dropdowns) within a specific context/container. Returns structured list with text, type, and unique selectors.',
    z.object({
      context_selector: z
        .string()
        .describe('CSS selector for the parent container to search within'),
    }),
    { isAvailableForPage: (page) => page && !page.isClosed() }
  )
  static async findContextualInteractiveElements({
    params,
    page,
    context,
  }: {
    params: { context_selector: string };
    page: Page;
    context: {
      browserContext?: AgentBrowserContext;
      browserSession?: BrowserSession;
      llmClient?: BaseLLMClient;
      fileSystem?: FileSystem;
      agent: Agent;
    };
  }): Promise<ActionResult> {
    return withHealthCheck(page, async () => {
      try {
        // JavaScript to find interactive elements within context
        const result = await page.evaluate((contextSelector) => {
          const context = document.querySelector(contextSelector);
          if (!context) return [];

          const interactiveSelectors =
            'a, button, [role="button"], [role="tab"], select, input, [onclick], [tabindex]';
          const elements = Array.from(
            context.querySelectorAll(interactiveSelectors)
          );

          return elements
            .map((el, index) => {
              const text = (
                el.textContent ||
                el.placeholder ||
                el.value ||
                ''
              ).trim();
              const tagName = el.tagName.toLowerCase();
              const type = el.getAttribute('role') || tagName;

              // Generate unique selector
              let selector = tagName;
              if (el.id) selector += `#${el.id}`;
              if (el.className)
                selector += `.${el.className.split(' ').join('.')}`;

              // Add index-based selector as fallback
              const uniqueSelector = `${contextSelector} ${selector}:nth-of-type(${index + 1})`;

              return {
                text: text,
                type: type,
                selector: uniqueSelector,
                tag: tagName,
              };
            })
            .filter((item) => item.text.length > 0 && item.text.length < 100);
        }, params.context_selector);

        if (!result || result.length === 0) {
          return {
            success: true,
            message: `No interactive elements found within context: ${params.context_selector}`,
            attachments: [],
          };
        }

        const formatted = result
          .map(
            (item, i) =>
              `${i + 1}. ${item.type}: '${item.text}' -> ${item.selector}`
          )
          .join('\n');

        return {
          success: true,
          message: `Found interactive elements:\n${formatted}`,
          attachments: [],
        };
      } catch (error) {
        return {
          success: false,
          message: `Error finding contextual elements: ${error}`,
          error: 'CONTEXTUAL_ELEMENTS_ERROR',
        };
      }
    });
  }

  @action(
    'click_and_wait_for_reveal',
    'Click an element and wait for DOM changes, returning only the newly revealed content. Ideal for tabs, expandable sections, and dynamic content.',
    z.object({
      element_selector: z
        .string()
        .describe('CSS selector of the element to click'),
      wait_timeout: z
        .number()
        .default(3000)
        .describe('Timeout in milliseconds to wait for changes'),
    }),
    { isAvailableForPage: (page) => page && !page.isClosed() }
  )
  static async clickAndWaitForReveal({
    params,
    page,
    context,
  }: {
    params: { element_selector: string; wait_timeout: number };
    page: Page;
    context: {
      browserContext?: AgentBrowserContext;
      browserSession?: BrowserSession;
      llmClient?: BaseLLMClient;
      fileSystem?: FileSystem;
      agent: Agent;
    };
  }): Promise<ActionResult> {
    return withHealthCheck(page, async () => {
      try {
        // Get initial DOM state
        const initialHtml = await page.evaluate(
          'document.documentElement.outerHTML'
        );

        // Click the element
        await page.click(params.element_selector, {
          timeout: params.wait_timeout,
        });

        // Wait for potential DOM changes
        await page.waitForTimeout(1000);

        // Get updated DOM state
        const updatedHtml = await page.evaluate(
          'document.documentElement.outerHTML'
        );

        if (initialHtml === updatedHtml) {
          return {
            success: true,
            message: 'No visible changes detected after clicking',
            attachments: [],
          };
        }

        // Try to identify newly revealed content
        const revealedContent = await page.evaluate((elementSelector) => {
          const clickedElement = document.querySelector(elementSelector);
          if (!clickedElement) return '';

          // Look for content that might have been revealed
          const parent =
            clickedElement.closest(
              '[class*="tab"], [role="tabpanel"], .content, .panel, .section'
            ) || clickedElement.parentElement;
          if (!parent)
            return document.body.textContent?.substring(0, 2000) || '';

          // Get visible text content from the parent area
          const walker = document.createTreeWalker(
            parent,
            NodeFilter.SHOW_TEXT,
            {
              acceptNode: (node) => {
                const parent = node.parentElement;
                return parent && getComputedStyle(parent).display !== 'none'
                  ? NodeFilter.FILTER_ACCEPT
                  : NodeFilter.FILTER_REJECT;
              },
            }
          );

          let text = '';
          let node;
          while ((node = walker.nextNode())) {
            text += node.textContent + ' ';
          }

          return text.trim().substring(0, 2000);
        }, params.element_selector);

        const content =
          revealedContent || 'Content was revealed but text extraction failed';

        return {
          success: true,
          message: `Revealed content after clicking:\n${content}`,
          attachments: [],
        };
      } catch (error) {
        return {
          success: false,
          message: `Error clicking and waiting: ${error}`,
          error: 'CLICK_AND_WAIT_ERROR',
        };
      }
    });
  }

  @action(
    'recursive_expand_and_extract',
    'Recursively find and click all expandable elements with specific trigger text (like "Show more", "Expand") until no more can be found. Returns all collected content.',
    z.object({
      context_selector: z
        .string()
        .describe('CSS selector for the area to search within'),
      expand_trigger_text: z
        .string()
        .default('Show more')
        .describe('Text pattern to look for in expandable buttons'),
    }),
    { isAvailableForPage: (page) => page && !page.isClosed() }
  )
  static async recursiveExpandAndExtract({
    params,
    page,
    context,
  }: {
    params: { context_selector: string; expand_trigger_text: string };
    page: Page;
    context: {
      browserContext?: AgentBrowserContext;
      browserSession?: BrowserSession;
      llmClient?: BaseLLMClient;
      fileSystem?: FileSystem;
      agent: Agent;
    };
  }): Promise<ActionResult> {
    return withHealthCheck(page, async () => {
      try {
        const allContent: string[] = [];
        let attempts = 0;
        const maxAttempts = 10;

        while (attempts < maxAttempts) {
          // Look for expandable elements with trigger text
          const result = await page.evaluate(
            (contextSelector, triggerText) => {
              const context = document.querySelector(contextSelector);
              if (!context) return null;

              const expandButtons = Array.from(
                context.querySelectorAll('*')
              ).filter((el: any) => {
                const text = (el.textContent || '').trim().toLowerCase();
                const triggerLower = triggerText.toLowerCase();
                return (
                  text.includes(triggerLower) &&
                  (el.tagName.toLowerCase() === 'button' ||
                    el.hasAttribute('onclick') ||
                    el.hasAttribute('role')) &&
                  getComputedStyle(el).display !== 'none'
                );
              });

              if (expandButtons.length === 0) return null;

              // Click first expandable button
              const button = expandButtons[0] as HTMLElement;
              button.click();

              // Return selector for tracking
              return {
                clicked: true,
                selector:
                  button.tagName.toLowerCase() +
                  (button.id ? '#' + button.id : '') +
                  (button.className
                    ? '.' + button.className.split(' ').join('.')
                    : ''),
              };
            },
            params.context_selector,
            params.expand_trigger_text
          );

          if (!result || !result.clicked) {
            break;
          }

          // Wait for content to load
          await page.waitForTimeout(1000);

          // Extract content from the context
          const content = await page.evaluate((contextSelector) => {
            const context = document.querySelector(contextSelector);
            if (!context) return '';

            return context.textContent?.trim().substring(0, 1000) || '';
          }, params.context_selector);

          if (content && !allContent.includes(content)) {
            allContent.push(content);
          }

          attempts++;
        }

        if (allContent.length === 0) {
          return {
            success: true,
            message: `No expandable content found with trigger '${params.expand_trigger_text}'`,
            attachments: [],
          };
        }

        const combined = allContent
          .map((content, i) => `\n--- Level ${i + 1} ---\n${content}`)
          .join('\n');

        return {
          success: true,
          message: `Recursively expanded content (${allContent.length} levels):${combined}`,
          attachments: [],
        };
      } catch (error) {
        return {
          success: false,
          message: `Error in recursive expansion: ${error}`,
          error: 'RECURSIVE_EXPAND_ERROR',
        };
      }
    });
  }

  @action(
    'select_option_and_extract',
    'Select an option from a dropdown/select element and return the updated content that appears as a result of the selection.',
    z.object({
      select_selector: z
        .string()
        .describe('CSS selector for the select/dropdown element'),
      option_value: z
        .string()
        .describe('Value or text of the option to select'),
    }),
    { isAvailableForPage: (page) => page && !page.isClosed() }
  )
  static async selectOptionAndExtract({
    params,
    page,
    context,
  }: {
    params: { select_selector: string; option_value: string };
    page: Page;
    context: {
      browserContext?: AgentBrowserContext;
      browserSession?: BrowserSession;
      llmClient?: BaseLLMClient;
      fileSystem?: FileSystem;
      agent: Agent;
    };
  }): Promise<ActionResult> {
    return withHealthCheck(page, async () => {
      try {
        // Select the option
        const result = await page.evaluate(
          (selectSelector, optionValue) => {
            const select = document.querySelector(
              selectSelector
            ) as HTMLSelectElement;
            if (!select) return { error: 'Select element not found' };

            // Try to find option by value or text
            const options = Array.from(select.options || select.children);
            const targetOption = options.find(
              (opt: any) =>
                opt.value === optionValue ||
                opt.textContent?.trim() === optionValue
            ) as HTMLOptionElement;

            if (!targetOption) {
              return {
                error: 'Option not found',
                availableOptions: options.map(
                  (o: any) => o.textContent?.trim() || ''
                ),
              };
            }

            // Select the option
            if (select.tagName.toLowerCase() === 'select') {
              select.value = targetOption.value;
              select.dispatchEvent(new Event('change', { bubbles: true }));
            } else {
              targetOption.click();
            }

            return {
              success: true,
              selectedValue: targetOption.textContent?.trim() || '',
            };
          },
          params.select_selector,
          params.option_value
        );

        if ('error' in result) {
          return {
            success: false,
            message: `Selection failed: ${result.error}`,
            error: 'SELECT_OPTION_ERROR',
          };
        }

        // Wait for content to update
        await page.waitForTimeout(1000);

        // Extract updated content from surrounding area
        const updatedContent = await page.evaluate((selectSelector) => {
          const select = document.querySelector(selectSelector);
          if (!select) return '';

          // Look for content container near the select
          const container =
            select.closest(
              '[class*="content"], [class*="panel"], [class*="response"], .section'
            ) || select.parentElement;

          return container
            ? container.textContent?.trim().substring(0, 1500) || ''
            : '';
        }, params.select_selector);

        return {
          success: true,
          message: `Selected '${result.selectedValue}' from dropdown. Updated content:\n${updatedContent}`,
          attachments: [],
        };
      } catch (error) {
        return {
          success: false,
          message: `Error selecting option: ${error}`,
          error: 'SELECT_OPTION_ERROR',
        };
      }
    });
  }

  @action(
    'validate_openapi_spec',
    'Validate an OpenAPI v3 specification JSON string for compliance and correctness.',
    z.object({
      spec_json_string: z
        .string()
        .describe('JSON string of the OpenAPI specification to validate'),
    })
  )
  static async validateOpenAPISpec({
    params,
    context,
  }: {
    params: { spec_json_string: string };
    context: {
      browserContext?: AgentBrowserContext;
      browserSession?: BrowserSession;
      llmClient?: BaseLLMClient;
      fileSystem?: FileSystem;
      agent: Agent;
    };
  }): Promise<ActionResult> {
    try {
      // Basic JSON validation
      let specDict: any;
      try {
        specDict = JSON.parse(params.spec_json_string);
      } catch (e) {
        return {
          success: false,
          message: `Invalid JSON: ${e}`,
          error: 'INVALID_JSON',
        };
      }

      // Basic OpenAPI structure validation
      const requiredFields = ['openapi', 'info', 'paths'];
      const missingFields = requiredFields.filter(
        (field) => !(field in specDict)
      );

      if (missingFields.length > 0) {
        return {
          success: false,
          message: `Missing required OpenAPI fields: ${missingFields.join(', ')}`,
          error: 'MISSING_REQUIRED_FIELDS',
        };
      }

      // Validate OpenAPI version
      if (!specDict.openapi?.startsWith('3.')) {
        return {
          success: false,
          message: `Invalid OpenAPI version: ${specDict.openapi}. Expected 3.x`,
          error: 'INVALID_OPENAPI_VERSION',
        };
      }

      // Count paths and operations
      const pathsCount = Object.keys(specDict.paths || {}).length;
      const operationsCount = Object.values(specDict.paths || {}).reduce(
        (count, pathObj: any) => {
          if (typeof pathObj === 'object') {
            const httpMethods = [
              'get',
              'post',
              'put',
              'delete',
              'patch',
              'head',
              'options',
            ];
            return (
              count + httpMethods.filter((method) => method in pathObj).length
            );
          }
          return count;
        },
        0
      );

      return {
        success: true,
        message: `Valid OpenAPI 3.x specification with ${pathsCount} paths and ${operationsCount} operations`,
        attachments: [],
      };
    } catch (error) {
      return {
        success: false,
        message: `Validation error: ${error}`,
        error: 'VALIDATION_ERROR',
      };
    }
  }
}

/**
 * OpenAPI Spec Agent - Main class implementing the three-phase workflow
 */
export class OASAgent {
  private timestamp: string;
  private workDir: string;

  constructor() {
    this.timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.workDir = `logs/${this.timestamp}`;
  }

  private createSystemPrompt(
    phase: string,
    url: string,
    requirements: string
  ): string {
    const basePrompt = `# ROLE:
You are "OAS-Agent", a world-class automation engineer specializing in web data extraction. Your mission is to meticulously create a valid OpenAPI v3 specification JSON from the URL: ${url}

User requirements: ${requirements}

# CORE PROTOCOL:
You operate based on a three-phase plan managed via a \`todo.md\` file. Your actions must be disciplined, methodical, and focused. Do not attempt to complete the entire task in one go. Follow the plan.

# AVAILABLE CUSTOM TOOLS:
- find_contextual_interactive_elements: Find interactive elements within a context
- click_and_wait_for_reveal: Click element and capture newly revealed content
- recursive_expand_and_extract: Recursively expand nested content
- select_option_and_extract: Select dropdown option and extract result
- validate_openapi_spec: Validate OpenAPI specification JSON

Note: Use built-in write_file and read_file actions for file operations.
`;

    if (phase === 'planning') {
      return (
        basePrompt +
        `
# PHASE 1: RECONNAISSANCE & PLANNING (CURRENT PHASE)
1. Your ONLY goal right now is to create a \`todo.md\` file.
2. Navigate to the URL and analyze the page structure.
3. Identify all top-level API endpoint entries (e.g., "GET /users", "POST /products").
4. Create a comprehensive \`todo.md\` file listing all endpoints as checkboxes, followed by synthesis steps.
5. Once \`todo.md\` is created, Phase 1 is complete. STOP HERE.

Focus ONLY on reconnaissance and planning. Do NOT extract detailed endpoint information yet.
`
      );
    } else if (phase === 'execution') {
      return (
        basePrompt +
        `
# PHASE 2: EXECUTION & LOGGING (CURRENT PHASE)
1. Read the \`todo.md\` file to see your tasks.
2. For each incomplete endpoint task (e.g., "- [ ] Extract details for GET /pet/{petId}"):
   a. **ISOLATE CONTEXT:** Focus exclusively on this one endpoint.
   b. **MAP THE SCENE:** Use \`find_contextual_interactive_elements\` to map interactive elements.
   c. **SYSTEMATIC INTERROGATION:** Use custom actions to collect all data fragments:
      - Parameters, request body, response schemas, examples
      - Click tabs, select dropdown options, expand sections
   d. **SAVE EVIDENCE:** Assemble into complete JSON and save to temp file (e.g., \`get_pet_petid.json\`)
   e. **UPDATE PLAN:** Update \`todo.md\` to mark task as \`[x]\` complete.
3. If an endpoint fails, mark it as \`[!] FAILED\` and continue.
4. Work through ALL endpoint tasks systematically.

Focus ONLY on extracting endpoint details. Do NOT synthesize the final spec yet.
`
      );
    } else {
      // synthesis
      return (
        basePrompt +
        `
# PHASE 3: SYNTHESIS & DELIVERY (CURRENT PHASE)
1. Read all temporary \`.json\` endpoint files.
2. Combine them into a single, complete OpenAPI v3 specification.
3. Apply the user's filtering requirements to the complete spec.
4. Use \`validate_openapi_spec\` to verify the final JSON.
5. Output the final, validated OpenAPI specification.
6. Clean up temporary files.

Focus ONLY on synthesis and delivery of the final result.
`
      );
    }
  }

  async extractOpenAPISpec(
    url: string,
    requirements: string = ''
  ): Promise<any> {
    console.log(`Starting OpenAPI extraction from ${url}`);
    console.log(`Requirements: ${requirements}`);

    try {
      // Phase 1: Planning
      console.log('=== PHASE 1: RECONNAISSANCE & PLANNING ===');
      await this.phase1Planning(url, requirements);

      // Phase 2: Execution
      console.log('=== PHASE 2: EXECUTION & LOGGING ===');
      await this.phase2Execution(url, requirements);

      // Phase 3: Synthesis
      console.log('=== PHASE 3: SYNTHESIS & DELIVERY ===');
      return await this.phase3Synthesis(url, requirements);
    } catch (error) {
      console.error('Error in extract_openapi_spec:', error);

      // Save error summary
      const errorSummary = {
        url,
        requirements,
        timestamp: this.timestamp,
        error: String(error),
        success: false,
      };

      try {
        await fs.mkdir(path.dirname(`${this.workDir}/error_summary.json`), {
          recursive: true,
        });
        await fs.writeFile(
          `${this.workDir}/error_summary.json`,
          JSON.stringify(errorSummary, null, 2)
        );
      } catch (writeError) {
        // Don't fail on error logging
      }

      throw error;
    }
  }

  private async phase1Planning(
    url: string,
    requirements: string
  ): Promise<void> {
    const controller = await createController({
      config: {
        llm: {
          // provider: 'google',
          // model: 'gemini-2.0-flash-exp',
          // baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
          // apiKey: process.env.GOOGLE_API_KEY,

          provider: 'azure',
          model: 'gpt-5',
          azureEndpoint: 'https://oai-ai4m-rnd-eastus-001.openai.azure.com',
          azureDeployment: 'oai-ai4m-rnd-eastus-001-gpt-4-0125-Preview-001',
          apiVersion: '2025-03-01-preview',
          apiKey: process.env.AZURE_OPENAI_API_KEY,

          timeout: 60000,
          maxTokens: 16384,
        },
        browser: {
          headless: true,
          browserType: 'chromium',
          viewport: { width: 1440, height: 900 },
          timeout: 45000,
        },
        logging: {
          level: 'info',
          console: true,
          json: false,
        },
        maxSteps: 60,
      },
    });

    // Register custom actions
    registry.register(OASActions);

    try {
      await controller.goto(url);

      const agentConfig: AgentConfig = {
        useVision: true,
        maxSteps: 20,
        actionTimeout: 15000,
        continueOnFailure: true,
        customInstructions: this.createSystemPrompt(
          'planning',
          url,
          requirements
        ),
        saveConversationPath: `${this.workDir}/phase1_conversations`,
        fileSystemPath: this.workDir,
      };

      const history = await controller.run(
        `Navigate to ${url} and create a comprehensive todo.md plan for extracting OpenAPI endpoints. Requirements: ${requirements}`,
        agentConfig
      );

      // Save phase results
      const phase1Summary = {
        phase: 'planning',
        url,
        requirements,
        steps_executed: history.length,
        timestamp: this.timestamp,
        success: true,
      };

      await fs.mkdir(this.workDir, { recursive: true });
      await fs.writeFile(
        `${this.workDir}/phase1_summary.json`,
        JSON.stringify(phase1Summary, null, 2)
      );

      console.log('Phase 1 complete: todo.md created');
    } finally {
      await controller.cleanup();
    }
  }

  private async phase2Execution(
    url: string,
    requirements: string
  ): Promise<void> {
    const controller = await createController({
      config: {
        llm: {
          // provider: 'google',
          // model: 'gemini-2.0-flash-exp',
          // baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
          // apiKey: process.env.GOOGLE_API_KEY,

          provider: 'azure',
          model: 'gpt-5',
          azureEndpoint: 'https://oai-ai4m-rnd-eastus-001.openai.azure.com',
          azureDeployment: 'oai-ai4m-rnd-eastus-001-gpt-4-0125-Preview-001',
          apiVersion: '2025-03-01-preview',
          apiKey: process.env.AZURE_OPENAI_API_KEY,

          timeout: 60000,
          maxTokens: 16384,
        },
        browser: {
          headless: true,
          browserType: 'chromium',
          viewport: { width: 1440, height: 900 },
          timeout: 45000,
        },
        logging: {
          level: 'info',
          console: true,
          json: false,
        },
        maxSteps: 60,
      },
    });

    // Register custom actions
    registry.register(OASActions);

    try {
      await controller.goto(url);

      const agentConfig: AgentConfig = {
        useVision: true,
        maxSteps: 50,
        actionTimeout: 15000,
        continueOnFailure: true,
        customInstructions: this.createSystemPrompt(
          'execution',
          url,
          requirements
        ),
        saveConversationPath: `${this.workDir}/phase2_conversations`,
        fileSystemPath: this.workDir,
      };

      const history = await controller.run(
        `Execute the todo.md plan to extract detailed information for each API endpoint from ${url}. Work systematically through each endpoint task.`,
        agentConfig
      );

      // Save phase results
      const phase2Summary = {
        phase: 'execution',
        url,
        requirements,
        steps_executed: history.length,
        timestamp: this.timestamp,
        success: true,
      };

      await fs.writeFile(
        `${this.workDir}/phase2_summary.json`,
        JSON.stringify(phase2Summary, null, 2)
      );

      console.log('Phase 2 complete: endpoint extraction finished');
    } finally {
      await controller.cleanup();
    }
  }

  private async phase3Synthesis(
    url: string,
    requirements: string
  ): Promise<any> {
    const controller = await createController({
      config: {
        llm: {
          // provider: 'google',
          // model: 'gemini-2.0-flash-exp',
          // baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
          // apiKey: process.env.GOOGLE_API_KEY,

          provider: 'azure',
          model: 'gpt-5',
          azureEndpoint: 'https://oai-ai4m-rnd-eastus-001.openai.azure.com',
          azureDeployment: 'oai-ai4m-rnd-eastus-001-gpt-4-0125-Preview-001',
          apiVersion: '2025-03-01-preview',
          apiKey: process.env.AZURE_OPENAI_API_KEY,

          timeout: 60000,
          maxTokens: 16384,
        },
        logging: {
          level: 'info',
          console: true,
          json: false,
        },
        maxSteps: 30,
      },
    });

    // Register custom actions
    registry.register(OASActions);

    try {
      const agentConfig: AgentConfig = {
        useVision: false, // No vision needed for synthesis
        maxSteps: 20,
        actionTimeout: 15000,
        continueOnFailure: true,
        customInstructions: this.createSystemPrompt(
          'synthesis',
          url,
          requirements
        ),
        saveConversationPath: `${this.workDir}/phase3_conversations`,
        fileSystemPath: this.workDir,
      };

      const history = await controller.run(
        `Read all extracted endpoint JSON files and synthesize them into a complete OpenAPI v3 specification. Apply filtering: ${requirements}`,
        agentConfig
      );

      // Try to find and return the generated OpenAPI spec
      let spec = null;
      try {
        const files = await fs.readdir(this.workDir);
        const openApiFiles = files.filter(
          (f) =>
            (f.toLowerCase().includes('openapi') ||
              f.toLowerCase().includes('spec')) &&
            f.endsWith('.json')
        );

        if (openApiFiles.length > 0) {
          const content = await fs.readFile(
            path.join(this.workDir, openApiFiles[0]),
            'utf-8'
          );
          spec = JSON.parse(content);
          console.log(
            `Phase 3 complete: OpenAPI spec generated in ${openApiFiles[0]}`
          );
        } else {
          // If no file was generated, create empty spec
          console.warn('No OpenAPI spec file found, returning empty spec');
          spec = {
            openapi: '3.0.3',
            info: { title: 'Extracted API', version: '1.0.0' },
            paths: {},
          };
        }
      } catch (error) {
        console.warn('Error reading generated spec file:', error);
        spec = {
          openapi: '3.0.3',
          info: { title: 'Extracted API', version: '1.0.0' },
          paths: {},
        };
      }

      // Save phase results
      const phase3Summary = {
        phase: 'synthesis',
        url,
        requirements,
        steps_executed: history.length,
        timestamp: this.timestamp,
        success: true,
        paths_extracted: Object.keys(spec?.paths || {}).length,
      };

      await fs.writeFile(
        `${this.workDir}/phase3_summary.json`,
        JSON.stringify(phase3Summary, null, 2)
      );

      // Save final OpenAPI spec to logs directory
      if (spec) {
        await fs.writeFile(
          `${this.workDir}/final_openapi_spec.json`,
          JSON.stringify(spec, null, 2)
        );
        console.log(
          `Final OpenAPI spec saved to: ${this.workDir}/final_openapi_spec.json`
        );
      }

      return spec;
    } finally {
      await controller.cleanup();
    }
  }
}

async function main() {
  // HubSpot Contacts API extraction example
  const url =
    'https://developers.hubspot.com/docs/api-reference/crm-contacts-v3/basic/get-crm-v3-objects-contacts';
  const requirements =
    "Retrieve contacts 'GET /crm/v3/objects/contacts' OpenAPI spec for extracting https://developers.hubspot.com/docs/api-reference/crm-contacts-v3/basic/get-crm-v3-objects-contacts";

  console.log('=== HubSpot Contacts API Extraction ===');
  console.log(`URL: ${url}`);
  console.log(`Requirements: ${requirements}`);
  console.log();

  try {
    // Initialize agent
    const agent = new OASAgent();
    console.log('✓ Successfully initialized OAS Agent with Google model');

    // Extract OpenAPI specification
    console.log('Starting extraction process...');
    const spec = await agent.extractOpenAPISpec(url, requirements);

    // Save result
    const outputFile = 'hubspot_contacts_openapi_spec.json';
    await fs.writeFile(outputFile, JSON.stringify(spec, null, 2));

    // Count operations
    let operationsCount = 0;
    if (spec?.paths) {
      operationsCount = Object.values(spec.paths).reduce(
        (count, pathObj: any) => {
          if (typeof pathObj === 'object') {
            const httpMethods = [
              'get',
              'post',
              'put',
              'delete',
              'patch',
              'head',
              'options',
            ];
            return (
              count + httpMethods.filter((method) => method in pathObj).length
            );
          }
          return count;
        },
        0
      );
    }

    // Save results summary
    const resultsSummary = {
      api_name: 'hubspot_contacts',
      target_url: url,
      execution_time: agent['timestamp'], // Access private property
      paths_extracted: Object.keys(spec?.paths || {}).length,
      operations_count: operationsCount,
      success: true,
      output_file: outputFile,
      logs_directory: agent['workDir'], // Access private property
    };

    const resultsFile = `${agent['workDir']}/final_results_summary.json`;
    await fs.writeFile(resultsFile, JSON.stringify(resultsSummary, null, 2));

    console.log('\n=== EXTRACTION COMPLETE ===');
    console.log(`OpenAPI specification saved to: ${outputFile}`);
    console.log(`Results summary saved to: ${resultsFile}`);
    console.log(`Logs directory: ${agent['workDir']}`);
    console.log(`Paths extracted: ${Object.keys(spec?.paths || {}).length}`);
    console.log(`Total operations: ${operationsCount}`);

    // Print first few paths as preview
    if (spec?.paths) {
      console.log('\nExtracted paths preview:');
      const pathEntries = Object.entries(spec.paths);
      for (let i = 0; i < Math.min(3, pathEntries.length); i++) {
        const [path, methods] = pathEntries[i];
        const methodsList =
          typeof methods === 'object' ? Object.keys(methods) : ['N/A'];
        console.log(`  ${path}: ${methodsList.join(', ')}`);
      }
      if (pathEntries.length > 3) {
        console.log(`  ... and ${pathEntries.length - 3} more paths`);
      }
    }
  } catch (error) {
    console.error('Extraction failed:', error);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
