# LLM Providers Guide

Browser-Use supports multiple LLM providers through a unified interface. This guide covers setup and configuration for each provider.

## Supported Providers

| Provider | Vision Support | Reasoning Models | Caching | Notes |
|----------|---------------|------------------|---------|-------|
| OpenAI | ✅ | ✅ (o1, o3, o4) | ❌ | Default provider |
| Anthropic | ✅ | ❌ | ✅ | Best for complex tasks |
| Google Gemini | ✅ | ✅ | ❌ | Extended thinking support |
| Azure OpenAI | ✅ | ✅ | ❌ | Enterprise deployment |
| AWS Bedrock | ✅ | ❌ | ❌ | Claude via AWS |
| Groq | ❌ | ❌ | ❌ | Fastest inference |
| Ollama | ❌ | ❌ | ❌ | Local models |
| DeepSeek | ❌ | ❌ | ❌ | Cost-effective |
| OpenRouter | Varies | Varies | ❌ | Multi-model routing |

## OpenAI

### Setup

```bash
npm install openai  # Installed automatically with browser-use
```

Set your API key:
```bash
export OPENAI_API_KEY=sk-your-api-key
```

### Usage

```typescript
import { ChatOpenAI } from 'browser-use/llm/openai';

const llm = new ChatOpenAI({
  model: 'gpt-4o',
  apiKey: process.env.OPENAI_API_KEY,
  temperature: 0.7
});
```

### Available Models

| Model | Vision | Best For |
|-------|--------|----------|
| `gpt-4o` | ✅ | General tasks, best quality |
| `gpt-4o-mini` | ✅ | Fast, cost-effective |
| `gpt-4-turbo` | ✅ | Complex reasoning |
| `o1` | ❌ | Advanced reasoning |
| `o1-mini` | ❌ | Fast reasoning |
| `o3` | ❌ | Next-gen reasoning |
| `o3-mini` | ❌ | Fast next-gen reasoning |
| `o4-mini` | ❌ | Latest reasoning |

### Reasoning Models

For reasoning models (o1, o3, o4 series), use the `reasoning_effort` parameter:

```typescript
const llm = new ChatOpenAI({
  model: 'o3-mini',
  apiKey: process.env.OPENAI_API_KEY,
  reasoning_effort: 'medium'  // 'low', 'medium', 'high'
});
```

### Advanced Options

```typescript
const llm = new ChatOpenAI({
  model: 'gpt-4o',
  apiKey: process.env.OPENAI_API_KEY,
  temperature: 0.7,
  baseURL: 'https://api.openai.com/v1',  // Custom endpoint
  maxRetries: 3,
  timeout: 60000
});
```

---

## Anthropic

### Setup

```bash
npm install @anthropic-ai/sdk
```

Set your API key:
```bash
export ANTHROPIC_API_KEY=sk-ant-your-api-key
```

### Usage

```typescript
import { ChatAnthropic } from 'browser-use/llm/anthropic';

const llm = new ChatAnthropic({
  model: 'claude-sonnet-4-20250514',
  apiKey: process.env.ANTHROPIC_API_KEY,
  temperature: 0.7
});
```

### Available Models

| Model | Vision | Best For |
|-------|--------|----------|
| `claude-sonnet-4-20250514` | ✅ | Default, balanced |
| `claude-opus-4-20250514` | ✅ | Complex tasks |
| `claude-3-5-sonnet-20241022` | ✅ | Previous generation |
| `claude-3-opus-20240229` | ✅ | Previous generation |

### Cache Control

Anthropic supports prompt caching for reduced costs:

```typescript
import { SystemMessage } from 'browser-use/llm/messages';

// Mark messages for caching
const systemMsg = new SystemMessage('Your system prompt...');
systemMsg.cache = true;  // Enable caching
```

### Advanced Options

```typescript
const llm = new ChatAnthropic({
  model: 'claude-sonnet-4-20250514',
  apiKey: process.env.ANTHROPIC_API_KEY,
  temperature: 0.7,
  maxTokens: 4096,
  baseURL: 'https://api.anthropic.com'
});
```

---

## Google Gemini

### Setup

```bash
npm install @google/generative-ai
```

Set your API key:
```bash
export GOOGLE_API_KEY=your-api-key
```

