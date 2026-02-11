import { createLogger } from '../logging-config.js';
import type { Registry } from '../tools/registry/service.js';
import type { Tools } from '../tools/service.js';
import { MCPClient, type MCPClientOptions } from './client.js';

const logger = createLogger('browser_use.mcp.controller');

export interface MCPToolWrapperOptions {
  serverName?: string;
  env?: Record<string, string>;
  clientOptions?: MCPClientOptions;
}

export class MCPToolWrapper {
  private client: MCPClient;

  constructor(
    private registry: Registry,
    mcpCommand: string,
    mcpArgs: string[] = [],
    options: MCPToolWrapperOptions = {}
  ) {
    this.client = new MCPClient(
      options.serverName ?? 'browser-use-mcp-tools',
      mcpCommand,
      mcpArgs,
      options.env,
      options.clientOptions
    );
  }

  async connect(
    toolFilter?: string[],
    prefix?: string,
    tools?: Pick<Tools, 'registry'>
  ): Promise<void> {
    if (!this.client.isConnected()) {
      await this.client.connect();
    }

    const targetTools =
      tools ?? ({ registry: this.registry } as Pick<Tools, 'registry'>);
    await this.client.registerToTools(targetTools, toolFilter, prefix);
  }

  async disconnect(): Promise<void> {
    await this.client.disconnect();
  }

  getClient(): MCPClient {
    return this.client;
  }

  getStats() {
    return this.client.getStats();
  }
}

export async function registerMcpTools(
  registry: Registry,
  mcpCommand: string,
  mcpArgs: string[] = [],
  options: MCPToolWrapperOptions = {}
): Promise<MCPToolWrapper> {
  const wrapper = new MCPToolWrapper(registry, mcpCommand, mcpArgs, options);
  await wrapper.connect();
  return wrapper;
}

export interface AddMCPServerOptions {
  serverName?: string;
  env?: Record<string, string>;
  clientOptions?: MCPClientOptions;
  toolFilter?: string[];
  prefix?: string;
  tools?: Pick<Tools, 'registry'>;
}

// Backward-compatible helper that can manage multiple MCP clients.
export class MCPController {
  private clients: MCPClient[] = [];
  private tools: Pick<Tools, 'registry'> | null;

  constructor(tools: Pick<Tools, 'registry'> | null = null) {
    this.tools = tools;
  }

  setTools(tools: Pick<Tools, 'registry'>) {
    this.tools = tools;
  }

  async addServer(
    command: string,
    args: string[] = [],
    options: AddMCPServerOptions = {}
  ): Promise<MCPClient> {
    const client = new MCPClient(
      options.serverName ?? `browser-use-client-${this.clients.length + 1}`,
      command,
      args,
      options.env,
      options.clientOptions
    );
    await client.connect();

    const targetTools = options.tools ?? this.tools;
    if (targetTools) {
      await client.registerToTools(
        targetTools,
        options.toolFilter,
        options.prefix
      );
    } else {
      logger.warning(
        'MCPController.addServer connected but skipped tool registration because no Tools instance was provided'
      );
    }

    this.clients.push(client);
    return client;
  }

  getClients(): MCPClient[] {
    return [...this.clients];
  }

  async disconnectAll(): Promise<void> {
    await Promise.all(this.clients.map((client) => client.disconnect()));
    this.clients = [];
  }
}
