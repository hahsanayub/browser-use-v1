/**
 * MCP (Model Context Protocol) client integration for browser-use.
 *
 * This module provides integration between external MCP servers and browser-use's action registry.
 * MCP tools are dynamically discovered and registered as browser-use actions.
 *
 * Example usage:
 *     import { Controller } from './controller/service.js';
 *     import { MCPClient } from './mcp/client.js';
 *
 *     const controller = new Controller();
 *
 *     // Connect to an MCP server
 *     const mcpClient = new MCPClient(
 *         'my-server',
 *         'npx',
 *         ['@mycompany/mcp-server@latest']
 *     );
 *
 *     // Register all MCP tools as browser-use actions
 *     await mcpClient.registerToController(controller);
 *
 *     // Now use with Agent as normal - MCP tools are available as actions
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { createLogger } from '../logging-config.js';
import type { Controller } from '../controller/service.js';
import type { Registry } from '../controller/registry/service.js';
import { ActionResult } from '../agent/views.js';
import { productTelemetry } from '../telemetry/service.js';
import { MCPClientTelemetryEvent } from '../telemetry/views.js';
import { get_browser_use_version } from '../utils.js';

const logger = createLogger('browser_use.mcp.client');

export class MCPClient {
    private client: Client;
    private command: string;
    private args: string[];
    private env?: Record<string, string>;
    private serverName: string;
    private _tools: Map<string, Tool> = new Map();
    private _registeredActions: Set<string> = new Set();
    private _connected = false;

    constructor(
        serverName: string,
        command: string,
        args: string[] = [],
        env?: Record<string, string>
    ) {
        this.serverName = serverName;
        this.command = command;
        this.args = args;
        this.env = env;

        this.client = new Client(
            {
                name: 'browser-use',
                version: get_browser_use_version(),
            },
            {
                capabilities: {},
            }
        );
    }

    /**
     * Connect to the MCP server and discover available tools
     */
    async connect(timeout: number = 30): Promise<void> {
        if (this._connected) {
            logger.debug(`Already connected to ${this.serverName}`);
            return;
        }

        const startTime = Date.now() / 1000;
        let errorMsg: string | null = null;

        try {
            logger.info(`🔌 Connecting to MCP server '${this.serverName}': ${this.command} ${this.args.join(' ')}`);

            // Create transport with environment variables
            const transport = new StdioClientTransport({
                command: this.command,
                args: this.args,
                env: this.env,
            });

            // Connect with timeout
            await this._connectWithTimeout(transport, timeout);
            this._connected = true;

            // Discover available tools
            const result = await this.client.request(ListToolsRequestSchema, {});
            this._tools = new Map(result.tools.map(tool => [tool.name, tool]));

            logger.info(`📦 Discovered ${this._tools.size} tools from '${this.serverName}': ${Array.from(this._tools.keys()).join(', ')}`);

        } catch (error) {
            errorMsg = error instanceof Error ? error.message : String(error);
            throw error;
        } finally {
            // Capture telemetry for connect action
            const duration = Date.now() / 1000 - startTime;
            productTelemetry.capture(
                new MCPClientTelemetryEvent({
                    server_name: this.serverName,
                    command: this.command,
                    tools_discovered: this._tools.size,
                    version: get_browser_use_version(),
                    action: 'connect',
                    duration_seconds: duration,
                    error_message: errorMsg,
                })
            );
        }
    }

    private async _connectWithTimeout(transport: StdioClientTransport, timeoutSeconds: number): Promise<void> {
        return new Promise(async (resolve, reject) => {
            const timeoutHandle = setTimeout(() => {
                reject(new Error(`Failed to connect to MCP server '${this.serverName}' after ${timeoutSeconds} seconds`));
            }, timeoutSeconds * 1000);

            try {
                await this.client.connect(transport);
                clearTimeout(timeoutHandle);
                resolve();
            } catch (error) {
                clearTimeout(timeoutHandle);
                reject(error);
            }
        });
    }

    /**
     * Disconnect from the MCP server
     */
    async disconnect(): Promise<void> {
        if (!this._connected) {
            return;
        }

        const startTime = Date.now() / 1000;
        let errorMsg: string | null = null;

        try {
            logger.info(`🔌 Disconnecting from MCP server '${this.serverName}'`);
            await this.client.close();
            this._connected = false;
            this._tools.clear();
            this._registeredActions.clear();
        } catch (error) {
            errorMsg = error instanceof Error ? error.message : String(error);
            logger.error(`Error disconnecting from MCP server: ${errorMsg}`);
        } finally {
            // Capture telemetry for disconnect action
            const duration = Date.now() / 1000 - startTime;
            productTelemetry.capture(
                new MCPClientTelemetryEvent({
                    server_name: this.serverName,
                    command: this.command,
                    tools_discovered: 0, // Tools cleared on disconnect
                    version: get_browser_use_version(),
                    action: 'disconnect',
                    duration_seconds: duration,
                    error_message: errorMsg,
                })
            );
            productTelemetry.flush();
        }
    }

    /**
     * List all available tools from the MCP server
     */
    async listTools(): Promise<Tool[]> {
        if (!this._connected) {
            await this.connect();
        }
        return Array.from(this._tools.values());
    }

    /**
     * Call a tool on the MCP server
     */
    async callTool(name: string, args: any): Promise<any> {
        if (!this._connected) {
            throw new Error(`MCP server '${this.serverName}' not connected`);
        }

        const startTime = Date.now() / 1000;
        let errorMsg: string | null = null;

        try {
            logger.debug(`🔧 Calling MCP tool '${name}' with params: ${JSON.stringify(args)}`);

            const result = await this.client.request(CallToolRequestSchema, {
                name,
                arguments: args,
            });

            return result.content;
        } catch (error) {
            errorMsg = error instanceof Error ? error.message : String(error);
            logger.error(`MCP tool '${name}' failed: ${errorMsg}`);
            throw error;
        } finally {
            // Capture telemetry for tool call
            const duration = Date.now() / 1000 - startTime;
            productTelemetry.capture(
                new MCPClientTelemetryEvent({
                    server_name: this.serverName,
                    command: this.command,
                    tools_discovered: this._tools.size,
                    version: get_browser_use_version(),
                    action: 'tool_call',
                    tool_name: name,
                    duration_seconds: duration,
                    error_message: errorMsg,
                })
            );
        }
    }

    /**
     * Register MCP tools as actions in the browser-use controller
     *
     * @param controller - Browser-use controller to register actions to
     * @param toolFilter - Optional list of tool names to register (undefined = all tools)
     * @param prefix - Optional prefix to add to action names (e.g., "playwright_")
     */
    async registerToController(
        controller: Controller<any>,
        toolFilter?: string[],
        prefix?: string
    ): Promise<void> {
        if (!this._connected) {
            await this.connect();
        }

        const registry = controller.registry;

        for (const [toolName, tool] of this._tools.entries()) {
            // Skip if not in filter
            if (toolFilter && !toolFilter.includes(toolName)) {
                continue;
            }

            // Apply prefix if specified
            const actionName = prefix ? `${prefix}${toolName}` : toolName;

            // Skip if already registered
            if (this._registeredActions.has(actionName)) {
                continue;
            }

            // Register the tool as an action
            this._registerToolAsAction(registry, actionName, tool);
            this._registeredActions.add(actionName);
        }

        logger.info(`✅ Registered ${this._registeredActions.size} MCP tools from '${this.serverName}' as browser-use actions`);
    }

    private _registerToolAsAction(registry: Registry, actionName: string, tool: Tool): void {
        /**
         * Register a single MCP tool as a browser-use action
         */

        // Create async wrapper function for the MCP tool
        const mcpActionWrapper = async (params?: any): Promise<ActionResult> => {
            if (!this._connected) {
                return new ActionResult({
                    error: `MCP server '${this.serverName}' not connected`,
                    success: false,
                });
            }

            const startTime = Date.now() / 1000;
            let errorMsg: string | null = null;

            try {
                // Call the MCP tool
                const result = await this.callTool(tool.name, params || {});

                // Convert MCP result to ActionResult
                const extractedContent = this._formatMcpResult(result);

                return new ActionResult({
                    extracted_content: extractedContent,
                    long_term_memory: `Used MCP tool '${tool.name}' from ${this.serverName}`,
                });

            } catch (error) {
                errorMsg = error instanceof Error ? error.message : String(error);
                logger.error(`MCP tool '${tool.name}' failed: ${errorMsg}`);
                return new ActionResult({
                    error: `MCP tool '${tool.name}' failed: ${errorMsg}`,
                    success: false,
                });
            }
        };

        // Set function metadata for better debugging
        Object.defineProperty(mcpActionWrapper, 'name', { value: actionName });

        // Register the action with browser-use
        const description = tool.description || `MCP tool from ${this.serverName}: ${tool.name}`;

        // Use the registry's action decorator
        registry.action(description)(mcpActionWrapper);

        logger.debug(`✅ Registered MCP tool '${tool.name}' as action '${actionName}'`);
    }

    private _formatMcpResult(result: any): string {
        /**
         * Format MCP tool result into a string for ActionResult
         */

        // Handle different MCP result formats
        if (result && typeof result === 'object') {
            if (Array.isArray(result)) {
                // List of content items
                const parts: string[] = [];
                for (const item of result) {
                    if (item && typeof item === 'object' && 'text' in item) {
                        parts.push(String(item.text));
                    } else {
                        parts.push(String(item));
                    }
                }
                return parts.join('\n');
            } else if ('text' in result) {
                return String(result.text);
            } else if ('content' in result) {
                // Structured content response
                if (Array.isArray(result.content)) {
                    const parts: string[] = [];
                    for (const item of result.content) {
                        if (item && typeof item === 'object' && 'text' in item) {
                            parts.push(String(item.text));
                        } else {
                            parts.push(String(item));
                        }
                    }
                    return parts.join('\n');
                } else {
                    return String(result.content);
                }
            }
        }

        // Direct result or unknown format
        return String(result);
    }

    // Async context manager support
    async [Symbol.asyncDispose](): Promise<void> {
        await this.disconnect();
    }
}
