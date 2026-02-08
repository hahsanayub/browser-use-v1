/**
 * Accessibility Tree Playground for browser-use
 *
 * - Launches a browser and navigates to a target URL (default: amazon.com)
 * - Extracts both the full and interesting-only accessibility trees using Playwright
 * - Prints and saves both trees to JSON files
 * - Recursively prints relevant info for each node (role, name, value, description, focusable, focused, checked, selected, disabled, children count)
 * - Explains the difference between the accessibility tree and the DOM tree
 * - Notes on React/Vue/SPA apps
 * - Easy to modify for your own experiments
 *
 * Run with: npx tsx src/dom/playground/test-accessibility.ts
 */

import { chromium } from 'playwright';
import type { ElementHandle } from 'playwright';

type AXNode = {
  role?: string;
  name?: string;
  value?: string | number;
  description?: string;
  focusable?: boolean;
  focused?: boolean;
  checked?: boolean | 'mixed';
  selected?: boolean;
  disabled?: boolean;
  children?: AXNode[];
  [key: string]: any;
};

/**
 * Helper to recursively print relevant info from the accessibility tree
 */
function printAxTree(node: AXNode | null, depth: number = 0): void {
  if (!node) {
    return;
  }

  const indent = '  '.repeat(depth);
  const info: (string | null)[] = [
    `role=${JSON.stringify(node.role)}`,
    node.name ? `name=${JSON.stringify(node.name)}` : null,
    node.value !== undefined ? `value=${JSON.stringify(node.value)}` : null,
    node.description ? `desc=${JSON.stringify(node.description)}` : null,
    'focusable' in node ? `focusable=${JSON.stringify(node.focusable)}` : null,
    'focused' in node ? `focused=${JSON.stringify(node.focused)}` : null,
    'checked' in node ? `checked=${JSON.stringify(node.checked)}` : null,
    'selected' in node ? `selected=${JSON.stringify(node.selected)}` : null,
    'disabled' in node ? `disabled=${JSON.stringify(node.disabled)}` : null,
    node.children ? `children=${node.children.length}` : null,
  ];

  console.log('--------------------------------');
  console.log(indent + info.filter((x) => x !== null).join(', '));

  for (const child of node.children || []) {
    printAxTree(child, depth + 1);
  }
}

/**
 * Helper to print all available accessibility node attributes
 * Prints all key-value pairs for each node (except 'children'), then recurses into children
 */
function printAllFields(node: AXNode | null, depth: number = 0): void {
  if (!node) {
    return;
  }

  const indent = '  '.repeat(depth);
  for (const [k, v] of Object.entries(node)) {
    if (k !== 'children') {
      console.log(`${indent}${k}: ${JSON.stringify(v)}`);
    }
  }

  if ('children' in node && node.children) {
    console.log(`${indent}children: ${node.children.length}`);
    for (const child of node.children) {
      printAllFields(child, depth + 1);
    }
  }
}

/**
 * Flatten the accessibility tree into a list of "role name" strings
 */
function flattenAxTree(node: AXNode | null, lines: string[]): void {
  if (!node) {
    return;
  }

  const role = node.role || '';
  const name = node.name || '';
  lines.push(`${role} ${name}`);

  for (const child of node.children || []) {
    flattenAxTree(child, lines);
  }
}

/**
 * Get and analyze the accessibility tree for a given URL
 */
async function getAxTree(targetUrl: string): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  console.log(`Navigating to ${targetUrl}`);
  await page.goto(targetUrl, { waitUntil: 'load' });

  const accessibilityApi = (page as any).accessibility;
  if (!accessibilityApi || typeof accessibilityApi.snapshot !== 'function') {
    throw new Error(
      'Playwright accessibility API is unavailable in this Playwright version.'
    );
  }

  const axTreeInteresting = await accessibilityApi.snapshot({
    interestingOnly: true,
  });
  const lines: string[] = [];
  flattenAxTree(axTreeInteresting, lines);

  console.log(lines);
  console.log(`length of ax_tree_interesting: ${lines.length}`);

  await browser.close();
}

/**
 * Main execution
 */
async function main(): Promise<void> {
  const TARGET_URLS = [
    // 'https://amazon.com/',
    // 'https://www.google.com/',
    // 'https://www.facebook.com/',
    // 'https://platform.openai.com/tokenizer',
    'https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input/checkbox',
  ];

  for (const url of TARGET_URLS) {
    await getAxTree(url);
  }
}

if (require.main === module) {
  main().catch(console.error);
}

export { printAxTree, printAllFields, flattenAxTree, getAxTree };
