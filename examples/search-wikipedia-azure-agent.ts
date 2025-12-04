import 'dotenv/config';
import { chromium } from 'playwright';
import { Agent, ActionResult } from '../src/index';
import { ChatAzure } from '../src/llm/azure/chat.js';
import { BrowserSession } from '../src/browser/index.js';
import fs from 'node:fs';
import path from 'node:path';
import {
  GoToUrlActionSchema,
  InputTextActionSchema,
  ClickElementActionSchema,
  ScrollActionSchema,
  ExtractStructuredDataActionSchema,
  WriteFileActionSchema,
} from '../src/controller/views.js';
import { z } from 'zod';

const timestamp = new Date().toISOString();

async function main() {
  // Ensure Azure env defaults
  process.env.AZURE_OPENAI_ENDPOINT =
    process.env.AZURE_OPENAI_ENDPOINT ||
    'https://oai-ai4m-rnd-eastus-001.openai.azure.com';
  process.env.AZURE_OPENAI_API_VERSION =
    process.env.AZURE_OPENAI_API_VERSION || '2025-03-01-preview';

  const llm = new ChatAzure(
    process.env.AZURE_OPENAI_DEPLOYMENT ||
      'oai-ai4m-rnd-eastus-001-gpt-4-0125-Preview-001'
  );

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  const browserSession = new BrowserSession({
    browser,
    browser_context: context,
    page,
    profile: {
      viewport: { width: 1440, height: 900 },
      timeout: 45000,
    },
  });
  await browserSession.start();
  await browserSession.navigate_to('https://www.wikipedia.org/');

  const agent = new Agent({
    task: "Navigate to https://en.wikipedia.org/wiki/Test-driven_development, scroll to the text 'Refactor as needed while ensuring all tests continue to pass', summarize that section, and finish.",
    llm,
    browser_session: browserSession,
    use_vision: true,
    max_actions_per_step: 10,
    save_conversation_path: `logs/${timestamp}/conversations`,
    file_system_path: `logs/${timestamp}`,
    llm_timeout: 60,
    step_timeout: 180,
  });

  // Provide simpler action aliases for the LLM
  const registry = agent.controller.registry;

  async function go_to_url(
    params: z.infer<typeof GoToUrlActionSchema>,
    { browser_session }: { browser_session: BrowserSession | null }
  ) {
    if (!browser_session) throw new Error('Browser session missing');
    await browser_session.navigate_to(params.url);
    const msg = `🔗 Navigated to ${params.url}`;
    return new ActionResult({
      extracted_content: msg,
      include_in_memory: true,
      long_term_memory: msg,
    });
  }

  async function input_text(
    params: z.infer<typeof InputTextActionSchema>,
    { browser_session }: { browser_session: BrowserSession | null }
  ) {
    if (!browser_session) throw new Error('Browser session missing');
    const element = await browser_session.get_dom_element_by_index(params.index);
    if (!element) {
      throw new Error(`Element index ${params.index} does not exist`);
    }
    await browser_session._input_text_element_node(element, params.text);
    const msg = `⌨️  Input ${params.text} into index ${params.index}`;
    return new ActionResult({
      extracted_content: msg,
      include_in_memory: true,
      long_term_memory: msg,
    });
  }

  async function click_element_by_index(
    params: z.infer<typeof ClickElementActionSchema>,
    { browser_session }: { browser_session: BrowserSession | null }
  ) {
    if (!browser_session) throw new Error('Browser session missing');
    const element = await browser_session.get_dom_element_by_index(params.index);
    if (!element) {
      throw new Error(`Element index ${params.index} does not exist`);
    }
    const initialTabs = Array.isArray(browser_session.tabs)
      ? browser_session.tabs.length
      : 0;
    const downloadPath = await browser_session._click_element_node(element);
    let msg = '';
    if (downloadPath) {
      msg = `💾 Downloaded file to ${downloadPath}`;
    } else {
      const snippet =
        element.get_all_text_till_next_clickable_element?.(2) ?? '';
      msg = `🖱️  Clicked button with index ${params.index}: ${snippet}`;
    }
    if (
      Array.isArray(browser_session.tabs) &&
      browser_session.tabs.length > initialTabs
    ) {
      msg += ' - New tab opened - switching to it';
      await browser_session.switch_to_tab(-1);
    }
    return new ActionResult({
      extracted_content: msg,
      include_in_memory: true,
      long_term_memory: msg,
    });
  }

  registry.action('go_to_url', { param_model: GoToUrlActionSchema })(
    go_to_url
  );
  registry.action('input_text', { param_model: InputTextActionSchema })(
    input_text
  );
  registry.action('click_element_by_index', {
    param_model: ClickElementActionSchema,
  })(click_element_by_index);

  async function scroll_down(
    params: Partial<z.infer<typeof ScrollActionSchema>>,
    { browser_session }: { browser_session: BrowserSession | null }
  ) {
    if (!browser_session) throw new Error('Browser session missing');
    const scrollParams = {
      down: params.down ?? true,
      num_pages: params.num_pages ?? 1,
      index: params.index ?? undefined,
    };
    const page: any = await browser_session.get_current_page();
    if (!page?.evaluate) {
      throw new Error('Unable to access current page for scrolling.');
    }
    const windowHeight =
      (await page.evaluate(() => window.innerHeight)) || VIEWPORT.height;
    const scrollAmount = Math.floor(windowHeight * scrollParams.num_pages);
    const dy = scrollParams.down ? scrollAmount : -scrollAmount;
    await page.mouse.wheel(0, dy);
    const msg = `🕒 Scrolled ${scrollParams.down ? 'down' : 'up'} ${scrollParams.num_pages} page(s)`;
    return new ActionResult({
      extracted_content: msg,
      include_in_memory: true,
      long_term_memory: msg,
    });
  }

  registry.action('scroll_down', {
    param_model: ScrollActionSchema.partial(),
  })(scroll_down);

  async function scroll(
    params: Partial<z.infer<typeof ScrollActionSchema>>,
    ctx: { browser_session: BrowserSession | null }
  ) {
    return scroll_down(params, ctx);
  }

  registry.action('scroll', { param_model: ScrollActionSchema.partial() })(
    scroll
  );

  async function extract_structured_data(
    params: z.infer<typeof ExtractStructuredDataActionSchema>,
    { browser_session }: { browser_session: BrowserSession | null }
  ) {
    if (!browser_session) throw new Error('Browser session missing');
    const page: any = await browser_session.get_current_page();
    const html = (await page?.content?.()) || '';
    const snippet = html.slice(0, 2000);
    const msg = `Extracted content (truncated): ${snippet}`;
    return new ActionResult({
      extracted_content: msg,
      include_in_memory: true,
      long_term_memory: msg,
    });
  }

  registry.action('extract_structured_data', {
    param_model: ExtractStructuredDataActionSchema,
  })(extract_structured_data);

  async function write_file(
    params: z.infer<typeof WriteFileActionSchema>,
    _ctx: { browser_session: BrowserSession | null }
  ) {
    const dir = path.join('logs', timestamp);
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, params.file_name);
    const leading = params.leading_newline ? '\n' : '';
    const trailing = params.trailing_newline ?? true ? '\n' : '';
    const content = `${leading}${params.content}${trailing}`;
    if (params.append) {
      fs.appendFileSync(target, content, 'utf8');
    } else {
      fs.writeFileSync(target, content, 'utf8');
    }
    const msg = `📝 Wrote file ${target}`;
    return new ActionResult({
      extracted_content: msg,
      include_in_memory: true,
      long_term_memory: msg,
    });
  }

  registry.action('write_file', { param_model: WriteFileActionSchema })(
    write_file
  );

  try {
    const history = await agent.run(20);
    const activePage = await browserSession.get_current_page();
    if (activePage) {
      const title = await activePage.title();
      const url = activePage.url();
      console.log(`Final page: ${title} (${url})`);
    }
    console.log(`Steps executed: ${history.history.length}`);
  } catch (error) {
    console.error('Azure Agent example failed:', error);
  } finally {
    await browserSession.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
