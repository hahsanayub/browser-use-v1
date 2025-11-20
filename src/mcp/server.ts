import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

// This is a basic implementation of an MCP server that exposes tools
export class MCPServer {
    private server: Server;
    private tools: Record<string, any> = {};

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
            const tool = this.tools[request.params.name];
            if (!tool) {
                throw new Error(`Tool not found: ${request.params.name}`);
            }

            const result = await tool.handler(request.params.arguments);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(result),
                    },
                ],
            };
        });
    }

    public registerTool(name: string, description: string, inputSchema: z.ZodType, handler: (args: any) => Promise<any>) {
        this.tools[name] = {
            description,
            inputSchema: zodToJsonSchema(inputSchema),
            handler,
        };
    }

    public async start() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
    }
}
