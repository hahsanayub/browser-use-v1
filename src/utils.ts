import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { stderr } from 'node:process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { createLogger } from './logging-config.js';

loadEnv();

const logger = createLogger('browser_use.utils');
let _exiting = false;

type Callback = (() => void) | undefined;

export interface SignalHandlerOptions {
	pause_callback?: Callback;
	resume_callback?: Callback;
	custom_exit_callback?: Callback;
	exit_on_second_int?: boolean;
	interruptible_task_patterns?: string[];
}

export class SignalHandler {
	loop: NodeJS.EventEmitter | null = null;
	pause_callback?: Callback;
	resume_callback?: Callback;
	custom_exit_callback?: Callback;
	exit_on_second_int: boolean;
	interruptible_task_patterns: string[];
	is_windows: boolean;
	private ctrl_c_pressed = false;
	private waiting_for_input = false;
	private bound_sigint = this.sigint_handler.bind(this);
	private bound_sigterm = this.sigterm_handler.bind(this);

	constructor(options: SignalHandlerOptions = {}) {
		this.pause_callback = options.pause_callback;
		this.resume_callback = options.resume_callback;
		this.custom_exit_callback = options.custom_exit_callback;
		this.exit_on_second_int = options.exit_on_second_int ?? true;
		this.interruptible_task_patterns = options.interruptible_task_patterns ?? ['step', 'multi_act', 'get_next_action'];
		this.is_windows = os.platform() === 'win32';
	}

	register() {
		process.on('SIGINT', this.bound_sigint);
		process.on('SIGTERM', this.bound_sigterm);
	}

	unregister() {
		process.off('SIGINT', this.bound_sigint);
		process.off('SIGTERM', this.bound_sigterm);
	}

	private _handle_second_ctrl_c() {
		if (!_exiting) {
			_exiting = true;
			if (this.custom_exit_callback) {
				try {
					this.custom_exit_callback();
				} catch (error) {
					logger.error(`Error in exit callback: ${(error as Error).message}`);
				}
			}
		}

		stderr.write('\n\n🛑  Got second Ctrl+C. Exiting immediately...\n');
		stderr.write('\x1b[?25h\x1b[0m\x1b[?1l\x1b[?2004l\r');
		process.exit(0);
	}

	private _cancel_interruptible_tasks() {
		// Node.js does not provide asyncio-style task cancellation.
		// Users should manage their own interruptible work via pause/resume callbacks.
	}

	async wait_for_resume() {
		this.waiting_for_input = true;
		const green = '\x1b[32;1m';
		const red = '\x1b[31m';
		const blink = '\x1b[33;5m';
		const unblink = '\x1b[0m';
		const reset = '\x1b[0m';

		stderr.write(
			`➡️  Press ${green}[Enter]${reset} to resume or ${red}[Ctrl+C]${reset} again to exit${blink}...${unblink} `,
		);

		await new Promise<void>((resolve) => {
			const rl = readline.createInterface({ input: process.stdin, output: stderr });
			const cleanup = () => {
				this.waiting_for_input = false;
				rl.close();
				resolve();
			};

			rl.once('line', () => {
				if (this.resume_callback) {
					try {
						this.resume_callback();
					} catch (error) {
						logger.error(`Error in resume callback: ${(error as Error).message}`);
					}
				}
				cleanup();
			});

			rl.once('SIGINT', () => {
				this._handle_second_ctrl_c();
				cleanup();
			});
		});
	}

	reset() {
		this.ctrl_c_pressed = false;
		this.waiting_for_input = false;
	}

	private sigint_handler() {
		if (_exiting) {
			process.exit(0);
		}

		if (this.ctrl_c_pressed) {
			if (this.waiting_for_input) {
				return;
			}
			if (this.exit_on_second_int) {
				this._handle_second_ctrl_c();
			}
		}

		this.ctrl_c_pressed = true;
		this._cancel_interruptible_tasks();

		if (this.pause_callback) {
			try {
				this.pause_callback();
			} catch (error) {
				logger.error(`Error in pause callback: ${(error as Error).message}`);
			}
		}

		stderr.write('----------------------------------------------------------------------\n');
	}

	private sigterm_handler() {
		if (!_exiting) {
			_exiting = true;
			stderr.write('\n\n🛑 SIGTERM received. Exiting immediately...\n\n');
			if (this.custom_exit_callback) {
				this.custom_exit_callback();
			}
		}
		process.exit(0);
	}
}

