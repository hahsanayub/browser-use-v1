import { describe, expect, it, vi } from 'vitest';
import { MCPClient } from '../src/mcp/client.js';
import { Tools } from '../src/tools/service.js';
import { Controller } from '../src/controller/service.js';

describe('MCPClient tools alignment', () => {
  it('registers MCP tools into Tools registry', async () => {
    const client = new MCPClient('test-server', 'node', ['-e', '']);
    (client as any)._connected = true;
    (client as any)._tools = new Map([
      [
        'echo',
        {
          name: 'echo',
          description: 'Echoes the input',
          inputSchema: {
            type: 'object',
            properties: {
              value: { type: 'string' },
            },
            required: ['value'],
          },
        },
      ],
    ]);

    const callToolSpy = vi
      .spyOn(client, 'callTool')
      .mockResolvedValue([{ type: 'text', text: 'Echoed from MCP' }]);
    const tools = new Tools();

    await client.registerToTools(tools, ['echo'], 'mcp_');

    const registered = tools.registry.get_action('mcp_echo');
    expect(registered).not.toBeNull();

    const actionResult = (await tools.registry.execute_action(
      'mcp_echo',
      { value: 'hello' },
      {}
    )) as any;

    expect(callToolSpy).toHaveBeenCalledWith('echo', { value: 'hello' });
    expect(actionResult.extracted_content).toContain('Echoed from MCP');
  });

  it('keeps registerToController as alias to registerToTools', async () => {
    const client = new MCPClient('test-server', 'node', ['-e', '']);
    const controller = new Controller();
    const registerSpy = vi
      .spyOn(client, 'registerToTools')
      .mockResolvedValue(undefined);

    await client.registerToController(controller, ['tool_a'], 'pref_');

    expect(registerSpy).toHaveBeenCalledTimes(1);
    const [targetTools, filter, prefix] = registerSpy.mock.calls[0]!;
    expect((targetTools as any).registry).toBe(controller.registry);
    expect(filter).toEqual(['tool_a']);
    expect(prefix).toBe('pref_');
  });
});
