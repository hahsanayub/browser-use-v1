#!/usr/bin/env node
import { Agent } from './agent/service.js';
import { ChatOpenAI } from './llm/openai/chat.js';
import { MCPServer } from './mcp/server.js';
import { get_browser_use_version } from './utils.js';
import dotenv from 'dotenv';

dotenv.config();

async function runMcpServer() {
  const server = new MCPServer('browser-use', get_browser_use_version());
  await server.start();

  const shutdown = async () => {
    await server.stop();
    process.exit(0);
  };

  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

  await new Promise(() => {});
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--mcp')) {
    await runMcpServer();
    return;
  }

  if (args.length === 0 || args.includes('--help')) {
    console.log('Usage: browser-use <task>');
    console.log('       browser-use --mcp');
    process.exit(1);
  }

  const task = args.join(' ');
  console.log(`Starting task: ${task}`);

  const llm = new ChatOpenAI();
  const agent = new Agent({ task, llm });

  try {
    await agent.run();
  } catch (error) {
    console.error('Error running agent:', error);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
