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
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
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

export class MCPServer {
    private server: Server;
    private tools: Record<string, any> = {};
    private browserSession: BrowserSession | null = null;
    private controller: Controller<any> | null = null;
    private startTime: number;

    constructor(name: string, version: string) {
        this.server = new Server(
            {
                name,
                version,
            },
            {
                capabilities: {
                    tools: {},
                },
            }
        );

        this.startTime = Date.now() / 1000;
        this.setupHandlers();
    }

    private setupHandlers() {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            return {
                tools: Object.entries(this.tools).map(([name, tool]) => ({
                    name,
                    description: tool.description,
                    inputSchema: tool.inputSchema,
                })),
            };
        });

        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const startTime = Date.now() / 1000;
            let errorMsg: string | null = null;

            try {
                const tool = this.tools[request.params.name];
                if (!tool) {
                    throw new Error(`Tool not found: ${request.params.name}`);
                }

                logger.debug(`Executing tool: ${request.params.name}`);
                const result = await tool.handler(request.params.arguments || {});

                return {
                    content: [
                        {
                            type: 'text',
                            text: typeof result === 'string' ? result : JSON.stringify(result),
                        },
                    ],
                };
            } catch (error) {
                errorMsg = error instanceof Error ? error.message : String(error);
                logger.error(`Tool execution failed: ${errorMsg}`);
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Error: ${errorMsg}`,
                        },
                    ],
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
            logger.info('🔌 MCP Server started');
        } catch (error) {
            logger.error(`Failed to start MCP server: ${error}`);
            throw error;
        }
    }

    /**
     * Stop the MCP server and cleanup resources
     */
    public async stop(): Promise<void> {
        try {
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

            logger.info('🔌 MCP Server stopped');
        } catch (error) {
            logger.error(`Error stopping MCP server: ${error}`);
        }
    }

    /**
     * Get the number of registered tools
     */
    public getToolCount(): number {
        return Object.keys(this.tools).length;
    }
}
