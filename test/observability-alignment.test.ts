import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import Module from 'node:module';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const require = createRequire(import.meta.url);

const mockRoot = path.resolve(process.cwd(), '.tmp-vitest-observability-lmnr');
const mockNodeModules = path.join(mockRoot, 'node_modules');
const mockLmnrDir = path.join(mockNodeModules, 'lmnr');
const mockLmnrIndex = path.join(mockLmnrDir, 'index.js');

const originalNodePath = process.env.NODE_PATH;
const originalDebugLevel = process.env.LMNR_LOGGING_LEVEL;
const originalVerboseFlag = process.env.BROWSER_USE_VERBOSE_OBSERVABILITY;

const importObservability = async () => {
  vi.resetModules();
  return import('../src/observability.js');
};

describe('observability alignment', () => {
  beforeAll(async () => {
    await fs.mkdir(mockLmnrDir, { recursive: true });
    await fs.writeFile(
      mockLmnrIndex,
      [
        'const calls = [];',
        'exports.__calls = calls;',
        'exports.__reset = () => { calls.length = 0; };',
        'exports.observe = (options) => {',
        '  calls.push(options);',
        '  return (fn) => fn;',
        '};',
      ].join('\n'),
      'utf8'
    );

    process.env.NODE_PATH = originalNodePath
      ? `${mockNodeModules}${path.delimiter}${originalNodePath}`
      : mockNodeModules;
    (Module as any)._initPaths();
  });

  afterAll(async () => {
    if (originalNodePath === undefined) {
      delete process.env.NODE_PATH;
    } else {
      process.env.NODE_PATH = originalNodePath;
    }

    if (originalDebugLevel === undefined) {
      delete process.env.LMNR_LOGGING_LEVEL;
    } else {
      process.env.LMNR_LOGGING_LEVEL = originalDebugLevel;
    }

    if (originalVerboseFlag === undefined) {
      delete process.env.BROWSER_USE_VERBOSE_OBSERVABILITY;
    } else {
      process.env.BROWSER_USE_VERBOSE_OBSERVABILITY = originalVerboseFlag;
    }

    (Module as any)._initPaths();
    await fs.rm(mockRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    (require('lmnr') as any).__reset();
    process.env.BROWSER_USE_VERBOSE_OBSERVABILITY = 'false';
  });

  it('observe forwards python-aligned default tags when lmnr is available', async () => {
    process.env.LMNR_LOGGING_LEVEL = 'info';
    const { observe } = await importObservability();
    const wrapped = observe({ name: 'test-observe' })(
      (value: number) => value + 1
    );
    const lmnr = require('lmnr') as any;

    expect(wrapped(1)).toBe(2);
    expect(lmnr.__calls).toHaveLength(1);
    expect(lmnr.__calls[0].name).toBe('test-observe');
    expect(lmnr.__calls[0].tags).toEqual(['observe', 'observe_debug']);
  });

  it('observe_debug traces only in debug mode with observe_debug tag', async () => {
    process.env.LMNR_LOGGING_LEVEL = 'debug';
    const { observe_debug } = await importObservability();
    const wrapped = observe_debug({ name: 'debug-only' })(
      (value: number) => value + 1
    );
    const lmnr = require('lmnr') as any;

    expect(wrapped(1)).toBe(2);
    expect(lmnr.__calls).toHaveLength(1);
    expect(lmnr.__calls[0].name).toBe('debug-only');
    expect(lmnr.__calls[0].tags).toEqual(['observe_debug']);
  });

  it('observe_debug is a no-op outside debug mode', async () => {
    process.env.LMNR_LOGGING_LEVEL = 'info';
    const { observe_debug } = await importObservability();
    const wrapped = observe_debug({ name: 'debug-only' })(
      (value: number) => value + 1
    );
    const lmnr = require('lmnr') as any;

    expect(wrapped(1)).toBe(2);
    expect(lmnr.__calls).toHaveLength(0);
  });
});
