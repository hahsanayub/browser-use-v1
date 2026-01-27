# MCP Server Guide

Browser-Use includes a Model Context Protocol (MCP) server that enables integration with Claude Desktop and other MCP-compatible clients.

## What is MCP?

The Model Context Protocol (MCP) is Anthropic's open standard for connecting AI assistants to external tools and data sources. Browser-Use's MCP server exposes browser automation capabilities as MCP tools.

## Quick Start

### Starting the MCP Server

```bash
# Start in MCP mode
npx browser-use --mcp

# Or with explicit port
npx browser-use --mcp --port 3000
```

### Configuring Claude Desktop

Add to your Claude Desktop configuration file:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "browser-use": {
      "command": "npx",
      "args": ["browser-use", "--mcp"],
      "env": {
        "OPENAI_API_KEY": "your-api-key"
      }
    }
  }
}
```

## Available MCP Tools

### browser_run_task

Execute an autonomous browser task.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `task` | `string` | Yes | Task description in natural language |
| `max_steps` | `number` | No | Maximum steps (default: 50) |
| `use_vision` | `boolean` | No | Enable screenshots (default: true) |

**Example:**
```json
{
  "task": "Go to amazon.com and search for 'wireless keyboard'",
  "max_steps": 30,
  "use_vision": true
}
```

### browser_navigate

Navigate to a specific URL.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `url` | `string` | Yes | URL to navigate to |

**Example:**
```json
{
  "url": "https://github.com"
}
```

### browser_click

Click an element on the page.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `index` | `number` | Yes | Element index from page state |

**Example:**
```json
{
  "index": 5
}
```

### browser_type

Type text into an input field.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `index` | `number` | Yes | Element index |
| `text` | `string` | Yes | Text to type |
| `press_enter` | `boolean` | No | Press Enter after typing |

**Example:**
```json
{
  "index": 3,
  "text": "search query",
  "press_enter": true
}
```

### browser_scroll

Scroll the page.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `direction` | `string` | Yes | "up" or "down" |
| `amount` | `number` | No | Pixels to scroll |

**Example:**
```json
{
  "direction": "down",
  "amount": 500
}
```

### browser_get_state

Get current browser state including interactive elements.

**Parameters:** None

**Returns:**
- Current URL
- Page title
- Screenshot (base64)
- Interactive elements list

### browser_extract

Extract structured data from the page.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `instruction` | `string` | Yes | What to extract |
| `schema` | `object` | No | Expected data structure |

**Example:**
```json
{
  "instruction": "Extract all product prices from the page",
  "schema": {
    "prices": ["string"]
  }
}
```

### browser_screenshot

Take a screenshot of the current page.

**Parameters:** None

**Returns:** Base64-encoded screenshot image

### browser_close

Close the browser session.

**Parameters:** None

## MCP Prompts

The MCP server also exposes prompt templates:

### web_search

Prompt for web search tasks.

```
Search the web for: {query}
```

### form_fill

Prompt for form filling tasks.

```
Fill out the form at {url} with the following data: {data}
```

### data_extraction

Prompt for data extraction tasks.

```
Extract {data_type} from {url}
```

## Configuration Options

### Environment Variables

```bash
# LLM Configuration
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
BROWSER_USE_LLM_PROVIDER=openai
BROWSER_USE_LLM_MODEL=gpt-4o

# Browser Configuration
BROWSER_USE_HEADLESS=true

# MCP Configuration
MCP_SERVER_PORT=3000

# Telemetry
ANONYMIZED_TELEMETRY=false
```

### Claude Desktop with Full Configuration

```json
{
  "mcpServers": {
    "browser-use": {
      "command": "npx",
      "args": ["browser-use", "--mcp"],
      "env": {
        "OPENAI_API_KEY": "sk-your-key",
        "BROWSER_USE_HEADLESS": "true",
        "BROWSER_USE_LLM_MODEL": "gpt-4o",
        "ANONYMIZED_TELEMETRY": "false"
      }
    }
  }
}
```

## Usage Examples

### With Claude Desktop

Once configured, you can use natural language in Claude Desktop:

> "Use browser-use to search for the latest TypeScript release notes on GitHub"

Claude will:
1. Call `browser_run_task` with the appropriate task
2. Display progress and results
3. Show screenshots if available

### Direct API Usage

```typescript
import { MCPServer } from 'browser-use/mcp';

