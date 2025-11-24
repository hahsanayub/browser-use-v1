import { MCPClient } from './client.js';
import { Registry } from '../controller/registry/service.js';
import { z } from 'zod';

// This controller integrates MCP tools into the browser-use registry
export class MCPController {
  private clients: MCPClient[] = [];

  constructor() {}

  async addServer(command: string, args: string[]) {
    const client = new MCPClient('browser-use-client', command, args);
    await client.connect();
    this.clients.push(client);
    await this.registerTools(client);
  }

  private async registerTools(client: MCPClient) {
    const tools = await client.listTools();

    for (const tool of tools) {
      // We need to convert JSON schema to Zod schema dynamically if we want to validate
      // For now, we might just use a generic schema or skip validation at the registry level
      // and let the MCP server validate.

      // However, the Registry expects a Zod schema.
      // We can create a dynamic Zod schema that accepts anything if we can't easily convert.
      // Or we can try to convert using json-schema-to-zod (if we had it) or just use z.any()

      const paramModel = z.any().describe(tool.description || '');

      // Register the action
      // Note: We need to access the singleton registry or pass it in.
      // Assuming we can use the decorator or manual registration.
      // Since we are registering dynamically, we might need a method on Registry to register actions at runtime.

      // Let's assume Registry has a static method or we can access the instance.
      // In the migration plan, Registry is a class.
      // We might need to modify Registry to support runtime registration if it doesn't already.
      // But wait, the Registry in `src/controller/registry/service.ts` has an `action` method which is a decorator.
      // It also has a `registry` property which holds the actions.

      // We'll assume we can access the global registry or pass it to this controller.
      // For now, I'll just log it as a placeholder for actual registration logic which might require
      // more complex integration with the Controller class.

      console.log(`Discovered MCP tool: ${tool.name}`);
    }
  }
}
