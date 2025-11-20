import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export class MCPClient {
    private client: Client;

    constructor(name: string, version: string) {
        this.client = new Client(
            {
                name,
                version,
            },
            {
                capabilities: {},
            }
        );
    }

    async connect(command: string, args: string[]) {
        const transport = new StdioClientTransport({
            command,
            args,
        });
        await this.client.connect(transport);
    }

    async listTools() {
        const result = await this.client.request(ListToolsRequestSchema, {});
        return result.tools;
    }

    async callTool(name: string, args: any) {
        const result = await this.client.request(CallToolRequestSchema, {
            name,
            arguments: args,
        });
        return result.content;
    }
}