### Usage

```typescript
import { ChatGoogle } from 'browser-use/llm/google';

const llm = new ChatGoogle({
  model: 'gemini-2.0-flash',
  apiKey: process.env.GOOGLE_API_KEY,
  temperature: 0.7
});
```

### Available Models

| Model | Vision | Best For |
|-------|--------|----------|
| `gemini-2.0-flash` | ✅ | Default, fast |
| `gemini-2.0-flash-exp` | ✅ | Experimental features |
| `gemini-exp-05-28` | ✅ | Latest experimental |
| `gemini-1.5-pro` | ✅ | Complex tasks |
| `gemini-1.5-flash` | ✅ | Cost-effective |

### Extended Thinking

Gemini supports extended thinking for complex reasoning:

```typescript
const llm = new ChatGoogle({
  model: 'gemini-2.0-flash',
  apiKey: process.env.GOOGLE_API_KEY,
  thinking: true  // Enable extended thinking
});
```

---

## Azure OpenAI

### Setup

Set your credentials:
```bash
export AZURE_OPENAI_API_KEY=your-api-key
export AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
```

### Usage

```typescript
import { AzureChatOpenAI } from 'browser-use/llm/azure';

const llm = new AzureChatOpenAI({
  model: 'gpt-4o',
  apiKey: process.env.AZURE_OPENAI_API_KEY,
  endpoint: process.env.AZURE_OPENAI_ENDPOINT,
  apiVersion: '2024-02-15-preview',
  deploymentName: 'your-deployment-name'
});
```

### Options

```typescript
const llm = new AzureChatOpenAI({
  model: 'gpt-4o',
  apiKey: process.env.AZURE_OPENAI_API_KEY,
  endpoint: process.env.AZURE_OPENAI_ENDPOINT,
  apiVersion: '2024-02-15-preview',
  deploymentName: 'gpt-4o-deployment',
  temperature: 0.7,
  maxTokens: 4096
});
```

---

## AWS Bedrock

### Setup

Configure AWS credentials:
```bash
export AWS_ACCESS_KEY_ID=your-access-key
export AWS_SECRET_ACCESS_KEY=your-secret-key
export AWS_REGION=us-east-1
```

Or use AWS profiles:
```bash
export AWS_PROFILE=your-profile
```

### Usage

```typescript
import { ChatBedrock } from 'browser-use/llm/aws';

const llm = new ChatBedrock({
  model: 'anthropic.claude-3-sonnet-20240229-v1:0',
  region: 'us-east-1'
});
```

### With Explicit Credentials

```typescript
const llm = new ChatBedrock({
  model: 'anthropic.claude-3-sonnet-20240229-v1:0',
  region: 'us-east-1',
  credentials: {
    accessKeyId: 'your-access-key',
    secretAccessKey: 'your-secret-key'
  }
});
```

### Available Models

| Model ID | Description |
|----------|-------------|
| `anthropic.claude-3-opus-20240229-v1:0` | Claude 3 Opus |
| `anthropic.claude-3-sonnet-20240229-v1:0` | Claude 3 Sonnet |
| `anthropic.claude-3-haiku-20240307-v1:0` | Claude 3 Haiku |

---

## Groq

### Setup

Set your API key:
```bash
export GROQ_API_KEY=your-api-key
```

### Usage

```typescript
import { ChatGroq } from 'browser-use/llm/groq';

const llm = new ChatGroq({
  model: 'llama-3.3-70b-versatile',
  apiKey: process.env.GROQ_API_KEY,
  temperature: 0.7
});
```

### Available Models

| Model | Speed | Best For |
|-------|-------|----------|
| `llama-3.3-70b-versatile` | Fast | General tasks |
| `llama-3.1-70b-versatile` | Fast | General tasks |
| `llama-3.1-8b-instant` | Fastest | Quick tasks |
| `mixtral-8x7b-32768` | Fast | Long context |

**Note:** Groq currently doesn't support vision. Use with `use_vision: false`.

---

## Ollama

### Setup

