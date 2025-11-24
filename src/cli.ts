import { Agent } from './agent/service.js';
import { ChatOpenAI } from './llm/openai/chat.js';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log('Usage: node dist/cli.js <task>');
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
