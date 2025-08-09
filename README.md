# browser-use

A TypeScript-first library for programmatic browser control, designed for building AI-powered web agents.

## Features

- 🤖 **AI-Powered**: Built specifically for LLM-driven web automation
- 🎯 **Type-Safe**: Full TypeScript support with comprehensive type definitions
- 🌐 **Multi-Browser**: Support for Chromium, Firefox, and WebKit via Playwright
- 🔌 **LLM Agnostic**: Works with OpenAI, Anthropic, Google, and custom providers
- 🛡️ **Robust**: Built-in error handling, recovery, and graceful shutdown
- 📊 **Observable**: Comprehensive logging and execution history
- ⚙️ **Configurable**: Flexible configuration system with environment variable support

## Quick Start

### Installation

```bash
npm install browser-use
# or
yarn add browser-use
```

### Install Playwright Browsers

```bash
npx playwright install
```

### Basic Usage

```typescript
import { run } from 'browser-use';

// Set your LLM API key
process.env.OPENAI_API_KEY = 'your-api-key';

// Run a simple automation task
const { controller, history } = await run(
  'Go to google.com and search for "TypeScript browser automation"',
  {
    headless: false, // Set to true for headless mode
    startUrl: 'https://google.com'
  }
);

console.log(`Task completed in ${history.length} steps`);

// Always cleanup
await controller.cleanup();
```

## Advanced Usage

### Custom Configuration

```typescript
import { createController } from 'browser-use';

const controller = await createController({
  config: {
    llm: {
      provider: 'openai',
      apiKey: process.env.OPENAI_API_KEY,
      model: 'gpt-4',
      temperature: 0.1,
    },
    browser: {
      headless: false,
      browserType: 'chromium',
      viewport: { width: 1920, height: 1080 },
    },
    logging: {
      level: 'debug',
      console: true,
    },
  },
});

// Navigate to a page
await controller.goto('https://example.com');

// Run tasks with custom agent configuration
const history = await controller.run('Take a screenshot of this page', {
  maxSteps: 10,
  actionTimeout: 5000,
  customInstructions: 'Be extra careful with form interactions',
});
```

### Using Individual Components

```typescript
import { 
  Browser, 
  BrowserContext, 
  Agent, 
  createLLMClient,
  DOMService 
} from 'browser-use';

// Create browser
const browser = new Browser({ browserType: 'chromium', headless: false });
await browser.launch();

// Create context
const context = new BrowserContext(browser.getBrowser()!, {});
await context.launch();

// Create page and navigate
const page = await context.newPage();
await page.goto('https://example.com');

// Create LLM client
const llmClient = createLLMClient({
  provider: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'gpt-3.5-turbo',
});

// Create agent
const agent = new Agent(context, llmClient);

// Run automation
const history = await agent.run('Find and click the main navigation menu');
```

## Configuration

### Environment Variables

```bash
# LLM Configuration
LLM_API_KEY=your-api-key
LLM_PROVIDER=openai  # openai, anthropic, google, custom
LLM_MODEL=gpt-3.5-turbo
LLM_BASE_URL=https://api.openai.com/v1  # for custom providers

# Browser Configuration
BROWSER_USE_HEADLESS=true
BROWSER_USE_TYPE=chromium  # chromium, firefox, webkit
BROWSER_USE_TIMEOUT=30000

# Logging Configuration
LOG_LEVEL=info  # debug, info, warn, error
LOG_FILE=/path/to/logfile.log

# General Configuration
BROWSER_USE_MAX_STEPS=100
BROWSER_USE_CONFIG_DIR=/path/to/config
```

### Configuration File

The library automatically creates a configuration file at `~/.config/browser-use/config.json`:

```json
{
  "browser": {
    "browserType": "chromium",
    "headless": true,
    "args": [],
    "timeout": 30000,
    "viewport": {
      "width": 1280,
      "height": 720
    }
  },
  "llm": {
    "provider": "openai",
    "model": "gpt-3.5-turbo",
    "timeout": 30000,
    "maxTokens": 4000,
    "temperature": 0.7
  },
  "logging": {
    "level": "info",
    "console": true,
    "json": false
  },
  "maxSteps": 100
}
```

## Supported LLM Providers

### OpenAI
```typescript
{
  provider: 'openai',
  apiKey: 'your-openai-api-key',
  model: 'gpt-4', // or gpt-3.5-turbo
}
```

### Anthropic Claude
```typescript
{
  provider: 'anthropic',
  apiKey: 'your-anthropic-api-key',
  model: 'claude-3-sonnet-20240229',
}
```

### Custom Providers
```typescript
{
  provider: 'custom',
  apiKey: 'your-api-key',
  baseUrl: 'https://your-custom-api.com/v1',
  model: 'your-model-name',
}
```

## Available Actions

The AI agent can perform these actions:

- **click**: Click on buttons, links, or other clickable elements
- **type**: Type text into input fields and textareas
- **scroll**: Scroll the page in any direction
- **goto**: Navigate to a specific URL
- **wait**: Wait for elements to appear or for time to pass
- **key**: Press keyboard keys (Enter, Tab, Escape, etc.)
- **hover**: Hover over elements to reveal hidden content
- **screenshot**: Take screenshots of the current page
- **finish**: Mark the task as completed

## Examples

See the `/examples` directory for more detailed examples:

- `examples/simple-search.ts` - Basic web search automation
- `examples/advanced-usage.ts` - Advanced configuration and multiple tasks

## Error Handling

The library includes comprehensive error handling:

```typescript
try {
  const { controller, history } = await run('Your task description');
  
  // Check if task was successful
  const lastStep = history[history.length - 1];
  if (lastStep?.result.success) {
    console.log('Task completed successfully!');
  } else {
    console.log('Task failed:', lastStep?.result.error);
  }
} catch (error) {
  console.error('Automation failed:', error);
}
```

## Development

### Building from Source

```bash
git clone https://github.com/unadlib/browser-use.git
cd browser-use
yarn install
yarn build
```

### Running Tests

```bash
yarn test
```

### Running Examples

```bash
# Make sure to set your API key first
export OPENAI_API_KEY=your-api-key

# Run an example
yarn tsx examples/simple-search.ts
```

## Architecture

The library follows a modular architecture:

- **Controller**: Main orchestrator that coordinates all components
- **Browser**: Manages Playwright browser instances and lifecycle
- **BrowserContext**: Handles browser contexts and pages
- **Agent**: AI-powered automation agent with LLM integration
- **DOMService**: Analyzes and processes web page content for AI consumption
- **LLM Clients**: Abstractions for different LLM providers
- **Configuration**: Multi-source configuration management
- **Logging**: Structured logging with multiple output formats
- **Signal Handler**: Graceful shutdown and resource cleanup

## License

MIT License - see [LICENSE](LICENSE) for details.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