const strip_hyphen = (value: string) => value.replace(/^-+|-+$/g, '').trim();

const pick_logger = (args: unknown[]): ReturnType<typeof createLogger> => {
	if (args.length > 0) {
		const candidate = args[0] as { logger?: ReturnType<typeof createLogger> };
		if (candidate && candidate.logger) {
			return candidate.logger;
		}
	}
	return logger;
};

export const time_execution_sync =
	(additional_text = '') =>
	<T extends (...args: any[]) => any>(func: T) => {
		const label = strip_hyphen(additional_text);
		const wrapper = function (this: ThisType<T>, ...args: Parameters<T>): ReturnType<T> {
			const start = performance.now();
			const result = func.apply(this, args);
			const execution_time = (performance.now() - start) / 1000;
			if (execution_time > 0.25) {
				pick_logger(args).debug(`⏳ ${label}() took ${execution_time.toFixed(2)}s`);
			}
			return result;
		};
		return wrapper as T;
	};

export const time_execution_async =
	(additional_text = '') =>
	<T extends (...args: any[]) => Promise<any>>(func: T) => {
		const label = strip_hyphen(additional_text);
		const wrapper = async function (this: ThisType<T>, ...args: Parameters<T>): Promise<Awaited<ReturnType<T>>> {
			const start = performance.now();
			const result = await func.apply(this, args);
			const execution_time = (performance.now() - start) / 1000;
			if (execution_time > 0.25) {
				pick_logger(args).debug(`⏳ ${label}() took ${execution_time.toFixed(2)}s`);
			}
			return result;
		};
		return wrapper as T;
	};

export const singleton = <T extends (...args: any[]) => any>(cls: T) => {
	let instance: ReturnType<T> | undefined;
	return (...args: Parameters<T>): ReturnType<T> => {
		if (instance === undefined) {
			instance = cls(...args);
		}
		return instance as ReturnType<T>;
	};
};

export const check_env_variables = (keys: string[], predicate: (values: string[]) => boolean = (values) =>
	values.every((value) => value.trim().length > 0),
) => {
	const values = keys.map((key) => process.env[key] ?? '');
	return predicate(values);
};

export const is_unsafe_pattern = (pattern: string) => {
	if (pattern.includes('://')) {
		const [, ...rest] = pattern.split('://');
		pattern = rest.join('://');
	}
	const bare_domain = pattern.replace('.*', '').replace('*.', '');
	return bare_domain.includes('*');
};

export const is_new_tab_page = (url: string) => ['about:blank', 'chrome://new-tab-page/', 'chrome://new-tab-page'].includes(url);

const escape_regex = (value: string) => value.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

const glob_to_regex = (pattern: string) => new RegExp(`^${pattern.split('*').map(escape_regex).join('.*')}$`);

const matches_pattern = (value: string, pattern: string) => glob_to_regex(pattern).test(value);

export const match_url_with_domain_pattern = (url: string, domain_pattern: string, log_warnings = false) => {
	try {
		if (is_new_tab_page(url)) {
			return false;
		}

		const parsed_url = new URL(url);
		const scheme = parsed_url.protocol.replace(':', '').toLowerCase();
		const domain = parsed_url.hostname.toLowerCase();

		if (!scheme || !domain) {
			return false;
		}

		let pattern_scheme = 'https';
		let pattern_domain = domain_pattern.toLowerCase();
		if (pattern_domain.includes('://')) {
			[pattern_scheme, pattern_domain] = pattern_domain.split('://', 2);
		}

		if (pattern_domain.includes(':') && !pattern_domain.startsWith(':')) {
			pattern_domain = pattern_domain.split(':')[0];
		}

		if (!matches_pattern(scheme, pattern_scheme)) {
			return false;
		}

		if (pattern_domain === '*' || domain === pattern_domain) {
			return true;
		}

		if (pattern_domain.includes('*')) {
			if (pattern_domain.split('*.').length - 1 > 1 || pattern_domain.split('.*').length - 1 > 1) {
				if (log_warnings) {
					logger.error(`⛔️ Multiple wildcards in pattern=[${domain_pattern}] are not supported`);
				}
				return false;
			}

			if (pattern_domain.endsWith('.*')) {
				if (log_warnings) {
					logger.error(`⛔️ Wildcard TLDs like in pattern=[${domain_pattern}] are not supported for security`);
				}
				return false;
			}

			const bare_domain = pattern_domain.replace('*.', '');
			if (bare_domain.includes('*')) {
				if (log_warnings) {
					logger.error(`⛔️ Only *.domain style patterns are supported, ignoring pattern=[${domain_pattern}]`);
				}
				return false;
			}

			if (pattern_domain.startsWith('*.')) {
				const parent_domain = pattern_domain.slice(2);
				if (domain === parent_domain || matches_pattern(domain, parent_domain)) {
					return true;
				}
			}

			return matches_pattern(domain, pattern_domain);
		}

		return false;
	} catch (error) {
		logger.error(`⛔️ Error matching URL ${url} with pattern ${domain_pattern}: ${(error as Error).message}`);
		return false;
	}
};

