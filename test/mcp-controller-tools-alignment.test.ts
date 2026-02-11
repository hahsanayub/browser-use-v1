import { beforeEach, describe, expect, it, vi } from 'vitest';

const connectMock = vi.fn(async () => undefined);
const registerToToolsMock = vi.fn(
  async (
    _tools: unknown,
    _filter?: string[],
    _prefix?: string
  ) => undefined
);
const disconnectMock = vi.fn(async () => undefined);
const isConnectedMock = vi.fn(() => false);
const getStatsMock = vi.fn(() => ({ connected: true }));

vi.mock('../src/mcp/client.js', () => {
  class MCPClient {
    constructor(
      _serverName: string,
      _command: string,
      _args: string[] = [],
      _env?: Record<string, string>,
      _options?: unknown
    ) {}

    connect = connectMock;
    registerToTools = registerToToolsMock;
    disconnect = disconnectMock;
    isConnected = isConnectedMock;
    getStats = getStatsMock;
  }

  return { MCPClient };
});

import {
  MCPController,
  MCPToolWrapper,
  registerMcpTools,
} from '../src/mcp/controller.js';

describe('MCP tools wrapper alignment', () => {
  beforeEach(() => {
    connectMock.mockClear();
    registerToToolsMock.mockClear();
    disconnectMock.mockClear();
    isConnectedMock.mockReset();
    isConnectedMock.mockReturnValue(false);
    getStatsMock.mockClear();
  });

  it('connects wrapper and registers tools on provided registry', async () => {
    const registry = {} as any;
    const wrapper = new MCPToolWrapper(registry, 'npx', ['@playwright/mcp']);

    await wrapper.connect(['browser_click'], 'pw_');

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(registerToToolsMock).toHaveBeenCalledTimes(1);
    const [toolsArg, filter, prefix] = registerToToolsMock.mock.calls[0]!;
    expect((toolsArg as any).registry).toBe(registry);
    expect(filter).toEqual(['browser_click']);
    expect(prefix).toBe('pw_');
  });

  it('registerMcpTools connects before returning wrapper', async () => {
    const registry = {} as any;

    const wrapper = await registerMcpTools(registry, 'npx', [
      '@playwright/mcp',
      '--headless',
    ]);

    expect(wrapper).toBeInstanceOf(MCPToolWrapper);
    expect(connectMock).toHaveBeenCalledTimes(1);
  });

  it('MCPController.addServer registers to tools when configured', async () => {
    const tools = { registry: {} } as any;
    const controller = new MCPController(tools);

    await controller.addServer('npx', ['@playwright/mcp'], {
      toolFilter: ['browser_type'],
      prefix: 'pw_',
    });

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(registerToToolsMock).toHaveBeenCalledWith(
      tools,
      ['browser_type'],
      'pw_'
    );
  });

  it('disconnectAll closes tracked clients', async () => {
    const controller = new MCPController({ registry: {} } as any);
    await controller.addServer('npx', ['@playwright/mcp']);
    await controller.addServer('npx', ['@playwright/mcp', '--headless']);

    expect(controller.getClients()).toHaveLength(2);

    await controller.disconnectAll();

    expect(disconnectMock).toHaveBeenCalledTimes(2);
    expect(controller.getClients()).toHaveLength(0);
  });
});