Install Ollama from [ollama.ai](https://ollama.ai):
```bash
curl -fsSL https://ollama.ai/install.sh | sh
ollama pull llama3
```

### Usage

```typescript
import { ChatOllama } from 'browser-use/llm/ollama';

const llm = new ChatOllama({
  model: 'llama3',
  baseUrl: 'http://localhost:11434'
});
```

### Available Models

Any model available in Ollama:
- `llama3`, `llama3:70b`
- `mistral`, `mixtral`
- `codellama`
- `phi3`
- And many more...

**Note:** Most Ollama models don't support vision. Use with `use_vision: false`.

---

## DeepSeek

### Setup

Set your API key:
```bash
export DEEPSEEK_API_KEY=your-api-key
```

### Usage

```typescript
import { ChatDeepSeek } from 'browser-use/llm/deepseek';

const llm = new ChatDeepSeek({
  model: 'deepseek-chat',
  apiKey: process.env.DEEPSEEK_API_KEY,
  temperature: 0.7
});
```

### Available Models

| Model | Best For |
|-------|----------|
| `deepseek-chat` | General conversation |
| `deepseek-coder` | Code generation |

**Note:** DeepSeek doesn't support vision yet. Use with `use_vision: false`.

---

## OpenRouter

### Setup

Set your API key:
```bash
export OPENROUTER_API_KEY=your-api-key
```

### Usage

```typescript
import { ChatOpenRouter } from 'browser-use/llm/openrouter';

const llm = new ChatOpenRouter({
  model: 'anthropic/claude-3-opus',
  apiKey: process.env.OPENROUTER_API_KEY,
  temperature: 0.7
});
```

### Model Selection

OpenRouter provides access to multiple providers. Use provider/model format:

| Model | Provider |
|-------|----------|
| `anthropic/claude-3-opus` | Anthropic |
| `openai/gpt-4-turbo` | OpenAI |
| `google/gemini-pro` | Google |
| `meta-llama/llama-3-70b-instruct` | Meta |

---

## Provider Comparison

### Speed vs Quality

```
Speed  ←──────────────────────────────────────────→ Quality
       Groq    Gemini-Flash    GPT-4o-mini    GPT-4o    Claude-Opus
       Ollama  DeepSeek        Gemini-Pro     Claude-Sonnet
```

### Cost Considerations

| Provider | Input Tokens | Output Tokens | Notes |
|----------|--------------|---------------|-------|
| OpenAI GPT-4o | $2.50/1M | $10/1M | Standard pricing |
| OpenAI GPT-4o-mini | $0.15/1M | $0.60/1M | Budget option |
| Anthropic Claude | $3/1M | $15/1M | With caching discounts |
| Google Gemini | $0.075/1M | $0.30/1M | Cost-effective |
| Groq | Free tier | Free tier | Rate limited |
| Ollama | Free | Free | Self-hosted |

### Recommended Configurations

**For Development:**
```typescript
// Fast iteration, low cost
const llm = new ChatOpenAI({ model: 'gpt-4o-mini' });
// or
const llm = new ChatGroq({ model: 'llama-3.3-70b-versatile' });
```

**For Production:**
```typescript
// Best quality
const llm = new ChatOpenAI({ model: 'gpt-4o' });
// or
const llm = new ChatAnthropic({ model: 'claude-sonnet-4-20250514' });
```

**For Complex Reasoning:**
```typescript
const llm = new ChatOpenAI({
  model: 'o3-mini',
  reasoning_effort: 'high'
});
```

**For Local/Privacy:**
```typescript
const llm = new ChatOllama({ model: 'llama3:70b' });
```

---

## Custom Provider Implementation

To add a custom LLM provider, implement the `BaseChatModel` interface:

```typescript
import { BaseChatModel, Message, ChatInvokeCompletion } from 'browser-use/llm';

class MyCustomLLM implements BaseChatModel {
  model: string;
  provider = 'my-provider';

  constructor(options: { model: string; apiKey: string }) {
    this.model = options.model;
  }

  async ainvoke(
    messages: Message[],
    output_format?: ZodSchema
  ): Promise<ChatInvokeCompletion> {
    // Implement your LLM call here
    const response = await this.callMyAPI(messages);

    return new ChatInvokeCompletion(
      response.content,
      {
        prompt_tokens: response.usage.input,
        completion_tokens: response.usage.output,
        total_tokens: response.usage.total
      }
    );
  }
}
```
