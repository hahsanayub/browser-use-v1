/**
 * MCP Server for browser-use - exposes browser automation capabilities via Model Context Protocol.
 *
 * This server provides tools for:
 * - Running autonomous browser tasks with an AI agent
 * - Direct browser control (navigation, clicking, typing, etc.)
 * - Content extraction from web pages
 * - File system operations
 *
 * Usage:
 *     npx browser-use --mcp
 *
 * Or as an MCP server in Claude Desktop or other MCP clients:
 *     {
 *         "mcpServers": {
 *             "browser-use": {
 *                 "command": "npx",
 *                 "args": ["browser-use", "--mcp"],
 *                 "env": {
 *                     "OPENAI_API_KEY": "sk-proj-1234567890"
 *                 }
 *             }
 *         }
 *     }
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    ListPromptsRequestSchema,
    GetPromptRequestSchema,
    type Tool,
    type Prompt,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { createLogger } from '../logging-config.js';
import type { Controller } from '../controller/service.js';
import { Controller as DefaultController } from '../controller/service.js';
import { BrowserSession } from '../browser/session.js';
import { productTelemetry } from '../telemetry/service.js';
import { MCPServerTelemetryEvent } from '../telemetry/views.js';
import { get_browser_use_version } from '../utils.js';

// Redirect console logs to stderr to prevent JSON-RPC interference
const originalLog = console.log;
const originalInfo = console.info;
const originalWarn = console.warn;
const originalError = console.error;

console.log = (...args: any[]) => console.error(...args);
console.info = (...args: any[]) => console.error(...args);
console.warn = (...args: any[]) => console.error(...args);

const logger = createLogger('browser_use.mcp.server');

export interface MCPPromptTemplate {
    name: string;
    description: string;
    arguments?: Array<{
        name: string;
        description?: string;
        required?: boolean;
    }>;
    template: (args: Record<string, string>) => string;
}

export class MCPServer {
    private server: Server;
    private tools: Record<string, any> = {};
    private prompts: Map<string, MCPPromptTemplate> = new Map();
    private browserSession: BrowserSession | null = null;
    private controller: Controller<any> | null = null;
    private startTime: number;
    private isRunning = false;
    private toolExecutionCount = 0;
    private errorCount = 0;
    private abortController: AbortController | null = null;

    constructor(name: string, version: string) {
        this.server = new Server(
            {
                name,
                version,
            },
            {
                capabilities: {
                    tools: {},
                    prompts: {},
                },
            }
        );

        this.startTime = Date.now() / 1000;
        this.setupHandlers();
        this.registerDefaultPrompts();
    }

    private setupHandlers() {
        // List available tools
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            return {
                tools: Object.entries(this.tools).map(([name, tool]) => ({
                    name,
                    description: tool.description,
                    inputSchema: tool.inputSchema,
                })),
            };
        });

        // Execute tool
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const startTime = Date.now() / 1000;
            let errorMsg: string | null = null;

            try {
                const tool = this.tools[request.params.name];
                if (!tool) {
                    throw new Error(`Tool not found: ${request.params.name}`);
                }

                logger.debug(`Executing tool: ${request.params.name}`);
                this.toolExecutionCount++;
                const result = await tool.handler(request.params.arguments || {});

                return {
                    content: [
                        {
                            type: 'text',
                            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
                        },
                    ],
                };
            } catch (error) {
                this.errorCount++;
                errorMsg = error instanceof Error ? error.message : String(error);
                logger.error(`Tool execution failed: ${errorMsg}`);
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Error: ${errorMsg}`,
                        },
                    ],
                    isError: true,
                };
            } finally {
                // Capture telemetry for tool calls
                const duration = Date.now() / 1000 - startTime;
                productTelemetry.capture(
                    new MCPServerTelemetryEvent({
                        version: get_browser_use_version(),
                        action: 'tool_call',
                        tool_name: request.params.name,
                        duration_seconds: duration,
                        error_message: errorMsg,
                    })
                );
            }
        });

        // List available prompts
        this.server.setRequestHandler(ListPromptsRequestSchema, async () => {
            return {
                prompts: Array.from(this.prompts.values()).map((prompt) => ({
                    name: prompt.name,
                    description: prompt.description,
                    arguments: prompt.arguments,
                })),
            };
        });

        // Get prompt with arguments
        this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
            const prompt = this.prompts.get(request.params.name);
            if (!prompt) {
                throw new Error(`Prompt not found: ${request.params.name}`);
            }

            const args = request.params.arguments || {};
            const message = prompt.template(args);

            return {
                messages: [
                    {
                        role: 'user',
                        content: {
                            type: 'text',
                            text: message,
                        },
                    },
                ],
            };
        });
    }

    /**
     * Register default prompts for common browser automation tasks
     */
    private registerDefaultPrompts() {
        // Scrape data prompt
        this.registerPrompt({
            name: 'scrape_data',
            description: 'Extract structured data from a website',
            arguments: [
                { name: 'url', description: 'URL to scrape', required: true },
                { name: 'data_type', description: 'Type of data to extract', required: true },
            ],
            template: (args) => `Use browser_navigate to go to ${args.url}, then use browser_extract_content to extract ${args.data_type}. If the page requires interaction, use browser_get_state to find elements and browser_click/browser_type as needed.`,
        });

        // Fill form prompt
        this.registerPrompt({
            name: 'fill_form',
            description: 'Fill out and submit a web form',
            arguments: [
                { name: 'url', description: 'URL of the form', required: true },
                { name: 'field_data', description: 'JSON object with field values', required: true },
            ],
            template: (args) => `Navigate to ${args.url}, use browser_get_state to identify form fields, then use browser_type to fill in: ${args.field_data}. Finally, click the submit button.`,
        });

        // Multi-step task prompt
        this.registerPrompt({
            name: 'multi_step_task',
            description: 'Execute a complex multi-step task',
            arguments: [
                { name: 'task_description', description: 'Detailed description of the task', required: true },
                { name: 'max_steps', description: 'Maximum number of steps (default: 100)', required: false },
            ],
            template: (args) => `Use retry_with_browser_use_agent with task: '${args.task_description}'. Set max_steps=${args.max_steps || '100'} and use_vision=true for better understanding.`,
        });

        // Research topic prompt
        this.registerPrompt({
            name: 'research_topic',
            description: 'Research a topic across multiple websites',
            arguments: [
                { name: 'topic', description: 'Topic to research', required: true },
                { name: 'sites', description: 'Comma-separated list of websites', required: true },
            ],
            template: (args) => `Open multiple tabs using browser_navigate with new_tab=true for sites: ${args.sites}. Use browser_extract_content on each to gather information about ${args.topic}. Switch between tabs with browser_switch_tab.`,
        });
    }

    /**
     * Register a tool with the MCP server
     */
    public registerTool(
        name: string,
        description: string,
        inputSchema: z.ZodType | Record<string, any>,
        handler: (args: any) => Promise<any>
    ) {
        this.tools[name] = {
            description,
            inputSchema: inputSchema instanceof z.ZodType ? zodToJsonSchema(inputSchema) : inputSchema,
            handler,
        };
        logger.debug(`Registered tool: ${name}`);
    }

    /**
     * Register all Controller actions as MCP tools
     */
    public async registerControllerActions(controller: Controller<any>): Promise<void> {
        this.controller = controller;

        // Get all registered actions from the controller
        const actions = controller.registry.get_all_actions();

        for (const [actionName, actionInfo] of Object.entries(actions)) {
            // Create a wrapper for the action
            const handler = async (args: any) => {
                if (!this.browserSession) {
                    throw new Error('Browser session not initialized');
                }

                // Execute the action through the controller
                const result = await (controller.registry as any).execute_action(
                    actionName,
                    args,
                    {
                        browser_session: this.browserSession,
                        context: undefined,
                    }
                );

                return result;
            };

            // Register the action as a tool
            this.registerTool(
                actionName,
                (actionInfo as any).description || `Execute ${actionName} action`,
                {},
                handler
            );
        }

        logger.info(`✅ Registered ${Object.keys(actions).length} controller actions as MCP tools`);
    }

    /**
     * Initialize the browser session
     */
    public async initBrowserSession(browserSession: BrowserSession): Promise<void> {
        this.browserSession = browserSession;
        await this.browserSession.start();
        logger.info('Browser session initialized');
    }

    /**
     * Start the MCP server
     */
    public async start() {
        if (this.isRunning) {
            logger.warning('MCP Server is already running');
            return;
        }

        // Capture telemetry for server start
        productTelemetry.capture(
            new MCPServerTelemetryEvent({
                version: get_browser_use_version(),
                action: 'start',
            })
        );

        try {
            const transport = new StdioServerTransport();
            await this.server.connect(transport);
            this.isRunning = true;
            logger.info(`🔌 MCP Server started (${this.getToolCount()} tools, ${this.getPromptCount()} prompts registered)`);
        } catch (error) {
            this.isRunning = false;
            logger.error(`Failed to start MCP server: ${error}`);
            throw error;
        }
    }

    /**
     * Stop the MCP server and cleanup resources
     */
    public async stop(): Promise<void> {
        if (!this.isRunning) {
            logger.warning('MCP Server is not running');
            return;
        }

        try {
            this.isRunning = false;

            // Cancel any pending operations
            if (this.abortController) {
                this.abortController.abort();
                this.abortController = null;
            }

            // Close browser session if active
            if (this.browserSession) {
                await this.browserSession.stop();
                this.browserSession = null;
                logger.info('Browser session closed');
            }

            // Capture telemetry for server stop
            const duration = Date.now() / 1000 - this.startTime;
            productTelemetry.capture(
                new MCPServerTelemetryEvent({
                    version: get_browser_use_version(),
                    action: 'stop',
                    duration_seconds: duration,
                })
            );
            productTelemetry.flush();

            const stats = this.getStats();
            logger.info(`🔌 MCP Server stopped (uptime: ${Math.floor(stats.uptime)}s, executions: ${stats.executionCount}, success rate: ${(stats.successRate * 100).toFixed(1)}%)`);
        } catch (error) {
            logger.error(`Error stopping MCP server: ${error}`);
        }
    }

    /**
     * Register a prompt template
     */
    public registerPrompt(prompt: MCPPromptTemplate): void {
        this.prompts.set(prompt.name, prompt);
        logger.debug(`Registered prompt: ${prompt.name}`);
    }

    /**
     * Get the number of registered tools
     */
    public getToolCount(): number {
        return Object.keys(this.tools).length;
    }

    /**
     * Get the number of registered prompts
     */
    public getPromptCount(): number {
        return this.prompts.size;
    }

    /**
     * Get server health status
     */
    public getHealth(): {
        status: 'healthy' | 'degraded' | 'unhealthy';
        uptime: number;
        toolExecutionCount: number;
        errorCount: number;
        errorRate: number;
        browserSessionActive: boolean;
    } {
        const uptime = Date.now() / 1000 - this.startTime;
        const errorRate = this.toolExecutionCount > 0 ? this.errorCount / this.toolExecutionCount : 0;

        let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
        if (errorRate > 0.5) {
            status = 'unhealthy';
        } else if (errorRate > 0.2) {
            status = 'degraded';
        }

        return {
            status,
            uptime,
            toolExecutionCount: this.toolExecutionCount,
            errorCount: this.errorCount,
            errorRate,
            browserSessionActive: this.browserSession !== null,
        };
    }

    /**
     * Get server statistics
     */
    public getStats(): {
        toolsRegistered: number;
        promptsRegistered: number;
        uptime: number;
        executionCount: number;
        errorCount: number;
        successRate: number;
    } {
        const health = this.getHealth();
        return {
            toolsRegistered: this.getToolCount(),
            promptsRegistered: this.getPromptCount(),
            uptime: health.uptime,
            executionCount: this.toolExecutionCount,
            errorCount: this.errorCount,
            successRate: health.toolExecutionCount > 0 ? 1 - health.errorRate : 1,
        };
    }

    /**
     * Reset statistics
     */
    public resetStats(): void {
        this.toolExecutionCount = 0;
        this.errorCount = 0;
        logger.info('Statistics reset');
    }

    /**
     * Check if server is running
     */
    public isServerRunning(): boolean {
        return this.isRunning;
    }
}