const server = new MCPServer({
  llm: yourLLMInstance,
  browserProfile: yourProfile
});

await server.start();
```

## Session Management

### Persistent Sessions

The MCP server maintains a single browser session across tool calls. This enables:

- Tab persistence
- Login state retention
- History tracking

### Session Lifecycle

1. **Start**: Browser launches on first tool call
2. **Active**: Session persists across subsequent calls
3. **Close**: Explicit `browser_close` or server shutdown

### Multiple Sessions

For multiple independent sessions, run multiple MCP server instances on different ports:

```json
{
  "mcpServers": {
    "browser-use-1": {
      "command": "npx",
      "args": ["browser-use", "--mcp", "--port", "3001"]
    },
    "browser-use-2": {
      "command": "npx",
      "args": ["browser-use", "--mcp", "--port", "3002"]
    }
  }
}
```

## Error Handling

### Common Errors

**Browser launch failed:**
```
Error: Browser failed to launch
```
Solution: Ensure Playwright browsers are installed:
```bash
npx playwright install chromium
```

**LLM API error:**
```
Error: API key not configured
```
Solution: Set the appropriate API key environment variable.

**Timeout error:**
```
Error: Operation timed out
```
Solution: Increase timeout or simplify the task.

### Error Responses

MCP tools return structured error responses:

```json
{
  "error": {
    "code": "BROWSER_ERROR",
    "message": "Navigation failed: Page not found"
  }
}
```

## Telemetry

The MCP server reports anonymous telemetry:

- Tool usage counts
- Success/failure rates
- Session durations

Disable with:
```bash
ANONYMIZED_TELEMETRY=false
```

## Security Considerations

### API Key Protection

Never expose API keys in shared configurations. Use environment variables:

```json
{
  "mcpServers": {
    "browser-use": {
      "command": "npx",
      "args": ["browser-use", "--mcp"],
      "env": {
        "OPENAI_API_KEY": "${OPENAI_API_KEY}"
      }
    }
  }
}
```

### Domain Restrictions

Limit browser access to specific domains:

```bash
BROWSER_USE_ALLOWED_DOMAINS=*.example.com,*.trusted.org
```

### Headless Mode

For security, run in headless mode in production:

```bash
BROWSER_USE_HEADLESS=true
```

## Debugging

### Enable Debug Logging

```bash
BROWSER_USE_LOGGING_LEVEL=debug npx browser-use --mcp
```

### View MCP Communication

Use the MCP Inspector:

```bash
npx @anthropic-ai/mcp-inspector browser-use --mcp
```

### Check Server Status

The server logs startup information:

```
INFO [browser_use.mcp] MCP Server starting on port 3000
INFO [browser_use.mcp] Available tools: browser_run_task, browser_navigate, ...
INFO [browser_use.mcp] Server ready
```

## Advanced Usage

### Custom Tool Registration

Extend the MCP server with custom tools:

```typescript
import { MCPServer } from 'browser-use/mcp';

const server = new MCPServer({ llm });

// Add custom tool
server.registerTool('my_custom_tool', {
  description: 'My custom browser tool',
  parameters: {
    type: 'object',
    properties: {
      param1: { type: 'string' }
    }
  },
  handler: async (params) => {
    // Implementation
    return { result: 'success' };
  }
});

await server.start();
```

### Integration with Other MCP Servers

Browser-Use can work alongside other MCP servers:

```json
{
  "mcpServers": {
    "browser-use": {
      "command": "npx",
      "args": ["browser-use", "--mcp"]
    },
    "filesystem": {
      "command": "npx",
      "args": ["@anthropic-ai/mcp-server-filesystem"]
    },
    "database": {
      "command": "npx",
      "args": ["your-database-mcp-server"]
    }
  }
}
```

This enables Claude to combine browser automation with file system access and database operations.
