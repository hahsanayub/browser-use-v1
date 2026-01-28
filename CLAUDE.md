# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Browser-Use is a TypeScript port of the Python [browser-use](https://github.com/browser-use/browser-use) library. It enables AI agents to autonomously control web browsers using LLMs and Playwright.

## Commands

```bash
# Build
npm run build              # Compile TypeScript to dist/

# Test
npm test                   # Run all tests with vitest
npm run test:watch         # Watch mode
npx vitest run test/controller.test.ts  # Run single test file

# Lint & Format
npm run lint               # ESLint
npm run prettier           # Format with Prettier

# Development
npm run dev                # Run src/index.ts with tsx
npx tsx examples/simple-search.ts  # Run an example
```

## Architecture

```
Agent (orchestrator)
    ↓
Controller (action execution)
    ↓
BrowserSession (Playwright wrapper)
    ↓
DomService (DOM extraction)
```

### Key Components

**Agent** (`src/agent/service.ts`): Main orchestrator that executes tasks via an LLM decision loop. Takes a task description and LLM, runs step-by-step until completion or max_steps.

**Controller** (`src/controller/service.ts`): Manages action registration and execution via Registry. Built-in actions are in `src/controller/registry/service.ts`.

**Registry** (`src/controller/registry/service.ts`): Decorator-based action registration using `@action()`. Actions are registered with Zod schemas for parameter validation.

**BrowserSession** (`src/browser/session.ts`): Manages Playwright browser lifecycle, tab management, and page state tracking.

**BrowserProfile** (`src/browser/profile.ts`): Configuration for browser launch options (headless, viewport, proxy, etc.).

**DomService** (`src/dom/service.ts`): Extracts interactive elements from pages for LLM consumption. Uses `buildDomTree.ts` for DOM tree construction.

**MessageManager** (`src/agent/message-manager/service.ts`): Manages conversation history with token optimization for the LLM context window.

### LLM Providers

All in `src/llm/` - each provider has: `chat.ts` (main client), `serializer.ts` (message format), `index.ts` (exports).

Providers: OpenAI, Anthropic, Google, Azure, AWS Bedrock, Groq, Ollama, DeepSeek, OpenRouter.

### Data Flow

1. Agent receives task → creates system prompt with available actions
2. LLM returns `AgentOutput` with actions to execute
3. Controller executes actions via Registry → returns `ActionResult`
4. Results fed back to LLM for next step
5. Loop until `done` action or max_steps

### Key Types

- `AgentOutput` (`src/agent/views.ts`): LLM response with thinking, memory, next_goal, actions
- `ActionResult` (`src/controller/views.ts`): Action execution result with extracted_content, is_done, error
- `BrowserStateSummary` (`src/browser/views.ts`): Current browser state including DOM tree and element index map

## Code Patterns

- **Views files**: Contain Zod schemas and type definitions (`views.ts`)
- **Service files**: Contain main class implementations (`service.ts`)
- **ES Modules**: Uses `.js` extensions in imports (compiled output)
- **Action decorator**: `registry.action(description, options)(handler)` pattern

## Testing

Tests are in `test/` using Vitest. Key test files:
- `controller.test.ts`: Registry and action execution
- `browser-session.test.ts`: BrowserSession lifecycle
- `dom.test.ts`: DOM extraction
- `agent.test.ts`: Agent execution flow
- `llm.test.ts`: LLM provider tests
