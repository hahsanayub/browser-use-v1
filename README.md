# browser-use

![Node CI](https://github.com/webllm/browser-use/workflows/Node%20CI/badge.svg)
[![npm](https://img.shields.io/npm/v/browser-use.svg)](https://www.npmjs.com/package/browser-use)
![license](https://img.shields.io/npm/l/browser-use)

> 🙏 **A TypeScript port of the amazing [browser-use](https://github.com/browser-use/browser-use) Python library**
>
> This project is a faithful TypeScript/JavaScript implementation of the original [browser-use](https://github.com/browser-use/browser-use) Python library, bringing the power of AI-driven browser automation to the Node.js ecosystem. All credit for the innovative design and architecture goes to the original Python project and its creators.

A TypeScript-first library for programmatic browser control, designed for building AI-powered web agents with vision capabilities and extensive LLM integrations.

## Why TypeScript?

While the original [browser-use Python library](https://github.com/browser-use/browser-use) is excellent and feature-complete, this TypeScript port aims to:

- 🌍 Bring browser-use capabilities to the JavaScript/TypeScript ecosystem
- 🔧 Enable seamless integration with Node.js, Deno, and Bun projects
- 📦 Provide native TypeScript type definitions for better DX
- 🤝 Make browser automation accessible to frontend and full-stack developers

### Python vs TypeScript: Which Should You Use?

| Feature             | Python Version                                                        | TypeScript Version                                          |
| ------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------- |
| **Recommended for** | Python developers, Data scientists, AI/ML engineers                   | JavaScript/TypeScript developers, Full-stack engineers      |
| **Ecosystem**       | PyPI, pip                                                             | npm, yarn, pnpm                                             |
| **Type Safety**     | Optional (with type hints)                                            | Built-in (TypeScript)                                       |
| **Runtime**         | Python 3.x                                                            | Node.js, Deno, Bun                                          |
| **LLM Providers**   | 10+ providers                                                         | 10+ providers (same)                                        |
| **Browser Support** | Playwright                                                            | Playwright (same)                                           |
| **Documentation**   | ⭐ Original & Complete                                                | Port with TS-specific examples                              |
| **Community**       | ⭐ Larger & More Established                                          | Growing                                                     |
| **GitHub**          | [browser-use/browser-use](https://github.com/browser-use/browser-use) | [webllm/browser-use](https://github.com/webllm/browser-use) |

**👉 If you're working in Python, we highly recommend using the [original browser-use library](https://github.com/browser-use/browser-use).** This TypeScript port is specifically for those who need to work within the JavaScript/TypeScript ecosystem.

### Commitment to the Original

We are committed to:

- ✅ Maintaining feature parity with the Python version whenever possible
- 🔄 Keeping up with upstream updates and improvements
- 🐛 Reporting bugs found in this port back to the original project when applicable
- 📚 Directing users to the original project's documentation for core concepts
- 🤝 Collaborating with the original authors and respecting their vision

This is **not** a fork or competing project—it's a respectful port to serve a different programming language community.

### Upstream Parity Status

This Node.js/TypeScript implementation is currently aligned with the Python `browser-use`
baseline at commit [`c011d07`](https://github.com/browser-use/browser-use/commit/c011d07e7e9e41c06b5c72036c6e3efa5b9f287d),
published on **February 5, 2026**.

- 📦 Core action behavior and schemas are aligned against that upstream baseline.
- ✅ The test suite is maintained to keep parity checks practical and regression-focused.
- 🔄 Upstream parity will continue to move forward as new Python changes stabilize.

## Features

- 🤖 **AI-Powered**: Built specifically for LLM-driven web automation with structured output support
- 🎯 **Type-Safe**: Full TypeScript support with comprehensive type definitions
- 🌐 **Multi-Browser**: Support for Chromium, Firefox, and WebKit via Playwright
- 🔌 **10+ LLM Providers**: OpenAI, Anthropic, Google, AWS, Azure, DeepSeek, Groq, Ollama, OpenRouter, and more
- 👁️ **Vision Support**: Multimodal capabilities with screenshot analysis
- 🛡️ **Robust**: Built-in error handling, recovery, graceful shutdown, and retry mechanisms
- 📊 **Observable**: Comprehensive logging, execution history, and telemetry
- 🔧 **Extensible**: Custom actions, MCP protocol, and plugin system
- 📁 **FileSystem**: Built-in file operations with PDF parsing
- 🔗 **Integrations**: Gmail API, Google Sheets, and MCP servers

## Quick Start

### Installation

```bash
npm install browser-use
# or
yarn add browser-use
# or
pnpm add browser-use
```

Playwright browsers will be installed automatically via postinstall hook.

Use only documented public entrypoints such as `browser-use` and
`browser-use/llm/openai`. Avoid deep imports like `browser-use/dist/...`.

### Basic Usage with Agent

```typescript
import { Agent } from 'browser-use';
import { ChatOpenAI } from 'browser-use/llm/openai';

async function main() {
  const llm = new ChatOpenAI({
    model: 'gpt-4',
    apiKey: process.env.OPENAI_API_KEY,
  });

  const agent = new Agent({
    task: 'Go to google.com and search for "TypeScript browser automation"',
    llm,
  });

  const history = await agent.run();

  console.log(`Task completed in ${history.history.length} steps`);

  // Access the browser session
  const browserSession = agent.browser_session;
  const currentPage = await browserSession.get_current_page();
  console.log('Final URL:', currentPage?.url());
}

main();
```

### Using Controller for Custom Actions

Use `Controller` to register domain-specific actions, then pass it into `Agent`:

```typescript
import { Agent, Controller, ActionResult } from 'browser-use';
import { ChatOpenAI } from 'browser-use/llm/openai';
import { z } from 'zod';

const controller = new Controller();

controller.registry.action('Extract product info from the current page', {
  param_model: z.object({
    include_price: z.boolean().default(true),
    include_reviews: z.boolean().default(false),
  }),
})(async function extract_product_info(params, { page }) {
  const productData = await page.evaluate(() => ({
    title: document.querySelector('h1')?.textContent ?? null,
    price: document.querySelector('.price')?.textContent ?? null,
  }));

  return new ActionResult({
    extracted_content: JSON.stringify({ ...productData, ...params }),
    include_in_memory: true,
  });
});

const agent = new Agent({
  task: 'Open product page and extract product info',
  llm: new ChatOpenAI({
    model: 'gpt-4o',
    apiKey: process.env.OPENAI_API_KEY,
  }),
  controller,
});

const history = await agent.run(10);
console.log(history.final_result());
```

### CLI Usage

```bash
# Interactive mode (when running in a TTY)
npx browser-use

# One-shot task
npx browser-use -p "Go to example.com and extract the page title"

# Positional task mode
npx browser-use "Search for TypeScript browser automation"

# Pick model/provider by model name
npx browser-use --model claude-sonnet-4-20250514 -p "Summarize latest AI news"

# Pick provider explicitly (uses provider default model)
npx browser-use --provider anthropic -p "Summarize latest AI news"

# Headless + custom browser profile settings
npx browser-use --headless --window-width 1440 --window-height 900 -p "Check dashboard status"

# Restrict navigation to trusted domains (recommended with secrets)
npx browser-use --allowed-domains "example.com,*.example.org" -p "Log in and fetch account info"

# Connect to existing Chromium via CDP
npx browser-use --cdp-url http://localhost:9222 -p "Inspect the active tab"

# MCP server mode
npx browser-use --mcp
```

Interactive mode commands:

- `help`: show interactive usage
- `exit`: quit interactive mode

Security notes:

- Prefer `--allowed-domains` whenever tasks involve credentials or sensitive data.
- `--allow-insecure` disables domain-lockdown enforcement for sensitive data and is unsafe for production.

## Advanced Usage

### Vision/Multimodal Support

Enable vision capabilities to let the AI analyze screenshots:

```typescript
import { Agent } from 'browser-use';
import { ChatGoogle } from 'browser-use/llm/google';

const llm = new ChatGoogle('gemini-2.5-flash');

const agent = new Agent({
  task: 'Describe what you see on this page and identify main visual elements',
  llm,
  use_vision: true,
  vision_detail_level: 'high', // 'auto' | 'low' | 'high'
});

const history = await agent.run(5);
```

### Custom Actions with Controller Registry

Extend the agent's capabilities with custom actions:

```typescript
import { Controller, ActionResult } from 'browser-use';
import { z } from 'zod';

const controller = new Controller();

controller.registry.action('Extract product information', {
  param_model: z.object({
    include_price: z.boolean().default(true),
    include_reviews: z.boolean().default(false),
  }),
})(async function extract_product_info(params, { page }) {
  const productData = await page.evaluate(() => ({
    title: document.querySelector('h1')?.textContent ?? null,
    price: document.querySelector('.price')?.textContent ?? null,
  }));

  return new ActionResult({
    extracted_content: JSON.stringify({ ...productData, ...params }),
    include_in_memory: true,
  });
});
```

### FileSystem Operations

Built-in file system support with PDF parsing:

```typescript
import { Agent } from 'browser-use';
import { ChatOpenAI } from 'browser-use/llm/openai';

const agent = new Agent({
  task: 'Download the PDF and extract text from page 1',
  llm: new ChatOpenAI(),
  file_system_path: './agent-workspace',
});

// FileSystem actions are available:
// - read_file: Read file contents (supports PDF)
// - write_file: Write content to file
// - replace_file_str: Replace text in file
```

### Browser Profile Configuration

Customize browser behavior with profiles:

```typescript
import { BrowserProfile, BrowserSession } from 'browser-use';

const profile = new BrowserProfile({
  window_size: { width: 1920, height: 1080 },
  disable_security: false,
  headless: true,
  chromium_sandbox: true, // Keep enabled by default in production
  args: ['--disable-blink-features=AutomationControlled'],
  wait_for_network_idle_page_load_time: 3, // seconds
  allowed_domains: ['example.com', '*.google.com'],
  cookies_file: './cookies.json',
  downloads_path: './downloads',
  highlight_elements: false, // Visual debugging
  viewport_expansion: 0, // Expand viewport for element detection
});

const browserSession = new BrowserSession({
  browser_profile: profile,
});

await browserSession.start();
```

If Chromium launch fails with `No usable sandbox` (common in restricted Linux CI),
`BrowserSession` automatically retries once with `chromium_sandbox: false` and logs
a warning. For deterministic CI behavior, set `chromium_sandbox: false` explicitly.

### MCP (Model Context Protocol) Integration

Connect to MCP servers for extended capabilities:

```typescript
import { MCPController } from 'browser-use';

const mcpController = new MCPController();

// Add MCP server
await mcpController.addServer('my-server', 'npx', [
  '-y',
  '@modelcontextprotocol/server-filesystem',
  '/path/to/data',
]);

// MCP tools are automatically available to the agent
const tools = await mcpController.listAllTools();
console.log('Available MCP tools:', tools);
```

### Gmail Integration

Built-in Gmail API support:

```typescript
import { GmailService } from 'browser-use';

// Gmail actions are automatically available:
// - get_recent_emails: Fetch recent emails
// - send_email: Send email via Gmail API

const agent = new Agent({
  task: 'Check my last 5 emails and summarize them',
  llm: new ChatOpenAI(),
  // Gmail credentials loaded from config files (or explicit GmailService options)
});
```

## Configuration

### Environment Variables

```bash
# LLM Configuration (provider-specific)
OPENAI_API_KEY=your-openai-key
ANTHROPIC_API_KEY=your-anthropic-key
GOOGLE_API_KEY=your-google-key
AWS_ACCESS_KEY_ID=your-aws-key
AWS_SECRET_ACCESS_KEY=your-aws-secret
AZURE_OPENAI_API_KEY=your-azure-key
AZURE_OPENAI_ENDPOINT=your-azure-endpoint
GROQ_API_KEY=your-groq-key
DEEPSEEK_API_KEY=your-deepseek-key

# Browser Configuration
BROWSER_USE_HEADLESS=true
BROWSER_USE_ALLOWED_DOMAINS=example.com,*.trusted.org
IN_DOCKER=true

# Logging Configuration
BROWSER_USE_LOGGING_LEVEL=info  # debug, info, warning, error

# Telemetry (optional)
ANONYMIZED_TELEMETRY=false

# Observability (optional)
LMNR_API_KEY=your-lmnr-key
```

### Agent Configuration

```typescript
interface AgentOptions {
  // Vision/multimodal
  use_vision?: boolean;
  vision_detail_level?: 'low' | 'high' | 'auto';

  // Error handling
  max_failures?: number; // default: 3
  retry_delay?: number; // seconds, default: 10
  max_actions_per_step?: number; // default: 5

  // Persistence / output
  save_conversation_path?: string | null;
  file_system_path?: string | null;
  validate_output?: boolean;
  include_attributes?: string[];

  // Runtime limits (seconds)
  llm_timeout?: number; // default: auto (model-dependent)
  step_timeout?: number; // default: 180
  final_response_after_failure?: boolean; // default: true

  // Planning / judgement
  use_judge?: boolean; // default: true
  judge_llm?: BaseChatModel | null; // default: null (falls back to llm)
  ground_truth?: string | null; // default: null
  enable_planning?: boolean; // default: true (auto-disabled in flash_mode)
  planning_replan_on_stall?: number; // default: 3
  planning_exploration_limit?: number; // default: 5
}

// Max step count is configured per run call:
await agent.run(100);
```

## Supported LLM Providers

### OpenAI

```typescript
import { ChatOpenAI } from 'browser-use/llm/openai';

const llm = new ChatOpenAI({
  model: 'gpt-4o', // or 'gpt-4', 'gpt-3.5-turbo'
  apiKey: process.env.OPENAI_API_KEY,
  temperature: 0.1,
  maxTokens: 4096,
});
```

### Anthropic Claude

```typescript
import { ChatAnthropic } from 'browser-use/llm/anthropic';

const llm = new ChatAnthropic({
  model: 'claude-3-5-sonnet-20241022', // or other Claude models
  apiKey: process.env.ANTHROPIC_API_KEY,
  temperature: 0.1,
});
```

### Google Gemini

```typescript
import { ChatGoogle } from 'browser-use/llm/google';

const llm = new ChatGoogle('gemini-2.5-flash');
// Configure GOOGLE_API_KEY in env. Optional:
// GOOGLE_API_BASE_URL / GOOGLE_API_VERSION
```

### AWS Bedrock

```typescript
import { ChatAnthropicBedrock } from 'browser-use/llm/aws';

const llm = new ChatAnthropicBedrock({
  model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
  region: 'us-east-1',
  max_tokens: 4096,
});
```

### Azure OpenAI

```typescript
import { ChatAzure } from 'browser-use/llm/azure';

const llm = new ChatAzure('gpt-4o');
// Configure AZURE_OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_VERSION in env.
```

### DeepSeek

```typescript
import { ChatDeepSeek } from 'browser-use/llm/deepseek';

const llm = new ChatDeepSeek('deepseek-chat');
```

### Groq

```typescript
import { ChatGroq } from 'browser-use/llm/groq';

const llm = new ChatGroq('mixtral-8x7b-32768');
```

### Ollama (Local)

```typescript
import { ChatOllama } from 'browser-use/llm/ollama';

const llm = new ChatOllama('llama3.1', 'http://localhost:11434');
```

### OpenRouter

```typescript
import { ChatOpenRouter } from 'browser-use/llm/openrouter';

const llm = new ChatOpenRouter('anthropic/claude-3-opus');
```

## Available Actions

The AI agent can perform these actions:

### Navigation

- **search_google** - Search query in Google (web results only)
- **go_to_url** - Navigate to a specific URL (with optional new tab)

### Element Interaction

- **click_element** - Click buttons, links, or clickable elements by index
- **input_text** - Type text into input fields and textareas by index

### Dropdown/Select

- **dropdown_options** - Get available options from a dropdown
- **select_dropdown** - Select option from dropdown by index

### Scrolling

- **scroll** - Scroll page up/down by pixels or direction
- **scroll_to_text** - Scroll to text content on page

### Tabs

- **switch_tab** - Switch to different browser tab by index
- **close_tab** - Close current or specific tab

### Keyboard

- **send_keys** - Send keyboard input (Enter, Tab, Escape, etc.)

### Content Extraction

- **extract_structured_data** - Extract specific data using LLM from page markdown

### FileSystem

- **read_file** - Read file contents (supports PDF parsing)
- **write_file** - Write content to file
- **replace_file_str** - Replace string in file

### Google Sheets

- **sheets_range** - Get cell range from Google Sheet
- **sheets_update** - Update Google Sheet cells
- **sheets_input** - Input data into Google Sheet

### Gmail

- **get_recent_emails** - Fetch recent emails from Gmail
- **send_email** - Send email via Gmail API

### Completion

- **done** - Mark task as completed with optional structured output

## Examples

See the `/examples` directory for detailed examples:

- `examples/simple-search.ts` - Basic web search automation
- `examples/search-wikipedia.ts` - Wikipedia navigation with vision
- `examples/test-vision.ts` - Vision/multimodal capabilities demo
- `examples/test-filesystem.ts` - File operations and PDF parsing
- `examples/openapi.ts` - Complex API documentation extraction

### Running Examples

```bash
# Set your API key
export OPENAI_API_KEY=your-key
# or for Google
export GOOGLE_API_KEY=your-key

# Run an example
npx tsx examples/simple-search.ts
```

## Error Handling

The library includes comprehensive error handling:

```typescript
import { Agent, AgentError } from 'browser-use';

try {
  const agent = new Agent({ task: 'Your task', llm });
  const history = await agent.run(10); // max 10 steps

  // Check completion status
  const lastStep = history.history[history.history.length - 1];
  if (lastStep?.result.is_done) {
    console.log('Task completed:', lastStep.result.extracted_content);
  } else {
    console.log('Task incomplete after max steps');
  }
} catch (error) {
  if (error instanceof AgentError) {
    console.error('Agent error:', error.message);
    console.error('Failed at step:', error.step);
  } else {
    console.error('Unexpected error:', error);
  }
}
```

## Development

### Building from Source

```bash
git clone https://github.com/webllm/browser-use.git
cd browser-use
yarn install  # Automatically installs Playwright browsers
yarn build
```

### Running Tests

```bash
# Run all tests
yarn test

# Run specific test
yarn test test/integration-advanced.test.ts

# Watch mode
yarn test:watch

# Validate published package exports
yarn test:pack
```

### Code Quality

```bash
# Lint
yarn lint

# Format
yarn prettier

# Type check
yarn typecheck
```

## Architecture

The library follows a modular, layered architecture:

```
┌──────────────────────────────────────────┐
│            Agent (Orchestrator)          │
│  - Task execution & planning             │
│  - LLM message management                │
│  - Step execution loop                   │
└─────────┬────────────────────────────────┘
          │
┌─────────▼────────────────────────────────┐
│           Controller (Actions)           │
│  - Action registry & execution           │
│  - Built-in actions (30+)                │
│  - Custom action support                 │
└─────────┬────────────────────────────────┘
          │
┌─────────▼────────────────────────────────┐
│        BrowserSession (Browser)          │
│  - Playwright integration                │
│  - Tab & page management                 │
│  - Navigation & interaction              │
└─────────┬────────────────────────────────┘
          │
┌─────────▼────────────────────────────────┐
│         DOMService (DOM Analysis)        │
│  - Element extraction                    │
│  - Clickable element detection           │
│  - History tree processing               │
└──────────────────────────────────────────┘

Supporting Services:
┌──────────────────────────────────────────┐
│  - LLM Clients (10+ providers)           │
│  - FileSystem (with PDF support)         │
│  - Screenshot Service                    │
│  - Token Tracking & Cost Calculation     │
│  - Telemetry (PostHog)                   │
│  - Observability (LMNR)                  │
│  - MCP Protocol Support                  │
│  - Gmail/Sheets Integration              │
└──────────────────────────────────────────┘
```

### Key Components

- **Agent**: High-level orchestrator managing task execution, LLM communication, and step-by-step planning
- **Controller**: Action registry and executor with 30+ built-in actions and custom action support
- **BrowserSession**: Browser lifecycle manager built on Playwright with tab management and state tracking
- **DOMService**: Intelligent DOM analyzer extracting relevant elements for AI consumption
- **MessageManager**: Manages conversation history with token optimization and context window management
- **FileSystem**: File operations with PDF parsing and workspace management
- **ScreenshotService**: Captures and manages screenshots for vision capabilities
- **Registry**: Type-safe action registration system with Zod schema validation

## Token Usage & Cost Tracking

The library automatically tracks token usage and calculates costs:

```typescript
import { TokenCost } from 'browser-use';

const agent = new Agent({ task: 'Your task', llm });
const history = await agent.run();

// Get token statistics
const stats = history.stats();
console.log(
  'Total tokens:',
  stats.total_input_tokens + stats.total_output_tokens
);
console.log('Steps:', stats.n_steps);

// Calculate cost (if pricing data available)
const cost = TokenCost.calculate(history);
console.log('Estimated cost: $', cost.toFixed(4));
```

## Screenshot & History Export

Generate GIF animations from agent execution history:

```typescript
import { create_history_gif } from 'browser-use';

const history = await agent.run();

await create_history_gif('My automation task', history, {
  output_path: 'agent-history.gif',
  duration: 3000, // ms per frame
  show_goals: true,
  show_task: true,
  show_logo: false,
});

console.log('Created agent-history.gif');
```

## Observability

Built-in observability with LMNR (Laminar) and custom debugging:

```typescript
import { observe, observe_debug } from 'browser-use';

// Automatic tracing (if LMNR_API_KEY set)
// All agent operations are automatically traced

// Custom debug observations
@observe_debug({ name: 'my_custom_operation' })
async function myFunction() {
  // Function execution is logged and timed
}
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'feat: add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Support

- 📚 [Documentation](https://github.com/webllm/browser-use)
- 🐛 [Issue Tracker](https://github.com/webllm/browser-use/issues)
- 💬 [Discussions](https://github.com/webllm/browser-use/discussions)

## Acknowledgments

### Original Project

This TypeScript implementation would not exist without the groundbreaking work of the original **[browser-use](https://github.com/browser-use/browser-use)** Python library:

- 🎯 **Original Project**: [browser-use/browser-use](https://github.com/browser-use/browser-use) (Python)
- 👏 **Created by**: The browser-use team and contributors
- 💡 **Inspiration**: All architectural decisions, agent design patterns, and innovative approaches come from the original Python implementation

We are deeply grateful to the original authors for creating such an elegant and powerful solution for AI-driven browser automation. This TypeScript port aims to faithfully replicate their excellent work for the JavaScript/TypeScript community.

### Key Differences from Python Version

While we strive to maintain feature parity with the Python version, there are some differences due to platform constraints:

- **Runtime**: Node.js/Deno/Bun instead of Python
- **Type System**: TypeScript's structural typing vs Python's duck typing
- **Async Model**: JavaScript Promises vs Python async/await (similar but different)
- **Ecosystem**: npm packages vs PyPI packages

### Technology Stack

This project is built with:

- [Playwright](https://playwright.dev/) - Browser automation framework
- [Zod](https://zod.dev/) - TypeScript-first schema validation
- [OpenAI](https://openai.com/), [Anthropic](https://anthropic.com/), [Google](https://ai.google.dev/) - LLM providers
- And many other excellent open-source libraries

### Community

- 🌟 **Star the original Python project**: [browser-use/browser-use](https://github.com/browser-use/browser-use)
- 🌟 **Star this TypeScript port**: [webllm/browser-use](https://github.com/webllm/browser-use)
- 💬 **Join the community**: Share your use cases and contribute to both projects!

## Related Projects

- 🐍 [browser-use (Python)](https://github.com/browser-use/browser-use) - The original and official implementation
- 🎭 [Playwright](https://playwright.dev/) - The browser automation foundation
- 🤖 [LangChain](https://www.langchain.com/) - LLM application framework
- 🦜 [Laminar](https://laminar.run/) - LLM observability platform

## License

MIT License - see [LICENSE](LICENSE) for details.
