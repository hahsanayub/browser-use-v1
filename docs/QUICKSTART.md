# Quick Start Guide

Get up and running with Browser-Use in 5 minutes.

## Prerequisites

- Node.js 18+ installed
- An API key from a supported LLM provider (OpenAI, Anthropic, etc.)

## Step 1: Install Browser-Use

```bash
npm install browser-use
```

This will also install Playwright as a dependency.

## Step 2: Install Browser Binaries

```bash
npx playwright install chromium
```

## Step 3: Set Up Environment Variables

Create a `.env` file in your project root:

```env
# Choose your LLM provider
OPENAI_API_KEY=sk-your-openai-key
# or
ANTHROPIC_API_KEY=sk-ant-your-anthropic-key
# or
GOOGLE_API_KEY=your-google-key
```

## Step 4: Create Your First Agent

Create a file `example.ts`:

```typescript
import { Agent } from 'browser-use';
import { ChatOpenAI } from 'browser-use/llm/openai';
import 'dotenv/config';

async function main() {
  // Initialize the LLM
  const llm = new ChatOpenAI({
    model: 'gpt-4o',
    apiKey: process.env.OPENAI_API_KEY
  });

  // Create the agent with a task
  const agent = new Agent({
    task: 'Search for "browser automation" on Google and tell me the first result',
    llm,
    use_vision: true  // Enable screenshot analysis
  });

  // Run the agent
  const history = await agent.run();

  // Output results
  if (history.is_successful()) {
    console.log('Task completed successfully!');
    console.log('Result:', history.final_result());
  } else {
    console.log('Task failed');
    console.log('Errors:', history.errors());
  }
}

main().catch(console.error);
```

## Step 5: Run Your Agent

```bash
npx tsx example.ts
```

## Using the CLI

Browser-Use includes a CLI for quick tasks:

```bash
# Run a simple task
npx browser-use "Go to example.com and extract the page title"

# Run with specific provider
npx browser-use --provider anthropic "Search for AI news"

# Run in headless mode
npx browser-use --headless "Check the weather"
```

## Using with Claude Desktop (MCP)

Start Browser-Use as an MCP server:

```bash
npx browser-use --mcp
```

Then add to your Claude Desktop configuration:

```json
{
  "mcpServers": {
    "browser-use": {
      "command": "npx",
      "args": ["browser-use", "--mcp"]
    }
  }
}
```

## Common Options

### Headless Mode

Run without displaying the browser:

```typescript
const agent = new Agent({
  task: 'Your task',
  llm,
  browser_profile: new BrowserProfile({ headless: true })
});
```

### Custom Browser Session

Use an existing Playwright browser:

```typescript
import { chromium } from 'playwright';
import { BrowserSession } from 'browser-use';

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();

const session = new BrowserSession({
  browser,
  browser_context: context,
  page
});

const agent = new Agent({
  task: 'Your task',
  llm,
  browser_session: session
});
```

### Vision Mode

Enable or disable screenshot-based understanding:

```typescript
const agent = new Agent({
  task: 'Your task',
  llm,
  use_vision: true,           // Enable vision
  vision_detail_level: 'high' // 'auto', 'low', or 'high'
});
```

### Step Limits

Control maximum execution steps:

```typescript
// Limit to 20 steps
const history = await agent.run(20);
```

## Next Steps

- Read the [Architecture](./ARCHITECTURE.md) guide to understand how Browser-Use works
- Explore [Built-in Actions](./ACTIONS.md) available to agents
- Learn about [LLM Provider Configuration](./LLM_PROVIDERS.md)
- Check out [Examples](./EXAMPLES.md) for more use cases

## Troubleshooting

### Browser doesn't launch

Ensure Playwright browsers are installed:
```bash
npx playwright install chromium
```

### LLM errors

1. Verify your API key is set correctly
2. Check your API quota/limits
3. Try a different model if rate-limited

### Timeout errors

Increase timeouts in agent settings:
```typescript
const agent = new Agent({
  task: 'Your task',
  llm,
  llm_timeout: 120000,  // 2 minutes for LLM calls
  step_timeout: 300000  // 5 minutes per step
});
```
