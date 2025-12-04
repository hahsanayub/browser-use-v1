import 'dotenv/config';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { ChatAzure } from '../src/llm/azure/chat.js';
import { UserMessage } from '../src/llm/messages.js';
import fs from 'node:fs';
import path from 'node:path';

const VIEWPORT = { width: 1440, height: 900 };
const DEFAULT_AZURE_ENDPOINT =
  'https://oai-ai4m-rnd-eastus-001.openai.azure.com';
const DEFAULT_AZURE_API_VERSION = '2025-03-01-preview';
const DEFAULT_AZURE_DEPLOYMENT =
  'oai-ai4m-rnd-eastus-001-gpt-4-0125-Preview-001';

async function main() {
  // Ensure the Azure client has the required env values
  process.env.AZURE_OPENAI_ENDPOINT =
    process.env.AZURE_OPENAI_ENDPOINT || DEFAULT_AZURE_ENDPOINT;
  process.env.AZURE_OPENAI_API_VERSION =
    process.env.AZURE_OPENAI_API_VERSION || DEFAULT_AZURE_API_VERSION;

  const llm = new ChatAzure(DEFAULT_AZURE_DEPLOYMENT);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logDir = path.join('logs', `azure-wiki-${timestamp}`);
  fs.mkdirSync(logDir, { recursive: true });

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;

  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: VIEWPORT });

    const page = await context.newPage();
    await page.goto('https://en.wikipedia.org/wiki/Test-driven_development', {
      waitUntil: 'domcontentloaded',
    });

    const targetText =
      'Refactor as needed while ensuring all tests continue to pass';
    const target = page.locator('dt', { hasText: targetText }).first();
    await target.waitFor({ state: 'visible', timeout: 30000 });
    await target.scrollIntoViewIfNeeded();

    const sectionContent = await target.evaluate((el) => {
      const texts: string[] = [];
      const termText = el.textContent?.trim();
      if (termText) texts.push(termText);

      const dd = el.nextElementSibling;
      if (dd && dd.tagName.toLowerCase() === 'dd') {
        const detailText = dd.textContent?.trim();
        if (detailText) texts.push(detailText);
      }

      return texts.join('\n').trim();
    });

    if (!sectionContent) {
      throw new Error('Could not extract section content to summarize.');
    }

    const summaryResponse = await llm.ainvoke([
      new UserMessage(
        `Summarize the following section in 2-3 sentences, focusing on the guidance around refactoring:\n\n${sectionContent}`
      ),
    ]);

    // Save summary to file
    const summaryText = String(summaryResponse.completion ?? '').trim();
    fs.writeFileSync(path.join(logDir, 'summary.txt'), summaryText || '(empty)', 'utf8');

    // Save screenshot
    await page.screenshot({
      path: path.join(logDir, 'page.png'),
      fullPage: true,
    });

    console.log('Summary:');
    console.log(summaryText);
    console.log(`Final page: ${await page.title()} (${page.url()})`);
    console.log(`Logs saved to: ${logDir}`);
  } catch (error) {
    console.error('Wikipedia Azure example failed:', error);
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