export const merge_dicts = (a: Record<string, any>, b: Record<string, any>, path: (string | number)[] = []) => {
	for (const key of Object.keys(b)) {
		if (key in a) {
			if (typeof a[key] === 'object' && !Array.isArray(a[key]) && typeof b[key] === 'object' && !Array.isArray(b[key])) {
				merge_dicts(a[key], b[key], [...path, key]);
			} else if (Array.isArray(a[key]) && Array.isArray(b[key])) {
				a[key] = [...a[key], ...b[key]];
			} else if (a[key] !== b[key]) {
				throw new Error(`Conflict at ${[...path, key].join('.')}`);
			}
		} else {
			a[key] = b[key];
		}
	}
	return a;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const package_root = path.resolve(__dirname, '..');

let cached_version: string | null = null;

export const get_browser_use_version = () => {
	if (cached_version) {
		return cached_version;
	}

	try {
		const package_json = JSON.parse(fs.readFileSync(path.join(package_root, 'package.json'), 'utf-8'));
		if (package_json?.version) {
			const version = String(package_json.version);
			cached_version = version;
			process.env.LIBRARY_VERSION = version;
			return version;
		}
	} catch (error) {
		logger.debug(`Error detecting browser-use version: ${(error as Error).message}`);
	}

	return 'unknown';
};

let cached_git_info: Record<string, string> | null | undefined;

export const get_git_info = () => {
	if (cached_git_info !== undefined) {
		return cached_git_info;
	}

	try {
		const git_dir = path.join(package_root, '.git');
		if (!fs.existsSync(git_dir)) {
			cached_git_info = null;
			return null;
		}

		const commit_hash = execSync('git rev-parse HEAD', { cwd: package_root, stdio: ['ignore', 'pipe', 'ignore'] })
			.toString()
			.trim();
		const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: package_root, stdio: ['ignore', 'pipe', 'ignore'] })
			.toString()
			.trim();
		const remote_url = execSync('git config --get remote.origin.url', { cwd: package_root, stdio: ['ignore', 'pipe', 'ignore'] })
			.toString()
			.trim();
		const commit_timestamp = execSync('git show -s --format=%ci HEAD', { cwd: package_root, stdio: ['ignore', 'pipe', 'ignore'] })
			.toString()
			.trim();

		cached_git_info = { commit_hash, branch, remote_url, commit_timestamp };
		return cached_git_info;
	} catch (error) {
		logger.debug(`Error getting git info: ${(error as Error).message}`);
		cached_git_info = null;
		return null;
	}
};

export const _log_pretty_path = (input: unknown) => {
	if (!input) {
		return '';
	}

	if (typeof input !== 'string') {
		return `<${(input as { constructor: { name: string } }).constructor?.name || typeof input}>`;
	}

	const normalized = input.trim();
	if (!normalized) {
		return '';
	}

	let pretty_path = normalized.replace(os.homedir(), '~');
	pretty_path = pretty_path.replace(process.cwd(), '.');

	return pretty_path.includes(' ') ? `"${pretty_path}"` : pretty_path;
};

export const _log_pretty_url = (value: string, max_len: number | null = 22) => {
	let sanitized = value.replace('https://', '').replace('http://', '').replace('www.', '');
	if (max_len !== null && sanitized.length > max_len) {
		sanitized = `${sanitized.slice(0, max_len)}…`;
	}
	return sanitized;
};

export const log_pretty_path = _log_pretty_path;
export const log_pretty_url = _log_pretty_url;
